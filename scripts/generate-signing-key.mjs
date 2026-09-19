// Genera un par de llaves Ed25519 nuevo para firmar tokens de licencia.
// Ejecutar UNA SOLA VEZ por ambiente (una vez en desarrollo, otra distinta
// al desplegar a producción) y guardar la llave privada como variable de
// entorno LICENSE_SIGNING_SECRET_KEY — nunca en el repositorio.
//
// Uso: node scripts/generate-signing-key.mjs
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';

ed.hashes.sha512 = sha512;

const { secretKey, publicKey } = ed.keygen();

console.log('LICENSE_SIGNING_SECRET_KEY (privada — va en el backend, NUNCA se comparte):');
console.log(Buffer.from(secretKey).toString('base64'));
console.log('');
console.log('Llave pública (esta SÍ se incrusta en el código Rust de la app de escritorio):');
console.log(Buffer.from(publicKey).toString('base64'));
