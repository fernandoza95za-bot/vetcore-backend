import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ServeStaticModule } from '@nestjs/serve-static';
import { AdminAuthModule } from './admin-auth/admin-auth.module.js';
import { DbModule } from './db/db.module.js';
import { LicensingModule } from './licensing/licensing.module.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // El panel de administración (React, ya compilado) vive como archivos
    // estáticos servidos por este mismo backend en /panel — así solo hay
    // que desplegar un servicio en Railway, no dos.
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'public', 'panel'),
      serveRoot: '/panel',
      exclude: ['/admin/{*splat}', '/v1/{*splat}'],
    }),
    DbModule,
    AdminAuthModule,
    LicensingModule,
  ],
})
export class AppModule {}
