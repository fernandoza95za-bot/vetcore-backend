import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';

ed.hashes.sha512 = sha512;

export interface TokenPayload {
  /** hash del hardware del dispositivo (nunca el identificador crudo) */
  hwid: string;
  clinicId: number;
  licenseId: number;
  deviceId: number;
  licenseType: 'saas' | 'lifetime' | 'trial';
  /** rol del dispositivo dentro de la sucursal: principal corre el sidecar LAN */
  deviceRole: 'principal' | 'secundario';
  issuedAt: number;
  expiresAt: number;
  /**
   * Unix seconds de cuándo el dueño marcó, desde el panel, que esta clínica
   * (en modo de prueba) ya necesita una licencia real — o null si nunca se
   * ha marcado. El cliente Rust calcula solo, a partir de este valor, si
   * debe mostrar un aviso o bloquear, sin depender de volver a preguntarle
   * al servidor (ver TRIAL_WARNING_DAYS en ambos lados).
   */
  requiresLicenseAt: number | null;
}

function base64url(input: Uint8Array): string {
  return Buffer.from(input).toString('base64url');
}

function base64urlToBytes(input: string): Uint8Array {
  return new Uint8Array(Buffer.from(input, 'base64url'));
}

/**
 * Emite y firma los tokens de activación que la app de escritorio guarda
 * localmente y verifica sin depender de la nube (ver
 * src-tauri/src/licensing/token.rs para la contraparte que solo verifica).
 *
 * Formato: "<payload-base64url>.<firma-base64url>" — deliberadamente más
 * simple que un JWT completo porque solo hay un algoritmo posible (Ed25519)
 * y no necesitamos negociar nada.
 */
@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);
  private readonly secretKey: Uint8Array;
  public readonly publicKeyBase64: string;

  constructor(config: ConfigService) {
    const secretB64 = config.getOrThrow<string>('LICENSE_SIGNING_SECRET_KEY');
    this.secretKey = new Uint8Array(Buffer.from(secretB64, 'base64'));
    const publicKey = ed.getPublicKey(this.secretKey);
    this.publicKeyBase64 = Buffer.from(publicKey).toString('base64');
    this.logger.log(`Llave pública de licenciamiento (para incrustar en el cliente Rust): ${this.publicKeyBase64}`);
  }

  sign(payload: TokenPayload): string {
    const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
    const payloadB64 = base64url(payloadBytes);
    const signature = ed.sign(new TextEncoder().encode(payloadB64), this.secretKey);
    return `${payloadB64}.${base64url(signature)}`;
  }

  /** Solo para pruebas/depuración del backend; el cliente Rust hace su propia verificación. */
  verify(token: string): TokenPayload | null {
    const [payloadB64, sigB64] = token.split('.');
    if (!payloadB64 || !sigB64) return null;
    try {
      const ok = ed.verify(base64urlToBytes(sigB64), new TextEncoder().encode(payloadB64), ed.getPublicKey(this.secretKey));
      if (!ok) return null;
      return JSON.parse(Buffer.from(base64urlToBytes(payloadB64)).toString('utf8')) as TokenPayload;
    } catch {
      return null;
    }
  }
}
