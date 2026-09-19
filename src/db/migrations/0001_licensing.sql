-- Esquema base de licenciamiento (Fase 4).
--
-- Esta base de datos vive en la nube (separada de la base local SQLite de
-- cada clínica) y es la única fuente de verdad sobre qué clínicas tienen
-- licencia activa y qué computadoras están autorizadas a usarla. La app de
-- escritorio nunca escribe aquí directamente: solo llama a los endpoints
-- de activación/heartbeat, y el panel de administración es el único que
-- puede aprobar o revocar dispositivos.

CREATE TABLE IF NOT EXISTS admin_users (
    id            SERIAL PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS clinics (
    id            SERIAL PRIMARY KEY,
    name          TEXT NOT NULL,
    contact_email TEXT,
    contact_phone TEXT,
    notes         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Una licencia por clínica (si más adelante una clínica necesita más de una
-- licencia -por ejemplo, para renegociar términos- se puede permitir varias
-- filas; por ahora el flujo de administración asume una vigente a la vez).
CREATE TABLE IF NOT EXISTS licenses (
    id            SERIAL PRIMARY KEY,
    clinic_id     INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
    license_type  TEXT NOT NULL CHECK (license_type IN ('saas', 'lifetime')),
    status        TEXT NOT NULL DEFAULT 'activa' CHECK (status IN ('activa', 'suspendida', 'cancelada')),
    max_devices   INTEGER NOT NULL DEFAULT 3,
    license_key   TEXT NOT NULL UNIQUE,
    -- Para 'saas': fecha hasta la que está pagada (el dueño la actualiza manualmente
    -- en el panel cada que se renueva el pago, hasta que exista pasarela automática).
    -- Para 'lifetime': normalmente NULL (no vence).
    paid_through  TIMESTAMPTZ,
    issued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_licenses_clinic ON licenses(clinic_id);

-- Dispositivo físico (una computadora con VetCore instalado). hwid_hash es
-- el resultado de combinar varias señales de hardware y hashearlas en Rust
-- (ver src-tauri/src/licensing/hwid.rs) — nunca guardamos identificadores
-- de hardware en crudo, solo el hash.
CREATE TABLE IF NOT EXISTS authorized_devices (
    id            SERIAL PRIMARY KEY,
    license_id    INTEGER NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
    hwid_hash     TEXT NOT NULL UNIQUE,
    device_name   TEXT NOT NULL,
    branch_label  TEXT,
    -- 'principal': el equipo que además corre el sidecar de servidor local
    -- para la sucursal (modo LAN); 'secundario': los demás equipos.
    device_role   TEXT NOT NULL DEFAULT 'secundario' CHECK (device_role IN ('principal', 'secundario')),
    status        TEXT NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente', 'aprobado', 'revocado')),
    requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    approved_at   TIMESTAMPTZ,
    approved_by   TEXT,
    last_seen_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_devices_license ON authorized_devices(license_id);
CREATE INDEX IF NOT EXISTS idx_devices_status ON authorized_devices(status);
