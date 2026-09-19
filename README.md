# VetCore — Backend de licenciamiento (Fase 4)

Backend en la nube (Node.js + NestJS + PostgreSQL) que activa y valida las licencias de las instalaciones de VetCore, e incluye el panel de administración (servido como archivos estáticos en `/panel`).

Hay dos guías de despliegue, según dónde quieras que viva esto:

- `../DESPLIEGUE_FASE4.md` — publicarlo en Railway ($5 USD/mes, siempre encendido, cero mantenimiento).
- `../DESPLIEGUE_FASE4_NAS.md` — publicarlo gratis en tu propio NAS Synology, con un túnel de Cloudflare.

## Desarrollo local

Requiere Node.js 22+ y una base PostgreSQL local (o cualquier `DATABASE_URL` a la que tengas acceso).

```bash
npm install
cp .env.example .env   # y llena los valores — ver más abajo
npm run build
npm run start:prod
```

Las migraciones (`src/db/migrations/*.sql`) se aplican solas al arrancar; no hay que correr nada aparte.

### Variables de entorno (`.env`)

- `DATABASE_URL` — cadena de conexión a PostgreSQL.
- `LICENSE_SIGNING_SECRET_KEY` — llave privada Ed25519 que firma los tokens de licencia. Generar una con `node scripts/generate-signing-key.mjs` (una distinta para desarrollo y para producción — nunca reutilizar la de pruebas).
- `ADMIN_JWT_SECRET` — secreto para las sesiones del panel de administración.
- `ADMIN_BOOTSTRAP_EMAIL` / `ADMIN_BOOTSTRAP_PASSWORD` — si no hay ningún administrador registrado todavía, el backend crea uno con estos datos al arrancar (una sola vez).
- `PORT` — puerto HTTP (por defecto 3000).

## Endpoints

Cara pública (la llama la app de escritorio):

- `POST /v1/activate` — primer arranque de un equipo.
- `POST /v1/heartbeat` — renovación periódica del token.
- `POST /v1/branch-bundle` — solo para el equipo "principal" de una sucursal, alimenta su sidecar de red local.

Panel de administración (requiere sesión, `POST /admin/auth/login` primero):

- `GET/POST /admin/clinics`, `PATCH /admin/licenses/:id`
- `GET /admin/devices`, `POST /admin/devices/:id/approve`, `POST /admin/devices/:id/revoke`

El panel en sí (React ya compilado) se sirve en `/panel`.

## Actualizar el panel de administración

Si se modifica el código en `../admin-panel`, hay que reconstruirlo y volver a copiarlo aquí:

```bash
cd ../admin-panel && npm run build
rm -rf ../backend/public/panel
cp -r dist ../backend/public/panel
```
