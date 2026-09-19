import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';
import { PG_POOL } from '../db/db.module.js';
import type { ClinicRow } from './licensing.service.js';

const CREATOR_NOTIFY_EMAIL = 'albertobarraza3@gmail.com';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

/**
 * Avisa por correo al creador de VetCore cada vez que se registra una
 * clínica nueva (ver LicensingService.registerTrial). Usa Resend (resend.com)
 * por HTTP directo, igual patrón que el envío de avisos a clientes del lado
 * de la app de escritorio (`app/src-tauri/src/messaging/channels`). Si no
 * hay `RESEND_API_KEY` configurada, no revienta nada: solo deja constancia
 * en `install_notifications` de que no se pudo enviar, y el registro de la
 * clínica sigue su curso con total normalidad.
 */
@Injectable()
export class CreatorNotifierService {
  private readonly logger = new Logger(CreatorNotifierService.name);

  constructor(
    private readonly config: ConfigService,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  async notifyNewInstall(clinic: ClinicRow): Promise<void> {
    const apiKey = this.config.get<string>('RESEND_API_KEY');
    let ok = false;
    let errorMessage: string | null = null;

    if (!apiKey) {
      errorMessage = 'RESEND_API_KEY no está configurada; no se envió el aviso por correo.';
      this.logger.warn(errorMessage);
    } else {
      try {
        const from = this.config.get<string>('RESEND_FROM_ADDRESS') ?? 'VetCore <onboarding@resend.dev>';
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from,
            to: [CREATOR_NOTIFY_EMAIL],
            subject: `Nueva instalación de VetCore: ${clinic.name}`,
            html: `
              <p>Se registró una nueva instalación de VetCore.</p>
              <ul>
                <li><strong>Clínica:</strong> ${escapeHtml(clinic.name)}</li>
                <li><strong>Contacto:</strong> ${escapeHtml(clinic.contact_name ?? '—')}</li>
                <li><strong>Correo:</strong> ${escapeHtml(clinic.contact_email ?? '—')}</li>
                <li><strong>Teléfono:</strong> ${escapeHtml(clinic.contact_phone ?? '—')}</li>
              </ul>
            `,
          }),
        });
        ok = res.ok;
        if (!ok) {
          errorMessage = `Resend respondió ${res.status}: ${await res.text()}`;
          this.logger.warn(errorMessage);
        }
      } catch (err) {
        errorMessage = err instanceof Error ? err.message : String(err);
        this.logger.warn(`No se pudo enviar el aviso de instalación nueva: ${errorMessage}`);
      }
    }

    try {
      await this.pool.query('INSERT INTO install_notifications (clinic_id, ok, error_message) VALUES ($1, $2, $3)', [
        clinic.id,
        ok,
        errorMessage,
      ]);
    } catch (err) {
      this.logger.warn(`No se pudo dejar constancia del aviso de instalación: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
