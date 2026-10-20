// Portal de Control - Combuses: configuración.
// La misma base de Supabase que la aplicación del conductor. La llave es la
// pública (la de todo navegador): lo que cada quien puede ver o corregir lo
// deciden las reglas de la base con la cuenta con que entra
// (almacentro/enturnes/sql/tarjeta_despacho.sql).
window.CONTROL_CONFIG = {
  VERSION: "v0.17.0",
  SUPABASE_URL: "https://cbplebkmxrkaafqdhiyi.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_DZCceNTENY4ViP17-eZrGg_bdMElZ9X",

  // El día de la tarjeta es el de la empresa: de las 2:30 a. m. a las 2:30 a. m. del día siguiente
  // (en minutos desde la medianoche). Tiene que ser el mismo del programa que publica la tarjeta.
  DIA_EMPIEZA_MIN: 150,

  // Más de esto en un informe es mucho para el navegador (un mes de toda la flota son ~20.000 viajes).
  INFORME_MAX_DIAS: 93,
  // Con el día de hoy a la vista se vuelve a pedir cada 2 minutos.
  REFRESCO_MS: 2 * 60 * 1000,
  // Cada cuánto se pregunta si hay una versión nueva publicada (también al volver a la pestaña).
  ACTUALIZACION_VERIFICAR_MS: 30 * 60 * 1000,
};
