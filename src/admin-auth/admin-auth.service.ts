import { Inject, Injectable, Logger, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import type { Pool } from 'pg';
import { PG_POOL } from '../db/db.module.js';

interface AdminRow {
  id: number;
  email: string;
  password_hash: string;
}

/**
 * Autenticación del panel de administración (tú, el dueño del negocio —
 * no confundir con los usuarios de cada clínica, que viven en la base
 * local de cada instalación). Un solo rol de administrador por ahora.
 */
@Injectable()
export class AdminAuthService implements OnModuleInit {
  private readonly logger = new Logger(AdminAuthService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit() {
    const { rows } = await this.pool.query<{ count: string }>('SELECT count(*)::text FROM admin_users');
    if (Number(rows[0].count) > 0) return;

    const email = this.config.get<string>('ADMIN_BOOTSTRAP_EMAIL');
    const password = this.config.get<string>('ADMIN_BOOTSTRAP_PASSWORD');
    if (!email || !password) {
      this.logger.warn(
        'No hay administradores registrados y no se configuraron ADMIN_BOOTSTRAP_EMAIL / ADMIN_BOOTSTRAP_PASSWORD. ' +
          'El panel de administración quedará inaccesible hasta que se cree un administrador.',
      );
      return;
    }
    const hash = await argon2.hash(password);
    await this.pool.query('INSERT INTO admin_users (email, password_hash) VALUES ($1, $2)', [email, hash]);
    this.logger.log(`Administrador inicial creado: ${email}`);
  }

  async login(email: string, password: string): Promise<{ accessToken: string }> {
    const { rows } = await this.pool.query<AdminRow>('SELECT id, email, password_hash FROM admin_users WHERE email = $1', [email]);
    const admin = rows[0];
    if (!admin) throw new UnauthorizedException('Correo o contraseña incorrectos');

    const valid = await argon2.verify(admin.password_hash, password);
    if (!valid) throw new UnauthorizedException('Correo o contraseña incorrectos');

    const accessToken = await this.jwt.signAsync({ sub: admin.id, email: admin.email });
    return { accessToken };
  }
}
