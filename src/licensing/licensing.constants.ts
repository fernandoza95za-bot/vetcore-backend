/**
 * Duración de los tokens firmados que la app guarda localmente y verifica
 * sin depender de la nube. Un token vencido no bloquea la app de inmediato:
 * el cliente Rust todavía permite un "periodo de gracia" adicional sin
 * internet (ver src-tauri/src/licensing/token.rs), pero pasado ese periodo
 * si no logró renovar el token, bloquea el uso.
 *
 * SaaS tiene una ventana más corta porque queremos que un pago vencido se
 * refleje relativamente pronto; de por vida es más generosa porque no hay
 * nada que revisar salvo revocación manual.
 */
export const SAAS_TOKEN_TTL_HOURS = 72; // 3 días
export const LIFETIME_TOKEN_TTL_HOURS = 24 * 14; // 14 días
// La prueba gratuita no tiene un pago que vencer, así que se le da la misma
// ventana generosa que a "de por vida" — ver TRIAL_GRACE_DAYS en
// app/src-tauri/src/licensing/mod.rs (el periodo sin internet que tolera).
export const TRIAL_TOKEN_TTL_HOURS = 24 * 14; // 14 días

/**
 * Cuántos dispositivos puede registrar libremente una misma clínica
 * mientras está en modo de prueba, sin que el dueño tenga que aprobar nada
 * (ver LicensingService.registerTrial). Es un tope de sensatez, no una
 * limitación pensada para estorbar — una clínica real rara vez lo alcanza.
 */
export const TRIAL_DEFAULT_MAX_DEVICES = 15;

/**
 * Días entre que el dueño marca, desde el panel, que una clínica en modo de
 * prueba ya necesita una licencia real (`licenses.requires_license_at`) y el
 * momento en que la app deja de funcionar. Durante esta ventana la app sigue
 * funcionando normal, solo muestra un aviso. Debe coincidir con
 * `TRIAL_WARNING_DAYS` en `app/src-tauri/src/licensing/mod.rs`, porque ambos
 * lados calculan el mismo plazo de forma independiente (el cliente Rust lo
 * hace también sin conexión, a partir de la fecha ya firmada en el token).
 */
export const TRIAL_WARNING_DAYS = 7;

/**
 * Cuántos días dura la prueba de una clínica nueva cuando nadie ha
 * configurado nada todavía — el valor real y editable vive en
 * `app_settings.default_trial_days` (ver migración 0003 y
 * `LicensingService.getDefaultTrialDays`); esto solo es la red de
 * seguridad por si esa fila llegara a faltar. También se puede dar un
 * valor distinto por clínica (`licenses.trial_days`), que manda sobre el
 * global cuando está puesto.
 */
export const DEFAULT_TRIAL_DAYS_FALLBACK = 60;
