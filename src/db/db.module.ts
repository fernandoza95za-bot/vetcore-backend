import { Global, Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { runMigrations } from './migrator.js';

export const PG_POOL = 'PG_POOL';

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        return new Pool({
          connectionString: config.getOrThrow<string>('DATABASE_URL'),
        });
      },
    },
  ],
  exports: [PG_POOL],
})
export class DbModule implements OnModuleInit {
  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    const pool = new Pool({ connectionString: this.config.getOrThrow<string>('DATABASE_URL') });
    try {
      await runMigrations(pool);
    } finally {
      await pool.end();
    }
  }
}
