-- Días de prueba configurables + aviso por correo al creador (Fase 4c).
--
-- Hasta ahora "requires_license_at" solo se ponía a mano, desde el panel.
-- Esta migración no cambia ese mecanismo: sigue existiendo tal cual, para
-- cuando el dueño quiera marcar una clínica manualmente. Lo que se agrega es
-- un plazo AUTOMÁTICO por clínica: `trial_days` (NULL = usar el valor global
-- de `app_settings.default_trial_days`, 60 por defecto). El cálculo del
-- plazo automático vive en LicensingService (no en la base de datos): se
-- deriva de `issued_at + trial_days` y nunca se guarda como tal, así que no
-- hace falta ninguna columna adicional para eso — ver
-- `effectiveRequiresLicenseAt` en licensing.service.ts.

ALTER TABLE licenses ADD COLUMN IF NOT EXISTS trial_days INTEGER;

-- Configuración global del negocio (por ahora solo el default de días de
-- prueba, pero sirve como lugar único para cualquier otro ajuste global
-- futuro sin tener que seguir agregando columnas sueltas a `licenses`).
CREATE TABLE IF NOT EXISTS app_settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO app_settings (key, value) VALUES ('default_trial_days', '60')
ON CONFLICT (key) DO NOTHING;

-- Bitácora de los avisos por correo al creador cuando se registra una
-- clínica nueva (ver CreatorNotifierService) — sirve para poder revisar
-- después si algún aviso falló (por ejemplo, por no tener configurada
-- RESEND_API_KEY), sin que eso nunca le impida a la clínica seguir
-- registrándose y usando la app con normalidad.
CREATE TABLE IF NOT EXISTS install_notifications (
    id             SERIAL PRIMARY KEY,
    clinic_id      INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
    notified_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    ok             BOOLEAN NOT NULL,
    error_message  TEXT
);

CREATE INDEX IF NOT EXISTS idx_install_notifications_clinic ON install_notifications(clinic_id);
