-- Registro silencioso de prueba (Fase 4b).
--
-- Permite que una clínica instale VetCore y empiece a usarlo sin pedirle
-- ninguna clave de licencia: el propio backend crea la clínica y una
-- licencia de tipo 'trial' la primera vez que un equipo se registra, y
-- cualquier otro equipo de la misma clínica se une a esa misma prueba
-- (identificándola por su correo/teléfono de contacto) sin necesitar
-- aprobación manual. El dueño del negocio decide, desde el panel y en
-- cualquier momento, marcar una clínica en prueba como "necesita licencia":
-- eso guarda la fecha en `requires_license_at` y, a partir de ahí, la app ya
-- instalada muestra un aviso durante unos días antes de bloquearse (ver
-- `backend/src/licensing/licensing.constants.ts` y
-- `app/src-tauri/src/licensing/mod.rs`).

ALTER TABLE clinics ADD COLUMN IF NOT EXISTS contact_name TEXT;

ALTER TABLE licenses DROP CONSTRAINT IF EXISTS licenses_license_type_check;
ALTER TABLE licenses ADD CONSTRAINT licenses_license_type_check
  CHECK (license_type IN ('saas', 'lifetime', 'trial'));

ALTER TABLE licenses ADD COLUMN IF NOT EXISTS requires_license_at TIMESTAMPTZ;

-- Encontrar rápido la clínica en prueba con la que "emparejar" un equipo
-- nuevo por su correo/teléfono de contacto (ver LicensingService.registerTrial).
CREATE INDEX IF NOT EXISTS idx_clinics_contact_email ON clinics (lower(contact_email));
CREATE INDEX IF NOT EXISTS idx_clinics_contact_phone ON clinics (contact_phone);
