// Pruebas de integración reales contra Postgres (no mocks) para la lógica
// nueva de días de prueba automáticos + aviso al creador. El resto del
// backend no tenía ninguna prueba automatizada todavía; para esta pieza en
// concreto (que decide cuándo se bloquea una instalación de verdad) vale la
// pena montar el arnés aunque sea la primera vez, en vez de confiar solo en
// pruebas manuales.
//
// Requiere una base de datos Postgres alcanzable en TEST_DATABASE_URL (por
// defecto, una instancia local en localhost:5432 con una base
// "vetcore_licensing_test" ya creada).

import { randomBytes } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrator.js';
import { CreatorNotifierService } from './creator-notifier.service.js';
import { LicensingService } from './licensing.service.js';
import { TokenService } from './token.service.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/vetcore_licensing_test';

/** ConfigService de mentiras: solo implementa lo que TokenService/CreatorNotifierService de verdad usan. */
function fakeConfig(overrides: Record<string, string | undefined> = {}): ConfigService {
  const values: Record<string, string | undefined> = {
    LICENSE_SIGNING_SECRET_KEY: randomBytes(32).toString('base64'),
    ...overrides,
  };
  return {
    get: (key: string) => values[key],
    getOrThrow: (key: string) => {
      const v = values[key];
      if (v === undefined) throw new Error(`falta configurar ${key}`);
      return v;
    },
  } as unknown as ConfigService;
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe('LicensingService (trial automático + aviso al creador)', () => {
  let pool: Pool;
  let tokens: TokenService;
  let notifier: CreatorNotifierService;
  let service: LicensingService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL });
    await runMigrations(pool);
    tokens = new TokenService(fakeConfig());
    notifier = new CreatorNotifierService(fakeConfig(), pool);
    service = new LicensingService(pool, tokens, notifier);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE authorized_devices, licenses, clinics, install_notifications RESTART IDENTITY CASCADE');
    await pool.query(`INSERT INTO app_settings (key, value) VALUES ('default_trial_days', '60')
                       ON CONFLICT (key) DO UPDATE SET value = '60'`);
  });

  async function registerNewClinic(overrides: Partial<{ clinicName: string; contactEmail: string; hwid: string; deviceName: string }> = {}) {
    return service.registerTrial({
      clinicName: overrides.clinicName ?? 'Veterinaria de prueba',
      contactEmail: overrides.contactEmail ?? 'contacto@clinica-test.com',
      hwid: overrides.hwid ?? 'HWID-TEST-1',
      deviceName: overrides.deviceName ?? 'PC Recepción',
    });
  }

  async function backdateIssuedAt(clinicName: string, daysAgo: number) {
    await pool.query(
      `UPDATE licenses SET issued_at = now() - ($2 || ' days')::interval
       WHERE clinic_id = (SELECT id FROM clinics WHERE name = $1)`,
      [clinicName, String(daysAgo)],
    );
  }

  it('una clínica nueva queda aprobada de inmediato, sin marca manual', async () => {
    const result = await registerNewClinic();
    expect(result.status).toBe('aprobado');
    expect(result.token).toBeTruthy();

    const { rows } = await pool.query('SELECT * FROM licenses WHERE license_key = $1', [result.licenseKey]);
    expect(rows[0].license_type).toBe('trial');
    expect(rows[0].requires_license_at).toBeNull();
    expect(rows[0].trial_days).toBeNull();
  });

  it('el token firmado ya trae el plazo automático calculado (60 - 7 días desde que se creó)', async () => {
    const result = await registerNewClinic();
    const payload = tokens.verify(result.token as string);
    expect(payload).not.toBeNull();
    expect(payload!.requiresLicenseAt).not.toBeNull();

    const { rows } = await pool.query('SELECT issued_at FROM licenses WHERE license_key = $1', [result.licenseKey]);
    const issuedAtMs = new Date(rows[0].issued_at).getTime();
    const expectedMs = issuedAtMs + (60 - 7) * DAY_MS;

    // Tolerancia de unos segundos por el tiempo real que toma la llamada.
    expect(Math.abs(payload!.requiresLicenseAt! * 1000 - expectedMs)).toBeLessThan(5000);
  });

  it('un valor global de días de prueba distinto se refleja en clínicas nuevas', async () => {
    await service.setDefaultTrialDays(30);
    const result = await registerNewClinic({ clinicName: 'Clínica con 30 días' });
    const payload = tokens.verify(result.token as string);

    const { rows } = await pool.query('SELECT issued_at FROM licenses WHERE license_key = $1', [result.licenseKey]);
    const issuedAtMs = new Date(rows[0].issued_at).getTime();
    const expectedMs = issuedAtMs + (30 - 7) * DAY_MS;

    expect(Math.abs(payload!.requiresLicenseAt! * 1000 - expectedMs)).toBeLessThan(5000);
  });

  it('un valor de días de prueba propio de la clínica manda sobre el global', async () => {
    const result = await registerNewClinic({ clinicName: 'Clínica con plazo especial' });
    const { rows: licenseRows } = await pool.query('SELECT id, issued_at FROM licenses WHERE license_key = $1', [result.licenseKey]);
    const licenseId = licenseRows[0].id as number;
    const issuedAtMs = new Date(licenseRows[0].issued_at).getTime();

    await service.updateLicense(licenseId, { trialDays: 90 });

    // Un heartbeat vuelve a emitir el token con el plazo ya recalculado.
    const heartbeat = await service.heartbeat({ licenseKey: result.licenseKey, hwid: 'HWID-TEST-1' });
    const payload = tokens.verify(heartbeat.token as string);
    const expectedMs = issuedAtMs + (90 - 7) * DAY_MS;

    expect(Math.abs(payload!.requiresLicenseAt! * 1000 - expectedMs)).toBeLessThan(5000);
  });

  it('un segundo equipo de la misma clínica sigue uniéndose sin aprobación, aunque ya esté cerca del límite automático', async () => {
    await registerNewClinic({ clinicName: 'Clínica con dos equipos', hwid: 'HWID-UNO' });
    await backdateIssuedAt('Clínica con dos equipos', 55); // día 55 de 60 — todavía no se bloquea

    const second = await service.registerTrial({
      clinicName: 'Clínica con dos equipos',
      contactEmail: 'contacto@clinica-test.com', // mismo contacto → se une a la misma prueba
      hwid: 'HWID-DOS',
      deviceName: 'PC Consultorio 2',
    });

    expect(second.status).toBe('aprobado');
  });

  it('pasado el plazo automático, la instalación queda bloqueada del lado del servidor', async () => {
    const result = await registerNewClinic({ clinicName: 'Clínica ya vencida', hwid: 'HWID-VENCIDA' });
    await backdateIssuedAt('Clínica ya vencida', 61); // más de 60 días desde que se creó

    await expect(service.heartbeat({ licenseKey: result.licenseKey, hwid: 'HWID-VENCIDA' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.heartbeat({ licenseKey: result.licenseKey, hwid: 'HWID-VENCIDA' })).rejects.toThrow(/no pudo confirmarse a tiempo/);
  });

  it('dentro del plazo automático pero antes de los 60 días, el heartbeat sigue funcionando normal', async () => {
    const result = await registerNewClinic({ clinicName: 'Clínica a la mitad', hwid: 'HWID-MITAD' });
    await backdateIssuedAt('Clínica a la mitad', 30); // a la mitad de 60 días

    const heartbeat = await service.heartbeat({ licenseKey: result.licenseKey, hwid: 'HWID-MITAD' });
    expect(heartbeat.status).toBe('aprobado');
    const payload = tokens.verify(heartbeat.token as string);
    // Todavía no llega la ventana de aviso (empieza el día 53): el token
    // lleva la fecha marcada, pero en el futuro.
    expect(payload!.requiresLicenseAt! * 1000).toBeGreaterThan(Date.now());
  });

  it('la marca manual (requiresLicense) sigue funcionando igual que antes, independiente del plazo automático', async () => {
    const result = await registerNewClinic({ clinicName: 'Clínica marcada a mano', hwid: 'HWID-MANO' });
    const { rows } = await pool.query('SELECT id FROM licenses WHERE license_key = $1', [result.licenseKey]);
    const licenseId = rows[0].id as number;

    await service.updateLicense(licenseId, { requiresLicense: true });

    const heartbeat = await service.heartbeat({ licenseKey: result.licenseKey, hwid: 'HWID-MANO' });
    const payload = tokens.verify(heartbeat.token as string);
    // Se marcó ahora mismo, así que el plazo marcado debe ser "hace un instante", no el automático de 53 días.
    expect(Math.abs(payload!.requiresLicenseAt! * 1000 - Date.now())).toBeLessThan(5000);
  });

  it('registrar una clínica nueva deja constancia del aviso al creador, aunque no haya API key configurada', async () => {
    const result = await registerNewClinic({ clinicName: 'Clínica que dispara el aviso', hwid: 'HWID-AVISO' });
    expect(result.status).toBe('aprobado');

    // notifyNewInstall se dispara sin esperar (fire-and-forget) dentro de
    // registerTrial — hay que darle un instante para que termine de
    // escribir su bitácora antes de comprobarla.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const { rows } = await pool.query(
      `SELECT n.ok, n.error_message FROM install_notifications n
       JOIN clinics c ON c.id = n.clinic_id
       WHERE c.name = 'Clínica que dispara el aviso'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].ok).toBe(false); // no hay RESEND_API_KEY en las pruebas
    expect(rows[0].error_message).toMatch(/RESEND_API_KEY/);
  });

  it('listClinicsWithLicenses expone el plazo automático efectivo aunque nunca se haya marcado a mano', async () => {
    const result = await registerNewClinic({ clinicName: 'Clínica listada' });
    const { rows: licenseRows } = await pool.query('SELECT issued_at FROM licenses WHERE license_key = $1', [result.licenseKey]);
    const issuedAtMs = new Date(licenseRows[0].issued_at).getTime();

    const clinics = await service.listClinicsWithLicenses();
    const found = clinics.find((c) => c.name === 'Clínica listada');
    expect(found).toBeDefined();
    expect(found!.license).not.toBeNull();
    expect(found!.license!.requires_license_at).toBeNull(); // nunca se marcó a mano
    expect(found!.license!.effectiveTrialDays).toBe(60);
    expect(found!.license!.effectiveRequiresLicenseAt).not.toBeNull();

    const expectedMs = issuedAtMs + (60 - 7) * DAY_MS;
    expect(Math.abs(new Date(found!.license!.effectiveRequiresLicenseAt as string).getTime() - expectedMs)).toBeLessThan(5000);
  });

  it('un segundo equipo que se une a una clínica existente NO dispara un segundo aviso al creador', async () => {
    await registerNewClinic({ clinicName: 'Clínica sin aviso duplicado', hwid: 'HWID-UNO-B' });
    await new Promise((resolve) => setTimeout(resolve, 200));

    await service.registerTrial({
      clinicName: 'Clínica sin aviso duplicado',
      contactEmail: 'contacto@clinica-test.com',
      hwid: 'HWID-DOS-B',
      deviceName: 'PC 2',
    });
    await new Promise((resolve) => setTimeout(resolve, 200));

    const { rows } = await pool.query(
      `SELECT count(*)::int AS count FROM install_notifications n
       JOIN clinics c ON c.id = n.clinic_id
       WHERE c.name = 'Clínica sin aviso duplicado'`,
    );
    expect(rows[0].count).toBe(1);
  });
});
