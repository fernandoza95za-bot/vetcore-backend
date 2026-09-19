import { randomBytes } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../db/db.module.js';
import { CreatorNotifierService } from './creator-notifier.service.js';
import { TokenService } from './token.service.js';
import {
  DEFAULT_TRIAL_DAYS_FALLBACK,
  LIFETIME_TOKEN_TTL_HOURS,
  SAAS_TOKEN_TTL_HOURS,
  TRIAL_DEFAULT_MAX_DEVICES,
  TRIAL_TOKEN_TTL_HOURS,
  TRIAL_WARNING_DAYS,
} from './licensing.constants.js';

export type LicenseType = 'saas' | 'lifetime' | 'trial';
export type LicenseStatus = 'activa' | 'suspendida' | 'cancelada';
export type DeviceStatus = 'pendiente' | 'aprobado' | 'revocado';
export type DeviceRole = 'principal' | 'secundario';

export interface ClinicRow {
  id: number;
  name: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  notes: string | null;
  created_at: Date;
}

export interface LicenseRow {
  id: number;
  clinic_id: number;
  license_type: LicenseType;
  status: LicenseStatus;
  max_devices: number;
  license_key: string;
  paid_through: Date | null;
  /** Ver RegisterTrialDto / UpdateLicenseDto.requiresLicense. */
  requires_license_at: Date | null;
  issued_at: Date;
  /**
   * Solo aplica a `license_type === 'trial'`: cuántos días dura la prueba de
   * ESTA clínica en particular. `null` = usar el valor global
   * (`app_settings.default_trial_days`). Ver `effectiveRequiresLicenseAt`.
   */
  trial_days: number | null;
}

export interface DeviceRow {
  id: number;
  license_id: number;
  hwid_hash: string;
  device_name: string;
  branch_label: string | null;
  device_role: DeviceRole;
  status: DeviceStatus;
  requested_at: Date;
  approved_at: Date | null;
  approved_by: string | null;
  last_seen_at: Date | null;
}

function generateLicenseKey(): string {
  const part = () => randomBytes(3).toString('hex').toUpperCase();
  return `VC-${part()}-${part()}-${part()}`;
}

@Injectable()
export class LicensingService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly tokens: TokenService,
    private readonly creatorNotifier: CreatorNotifierService,
  ) {}

  // ---------- Administración (panel) ----------

  async createClinicWithLicense(input: {
    name: string;
    contactName?: string;
    contactEmail?: string;
    contactPhone?: string;
    notes?: string;
    licenseType: LicenseType;
    maxDevices: number;
  }): Promise<{ clinic: ClinicRow; license: LicenseRow }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const clinicResult = await client.query<ClinicRow>(
        'INSERT INTO clinics (name, contact_name, contact_email, contact_phone, notes) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [input.name, input.contactName ?? null, input.contactEmail ?? null, input.contactPhone ?? null, input.notes ?? null],
      );
      const clinic = clinicResult.rows[0];

      const licenseKey = generateLicenseKey();
      const paidThrough = input.licenseType === 'saas' ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) : null;
      const licenseResult = await client.query<LicenseRow>(
        `INSERT INTO licenses (clinic_id, license_type, max_devices, license_key, paid_through)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [clinic.id, input.licenseType, input.maxDevices, licenseKey, paidThrough],
      );
      await client.query('COMMIT');
      return { clinic, license: licenseResult.rows[0] };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async listClinicsWithLicenses(): Promise<
    Array<
      ClinicRow & {
        license:
          | (LicenseRow & {
              /** El plazo que de verdad aplica (manual si existe, si no el automático calculado de `issued_at` + días de prueba) — el panel lo necesita para poder mostrar la cuenta regresiva de una prueba que nunca se marcó a mano. */
              effectiveRequiresLicenseAt: string | null;
              /** Días de prueba que de verdad aplican a esta clínica (propios si tiene, si no el global). Solo relevante para license_type === 'trial'. */
              effectiveTrialDays: number | null;
            })
          | null;
        deviceCount: number;
        approvedCount: number;
      }
    >
  > {
    const { rows } = await this.pool.query(`
      SELECT
        c.*,
        row_to_json(l.*) AS license,
        (SELECT count(*) FROM authorized_devices d WHERE d.license_id = l.id) AS device_count,
        (SELECT count(*) FROM authorized_devices d WHERE d.license_id = l.id AND d.status = 'aprobado') AS approved_count
      FROM clinics c
      LEFT JOIN licenses l ON l.clinic_id = c.id
      ORDER BY c.created_at DESC
    `);

    const defaultTrialDays = await this.getDefaultTrialDays();

    return Promise.all(
      rows.map(async (r) => {
        const rawLicense = r.license as (LicenseRow & { issued_at: string; requires_license_at: string | null; paid_through: string | null }) | null;
        if (!rawLicense) {
          return { ...r, license: null, deviceCount: Number(r.device_count), approvedCount: Number(r.approved_count) };
        }

        // row_to_json manda fechas como texto ISO — hay que volver a
        // convertirlas a Date antes de reusar la misma lógica que ya opera
        // sobre LicenseRow en el resto del servicio.
        const normalized: LicenseRow = {
          ...rawLicense,
          issued_at: new Date(rawLicense.issued_at),
          requires_license_at: rawLicense.requires_license_at ? new Date(rawLicense.requires_license_at) : null,
          paid_through: rawLicense.paid_through ? new Date(rawLicense.paid_through) : null,
        };
        const effectiveAt = await this.effectiveRequiresLicenseAt(normalized);

        return {
          ...r,
          license: {
            ...rawLicense,
            effectiveRequiresLicenseAt: effectiveAt ? effectiveAt.toISOString() : null,
            effectiveTrialDays: normalized.license_type === 'trial' ? (normalized.trial_days ?? defaultTrialDays) : null,
          },
          deviceCount: Number(r.device_count),
          approvedCount: Number(r.approved_count),
        };
      }),
    );
  }

  async updateLicense(
    licenseId: number,
    input: {
      status?: LicenseStatus;
      licenseType?: LicenseType;
      maxDevices?: number;
      paidThrough?: string | null;
      requiresLicense?: boolean;
      /** null = quitar el valor de esta clínica y volver a usar el global. */
      trialDays?: number | null;
    },
  ): Promise<LicenseRow> {
    const existing = await this.findLicenseById(licenseId);
    if (!existing) throw new NotFoundException('Licencia no encontrada');

    const status = input.status ?? existing.status;
    const licenseType = input.licenseType ?? existing.license_type;
    const maxDevices = input.maxDevices ?? existing.max_devices;
    const paidThrough = input.paidThrough === undefined ? existing.paid_through : input.paidThrough ? new Date(input.paidThrough) : null;
    const trialDays = input.trialDays === undefined ? existing.trial_days : input.trialDays;

    // "requiresLicense" solo tiene sentido para una clínica en modo de
    // prueba: si se cambia el tipo a saas/lifetime (por ejemplo, porque el
    // dueño acaba de convertir la prueba en un cliente de pago), la marca
    // deja de aplicar y se limpia sola aunque no se haya pedido.
    let requiresLicenseAt = existing.requires_license_at;
    if (licenseType !== 'trial') {
      requiresLicenseAt = null;
    } else if (input.requiresLicense === true && !existing.requires_license_at) {
      requiresLicenseAt = new Date();
    } else if (input.requiresLicense === false) {
      requiresLicenseAt = null;
    }

    const { rows } = await this.pool.query<LicenseRow>(
      `UPDATE licenses SET
         status = $2,
         license_type = $3,
         max_devices = $4,
         paid_through = $5,
         requires_license_at = $6,
         trial_days = $7,
         updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [licenseId, status, licenseType, maxDevices, paidThrough, requiresLicenseAt, trialDays],
    );
    return rows[0];
  }

  /** Valor global (editable desde el panel) de cuántos días dura la prueba
   * de una clínica nueva cuando no se le puso un valor propio. */
  async getDefaultTrialDays(): Promise<number> {
    const { rows } = await this.pool.query<{ value: string }>(`SELECT value FROM app_settings WHERE key = 'default_trial_days'`);
    const parsed = rows[0] ? parseInt(rows[0].value, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TRIAL_DAYS_FALLBACK;
  }

  async setDefaultTrialDays(days: number): Promise<{ defaultTrialDays: number }> {
    await this.pool.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('default_trial_days', $1, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [String(days)],
    );
    return { defaultTrialDays: days };
  }

  async listDevices(status?: DeviceStatus): Promise<Array<DeviceRow & { clinicName: string; licenseKey: string }>> {
    const { rows } = await this.pool.query(
      `SELECT d.*, c.name AS clinic_name, l.license_key
       FROM authorized_devices d
       JOIN licenses l ON l.id = d.license_id
       JOIN clinics c ON c.id = l.clinic_id
       WHERE $1::text IS NULL OR d.status = $1
       ORDER BY d.requested_at DESC`,
      [status ?? null],
    );
    return rows.map((r) => ({ ...r, clinicName: r.clinic_name, licenseKey: r.license_key }));
  }

  async approveDevice(deviceId: number, approvedBy: string): Promise<DeviceRow> {
    const device = await this.findDeviceById(deviceId);
    if (!device) throw new NotFoundException('Dispositivo no encontrado');
    if (device.status === 'aprobado') return device;

    const license = await this.findLicenseById(device.license_id);
    if (!license) throw new NotFoundException('Licencia no encontrada');

    const approvedCount = await this.countDevicesByStatus(device.license_id, 'aprobado');
    if (approvedCount >= license.max_devices) {
      throw new ForbiddenException(`Esta licencia ya tiene el máximo de ${license.max_devices} dispositivos aprobados`);
    }

    const { rows } = await this.pool.query<DeviceRow>(
      `UPDATE authorized_devices SET status = 'aprobado', approved_at = now(), approved_by = $2 WHERE id = $1 RETURNING *`,
      [deviceId, approvedBy],
    );
    return rows[0];
  }

  async revokeDevice(deviceId: number): Promise<DeviceRow> {
    const { rows } = await this.pool.query<DeviceRow>(
      `UPDATE authorized_devices SET status = 'revocado' WHERE id = $1 RETURNING *`,
      [deviceId],
    );
    if (!rows[0]) throw new NotFoundException('Dispositivo no encontrado');
    return rows[0];
  }

  // ---------- Cara pública (la app de escritorio) ----------

  async activate(input: {
    licenseKey: string;
    hwid: string;
    deviceName: string;
    deviceRole: DeviceRole;
    branchLabel?: string;
  }): Promise<{ status: DeviceStatus; token?: string }> {
    const license = await this.findLicenseByKey(input.licenseKey);
    if (!license) throw new NotFoundException('Clave de licencia inválida');
    await this.assertLicenseUsable(license);

    let device = await this.findDeviceByHwid(input.hwid);
    if (device && device.license_id !== license.id) {
      throw new ConflictException('Este equipo ya está vinculado a otra licencia. Contacta al administrador.');
    }

    if (!device) {
      const activeCount = await this.countDevicesByStatus(license.id, 'aprobado');
      const pendingCount = await this.countDevicesByStatus(license.id, 'pendiente');
      if (activeCount + pendingCount >= license.max_devices) {
        throw new ForbiddenException(
          `Esta licencia permite un máximo de ${license.max_devices} equipos y ya fue alcanzado. Contacta al administrador para ampliarlo.`,
        );
      }
      const { rows } = await this.pool.query<DeviceRow>(
        `INSERT INTO authorized_devices (license_id, hwid_hash, device_name, branch_label, device_role)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [license.id, input.hwid, input.deviceName, input.branchLabel ?? null, input.deviceRole],
      );
      device = rows[0];
    }

    if (device.status === 'revocado') {
      throw new ForbiddenException('Este equipo fue desautorizado. Contacta al administrador.');
    }
    if (device.status === 'pendiente') {
      return { status: 'pendiente' };
    }

    await this.touchLastSeen(device.id);
    const token = await this.issueToken(license, device);
    return { status: 'aprobado', token };
  }

  /**
   * Registro silencioso de prueba (sin clave de licencia): lo llama la app
   * en el primer arranque de una instalación nueva. Si el correo/teléfono de
   * contacto ya coincide con una clínica que está en modo de prueba, este
   * equipo se une a ELLA en vez de crear una clínica duplicada — así una
   * segunda computadora de la misma veterinaria "simplemente funciona" sin
   * que nadie tenga que copiar ni pegar ninguna clave. La clínica y la
   * licencia de prueba se guardan la clave (`license_key`) igual que
   * cualquier otra licencia, solo que la app nunca se la muestra al usuario:
   * la usa por dentro, sin que se note, para los heartbeats siguientes (ver
   * `LicenseManager::register_trial` del lado de Rust).
   */
  async registerTrial(input: {
    clinicName: string;
    contactName?: string;
    contactEmail?: string;
    contactPhone?: string;
    hwid: string;
    deviceName: string;
  }): Promise<{ status: DeviceStatus; token?: string; licenseKey: string; deviceRole: DeviceRole }> {
    if (!input.contactEmail?.trim() && !input.contactPhone?.trim()) {
      throw new BadRequestException('Se requiere al menos un correo o un teléfono de contacto');
    }

    // Reintento (por ejemplo, si la app se cerró antes de guardar la
    // respuesta la primera vez): este equipo ya existe, no hay que crear
    // nada de nuevo, solo contarle en qué quedó.
    const existingDevice = await this.findDeviceByHwid(input.hwid);
    if (existingDevice) {
      const license = await this.findLicenseById(existingDevice.license_id);
      if (license) {
        return await this.respondForDevice(license, existingDevice);
      }
    }

    const client = await this.pool.connect();
    let clinic: ClinicRow | null = null;
    let license: LicenseRow | null = null;
    let isNewClinic = false;
    try {
      await client.query('BEGIN');

      clinic = await this.findTrialClinicByContact(client, input.contactEmail, input.contactPhone);
      if (clinic) {
        const { rows } = await client.query<LicenseRow>(
          `SELECT * FROM licenses WHERE clinic_id = $1 AND license_type = 'trial' ORDER BY created_at DESC LIMIT 1`,
          [clinic.id],
        );
        license = rows[0] ?? null;
      }

      if (!clinic || !license) {
        isNewClinic = true;
        const clinicResult = await client.query<ClinicRow>(
          `INSERT INTO clinics (name, contact_name, contact_email, contact_phone)
           VALUES ($1, $2, $3, $4) RETURNING *`,
          [input.clinicName, input.contactName ?? null, input.contactEmail ?? null, input.contactPhone ?? null],
        );
        clinic = clinicResult.rows[0];

        const licenseResult = await client.query<LicenseRow>(
          `INSERT INTO licenses (clinic_id, license_type, max_devices, license_key)
           VALUES ($1, 'trial', $2, $3) RETURNING *`,
          [clinic.id, TRIAL_DEFAULT_MAX_DEVICES, generateLicenseKey()],
        );
        license = licenseResult.rows[0];
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    if (!license) {
      // No debería pasar nunca — una de las dos ramas de arriba siempre
      // deja `license` asignada. Solo es una red de seguridad.
      throw new Error('No se pudo determinar la licencia de prueba');
    }

    // Aviso por correo al creador: solo cuando de verdad se creó una
    // clínica nueva (no cuando un segundo equipo se unió a una que ya
    // existía). Nunca debe tumbar el registro si falla — por eso el propio
    // servicio se encarga de no lanzar, solo de dejar constancia.
    if (isNewClinic) {
      void this.creatorNotifier.notifyNewInstall(clinic).catch(() => {
        // notifyNewInstall ya atrapa sus propios errores; esto es solo una
        // red de seguridad extra para que una promesa nunca quede suelta.
      });
    }

    await this.assertLicenseUsable(license);

    const activeCount = await this.countDevicesByStatus(license.id, 'aprobado');
    const pendingCount = await this.countDevicesByStatus(license.id, 'pendiente');
    if (activeCount + pendingCount >= license.max_devices) {
      throw new ForbiddenException(
        `Esta clínica ya alcanzó el máximo de ${license.max_devices} equipos en modo de prueba. Contacta al soporte.`,
      );
    }

    // Libre mientras nadie haya marcado que ya necesita una licencia real:
    // ni el primer equipo ni los siguientes piden aprobación manual. En
    // cuanto se marca, vuelve a comportarse como cualquier licencia normal
    // (el siguiente equipo nuevo queda "pendiente" hasta que el dueño lo
    // apruebe desde el panel).
    const autoApprove = license.requires_license_at === null;
    const deviceRole: DeviceRole = isNewClinic ? 'principal' : 'secundario';

    const { rows } = await this.pool.query<DeviceRow>(
      `INSERT INTO authorized_devices (license_id, hwid_hash, device_name, device_role, status, approved_at, approved_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        license.id,
        input.hwid,
        input.deviceName,
        deviceRole,
        autoApprove ? 'aprobado' : 'pendiente',
        autoApprove ? new Date() : null,
        autoApprove ? 'registro automático (prueba)' : null,
      ],
    );
    const device = rows[0];

    return await this.respondForDevice(license, device);
  }

  async heartbeat(input: { licenseKey: string; hwid: string }): Promise<{ status: DeviceStatus; token?: string }> {
    const license = await this.findLicenseByKey(input.licenseKey);
    if (!license) throw new NotFoundException('Clave de licencia inválida');

    const device = await this.findDeviceByHwid(input.hwid);
    if (!device || device.license_id !== license.id) {
      throw new NotFoundException('Este equipo no está registrado con esta licencia');
    }
    if (device.status === 'revocado') {
      return { status: 'revocado' };
    }
    if (device.status === 'pendiente') {
      return { status: 'pendiente' };
    }

    await this.assertLicenseUsable(license);
    await this.touchLastSeen(device.id);
    const token = await this.issueToken(license, device);
    return { status: 'aprobado', token };
  }

  /**
   * Usado por el dispositivo "principal" de una sucursal para obtener, de
   * una sola vez, tokens pre-firmados de todos los equipos ya aprobados de
   * la misma sucursal. Su sidecar Axum los reparte por LAN a los equipos
   * "secundarios" cuando ellos no tienen internet directo — el sidecar
   * nunca firma nada por su cuenta, solo reenvía lo que el backend ya firmó.
   */
  async branchBundle(input: { licenseKey: string; hwid: string }): Promise<Array<{ hwid: string; deviceName: string; token: string }>> {
    const license = await this.findLicenseByKey(input.licenseKey);
    if (!license) throw new NotFoundException('Clave de licencia inválida');

    const requester = await this.findDeviceByHwid(input.hwid);
    if (!requester || requester.license_id !== license.id) {
      throw new NotFoundException('Este equipo no está registrado con esta licencia');
    }
    if (requester.device_role !== 'principal') {
      throw new ForbiddenException('Solo el equipo principal de la sucursal puede solicitar este paquete');
    }
    if (requester.status !== 'aprobado') {
      throw new ForbiddenException('El equipo principal todavía no está aprobado');
    }
    await this.assertLicenseUsable(license);

    const { rows } = await this.pool.query<DeviceRow>(
      `SELECT * FROM authorized_devices
       WHERE license_id = $1 AND status = 'aprobado'
         AND (branch_label IS NOT DISTINCT FROM $2)`,
      [license.id, requester.branch_label],
    );

    return await Promise.all(
      rows.map(async (device) => ({
        hwid: device.hwid_hash,
        deviceName: device.device_name,
        token: await this.issueToken(license, device),
      })),
    );
  }

  // ---------- Helpers internos ----------

  /** Arma la respuesta {status, token?, licenseKey, deviceRole} que espera el cliente de registerTrial. */
  private async respondForDevice(
    license: LicenseRow,
    device: DeviceRow,
  ): Promise<{ status: DeviceStatus; token?: string; licenseKey: string; deviceRole: DeviceRole }> {
    if (device.status !== 'aprobado') {
      return { status: device.status, licenseKey: license.license_key, deviceRole: device.device_role };
    }
    const token = await this.issueToken(license, device);
    return { status: 'aprobado', token, licenseKey: license.license_key, deviceRole: device.device_role };
  }

  /**
   * Busca, dentro de una transacción ya abierta, una clínica en modo de
   * prueba cuyo correo o teléfono de contacto coincida — es la única forma
   * en la que este flujo "reconoce" que dos computadoras son de la misma
   * veterinaria, ya que nunca se le pide al usuario ninguna clave.
   */
  private async findTrialClinicByContact(
    client: PoolClient,
    contactEmail: string | undefined,
    contactPhone: string | undefined,
  ): Promise<ClinicRow | null> {
    if (contactEmail?.trim()) {
      const { rows } = await client.query<ClinicRow>(
        `SELECT c.* FROM clinics c
         JOIN licenses l ON l.clinic_id = c.id
         WHERE l.license_type = 'trial' AND lower(c.contact_email) = lower($1)
         ORDER BY c.created_at DESC LIMIT 1`,
        [contactEmail.trim()],
      );
      if (rows[0]) return rows[0];
    }
    if (contactPhone?.trim()) {
      const { rows } = await client.query<ClinicRow>(
        `SELECT c.* FROM clinics c
         JOIN licenses l ON l.clinic_id = c.id
         WHERE l.license_type = 'trial' AND c.contact_phone = $1
         ORDER BY c.created_at DESC LIMIT 1`,
        [contactPhone.trim()],
      );
      if (rows[0]) return rows[0];
    }
    return null;
  }

  /**
   * El plazo que de verdad importa para el aviso/bloqueo automático: el que
   * el dueño haya marcado a mano (`requires_license_at`) si existe, y si no,
   * el que se calcula solo a partir de cuándo se emitió la licencia y
   * cuántos días de prueba le tocan a esta clínica (propios o el global).
   * Ambos caminos producen el mismo tipo de fecha ("a partir de aquí
   * empieza la cuenta regresiva de `TRIAL_WARNING_DAYS`"), así que de aquí
   * para adelante (el token firmado, el bloqueo del lado del servidor) no
   * hace falta distinguir cuál de los dos fue.
   */
  private async effectiveRequiresLicenseAt(license: LicenseRow): Promise<Date | null> {
    if (license.requires_license_at) return license.requires_license_at;
    if (license.license_type !== 'trial') return null;

    const trialDays = license.trial_days ?? (await this.getDefaultTrialDays());
    const warnStartMs = license.issued_at.getTime() + (trialDays - TRIAL_WARNING_DAYS) * 24 * 60 * 60 * 1000;
    return new Date(warnStartMs);
  }

  private async issueToken(license: LicenseRow, device: DeviceRow): Promise<string> {
    const ttlHours =
      license.license_type === 'saas' ? SAAS_TOKEN_TTL_HOURS : license.license_type === 'trial' ? TRIAL_TOKEN_TTL_HOURS : LIFETIME_TOKEN_TTL_HOURS;
    const now = Date.now();
    const requiresLicenseAt = await this.effectiveRequiresLicenseAt(license);
    return this.tokens.sign({
      hwid: device.hwid_hash,
      clinicId: license.clinic_id,
      licenseId: license.id,
      deviceId: device.id,
      licenseType: license.license_type,
      deviceRole: device.device_role,
      issuedAt: Math.floor(now / 1000),
      expiresAt: Math.floor((now + ttlHours * 60 * 60 * 1000) / 1000),
      requiresLicenseAt: requiresLicenseAt ? Math.floor(requiresLicenseAt.getTime() / 1000) : null,
    });
  }

  private async assertLicenseUsable(license: LicenseRow): Promise<void> {
    if (license.status === 'cancelada') throw new ForbiddenException('Esta licencia fue cancelada');
    if (license.status === 'suspendida') throw new ForbiddenException('Esta licencia está suspendida. Contacta al administrador.');
    if (license.license_type === 'saas' && license.paid_through && license.paid_through.getTime() < Date.now()) {
      throw new ForbiddenException('El pago de esta licencia está vencido. Contacta al administrador.');
    }
    if (license.license_type === 'trial') {
      const flaggedAt = await this.effectiveRequiresLicenseAt(license);
      if (flaggedAt) {
        const blockDeadline = flaggedAt.getTime() + TRIAL_WARNING_DAYS * 24 * 60 * 60 * 1000;
        if (Date.now() > blockDeadline) {
          throw new ForbiddenException('Esta instalación no pudo confirmarse a tiempo y quedó bloqueada. Comunícate con el creador del programa para reactivarla.');
        }
      }
    }
  }

  private async touchLastSeen(deviceId: number): Promise<void> {
    await this.pool.query('UPDATE authorized_devices SET last_seen_at = now() WHERE id = $1', [deviceId]);
  }

  private async countDevicesByStatus(licenseId: number, status: DeviceStatus): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      'SELECT count(*)::text FROM authorized_devices WHERE license_id = $1 AND status = $2',
      [licenseId, status],
    );
    return Number(rows[0].count);
  }

  private async findLicenseByKey(licenseKey: string): Promise<LicenseRow | null> {
    const { rows } = await this.pool.query<LicenseRow>('SELECT * FROM licenses WHERE license_key = $1', [licenseKey]);
    return rows[0] ?? null;
  }

  private async findLicenseById(id: number): Promise<LicenseRow | null> {
    const { rows } = await this.pool.query<LicenseRow>('SELECT * FROM licenses WHERE id = $1', [id]);
    return rows[0] ?? null;
  }

  private async findDeviceByHwid(hwid: string): Promise<DeviceRow | null> {
    const { rows } = await this.pool.query<DeviceRow>('SELECT * FROM authorized_devices WHERE hwid_hash = $1', [hwid]);
    return rows[0] ?? null;
  }

  private async findDeviceById(id: number): Promise<DeviceRow | null> {
    const { rows } = await this.pool.query<DeviceRow>('SELECT * FROM authorized_devices WHERE id = $1', [id]);
    return rows[0] ?? null;
  }
}
