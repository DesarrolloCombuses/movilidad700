/* ==========================================================================
   Portal de Control - Combuses

   Para las personas de control: las tarjetas de despacho de todos los buses,
   lo que dijo cada conductor contra lo que contó el sensor, la plata de cada
   viaje, y los informes por fechas.

   Todo sale de Supabase (almacentro/enturnes/sql/tarjeta_despacho.sql):
     v_tarjeta_viajes          un renglón por viaje, con todo junto
     tarjeta_viajes            el detalle de cada apertura de puerta
     civica_lecturas, tarjeta_pasajeros_conductor, tarjeta_tiquetes
                               lo que escribió el conductor y sus correcciones
     civica_danos              los daños del validador, con foto
     tarjeta_viajes_manual     control y observaciones de cada viaje
     tarjeta_dia_manual        despachadores del día
   Corregir, aprobar y escribir solo lo puede una cuenta que esté en
   tarjeta_revisores: lo dice Supabase, no esta página. Nada se borra: una
   corrección es otro renglón con quién, cuándo y por qué.
   ========================================================================== */
(function () {
  "use strict";

  var cfg = window.CONTROL_CONFIG;
  if (!cfg || !window.supabase) {
    document.body.innerHTML = '<p class="caja-error" style="margin:24px">No cargó la página completa. Revise la conexión y recargue.</p>';
    return;
  }
  var client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: "control-combuses-sesion" },
  });

  var ZONA = "America/Bogota";
  var HORA_MS = 3600 * 1000;

  var CAMPOS_VIAJE = [
    "clave", "dia", "interno", "placa", "viaje", "sin_despacho", "salio_cancelado", "hora_salida", "llego_en",
    "ruta", "itinerario", "punto_salida", "punto_llegada", "conductor", "pasajeros", "pasajeros_sensor", "subidas", "recortados", "estado_calculo",
    "civica_lectura", "civicas", "estado_civica", "lectura_corregida", "dano_id", "dano_estado",
    "tiquetes_escaneados", "tiquetes_corregidos", "control", "observaciones",
    "pasajeros_conductor", "pasajeros_conductor_corregidos", "pasajeros_conductor_en", "diferencia_con_sensor",
    "tarifa", "plata_conductor", "plata_sensor", "diferencia_plata",
  ].join(",");

  var CAMPOS_REGISTRO = "id,clave_viaje,dia,interno,cedula,nombre,origen,corrige_a,motivo,escrita_por_correo,escrita_en";

  // Lo que el conductor escribe en cada despacho, y dónde se guarda.
  var TIPOS = {
    civica: { nombre: "Cívica", que: "la cívica", tabla: "civica_lecturas", columna: "lectura", largo: 9, etiqueta: "Número del validador" },
    pasajeros: { nombre: "Pasajeros que dice el conductor", que: "los pasajeros del conductor", tabla: "tarjeta_pasajeros_conductor", columna: "cantidad", largo: 2, etiqueta: "Pasajeros" },
    tiquetes: { nombre: "Tiquetes escaneados", que: "los tiquetes", tabla: "tarjeta_tiquetes", columna: "cantidad", largo: 3, etiqueta: "Tiquetes" },
  };

  var ESTADO_CIVICA = {
    ok: ["ok", "Cuadra"],
    pendiente_cierre: ["", "Se completa en el próximo despacho"],
    falta_lectura: ["", "Falta la lectura"],
    falta_lectura_siguiente: ["", "Falta la del viaje siguiente"],
    dano_por_revisar: ["revisa", "Daño por revisar"],
    bajo: ["mal", "El número bajó"],
    salto: ["revisa", "Subió de más"],
  };

  // La base escogida se recuerda en este navegador (la persona de una base casi siempre mira la suya).
  var GUARDAR_BASE = "control-combuses-base";
  function baseGuardada() {
    try { return localStorage.getItem(GUARDAR_BASE) || ""; } catch (_) { return ""; }
  }
  function guardarBase(base) {
    try { if (base) localStorage.setItem(GUARDAR_BASE, base); else localStorage.removeItem(GUARDAR_BASE); } catch (_) {}
  }

  var state = {
    user: null,
    revisor: false,
    vista: null,
    dia: {
      fecha: null, filas: null, error: null, cargando: false, cargadoEn: null, conBases: false,
      filtro: "todos", buscar: "", ruta: "", base: baseGuardada(), orden: { campo: "clave", desc: false },
    },
    bus: {
      interno: null, fecha: null, filas: null, extra: {}, historial: null, danos: [], diaManual: null,
      manualViaje: {}, abiertos: {}, error: null, cargando: false, base: "",
    },
    inf: { desde: null, hasta: null, por: "interno", base: baseGuardada(), filas: null, porBus: null, conBases: false,
      error: null, cargando: false, progreso: 0, orden: null },
    // Gestores (sql v8): sus celulares y lo que el programa decidió de cada código que leyó un conductor
    ges: { fecha: null, lecturas: null, celulares: null, error: null, cargando: false },
    // Movilidad: la Base de datos de Movilidad 2026 (movilidad.sql: ajustes y archivos planos)
    mov: { desde: null, hasta: null, datos: null, filas: null, error: null, cargando: false, resumenAbierto: false,
      entradas: true, salidas: true, tablas: true, cargadoEn: null, armandoExcel: false,
      filtro: { dia: "", base: "", difNeg: false, metro20: false, texto: "", vehiculos: [] } },
    v8: false,
  };

  // ================================================================ utilidades
  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function n(x) { return Number(x) || 0; }

  var fmtFecha = new Intl.DateTimeFormat("en-CA", { timeZone: ZONA, year: "numeric", month: "2-digit", day: "2-digit" });
  var fmtHora = new Intl.DateTimeFormat("es-CO", { timeZone: ZONA, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  var fmtLarga = new Intl.DateTimeFormat("es-CO", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" });
  var fmtMomento = new Intl.DateTimeFormat("es-CO", { timeZone: ZONA, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  var fmtCorta = new Intl.DateTimeFormat("es-CO", { timeZone: "UTC", day: "numeric", month: "short" });

  function fechaDe(ms) { return fmtFecha.format(new Date(ms)); }
  // El día de la tarjeta es el de la empresa: de 2:30 a. m. a 2:30 a. m. del día siguiente
  // (cfg.DIA_EMPIEZA_MIN). A la 1 de la mañana todavía es "ayer".
  var CORTE_MIN = cfg.DIA_EMPIEZA_MIN == null ? 150 : Number(cfg.DIA_EMPIEZA_MIN);
  function diaDeHoy() { return fechaDe(Date.now() - CORTE_MIN * 60 * 1000); }
  function horaDelCorte() {
    var h = Math.floor(CORTE_MIN / 60), m = CORTE_MIN % 60;
    return (h % 12 || 12) + ":" + (m < 10 ? "0" : "") + m + (h < 12 ? " a. m." : " p. m.");
  }
  function textoCorte() { return "de " + horaDelCorte() + " a " + horaDelCorte() + " del día siguiente"; }
  function esFecha(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")); }
  function sumarDias(fecha, dias) {
    var d = new Date(fecha + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + dias);
    return d.toISOString().slice(0, 10);
  }
  function diasEntre(a, b) { return Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / (24 * HORA_MS)); }
  function hora(iso) { return iso ? fmtHora.format(new Date(iso)) : "—"; }
  function momento(iso) { return iso ? fmtMomento.format(new Date(iso)) : ""; }
  function fechaCorta(fecha) { return fmtCorta.format(new Date(fecha + "T12:00:00Z")); }
  function fechaLarga(fecha) {
    var s = fmtLarga.format(new Date(fecha + "T12:00:00Z"));
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function miles(x) { return String(Math.round(Math.abs(x))).replace(/\B(?=(\d{3})+(?!\d))/g, "."); }
  function pesos(x) { return x == null ? "—" : (x < 0 ? "−$" : "$") + miles(x); }
  function pesosDif(x) { return x == null ? "—" : x > 0 ? "+" + pesos(x) : pesos(x); }
  function numDif(x) { return x == null ? "—" : x > 0 ? "+" + x : x < 0 ? "−" + Math.abs(x) : "0"; }
  // Menos que el sensor (puede faltar plata) va en rojo; más, en naranja; igual, en verde.
  function claseDif(x) { return x == null ? "" : x < 0 ? "dif-mal" : x > 0 ? "dif-mas" : "dif-cero"; }

  function capitalizar(s) {
    return String(s || "").toLowerCase().replace(/(^|\s)(\S)/g, function (_, e, l) { return e + l.toUpperCase(); });
  }

  var PALABRAS_RUTA = { tunel: "Túnel", ccsandiego: "CC San Diego", terminalnorte: "Terminal Norte" };
  // "Almacentro-Tunel-Aeropuerto" -> "Almacentro → Túnel → Aeropuerto"
  function rutaLegible(s) {
    var tramos = String(s || "").split(/\s*-\s*/).filter(Boolean);
    if (!tramos.length) return "";
    return tramos.map(function (t) {
      return PALABRAS_RUTA[t.toLowerCase().replace(/\s+/g, "")] || capitalizar(t);
    }).join(" → ");
  }
  // Los nombres de Sonar de los itinerarios que se despachan; se completan con los que traen los viajes.
  var NOMBRES_ITINERARIO = {
    "4500": "Terminalnorte-autopista-aeropuerto", "4501": "Aeropuerto-autopista-terminalnorte",
    "4502": "Nutibara-exposiciones-tunel-aeropuerto", "4503": "Aeropuerto-Tunel-Exposiciones-Nutibara",
    "4504": "ccsandiego-tunel-aeropuerto", "4505": "Almacentro-Tunel-Aeropuerto", "4507": "Aeropuerto - Tunel - ccsandiego",
  };
  function aprenderNombres(filas) {
    (filas || []).forEach(function (f) { if (f.ruta && f.itinerario) NOMBRES_ITINERARIO[f.ruta] = f.itinerario; });
  }
  function nombreItinerario(id) { return rutaLegible(NOMBRES_ITINERARIO[id] || "") || (id ? "Ruta " + id : ""); }
  // Sin despacho, Sonar no dice el itinerario: el viaje a viaje dice cuál se parece (sql v7), y el viaje
  // sigue siendo sin despacho.
  function nombreRuta(f) {
    if (f.sin_despacho) return f.itinerario_estimado ? "Sin despacho · como " + nombreItinerario(f.itinerario_estimado) : "Sin despacho";
    return rutaLegible(f.itinerario) || (f.ruta ? "Ruta " + f.ruta : "Sin itinerario");
  }

  function compararInternos(a, b) {
    var x = parseInt(a, 10), y = parseInt(b, 10);
    if (!isNaN(x) && !isNaN(y) && x !== y) return x - y;
    return String(a).localeCompare(String(b));
  }

  function conTiempo(promesa, ms) {
    return Promise.race([
      promesa,
      new Promise(function (_, no) {
        setTimeout(function () { no(new Error("Supabase no respondió a tiempo")); }, ms || 25000);
      }),
    ]);
  }

  // Supabase entrega de a 1.000 renglones: se piden por tandas.
  async function traerTodo(armar, alAvanzar) {
    var PAGINA = 1000, desde = 0, todo = [];
    for (;;) {
      var res = await conTiempo(armar().range(desde, desde + PAGINA - 1), 40000);
      if (res.error) throw res.error;
      var lote = res.data || [];
      todo = todo.concat(lote);
      if (alAvanzar) alAvanzar(todo.length);
      if (lote.length < PAGINA) return todo;
      desde += PAGINA;
    }
  }

  // ---------------------------------------------------------------- las bases
  // La base de cada bus sale de la programación del día (v_programacion_turnos: fecha, vehiculo,
  // base). Si ese día no estaba programado, toma la última base que tuvo en los 7 días anteriores.
  var SIN_BASE = "Sin base";
  var basesGuardadas = {};          // "desde|hasta" -> { t, promesa de {bus: [[fecha, base], ...]} }

  function nombreBase(b) {
    var t = String(b == null ? "" : b).trim();
    var m = /^base\s*0*(\d+)$/i.exec(t);
    return m ? "Base " + m[1] : capitalizar(t);
  }

  function compararBases(a, b) {
    if (a === SIN_BASE || b === SIN_BASE) return (a === SIN_BASE) - (b === SIN_BASE);
    return String(a).localeCompare(String(b), "es", { numeric: true });
  }

  function traerBases(desde, hasta) {
    var k = desde + "|" + hasta;
    var g = basesGuardadas[k];
    if (g && Date.now() - g.t < 30 * 60 * 1000) return g.promesa;
    var promesa = traerTodo(function () {
      return client.from("v_programacion_turnos").select("fecha,vehiculo,base")
        .gte("fecha", sumarDias(desde, -7)).lte("fecha", hasta).order("fecha").order("vehiculo");
    }).then(function (filas) {
      var porBus = {};
      filas.forEach(function (x) {
        var bus = String(x.vehiculo == null ? "" : x.vehiculo).trim();
        if (!bus || !x.base) return;
        var lista = porBus[bus] || (porBus[bus] = []);
        if (!lista.length || lista[lista.length - 1][0] !== x.fecha) lista.push([x.fecha, nombreBase(x.base)]);
      });
      return porBus;
    });
    promesa.catch(function () { delete basesGuardadas[k]; });
    basesGuardadas[k] = { t: Date.now(), promesa: promesa };
    return promesa;
  }

  // La base de ese bus ese día ("" si no se pudo leer la programación).
  function baseEn(porBus, interno, dia) {
    if (!porBus) return "";
    var lista = porBus[String(interno == null ? "" : interno).trim()] || [];
    var base = "";
    for (var i = 0; i < lista.length && lista[i][0] <= dia; i++) base = lista[i][1];
    return base || SIN_BASE;
  }

  function ponerBases(filas, porBus) {
    filas.forEach(function (f) { f.base = baseEn(porBus, f.interno, f.dia); });
  }

  function opcionesBases(sel, filas, elegida) {
    var cuantos = {};
    filas.forEach(function (f) { (cuantos[f.base] || (cuantos[f.base] = {}))[f.interno] = 1; });
    sel.innerHTML = '<option value="">Todas las bases</option>' + Object.keys(cuantos).sort(compararBases).map(function (b) {
      var nb = Object.keys(cuantos[b]).length;
      return '<option value="' + esc(b) + '">' + esc(b + " · " + nb + (nb === 1 ? " bus" : " buses")) + "</option>";
    }).join("");
    sel.value = cuantos[elegida] ? elegida : "";
    return sel.value;
  }

  function textoError(err) {
    var m = (err && (err.message || err.error_description)) || String(err || "");
    if (err && err.code === "42501") return "Esta cuenta no tiene permiso para eso.";
    if (err && err.code === "23505") return "Alguien ya lo guardó o lo corrigió mientras tanto. Se recargó la tarjeta: revise y vuelva a intentar.";
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return "No hay conexión con Supabase. Revise el internet.";
    if (/JWT expired/i.test(m)) return "La sesión venció. Salga y vuelva a entrar.";
    return m || "Algo salió mal.";
  }

  var avisoTimer = null;
  function aviso(texto, tono) {
    var box = $("aviso");
    box.textContent = texto;
    box.setAttribute("data-tono", tono || "");
    box.hidden = false;
    clearTimeout(avisoTimer);
    avisoTimer = setTimeout(function () { box.hidden = true; }, tono === "mal" ? 7000 : 3500);
  }

  function chip(tono, texto) { return '<span class="chip" data-tono="' + (tono || "") + '">' + esc(texto) + "</span>"; }

  function cajaError(texto, accion) {
    return '<div class="caja-error">' + esc(texto) +
      (accion ? '<button class="btn btn-chico" type="button" data-accion="' + accion + '">Reintentar</button>' : "") + "</div>";
  }

  // ================================================================ la hoja (ventana encima)
  var alCerrarHoja = null;
  function abrirHoja(titulo, html, alAbrir) {
    $("hojaTitulo").textContent = titulo;
    $("hojaCuerpo").innerHTML = html;
    $("hoja").hidden = false;
    if (alAbrir) alAbrir($("hojaCuerpo"));
    var primero = $("hojaCuerpo").querySelector("input, textarea, select, button");
    if (primero) primero.focus();
  }
  function cerrarHoja() {
    $("hoja").hidden = true;
    $("hojaCuerpo").innerHTML = "";
    if (alCerrarHoja) { alCerrarHoja(); alCerrarHoja = null; }
  }

  // ================================================================ entrar y salir
  function mostrarEntrar() {
    state.user = null;
    $("app").hidden = true;
    $("vistaEntrar").hidden = false;
    $("btnEntrar").disabled = false;
    setTimeout(function () { $("entrarCorreo").focus(); }, 0);
  }

  async function entrar(user) {
    state.user = user;
    $("quienCorreo").textContent = user.email || "";
    $("vistaEntrar").hidden = true;
    $("app").hidden = false;
    // ¿Puede corregir? Lo dice la base (tarjeta_revisores).
    state.revisor = false;
    try {
      var r = await conTiempo(client.rpc("tarjeta_es_revisor"), 15000);
      state.revisor = r.data === true;
    } catch (_) { /* queda en solo lectura */ }
    // ¿Ya corrieron la v7 del SQL? Con ella llega el itinerario estimado de los viajes sin despacho.
    try {
      var v7 = await conTiempo(client.from("v_tarjeta_viajes").select("itinerario_estimado").limit(1), 15000);
      if (!v7.error && CAMPOS_VIAJE.indexOf("itinerario_estimado") < 0) CAMPOS_VIAJE += ",itinerario_estimado";
    } catch (_) { /* sin la v7: los sin despacho salen sin itinerario */ }
    // ¿Y la v8? Con ella llegan los gestores que se restaron de cada viaje.
    try {
      var v8 = await conTiempo(client.from("v_tarjeta_viajes").select("gestores").limit(1), 15000);
      state.v8 = !v8.error;
      if (state.v8 && CAMPOS_VIAJE.indexOf(",gestores") < 0) CAMPOS_VIAJE += ",gestores";
    } catch (_) { state.v8 = false; }
    var rol = $("quienRol");
    rol.textContent = state.revisor ? "Puede corregir" : "Solo lectura";
    rol.setAttribute("data-tono", state.revisor ? "ok" : "revisa");
    rol.title = state.revisor
      ? "Esta cuenta está en tarjeta_revisores: puede corregir, aprobar daños y escribir control."
      : "Esta cuenta puede ver todo, pero no corregir. Para corregir, hay que agregarla a tarjeta_revisores en Supabase.";
    enrutar();
  }

  async function alEntrar(ev) {
    ev.preventDefault();
    var correo = $("entrarCorreo").value.trim();
    var clave = $("entrarClave").value;
    var error = $("entrarError");
    error.hidden = true;
    if (!correo || !clave) {
      error.textContent = "Escriba el correo y la clave.";
      error.hidden = false;
      return;
    }
    $("btnEntrar").disabled = true;
    $("btnEntrar").textContent = "Entrando…";
    try {
      var res = await conTiempo(client.auth.signInWithPassword({ email: correo, password: clave }), 20000);
      if (res.error) throw res.error;
      $("entrarClave").value = "";
      await entrar(res.data.user);
    } catch (err) {
      error.textContent = /invalid login credentials/i.test(err && err.message) ? "El correo o la clave no son correctos." : textoError(err);
      error.hidden = false;
    } finally {
      $("btnEntrar").disabled = false;
      $("btnEntrar").textContent = "Entrar";
    }
  }

  // ================================================================ las secciones (#/dia, #/bus, #/informes)
  function enrutar() {
    if (!state.user) return;
    var partes = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
    var vista = ["dia", "bus", "informes", "movilidad", "gestores"].indexOf(partes[0]) >= 0 ? partes[0] : "dia";
    mostrarVista(vista);
    if (vista === "dia") {
      abrirDia(esFecha(partes[1]) ? partes[1] : state.dia.fecha || diaDeHoy());
    } else if (vista === "bus") {
      abrirBus(partes[1] || state.bus.interno, esFecha(partes[2]) ? partes[2] : state.bus.fecha || state.dia.fecha || diaDeHoy());
    } else if (vista === "gestores") {
      abrirGestores(esFecha(partes[1]) ? partes[1] : state.ges.fecha || state.dia.fecha || diaDeHoy());
    } else if (vista === "movilidad") {
      // Sin fechas: del primero del mes hasta ayer (los días ya cerrados).
      var hasta = esFecha(partes[2]) ? partes[2] : state.mov.hasta || sumarDias(diaDeHoy(), -1);
      abrirMovilidad(esFecha(partes[1]) ? partes[1] : state.mov.desde || hasta.slice(0, 8) + "01", hasta);
    } else {
      abrirInformes();
    }
  }

  function mostrarVista(vista) {
    state.vista = vista;
    $("vistaDia").hidden = vista !== "dia";
    $("vistaBus").hidden = vista !== "bus";
    $("vistaInformes").hidden = vista !== "informes";
    $("vistaGestores").hidden = vista !== "gestores";
    $("vistaMovilidad").hidden = vista !== "movilidad";
    Array.prototype.forEach.call(document.querySelectorAll("[data-pestana]"), function (a) {
      if (a.getAttribute("data-pestana") === vista) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    actualizarPestanas();
  }

  // Las pestañas recuerdan el día y el bus que se estaban viendo.
  function actualizarPestanas() {
    var dia = document.querySelector('[data-pestana="dia"]');
    var bus = document.querySelector('[data-pestana="bus"]');
    if (state.dia.fecha) dia.href = "#/dia/" + state.dia.fecha;
    if (state.bus.interno) bus.href = "#/bus/" + encodeURIComponent(state.bus.interno) + "/" + state.bus.fecha;
    if (state.ges.fecha) document.querySelector('[data-pestana="gestores"]').href = "#/gestores/" + state.ges.fecha;
    if (state.mov.desde) document.querySelector('[data-pestana="movilidad"]').href = "#/movilidad/" + state.mov.desde + "/" + state.mov.hasta;
  }

  // ================================================================ resumen de un grupo de viajes
  function nuevoResumen(clave) {
    return {
      clave: clave, placa: "", conductores: [], rutas: [], buses: [], dias: [], bases: [],
      viajes: 0, sd: 0, sensor: 0, plataSensor: 0, subidas: 0,
      conductor: 0, plataConductor: 0, escribio: 0, comparados: 0,
      faltaCivica: 0, faltaPasajeros: 0, faltaTiquetes: 0,
      dif: 0, difPlata: 0, noCuadran: 0, civicas: 0, tiquetes: 0,
      revisarCivica: 0, danos: 0, enCurso: 0, corregidos: 0,
      estadoBus: null, avisosBus: 0,     // cómo está el bus (tarjeta_buses_dia) / cuántos buses con aviso
    };
  }

  function agregarUnico(lista, valor) { if (valor && lista.indexOf(valor) < 0) lista.push(valor); }

  function sumarViaje(r, f) {
    r.viajes++;
    if (f.sin_despacho) r.sd++;
    if (f.placa && !r.placa) r.placa = f.placa;
    agregarUnico(r.conductores, f.conductor);
    agregarUnico(r.rutas, f.ruta);
    agregarUnico(r.buses, f.interno);
    agregarUnico(r.dias, f.dia);
    agregarUnico(r.bases, f.base);
    r.sensor += n(f.pasajeros_sensor);
    r.subidas += n(f.subidas);
    r.plataSensor += n(f.plata_sensor);
    if (f.pasajeros_conductor != null) {
      r.escribio++;
      r.conductor += n(f.pasajeros_conductor);
      r.plataConductor += n(f.plata_conductor);
    } else {
      r.faltaPasajeros++;
    }
    if (f.civica_lectura == null) r.faltaCivica++;
    if (f.tiquetes_escaneados == null) r.faltaTiquetes++;
    else r.tiquetes += n(f.tiquetes_escaneados);
    if (f.civicas != null) r.civicas += n(f.civicas);
    if (f.estado_civica === "bajo" || f.estado_civica === "salto") r.revisarCivica++;
    if (f.dano_estado === "reportado") r.danos++;
    if (f.lectura_corregida || f.tiquetes_corregidos || f.pasajeros_conductor_corregidos) r.corregidos++;
    // La diferencia solo cuenta cuando el viaje ya llegó: en camino el sensor todavía puede contar.
    if (f.estado_calculo === "en_curso") {
      r.enCurso++;
    } else if (f.diferencia_con_sensor != null) {
      r.comparados++;
      r.dif += n(f.diferencia_con_sensor);
      r.difPlata += n(f.diferencia_plata);
      if (n(f.diferencia_con_sensor) !== 0) r.noCuadran++;
    }
  }

  function resumir(filas, claveDe) {
    var grupos = {};
    filas.forEach(function (f) {
      var k = claveDe(f);
      sumarViaje(grupos[k] || (grupos[k] = nuevoResumen(k)), f);
    });
    return Object.keys(grupos).map(function (k) { return grupos[k]; });
  }

  // ---------------------------------------------------------------- cómo está cada bus
  // tarjeta_buses_dia: el programa revisa los 51 buses en cada vuelta y dice si alguno dejó de reportar.
  var CAMPOS_ESTADO_BUS = "dia,interno,placa,programado,viajes,pasajeros,aperturas,ultima_puerta,ultimo_gps," +
    "estado,aviso,historial,revisado_en,intento_en";
  var ESTADO_BUS = {
    no_esta_en_sonar: ["mal", "No está en Sonar"],
    sin_gps: ["mal", "No reporta GPS"],
    sin_sensor: ["mal", "Sensor sin datos"],
    sin_viajes: ["revisa", "Programado sin viajes"],
    no_contesto: ["revisa", "Sonar no contestó"],
    descansa: ["", "No programado"],
  };
  var AVISOS_BUS = ["no_esta_en_sonar", "sin_gps", "sin_sensor", "sin_viajes"];
  var REVISION_VIEJA_MS = 15 * 60 * 1000;   // hoy, si el programa no revisa hace esto, se avisa

  function conAviso(e) { return !!e && AVISOS_BUS.indexOf(e.estado) >= 0; }
  // Avisos que tuvo ese día y ya se arreglaron (el historial los guarda).
  function avisosPasados(e) {
    return (e && Array.isArray(e.historial) ? e.historial : []).filter(function (h) { return h && h.hasta; });
  }
  function tieneAvisos(e) { return conAviso(e) || avisosPasados(e).length > 0; }

  function porInterno(lista) {
    var salida = {};
    (lista || []).forEach(function (e) { salida[String(e.interno)] = e; });
    return salida;
  }

  // Lo que pasó en palabras, para la lista de avisos, la tarjeta del bus y el Excel.
  function textoAvisos(e) {
    var partes = [];
    if (conAviso(e) && e.aviso) partes.push(e.aviso);
    avisosPasados(e).forEach(function (h) {
      // el "(hace 70 min)" era de cuando se vio: ya no sirve
      partes.push("Tuvo: " + String(h.aviso || ESTADO_BUS[h.estado] && ESTADO_BUS[h.estado][1] || h.estado)
        .replace(/\s*\(hace [^)]*\)/, "").replace(/\.$/, "") +
        " (visto de " + hora(h.visto) + " a " + hora(h.hasta) + ").");
    });
    return partes.join(" ");
  }

  // Qué tiene ese grupo, en chips: lo más grave primero.
  function chipsEstado(r) {
    var chips = [];
    var eb = r.estadoBus && ESTADO_BUS[r.estadoBus.estado];
    if (eb) chips.push(chip(eb[0], eb[1]));
    else if (r.avisosBus) chips.push(chip("mal", r.avisosBus === 1 ? "1 bus con aviso" : r.avisosBus + " buses con aviso"));
    if (r.estadoBus && !conAviso(r.estadoBus) && avisosPasados(r.estadoBus).length) chips.push(chip("revisa", "Tuvo avisos"));
    if (r.danos) chips.push(chip("revisa", r.danos === 1 ? "Daño por revisar" : r.danos + " daños por revisar"));
    if (r.noCuadran) chips.push(chip("mal", r.noCuadran === 1 ? "1 viaje no cuadra" : r.noCuadran + " viajes no cuadran"));
    if (r.revisarCivica) chips.push(chip("revisa", "Cívica por revisar"));
    var faltas = [];
    if (r.faltaCivica) faltas.push("cívica " + r.faltaCivica);
    if (r.faltaPasajeros) faltas.push("pasajeros " + r.faltaPasajeros);
    if (r.faltaTiquetes) faltas.push("tiquetes " + r.faltaTiquetes);
    if (faltas.length) chips.push(chip("", "Falta " + faltas.join(" · ")));
    if (r.enCurso) chips.push(chip("info", "En camino"));
    if (!chips.length) chips.push(chip("ok", "Completa"));
    return '<div class="chips">' + chips.join("") + "</div>";
  }

  // Para ordenar por estado: lo más grave arriba.
  function gravedad(r) {
    var avisos = conAviso(r.estadoBus) ? 1 : r.avisosBus;
    return avisos * 10000 + r.danos * 1000 + r.noCuadran * 100 + r.revisarCivica * 10 +
      (r.faltaCivica + r.faltaPasajeros + r.faltaTiquetes);
  }

  function celdaDif(r) {
    if (!r.comparados) return '<td class="n">—</td>';
    return '<td class="n"><span class="' + claseDif(r.difPlata) + '">' + pesosDif(r.difPlata) + "</span>" +
      '<span class="menor">' + numDif(r.dif) + " pas.</span></td>";
  }

  function celdasNumeros(r) {
    return '<td class="n">' + r.viajes + (r.sd ? '<span class="menor">' + r.sd + " sin despacho</span>" : "") + "</td>" +
      '<td class="n">' + r.sensor + '<span class="menor">subieron ' + r.subidas + "</span></td>" +
      '<td class="n">' + pesos(r.plataSensor) + "</td>" +
      '<td class="n">' + (r.escribio ? r.conductor : "—") +
        (r.faltaPasajeros ? '<span class="menor">falta en ' + r.faltaPasajeros + "</span>" : "") + "</td>" +
      '<td class="n">' + (r.escribio ? pesos(r.plataConductor) : "—") + "</td>" +
      celdaDif(r) +
      '<td class="n">' + r.civicas + "</td>" +
      '<td class="n">' + r.tiquetes + "</td>";
  }

  function totalesHtml(r, extra) {
    function caja(titulo, grande, chico, tono) {
      return '<div class="total"' + (tono ? ' data-tono="' + tono + '"' : "") + "><span>" + titulo + "</span><strong>" + grande + "</strong>" +
        (chico ? "<small>" + chico + "</small>" : "") + "</div>";
    }
    return (extra || "") +
      caja("Viajes", r.viajes, r.sd ? r.sd + " sin despacho" : "todos con despacho") +
      caja("Según el sensor", pesos(r.plataSensor), r.sensor + " pasajeros") +
      caja("Según los conductores", r.escribio ? pesos(r.plataConductor) : "—",
        r.escribio ? r.conductor + " pasajeros" + (r.faltaPasajeros ? " · faltan " + r.faltaPasajeros + " viajes" : "") : "todavía no han escrito") +
      caja("Diferencia", r.comparados ? pesosDif(r.difPlata) : "—",
        r.comparados ? numDif(r.dif) + " pasajeros · " + (r.noCuadran === 1 ? "1 viaje no cuadra" : r.noCuadran + " viajes no cuadran") : "sin viajes para comparar",
        !r.comparados ? "" : r.difPlata < 0 ? "mal" : r.difPlata > 0 ? "revisa" : "bien") +
      caja("Cívicas", r.civicas, r.faltaCivica ? "falta la lectura en " + r.faltaCivica : "todas leídas") +
      caja("Tiquetes", r.tiquetes, r.faltaTiquetes ? "faltan en " + r.faltaTiquetes + " viajes" : "todos escritos");
  }

  function thOrden(campo, titulo, orden, num) {
    var sort = orden && orden.campo === campo ? (orden.desc ? "descending" : "ascending") : "none";
    return '<th data-orden="' + campo + '" aria-sort="' + sort + '"' + (num ? ' class="n"' : "") + ">" + titulo + "</th>";
  }

  var VALOR_ORDEN = {
    clave: function (r) { return r.clave; },
    conductor: function (r) { return (r.conductores[0] || "").toLowerCase(); },
    viajes: function (r) { return r.viajes; },
    sensor: function (r) { return r.sensor; },
    plataSensor: function (r) { return r.plataSensor; },
    conductorP: function (r) { return r.escribio ? r.conductor : -1; },
    plataConductor: function (r) { return r.escribio ? r.plataConductor : -1; },
    difPlata: function (r) { return r.comparados ? r.difPlata : 0; },
    civicas: function (r) { return r.civicas; },
    tiquetes: function (r) { return r.tiquetes; },
    estado: gravedad,
  };

  function ordenar(lista, orden, claveEsInterno) {
    var valor = VALOR_ORDEN[orden.campo] || VALOR_ORDEN.clave;
    var signo = orden.desc ? -1 : 1;
    return lista.slice().sort(function (a, b) {
      if (orden.campo === "clave" || orden.campo === "interno") {
        return signo * (claveEsInterno ? compararInternos(a.clave, b.clave) : compararBases(a.clave, b.clave));
      }
      var x = valor(a), y = valor(b);
      if (x < y) return -signo;
      if (x > y) return signo;
      return compararInternos(a.clave, b.clave);
    });
  }

  function cambiarOrden(orden, campo) {
    if (orden.campo === campo) {
      orden.desc = !orden.desc;
      return;
    }
    orden.campo = campo;
    // Los números empiezan por el más grande; la diferencia, por la que más falta (la más negativa).
    orden.desc = ["clave", "conductor", "difPlata"].indexOf(campo) < 0;
  }

  // ================================================================ DÍA: todos los buses
  function abrirDia(fecha) {
    var d = state.dia;
    if (d.fecha !== fecha) {
      d.fecha = fecha;
      d.filas = null;
      d.error = null;
    }
    $("diaFecha").value = fecha;
    $("diaSub").textContent = fechaLarga(fecha) + " · " + textoCorte() + (fecha === diaDeHoy() ? " · hoy" : "");
    actualizarPestanas();
    pintarDia();
    if (!d.filas && !d.cargando) cargarDia();
  }

  async function cargarDia() {
    var d = state.dia, fecha = d.fecha;
    d.cargando = true;
    $("diaActualizar").disabled = true;
    if (!d.filas) pintarDia();
    try {
      // Si la programación o el estado de los buses no se pueden leer, el día sale igual, sin eso.
      var bases = traerBases(fecha, fecha).catch(function () { return null; });
      var estados = traerTodo(function () {
        return client.from("tarjeta_buses_dia").select(CAMPOS_ESTADO_BUS).eq("dia", fecha).order("interno");
      }).catch(function () { return null; });
      var filas = await traerTodo(function () {
        return client.from("v_tarjeta_viajes").select(CAMPOS_VIAJE).eq("dia", fecha)
          .order("interno").order("hora_salida").order("clave");
      });
      var porBus = await bases;
      var lista = await estados;
      if (d.fecha !== fecha) return;
      ponerBases(filas, porBus);
      d.conBases = !!porBus;
      d.porBus = porBus;
      d.estados = lista ? porInterno(lista) : null;
      // Los buses que el programa revisó y no tienen viajes también van en la lista: así salen los 51.
      var conViajes = {};
      filas.forEach(function (f) { conViajes[f.interno] = true; });
      d.sinViajes = (lista || []).filter(function (e) { return !conViajes[e.interno]; }).map(function (e) {
        return { interno: String(e.interno), placa: e.placa || "", dia: fecha };
      });
      ponerBases(d.sinViajes, porBus);
      d.filas = filas;
      d.error = null;
      d.cargadoEn = Date.now();
    } catch (err) {
      if (d.fecha === fecha) d.error = err;
    } finally {
      d.cargando = false;
      $("diaActualizar").disabled = false;
      if (state.vista === "dia" && d.fecha === fecha) pintarDia();
    }
  }

  function pasaFiltro(r, d) {
    var f = d.filtro;
    if (f === "no_cuadra" && !r.noCuadran) return false;
    if (f === "revisar" && !(r.danos || r.revisarCivica)) return false;
    if (f === "falta" && !(r.faltaCivica || r.faltaPasajeros || r.faltaTiquetes)) return false;
    if (f === "sin_despacho" && !r.sd) return false;
    if (f === "aviso" && !tieneAvisos(r.estadoBus)) return false;
    if (d.ruta && r.rutas.indexOf(d.ruta) < 0) return false;
    var q = d.buscar.trim().toLowerCase();
    if (q) {
      var texto = [r.clave, r.placa].concat(r.conductores, r.bases).join(" ").toLowerCase();
      if (texto.indexOf(q) < 0) return false;
    }
    return true;
  }

  function pintarDia() {
    var d = state.dia;
    var tabla = $("diaTabla");
    var totales = $("diaTotales");
    $("diaExcel").disabled = !(d.filas && d.filas.length) || !!d.armandoExcel;
    if (!d.filas) {
      totales.innerHTML = "";
      $("diaBases").innerHTML = "";
      $("diaAvisos").innerHTML = "";
      tabla.innerHTML = d.error ? cajaError("No se pudo traer el día: " + textoError(d.error), "recargar-dia")
        : '<p class="cargando">Trayendo las tarjetas del día…</p>';
      $("diaPie").textContent = "";
      return;
    }
    // La base escogida: los totales de arriba y la lista son solo de esa base.
    var selBase = $("diaBase");
    selBase.hidden = !d.conBases;
    var base = d.conBases ? opcionesBases(selBase, d.filas.concat(d.sinViajes || []), d.base) : "";
    var filas = base ? d.filas.filter(function (f) { return f.base === base; }) : d.filas;
    pintarBases(d, base);

    var buses = resumir(filas, function (f) { return f.interno; });
    (d.sinViajes || []).forEach(function (e) {
      if (base && e.base !== base) return;
      var r = nuevoResumen(e.interno);
      r.placa = e.placa;
      agregarUnico(r.bases, e.base);
      buses.push(r);
    });
    buses.forEach(function (r) { r.estadoBus = d.estados ? d.estados[r.clave] || null : null; });
    pintarAvisos(d, buses, base);
    var todo = nuevoResumen("todo");
    filas.forEach(function (f) { sumarViaje(todo, f); });
    var conProblemas = buses.filter(function (r) { return r.danos || r.noCuadran || r.revisarCivica; }).length;
    var avisan = buses.filter(function (r) { return conAviso(r.estadoBus); }).length;
    totales.innerHTML = totalesHtml(todo,
      '<div class="total"' + (avisan ? ' data-tono="mal"' : "") + "><span>" + (base ? "Buses · " + esc(base) : "Buses") + "</span><strong>" +
        buses.length + "</strong><small>" + (avisan ? (avisan === 1 ? "1 con aviso" : avisan + " con aviso") + " · " : "") +
        (conProblemas ? conProblemas + " para revisar" : "ninguno para revisar") + "</small></div>");

    // Las rutas del día, para el filtro
    var nombres = {};
    d.filas.forEach(function (f) { if (f.ruta) nombres[f.ruta] = rutaLegible(f.itinerario) || "Ruta " + f.ruta; });
    var sel = $("diaRuta");
    var elegida = d.ruta;
    sel.innerHTML = '<option value="">Todas las rutas</option>' + Object.keys(nombres).sort().map(function (k) {
      return '<option value="' + esc(k) + '">' + esc(k + " · " + nombres[k]) + "</option>";
    }).join("");
    sel.value = nombres[elegida] ? elegida : "";
    d.ruta = sel.value;

    var visibles = ordenar(buses.filter(function (r) { return pasaFiltro(r, d); }), d.orden, true);
    var o = d.orden;
    var html = "<table><thead><tr>" +
      thOrden("clave", "Bus", o) + thOrden("conductor", "Conductor", o) + thOrden("viajes", "Viajes", o, true) +
      thOrden("sensor", "Sensor", o, true) + thOrden("plataSensor", "$ Sensor", o, true) +
      thOrden("conductorP", "Conductor dice", o, true) + thOrden("plataConductor", "$ Conductor", o, true) +
      thOrden("difPlata", "Diferencia", o, true) + thOrden("civicas", "Cívicas", o, true) +
      thOrden("tiquetes", "Tiquetes", o, true) + thOrden("estado", "Estado", o) +
      "</tr></thead><tbody>";
    if (!visibles.length) {
      html += '<tr><td colspan="11" class="vacio">' +
        (buses.length ? "Ningún bus con ese filtro." : "Todavía no hay tarjetas este día. Aparecen cuando el programa del servidor las publica.") +
        "</td></tr>";
    }
    visibles.forEach(function (r) {
      var otros = r.conductores.length > 1 ? '<span class="menor">y ' + capitalizar(r.conductores.slice(1).join(", ")) + "</span>" : "";
      html += '<tr class="fila-link" tabindex="0" data-bus="' + esc(r.clave) + '">' +
        '<td><span class="bus-num">' + esc(r.clave) + '</span><span class="menor">' + esc(r.placa) + "</span>" +
          (d.conBases && !base ? '<span class="menor">' + esc(r.bases.join(", ")) + "</span>" : "") + "</td>" +
        "<td>" + esc(capitalizar(r.conductores[0] || "—")) + otros + "</td>" +
        celdasNumeros(r) +
        "<td>" + chipsEstado(r) + "</td></tr>";
    });
    html += "</tbody>";
    if (visibles.length > 1) {
      var suma = nuevoResumen("suma");
      d.filas.forEach(function (f) {
        if (visibles.some(function (r) { return r.clave === f.interno; })) sumarViaje(suma, f);
      });
      html += '<tfoot><tr><td colspan="2">' + visibles.length + " buses</td>" + celdasNumeros(suma) + "<td></td></tr></tfoot>";
    }
    html += "</table>";
    tabla.innerHTML = html;
    $("diaPie").textContent = d.cargadoEn ? "Actualizado a las " + fmtHora.format(new Date(d.cargadoEn)) +
      ". Diferencia = lo que dice el conductor menos lo del sensor, solo en los viajes que ya llegaron." +
      (d.conBases ? " La base es la de la programación del día." : " No se pudo leer la programación: sin las bases.") : "";
  }

  // Un renglón por base con sus totales; tocarlo deja solo esa base (y tocarlo otra vez, todas).
  function pintarBases(d, base) {
    var caja = $("diaBases");
    var sinViajes = d.sinViajes || [];
    if (!d.conBases || !(d.filas.length || sinViajes.length)) {
      caja.innerHTML = "";
      return;
    }
    var bases = resumir(d.filas, function (f) { return f.base; });
    var todas = nuevoResumen("todas");
    d.filas.forEach(function (f) { sumarViaje(todas, f); });
    // los buses sin viajes también cuentan en su base
    sinViajes.forEach(function (e) {
      var r = bases.filter(function (x) { return x.clave === e.base; })[0];
      if (!r) bases.push(r = nuevoResumen(e.base));
      agregarUnico(r.buses, e.interno);
      agregarUnico(todas.buses, e.interno);
    });
    bases.sort(function (a, b) { return compararBases(a.clave, b.clave); });
    bases.forEach(function (r) {
      r.avisosBus = r.buses.filter(function (i) { return conAviso(d.estados && d.estados[i]); }).length;
    });
    function renglon(r, valor, etiqueta, enPie) {
      var elegido = valor === base;
      return '<tr class="fila-link' + (elegido ? " elegida" : "") + '" tabindex="0" data-base="' + esc(valor) + '" aria-selected="' + elegido + '">' +
        "<td><strong>" + esc(etiqueta) + "</strong></td>" +
        '<td class="n">' + r.buses.length + "</td>" + celdasNumeros(r) + (enPie ? "<td></td>" : "<td>" + chipsEstado(r) + "</td>") + "</tr>";
    }
    caja.innerHTML = '<h2 class="seccion-titulo">Por base</h2><div class="tabla-caja"><table class="tabla-bases"><thead><tr>' +
      "<th>Base</th><th class=\"n\">Buses</th><th class=\"n\">Viajes</th><th class=\"n\">Sensor</th><th class=\"n\">$ Sensor</th>" +
      '<th class="n">Conductor dice</th><th class="n">$ Conductor</th><th class="n">Diferencia</th><th class="n">Cívicas</th>' +
      '<th class="n">Tiquetes</th><th>Estado</th></tr></thead><tbody>' +
      bases.map(function (r) { return renglon(r, r.clave, r.clave); }).join("") +
      "</tbody><tfoot>" + renglon(todas, "", "Todas las bases", true) + "</tfoot></table></div>";
  }

  // Los buses que dejaron de reportar (o que tuvieron un aviso ese día), y si el programa sigue revisando.
  function pintarAvisos(d, buses, base) {
    var caja = $("diaAvisos");
    if (!d.estados) {
      caja.innerHTML = '<p class="nota-avisos">Todavía no se ve si algún bus dejó de reportar: falta correr la versión 6 del SQL ' +
        "y que el programa del servidor publique.</p>";
      return;
    }
    var revisados = Object.keys(d.estados).map(function (k) { return d.estados[k]; });
    if (!revisados.length) {
      caja.innerHTML = '<p class="nota-avisos">El programa todavía no ha revisado los buses de este día.</p>';
      return;
    }
    var ultima = revisados.reduce(function (m, e) { return Math.max(m, Date.parse(e.revisado_en || e.intento_en) || 0); }, 0);
    var esHoy = d.fecha === diaDeHoy();
    var viejo = esHoy && Date.now() - ultima > REVISION_VIEJA_MS;
    var conAvisos = ordenar(buses.filter(function (r) { return tieneAvisos(r.estadoBus); }), { campo: "estado", desc: true }, true);
    var html = '<div class="avisos-buses"' + (conAvisos.length || viejo ? ' data-tono="mal"' : ' data-tono="bien"') + ">" +
      '<div class="avisos-cabeza"><h2>' + (conAvisos.length
        ? (conAvisos.length === 1 ? "1 bus con aviso" : conAvisos.length + " buses con aviso")
        : "Todos los buses reportaron bien") + (base ? " · " + esc(base) : "") + "</h2>" +
      "<span>El programa revisó " + buses.length + (buses.length === 1 ? " bus" : " buses") +
        (ultima ? (esHoy ? " a las " : " por última vez el ") + esc(esHoy ? fmtHora.format(new Date(ultima)) : momento(new Date(ultima).toISOString())) : "") +
        "</span></div>";
    if (viejo) {
      html += '<p class="aviso-programa">El programa no revisa los buses desde las ' + esc(fmtHora.format(new Date(ultima))) +
        ". Puede estar apagado o sin internet: lo de hoy puede estar incompleto.</p>";
    }
    if (conAvisos.length) {
      html += '<ul class="lista-avisos">' + conAvisos.map(function (r) {
        var eb = ESTADO_BUS[r.estadoBus.estado];
        return '<li><a class="bus-num" href="#/bus/' + encodeURIComponent(r.clave) + "/" + d.fecha + '">' + esc(r.clave) + "</a>" +
          (conAviso(r.estadoBus) && eb ? chip(eb[0], eb[1]) : chip("revisa", "Tuvo avisos")) +
          "<span>" + esc(textoAvisos(r.estadoBus)) + "</span></li>";
      }).join("") + "</ul>";
    }
    caja.innerHTML = html + "</div>";
  }

  // ================================================================ LA TARJETA DE UN BUS
  function abrirBus(interno, fecha) {
    var b = state.bus;
    interno = interno ? String(interno).trim() : "";
    $("busFecha").value = fecha;
    $("busNumero").value = interno;
    llenarListaBuses();
    $("busVolver").href = "#/dia/" + fecha;
    if (!interno) {
      b.interno = null;
      b.fecha = fecha;
      $("busTitulo").textContent = "Tarjeta del bus";
      $("busSub").textContent = "Escriba el número del bus y el día.";
      $("busCuerpo").innerHTML = '<p class="vacio">También puede abrirla desde la lista del día, tocando el bus.</p>';
      $("busExcel").disabled = $("busImprimir").disabled = true;
      return;
    }
    if (b.interno !== interno || b.fecha !== fecha) {
      b.interno = interno;
      b.fecha = fecha;
      b.filas = null;
      b.extra = {};
      b.historial = null;
      b.danos = [];
      b.diaManual = null;
      b.abiertos = {};
      b.error = null;
      b.base = "";
      b.estadoBus = null;
    }
    actualizarPestanas();
    pintarBus();
    if (!b.filas && !b.cargando) cargarBus();
  }

  function llenarListaBuses() {
    var internos = {};
    (state.dia.filas || []).forEach(function (f) { internos[f.interno] = f.placa || ""; });
    $("busLista").innerHTML = Object.keys(internos).sort(compararInternos).map(function (k) {
      return '<option value="' + esc(k) + '">' + esc(internos[k]) + "</option>";
    }).join("");
  }

  async function cargarBus() {
    var b = state.bus, interno = b.interno, fecha = b.fecha;
    b.cargando = true;
    function de(tabla, campos) {
      return conTiempo(client.from(tabla).select(campos).eq("interno", interno).eq("dia", fecha));
    }
    try {
      var res = await Promise.all([
        conTiempo(client.from("v_tarjeta_viajes").select(CAMPOS_VIAJE).eq("interno", interno).eq("dia", fecha).order("hora_salida")),
        de("tarjeta_viajes", "clave,detalle,aperturas,bajadas,llegada_estimada,cancelado_sonar,calculado_en"),
        de("civica_lecturas", CAMPOS_REGISTRO + ",lectura"),
        de("tarjeta_pasajeros_conductor", CAMPOS_REGISTRO + ",cantidad"),
        de("tarjeta_tiquetes", CAMPOS_REGISTRO + ",cantidad"),
        de("civica_danos", "*"),
        conTiempo(client.from("tarjeta_dia_manual").select("*").eq("interno", interno).eq("dia", fecha).maybeSingle()),
        traerBases(fecha, fecha).catch(function () { return null; }),
        conTiempo(client.from("tarjeta_buses_dia").select(CAMPOS_ESTADO_BUS).eq("interno", interno).eq("dia", fecha).maybeSingle())
          .catch(function () { return { data: null }; }),
        // v8: los gestores que se subieron (solo los ven los despachadores)
        state.v8 ? conTiempo(client.from("tarjeta_gestores").select(CAMPOS_GESTOR).eq("interno", interno).eq("dia", fecha).order("leido_en"))
          .catch(function () { return { data: [] }; }) : Promise.resolve({ data: [] }),
      ]);
      if (res[0].error) throw res[0].error;
      if (b.interno !== interno || b.fecha !== fecha) return;
      b.filas = res[0].data || [];
      aprenderNombres(b.filas);
      b.recorridos = {};
      ponerBases(b.filas, res[7]);
      b.base = baseEn(res[7], interno, fecha);
      b.estadoBus = res[8] && res[8].data || null;
      b.extra = {};
      (res[1].data || []).forEach(function (x) { b.extra[x.clave] = x; });
      b.historial = { civica: res[2].data || [], pasajeros: res[3].data || [], tiquetes: res[4].data || [] };
      b.danos = res[5].data || [];
      b.diaManual = res[6].data || null;
      b.gestores = res[9] && res[9].data || [];
      b.error = null;
      // lo manual de cada viaje (quién escribió el control): se pide con las claves ya sabidas
      var claves = b.filas.map(function (f) { return f.clave; });
      b.manualViaje = {};
      if (claves.length) {
        var man = await conTiempo(client.from("tarjeta_viajes_manual").select("*").in("clave", claves));
        (man.data || []).forEach(function (m) { b.manualViaje[m.clave] = m; });
      }
    } catch (err) {
      if (b.interno === interno && b.fecha === fecha) b.error = err;
    } finally {
      b.cargando = false;
      if (state.vista === "bus" && b.interno === interno && b.fecha === fecha) pintarBus();
    }
  }

  // La cadena de un dato de un viaje: el original y sus correcciones, en orden.
  function cadenaDe(lista, clave) {
    var suyos = lista.filter(function (x) { return x.clave_viaje === clave; });
    var original = suyos.filter(function (x) { return x.corrige_a == null; })[0];
    var cadena = [];
    var actual = original;
    while (actual) {
      cadena.push(actual);
      var id = actual.id;
      actual = suyos.filter(function (x) { return x.corrige_a === id; })[0];
    }
    return cadena;
  }

  function valorDe(tipo, x) { return x[TIPOS[tipo].columna]; }

  function quienEscribio(x) {
    var partes = [];
    if (x.nombre) partes.push(capitalizar(x.nombre));
    if (x.cedula) partes.push("cédula ···" + String(x.cedula).slice(-4));
    partes.push(x.origen === "celular" ? "desde el celular" : "control");
    if (x.escrita_por_correo && x.origen !== "celular") partes.push(x.escrita_por_correo);
    return partes.join(" · ");
  }

  function pintarBus() {
    var b = state.bus;
    var cuerpo = $("busCuerpo");
    $("busTitulo").textContent = "Bus " + b.interno;
    $("busSub").textContent = fechaLarga(b.fecha);
    if (!b.filas) {
      $("busExcel").disabled = $("busImprimir").disabled = true;
      cuerpo.innerHTML = b.error ? cajaError("No se pudo traer la tarjeta: " + textoError(b.error), "recargar-bus")
        : '<p class="cargando">Trayendo la tarjeta del bus ' + esc(b.interno) + "…</p>";
      return;
    }
    if (!b.filas.length) {
      $("busExcel").disabled = $("busImprimir").disabled = true;
      cuerpo.innerHTML = avisoDelBus(b.estadoBus) + '<p class="vacio">El bus ' + esc(b.interno) + " no tiene viajes en la tarjeta del " +
        esc(fechaLarga(b.fecha).toLowerCase()) + "." + (b.estadoBus ? "" : " Revise el número, o puede que el programa del servidor todavía no la haya publicado.") +
        "</p>";
      return;
    }
    $("busExcel").disabled = $("busImprimir").disabled = false;

    var r = nuevoResumen(b.interno);
    b.filas.forEach(function (f) { sumarViaje(r, f); });
    $("busSub").textContent = fechaLarga(b.fecha) + " (" + textoCorte() + ")" +
      (r.placa ? " · placa " + r.placa : "") + (b.base ? " · " + b.base : "");
    var dm = b.diaManual || {};
    var html = avisoDelBus(b.estadoBus) + '<div class="bus-cabeza">' +
      dato("Conductor 1", capitalizar(r.conductores[0] || "—")) +
      dato("Conductor 2", capitalizar(r.conductores[1] || "—") + (r.conductores.length > 2 ? " y " + (r.conductores.length - 2) + " más" : "")) +
      '<div class="dato dato-ancho"><span>Rutas</span><ul>' + (r.rutas.map(function (k) {
        var f = b.filas.filter(function (x) { return x.ruta === k; })[0];
        return "<li>" + esc(k + " · " + (rutaLegible(f && f.itinerario) || "")) + "</li>";
      }).join("") || "<li>—</li>") + "</ul></div>" +
      (state.revisor
        ? '<form class="dato" data-form="dia-manual"><span>Despachadores</span><div class="dato-edit">' +
            '<input name="despachador_1" placeholder="Despachador 1" value="' + esc(dm.despachador_1 || "") + '">' +
            '<input name="despachador_2" placeholder="Despachador 2" value="' + esc(dm.despachador_2 || "") + '">' +
            '<input name="observaciones" placeholder="Observaciones del día" value="' + esc(dm.observaciones || "") + '">' +
            '<button class="btn btn-chico no-imprimir" type="submit">Guardar</button></div></form>'
        : dato("Despachadores", [dm.despachador_1, dm.despachador_2].filter(Boolean).join(" / ") || "—") +
          (dm.observaciones ? dato("Observaciones del día", dm.observaciones) : "")) +
      "</div>";
    html += '<div class="totales">' + totalesHtml(r) + "</div>";

    html += '<div class="tabla-caja"><table class="tarjeta"><thead><tr>' +
      "<th>Viaje</th><th>Salió</th><th>Ruta</th><th>Conductor</th>" +
      '<th class="n">Sensor</th><th class="n">Conductor dice</th><th class="n">Diferencia</th><th class="n">$ Conductor</th>' +
      '<th>Cívica</th><th class="n">Tiquetes</th><th>Control</th><th class="no-imprimir"></th>' +
      "</tr></thead><tbody>";
    b.filas.forEach(function (f) {
      var abierto = !!b.abiertos[f.clave];
      html += renglonViaje(f, abierto);
      if (abierto) html += '<tr class="detalle-fila"><td colspan="12">' + detalleViaje(f) + "</td></tr>";
    });
    html += "</tbody></table></div>";
    html += '<p class="pie no-imprimir">Toque un viaje para ver cada parada, quién escribió cada número y sus correcciones.' +
      (state.revisor ? "" : " Esta cuenta es de solo lectura: para corregir, hay que agregarla a tarjeta_revisores.") + "</p>";
    html += '<div class="firmas"><div>Firma del conductor</div><div>Firma de control</div></div>';
    quitarMapas();
    cuerpo.innerHTML = html;
    dibujarMapas();
  }

  function dato(titulo, valor) { return '<div class="dato"><span>' + esc(titulo) + "</span><strong>" + esc(valor) + "</strong></div>"; }

  // Arriba de la tarjeta: si el bus dejó de reportar o tuvo un aviso ese día.
  function avisoDelBus(e) {
    if (!e) return "";
    var eb = ESTADO_BUS[e.estado];
    if (!tieneAvisos(e)) {
      return e.estado === "no_contesto" && eb ? '<div class="aviso-bus" data-tono="revisa"><strong>' + esc(eb[1]) + "</strong>" +
        (e.aviso ? "<span>" + esc(e.aviso) + "</span>" : "") + "</div>" : "";
    }
    return '<div class="aviso-bus"' + (conAviso(e) ? "" : ' data-tono="revisa"') + "><strong>" +
      esc(conAviso(e) && eb ? eb[1] : "Tuvo avisos este día") + "</strong><span>" + esc(textoAvisos(e)) + "</span>" +
      (e.ultimo_gps ? '<span class="menor">Último GPS que tenía Sonar: ' + esc(momento(e.ultimo_gps)) + "</span>" : "") + "</div>";
  }

  function renglonViaje(f, abierto) {
    var llegada = f.estado_calculo === "en_curso" ? "en camino"
      : f.llego_en ? "llegó " + hora(f.llego_en) + ((state.bus.extra[f.clave] || {}).llegada_estimada ? " (calculada)" : "") : "";
    var dif = f.estado_calculo === "en_curso" || f.diferencia_con_sensor == null ? null : n(f.diferencia_con_sensor);
    var est = ESTADO_CIVICA[f.estado_civica] || ["", f.estado_civica || ""];
    return '<tr class="fila-link' + (abierto ? " viaje-abierto" : "") + '" tabindex="0" data-viaje="' + esc(f.clave) + '" aria-expanded="' + abierto + '">' +
      "<td>" + (f.sin_despacho ? '<span class="sd">SIN DESPACHO</span>' : '<span class="viaje-n">' + esc(f.viaje) + "</span>") +
        (f.salio_cancelado ? '<span class="menor">cancelado, salió igual</span>' : "") + "</td>" +
      '<td class="num"><strong>' + hora(f.hora_salida) + '</strong><span class="menor">' + esc(llegada) + "</span></td>" +
      (f.sin_despacho && f.itinerario_estimado
        ? "<td>" + esc(nombreItinerario(f.itinerario_estimado)) + '<span class="menor">como el ' + esc(f.itinerario_estimado) +
          " · lo encontró el viaje a viaje</span></td>"
        : "<td>" + esc(nombreRuta(f)) + (f.ruta ? '<span class="menor">' + esc(f.ruta) + "</span>" : "") + "</td>") +
      "<td>" + esc(capitalizar(f.conductor || "—")) + "</td>" +
      '<td class="n"><strong>' + n(f.pasajeros_sensor) + '</strong><span class="menor">subieron ' + n(f.subidas) +
        (f.estado_calculo === "en_curso" ? ", hasta ahora" : "") + "</span>" +
        (n(f.gestores) ? '<span class="menor gestor-menos">' + (n(f.gestores) === 1 ? "+1 gestor" : "+" + n(f.gestores) + " gestores") +
          " (no cuenta)</span>" : "") + "</td>" +
      '<td class="n">' + (f.pasajeros_conductor != null ? "<strong>" + esc(f.pasajeros_conductor) + "</strong>" +
        (f.pasajeros_conductor_corregidos ? '<span class="menor">corregido</span>' : "") : chip("", "falta")) + "</td>" +
      '<td class="n">' + (dif == null ? "—" : '<span class="' + claseDif(dif) + '">' + numDif(dif) + '</span><span class="menor">' +
        pesosDif(n(f.diferencia_plata)) + "</span>") + "</td>" +
      '<td class="n">' + (f.plata_conductor != null ? pesos(n(f.plata_conductor)) : "—") +
        '<span class="menor">sensor ' + pesos(n(f.plata_sensor)) + "</span></td>" +
      "<td>" + (f.civica_lectura != null
        ? '<strong class="num">' + esc(f.civica_lectura) + "</strong>" + (f.civicas != null ? " · " + esc(f.civicas) + " cívicas" : "") +
          (f.lectura_corregida ? '<span class="menor">corregida</span>' : "") + '<div class="chips">' + chip(est[0], est[1]) + "</div>"
        : chip("", "falta")) + "</td>" +
      '<td class="n">' + (f.tiquetes_escaneados != null ? esc(f.tiquetes_escaneados) + (f.tiquetes_corregidos ? '<span class="menor">corregidos</span>' : "")
        : chip("", "falta")) + "</td>" +
      "<td>" + esc(f.control || "") + (f.observaciones ? '<span class="menor">' + esc(f.observaciones) + "</span>" : "") + "</td>" +
      '<td class="no-imprimir"><button class="btn-link" type="button" tabindex="-1">' + (abierto ? "Cerrar" : "Ver") + "</button></td>" +
      "</tr>";
  }

  function detalleViaje(f) {
    var b = state.bus;
    var extra = b.extra[f.clave] || {};
    var paradas = Array.isArray(extra.detalle) ? extra.detalle : [];
    var izq = '<div><div class="bloque"><h3>Puerta por puerta</h3>';
    if (paradas.length) {
      var suben = 0, bajan = 0;
      izq += '<table><thead><tr><th>Hora</th><th class="n">Suben</th><th class="n">Bajan</th><th>Dónde</th></tr></thead><tbody>' +
        paradas.map(function (p) {
          suben += n(p.suben);
          bajan += n(p.bajan);
          var mapa = p.lat != null && p.lon != null
            ? ' <a class="no-imprimir" href="https://www.google.com/maps?q=' + encodeURIComponent(p.lat + "," + p.lon) + '" target="_blank" rel="noopener">mapa</a>' : "";
          return '<tr><td class="num">' + hora(p.hora) + '</td><td class="n">' + (n(p.suben) || "") + '</td><td class="n">' + (n(p.bajan) || "") + "</td>" +
            "<td>" + esc(p.donde || "") + mapa + (p.tapado ? " " + chip("revisa", "sensor tapado") : "") + "</td></tr>";
        }).join("") +
        '</tbody><tfoot><tr><td>Total</td><td class="n">' + suben + '</td><td class="n">' + bajan + "</td><td></td></tr></tfoot></table>" +
        '<p class="nota">' + (extra.aperturas ? "La puerta se abrió " + extra.aperturas + " veces (también las que no movieron a nadie). " : "") +
        (n(f.recortados) ? n(f.recortados) + " subidas pasaron del tope de 19. " : "") +
        (paradas.some(function (p) { return p.tapado; }) ? "Con el sensor tapado, el conteo puede llegar tarde, en la parada siguiente." : "") + "</p>";
    } else {
      izq += '<p class="nota">Este viaje se publicó sin el detalle de cada parada. Aparece cuando el programa del servidor lo vuelva a publicar con la versión nueva.</p>';
    }
    izq += "</div>";

    // Control y observaciones del viaje
    var m = (b.manualViaje || {})[f.clave] || {};
    izq += '<div class="bloque"><h3>Control y observaciones</h3>';
    if (state.revisor) {
      izq += '<form class="form-linea" data-form="viaje-manual" data-clave="' + esc(f.clave) + '">' +
        '<label class="campo"><span>Control</span><input name="control" value="' + esc(m.control || "") + '" maxlength="40"></label>' +
        '<label class="campo"><span>Observaciones</span><input name="observaciones" value="' + esc(m.observaciones || "") + '" maxlength="300"></label>' +
        '<button class="btn" type="submit">Guardar</button></form>';
    } else {
      izq += '<p class="nota">' + esc([m.control, m.observaciones].filter(Boolean).join(" · ") || "Nada escrito.") + "</p>";
    }
    if (m.editado_por_correo) izq += '<p class="nota">Lo escribió ' + esc(m.editado_por_correo) + " el " + esc(momento(m.editado_en)) + ".</p>";
    izq += "</div></div>";

    // Lo que escribió el conductor y las correcciones
    var der = "<div><h3>Lo que escribieron</h3>";
    ["civica", "pasajeros", "tiquetes"].forEach(function (tipo) {
      var cadena = b.historial ? cadenaDe(b.historial[tipo], f.clave) : [];
      der += '<div class="registro"><div class="registro-cabeza"><b>' + esc(TIPOS[tipo].nombre) + "</b>" +
        (state.revisor ? '<button class="btn btn-chico" type="button" data-corregir="' + tipo + '" data-clave="' + esc(f.clave) + '">' +
          (cadena.length ? "Corregir" : "Escribir") + "</button>" : "") + "</div>";
      if (!cadena.length) {
        der += '<p class="nota">' + (tipo === "tiquetes" && f.tiquetes_escaneados != null
          ? "La tarjeta tiene " + esc(f.tiquetes_escaneados) + " (los puso un despachador en lo manual)."
          : "No lo ha escrito.") + "</p>";
      } else {
        der += '<ol class="cadena">' + cadena.map(function (x, i) {
          return '<li class="' + (i === cadena.length - 1 ? "vigente" : "") + '">' + (i ? "→ " : "") +
            "<strong>" + esc(valorDe(tipo, x)) + "</strong> · " + esc(quienEscribio(x)) + " · " + esc(momento(x.escrita_en)) +
            (x.motivo ? '<span class="motivo">“' + esc(x.motivo) + "”</span>" : "") + "</li>";
        }).join("") + "</ol>";
      }
      der += "</div>";
    });

    // Gestores que se subieron en este viaje (v8): el sensor los contó; la tarjeta resta los que cuadran
    var suyos = (b.gestores || []).filter(function (g) { return g.clave_viaje === f.clave; });
    if (suyos.length) {
      der += '<div class="registro"><div class="registro-cabeza"><b>Gestores que subieron</b></div><ul class="gestores-lista">' +
        suyos.map(function (g) {
          return "<li>" + resultadoGestor(g) + " <strong>" + esc(capitalizar(g.nombre || "Cédula ···" + String(g.dni || "").slice(-4))) +
            "</strong> · " + hora(g.leido_en) + (g.donde ? " · " + esc(g.donde) : "") +
            (g.motivo ? '<span class="menor">' + esc(g.motivo) + "</span>" : "") + "</li>";
        }).join("") + "</ul>" +
        '<p class="nota">El conductor leyó el código del gestor; los que se restaron no cuentan en los pasajeros del viaje.</p></div>';
    }

    // Daños del validador reportados en este viaje
    b.danos.filter(function (d) { return d.clave_viaje === f.clave; }).forEach(function (d) {
      der += '<div class="dano" data-estado="' + esc(d.estado) + '"><div class="registro-cabeza"><b>Daño del validador</b>' +
        chip(d.estado === "aprobado" ? "ok" : d.estado === "rechazado" ? "mal" : "revisa",
          d.estado === "aprobado" ? "Aprobado" : d.estado === "rechazado" ? "Rechazado" : "Por revisar") + "</div>" +
        "<p>" + (d.lectura_final_viejo != null ? "El viejo quedó en <strong>" + esc(d.lectura_final_viejo) + "</strong> · " : "") +
          "el nuevo arrancó en <strong>" + esc(d.lectura_inicial_nuevo) + "</strong></p>" +
        "<p>" + esc(d.descripcion) + "</p>" +
        '<p class="nota">Lo reportó ' + esc(capitalizar(d.nombre || d.reportado_por_correo || "")) + " · " + esc(momento(d.reportado_en)) +
          (d.revisado_en ? " · revisado por " + esc(d.revisado_por_correo) + " · " + esc(momento(d.revisado_en)) : "") +
          (d.nota_revision ? " · “" + esc(d.nota_revision) + "”" : "") + "</p>" +
        '<div class="acciones no-imprimir"><button class="btn btn-chico" type="button" data-foto="' + esc(d.foto) + '">Ver la foto</button>' +
        (state.revisor && d.estado === "reportado"
          ? '<button class="btn btn-chico btn-primario" type="button" data-dano-aprobar="' + d.id + '">Aprobar</button>' +
            '<button class="btn btn-chico" type="button" data-dano-rechazar="' + d.id + '">Rechazar</button>' : "") +
        "</div></div>";
    });
    der += "</div>";
    return '<div class="detalle">' + bloqueRecorrido(f) + izq + der + "</div>";
  }

  // ---------------------------------------------------------------- el mapa del recorrido
  // El recorrido GPS lo publica el programa de la oficina en tarjeta_recorridos (sql v7) cuando el viaje
  // llega, en "polilínea codificada". Encima van las paradas donde se abrió la puerta (tarjeta_viajes.detalle).
  // Leaflet se carga solo al abrir el primer viaje, para que la página arranque liviana.
  var LEAFLET = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/";
  var cargaLeaflet = null;
  var mapas = [];

  function cargarLeaflet() {
    if (window.L) return Promise.resolve(window.L);
    if (!cargaLeaflet) {
      cargaLeaflet = new Promise(function (si, no) {
        var css = document.createElement("link");
        css.rel = "stylesheet";
        css.href = LEAFLET + "leaflet.css";
        document.head.appendChild(css);
        var js = document.createElement("script");
        js.src = LEAFLET + "leaflet.js";
        js.onload = function () { si(window.L); };
        js.onerror = function () { cargaLeaflet = null; no(new Error("No cargó el mapa")); };
        document.head.appendChild(js);
      });
    }
    return cargaLeaflet;
  }

  // "polilínea codificada" (el formato de Google, 5 decimales) -> [[lat, lon], ...]
  function leerPolilinea(texto) {
    var puntos = [], i = 0, lat = 0, lon = 0;
    while (i < texto.length) {
      var v = [0, 0];
      for (var k = 0; k < 2; k++) {
        var b, valor = 0, corrida = 0;
        do {
          b = texto.charCodeAt(i++) - 63;
          valor |= (b & 0x1f) << corrida;
          corrida += 5;
        } while (b >= 0x20);
        v[k] = valor & 1 ? ~(valor >> 1) : valor >> 1;
      }
      lat += v[0];
      lon += v[1];
      puntos.push([lat / 1e5, lon / 1e5]);
    }
    return puntos;
  }

  function bloqueRecorrido(f) {
    var titulo, explica;
    if (f.sin_despacho) {
      titulo = f.itinerario_estimado
        ? "Sin despacho · como el " + f.itinerario_estimado + " · " + nombreItinerario(f.itinerario_estimado)
        : "Sin despacho · itinerario sin identificar";
      explica = "No tiene despacho en Sonar: lo encontró el viaje a viaje porque se subieron " + n(f.subidas) + " personas" +
        (f.punto_salida ? " en " + f.punto_salida : "") + (f.punto_llegada ? " y se bajaron en " + f.punto_llegada : "") +
        (f.itinerario_estimado ? ". El itinerario es el que va de ahí a allá; Sonar no lo dice." : ".");
    } else {
      titulo = f.ruta ? "Itinerario " + f.ruta + " · " + (rutaLegible(f.itinerario) || nombreItinerario(f.ruta)) : "Sin itinerario en Sonar";
      explica = "El itinerario es el del despacho en Sonar" +
        (f.punto_salida || f.punto_llegada ? "; la gente se subió" + (f.punto_salida ? " en " + f.punto_salida : " fuera de los puntos") +
          " y se bajó" + (f.punto_llegada ? " en " + f.punto_llegada : " fuera de los puntos") : "") + ".";
    }
    return '<div class="recorrido no-imprimir"><div class="recorrido-cabeza"><h3>' + esc(titulo) + "</h3>" +
      '<span class="leyenda"><i style="background:' + (f.sin_despacho ? "#c2410c" : "#0b6b3a") + '"></i>recorrido' +
      '<i class="punto" style="background:#16a34a"></i>suben<i class="punto" style="background:#d97706"></i>solo bajan' +
      ((state.bus.gestores || []).some(function (g) { return g.clave_viaje === f.clave; })
        ? '<i class="punto" style="background:' + COLOR_GESTOR + '"></i>gestor' : "") + "</span></div>" +
      '<p class="nota">' + esc(explica) + "</p>" +
      '<div class="mapa" data-mapa="' + esc(f.clave) + '"></div><p class="nota mapa-nota"></p></div>';
  }

  function quitarMapas() {
    mapas.forEach(function (m) { try { m.remove(); } catch (_) {} });
    mapas = [];
  }

  async function recorridoDe(clave) {
    var b = state.bus;
    b.recorridos = b.recorridos || {};
    if (!(clave in b.recorridos)) {
      try {
        var r = await conTiempo(client.from("tarjeta_recorridos").select("recorrido,puntos").eq("clave", clave).maybeSingle(), 15000);
        b.recorridos[clave] = r.error ? null : r.data || null;
      } catch (_) {
        b.recorridos[clave] = null;
      }
    }
    return b.recorridos[clave];
  }

  async function dibujarMapas() {
    var cajas = Array.prototype.slice.call(document.querySelectorAll("[data-mapa]"));
    if (!cajas.length) return;
    var L;
    try {
      L = await cargarLeaflet();
    } catch (_) {
      cajas.forEach(function (c) { c.hidden = true; c.nextSibling.textContent = "No cargó el mapa. Revise el internet y vuelva a abrir el viaje."; });
      return;
    }
    cajas.forEach(function (caja) { dibujarMapa(L, caja); });
  }

  async function dibujarMapa(L, caja) {
    var b = state.bus, clave = caja.getAttribute("data-mapa");
    var f = (b.filas || []).filter(function (x) { return x.clave === clave; })[0];
    if (!f) return;
    var rec = await recorridoDe(clave);
    if (!caja.isConnected) return;               // se cerró o se volvió a pintar mientras tanto
    var nota = caja.nextSibling;
    var paradas = ((b.extra[clave] || {}).detalle || []).filter(function (p) { return p.lat != null && p.lon != null; });
    var linea = rec && rec.recorrido ? leerPolilinea(rec.recorrido) : [];
    if (!linea.length && !paradas.length) {
      caja.hidden = true;
      nota.textContent = "Este viaje no tiene puntos para el mapa.";
      return;
    }
    var mapa = L.map(caja, { scrollWheelZoom: false });
    mapas.push(mapa);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(mapa);
    var limites = [];
    if (linea.length) {
      L.polyline(linea, { color: f.sin_despacho ? "#c2410c" : "#0b6b3a", weight: 4, opacity: 0.85 }).addTo(mapa);
      limites = limites.concat(linea);
    }
    paradas.forEach(function (p) {
      var suben = n(p.suben), bajan = n(p.bajan);
      L.circleMarker([p.lat, p.lon], {
        radius: 4 + Math.min(8, Math.sqrt(suben + bajan) * 1.6), color: "#fff", weight: 1.5,
        fillColor: suben ? "#16a34a" : "#d97706", fillOpacity: 0.9,
      }).bindTooltip(hora(p.hora) + (suben ? " · suben " + suben : "") + (bajan ? " · bajan " + bajan : "") +
        (p.donde ? " · " + p.donde : "") + (p.tapado ? " · sensor tapado" : "")).addTo(mapa);
      limites.push([p.lat, p.lon]);
    });
    // Donde el conductor leyó el código de un gestor
    (b.gestores || []).filter(function (g) { return g.clave_viaje === clave && g.lat != null && g.lon != null; }).forEach(function (g) {
      L.circleMarker([g.lat, g.lon], { radius: 8, color: "#fff", weight: 2, fillColor: COLOR_GESTOR, fillOpacity: 0.95 })
        .bindTooltip("Gestor " + capitalizar(g.nombre || "") + " · " + hora(g.leido_en) + " · " +
          (g.resta ? "se restó" : "no se restó")).addTo(mapa);
      limites.push([g.lat, g.lon]);
    });
    if (linea.length) {
      etiqueta(L, mapa, linea[0], "Salió " + hora(f.hora_salida));
      etiqueta(L, mapa, linea[linea.length - 1], f.llego_en ? "Llegó " + hora(f.llego_en) : "Último punto");
    }
    mapa.fitBounds(limites, { padding: [28, 28], maxZoom: 15 });
    nota.textContent = linea.length
      ? "Recorrido GPS de Sonar, desde el despacho hasta la llegada. Toque un punto para ver la hora y cuántos subieron o bajaron."
      : f.estado_calculo === "en_curso"
        ? "El recorrido GPS sale cuando el viaje llegue. Por ahora, solo las paradas donde se abrió la puerta."
        : "Todavía no está el recorrido GPS de este viaje (lo publica el programa de la oficina). Por ahora, solo las paradas donde se abrió la puerta.";
  }

  function etiqueta(L, mapa, punto, texto) {
    L.circleMarker(punto, { radius: 6, color: "#111", weight: 2, fillColor: "#fff", fillOpacity: 1 })
      .bindTooltip(texto, { permanent: true, direction: "top", offset: [0, -6], className: "mapa-etiqueta" }).addTo(mapa);
  }

  // ---------------------------------------------------------------- corregir lo del conductor
  function abrirCorregir(tipo, clave) {
    var b = state.bus;
    var f = b.filas.filter(function (x) { return x.clave === clave; })[0];
    if (!f) return;
    var t = TIPOS[tipo];
    var cadena = cadenaDe(b.historial[tipo], clave);
    var vigente = cadena[cadena.length - 1];
    var viaje = f.sin_despacho ? "el viaje sin despacho de las " + hora(f.hora_salida) : "el viaje " + f.viaje + " (" + hora(f.hora_salida) + ")";
    abrirHoja((vigente ? "Corregir " : "Escribir ") + t.que,
      '<p class="nota">Bus ' + esc(b.interno) + " · " + esc(viaje) + ". Nada se borra: queda lo de antes, quién corrigió, cuándo y por qué.</p>" +
      (vigente ? '<div class="valor-actual">Dice <strong>' + esc(valorDe(tipo, vigente)) + "</strong> · " + esc(quienEscribio(vigente)) + "</div>" : "") +
      '<form id="formCorregir" novalidate>' +
        '<label class="campo"><span>' + esc(t.etiqueta) + (vigente ? " correcto" : "") + "</span>" +
          '<input id="corrValor" inputmode="numeric" autocomplete="off" maxlength="' + t.largo + '"></label>' +
        '<label class="campo" style="margin-top:10px"><span>¿Por qué? (obligatorio)</span>' +
          '<textarea id="corrMotivo" maxlength="300" placeholder="Ej.: en la foto del validador se lee 2090"></textarea></label>' +
        '<p id="corrError" class="error" hidden style="margin-top:10px"></p>' +
        '<div class="acciones"><button class="btn btn-primario" type="submit" id="corrGuardar">Guardar</button>' +
        '<button class="btn" type="button" data-cerrar-hoja>Cancelar</button></div>' +
      "</form>",
      function (caja) {
        caja.querySelector("#corrValor").addEventListener("input", function (ev) { ev.target.value = ev.target.value.replace(/\D/g, ""); });
        caja.querySelector("#formCorregir").addEventListener("submit", function (ev) {
          ev.preventDefault();
          guardarCorreccion(tipo, f, vigente);
        });
      });
  }

  async function guardarCorreccion(tipo, f, vigente) {
    var t = TIPOS[tipo];
    var valor = $("corrValor").value.trim();
    var motivo = $("corrMotivo").value.trim();
    var error = $("corrError");
    var falla = !valor ? "Escriba el número." : !motivo ? "Escriba por qué." :
      vigente && Number(valor) === Number(valorDe(tipo, vigente)) ? "Es el mismo número que ya tiene." : "";
    if (falla) {
      error.textContent = falla;
      error.hidden = false;
      return;
    }
    var fila = { clave_viaje: f.clave, dia: f.dia, interno: f.interno, corrige_a: vigente ? vigente.id : null, motivo: motivo, origen: "programa_central" };
    fila[t.columna] = Number(valor);
    $("corrGuardar").disabled = true;
    try {
      var res = await conTiempo(client.from(t.tabla).insert(fila));
      if (res.error) throw res.error;
      cerrarHoja();
      aviso("Guardado: " + t.que + " del bus " + f.interno + " ahora dice " + valor + ".");
      refrescarTrasEscribir();
    } catch (err) {
      error.textContent = textoError(err);
      error.hidden = false;
      $("corrGuardar").disabled = false;
      if (err && err.code === "23505") refrescarTrasEscribir();
    }
  }

  // Después de escribir: la tarjeta del bus se vuelve a traer, y el día también cuando se abra.
  function refrescarTrasEscribir() {
    if (state.dia.fecha === state.bus.fecha) state.dia.filas = null;
    cargarBus();
  }

  // ---------------------------------------------------------------- control, observaciones, despachadores
  async function guardarManualViaje(form) {
    var clave = form.getAttribute("data-clave");
    var boton = form.querySelector("button");
    boton.disabled = true;
    try {
      var res = await conTiempo(client.from("tarjeta_viajes_manual").upsert({
        clave: clave,
        control: form.control.value.trim() || null,
        observaciones: form.observaciones.value.trim() || null,
      }, { onConflict: "clave" }));
      if (res.error) throw res.error;
      aviso("Guardado el control del viaje.");
      refrescarTrasEscribir();
    } catch (err) {
      aviso("No se pudo guardar: " + textoError(err), "mal");
      boton.disabled = false;
    }
  }

  async function guardarManualDia(form) {
    var b = state.bus;
    var boton = form.querySelector("button");
    boton.disabled = true;
    try {
      var res = await conTiempo(client.from("tarjeta_dia_manual").upsert({
        dia: b.fecha, interno: b.interno,
        despachador_1: form.despachador_1.value.trim() || null,
        despachador_2: form.despachador_2.value.trim() || null,
        observaciones: form.observaciones.value.trim() || null,
      }, { onConflict: "dia,interno" }));
      if (res.error) throw res.error;
      aviso("Guardados los despachadores del bus " + b.interno + ".");
      refrescarTrasEscribir();
    } catch (err) {
      aviso("No se pudo guardar: " + textoError(err), "mal");
      boton.disabled = false;
    }
  }

  // ---------------------------------------------------------------- daños del validador
  async function verFoto(ruta) {
    abrirHoja("Foto del validador", '<p class="cargando">Trayendo la foto…</p>');
    try {
      var res = await conTiempo(client.storage.from("civica-evidencias").createSignedUrl(ruta, 600));
      if (res.error) throw res.error;
      $("hojaCuerpo").innerHTML = '<img src="' + esc(res.data.signedUrl) + '" alt="Foto del validador">' +
        '<p class="nota">' + esc(ruta) + '</p><a class="btn" href="' + esc(res.data.signedUrl) + '" target="_blank" rel="noopener">Abrir en grande</a>';
    } catch (err) {
      $("hojaCuerpo").innerHTML = '<p class="caja-error">No se pudo traer la foto: ' + esc(textoError(err)) + "</p>";
    }
  }

  function abrirRevisarDano(id, aprobar) {
    var d = state.bus.danos.filter(function (x) { return String(x.id) === String(id); })[0];
    if (!d) return;
    abrirHoja(aprobar ? "Aprobar el daño del validador" : "Rechazar el daño del validador",
      '<p class="nota">' + (aprobar
        ? "Al aprobarlo, las cívicas de ese viaje se cuentan con los números del reporte (lo que marcó el viejo y con cuál arrancó el nuevo)."
        : "Al rechazarlo, las cívicas se cuentan como si no hubiera pasado nada.") + " Se revisa una sola vez.</p>" +
      '<form id="formDano" novalidate><label class="campo"><span>Nota' + (aprobar ? " (si quiere)" : " (obligatoria: por qué se rechaza)") + "</span>" +
        '<textarea id="danoNota" maxlength="300"></textarea></label>' +
        '<p id="danoError" class="error" hidden style="margin-top:10px"></p>' +
        '<div class="acciones"><button class="btn ' + (aprobar ? "btn-primario" : "btn-peligro") + '" type="submit" id="danoGuardar">' +
          (aprobar ? "Aprobar" : "Rechazar") + '</button><button class="btn" type="button" data-cerrar-hoja>Cancelar</button></div></form>',
      function (caja) {
        caja.querySelector("#formDano").addEventListener("submit", async function (ev) {
          ev.preventDefault();
          var nota = $("danoNota").value.trim();
          if (!aprobar && !nota) {
            $("danoError").textContent = "Escriba por qué se rechaza.";
            $("danoError").hidden = false;
            return;
          }
          $("danoGuardar").disabled = true;
          try {
            var res = await conTiempo(client.from("civica_danos").update({ estado: aprobar ? "aprobado" : "rechazado", nota_revision: nota || null })
              .eq("id", d.id).select("id"));
            if (res.error) throw res.error;
            if (!res.data || !res.data.length) throw { code: "42501" };
            cerrarHoja();
            aviso(aprobar ? "Daño aprobado." : "Daño rechazado.");
            refrescarTrasEscribir();
          } catch (err) {
            $("danoError").textContent = textoError(err);
            $("danoError").hidden = false;
            $("danoGuardar").disabled = false;
          }
        });
      });
  }

  // ================================================================ gestores (sql v8)
  // El gestor activa su celular en el Portal del Conductor (selfie + huella) y aquí un despachador lo
  // aprueba. Después, cada código que lee un conductor lo revisa el programa de la oficina y queda en
  // tarjeta_gestores: si se restó del viaje o por qué no. Solo los despachadores ven estas tablas.
  var CAMPOS_GESTOR = "id_local,dia,interno,clave_viaje,dni,nombre,marcado_en,leido_en,lat,lon,donde,valido,resta,motivo";
  var CAMPOS_CELULAR = "id,dni,nombre,cargo,selfie,dispositivo,pedido_en,pedido_por,estado,aprobado_en,revisado_por,revisado_en,nota";
  var COLOR_GESTOR = "#7c3aed";

  function resultadoGestor(g) {
    if (g.resta) return chip("ok", "Se restó");
    if (g.motivo && /^Sospechoso/.test(g.motivo)) return chip("mal", "Sospechoso");
    return chip("revisa", "No se restó");
  }

  function dispositivoCorto(ua) {
    ua = String(ua || "");
    var m = ua.match(/Android [\d.]+(?:; ([^;)]+))?/);
    if (m) return "Android" + (m[1] && !/^K$/.test(m[1].trim()) ? " · " + m[1].trim() : "");
    if (/iPhone|iPad/.test(ua)) return /iPad/.test(ua) ? "iPad" : "iPhone";
    if (/Windows/.test(ua)) return "Windows";
    return ua.slice(0, 40) || "—";
  }

  function abrirGestores(fecha) {
    var g = state.ges;
    var cambio = g.fecha !== fecha;
    g.fecha = fecha;
    $("gesFecha").value = fecha;
    actualizarPestanas();
    if (cambio || !g.lecturas) {
      g.lecturas = null;
      g.error = null;
      pintarGestores();
      cargarGestores();
    } else {
      pintarGestores();
    }
  }

  async function cargarGestores() {
    var g = state.ges, fecha = g.fecha;
    if (!state.v8) { pintarGestores(); return; }
    g.cargando = true;
    try {
      var res = await Promise.all([
        conTiempo(client.from("tarjeta_gestores").select(CAMPOS_GESTOR).eq("dia", fecha).order("leido_en")),
        conTiempo(client.from("gestores_celulares").select(CAMPOS_CELULAR).in("estado", ["pendiente", "aprobado"])
          .order("pedido_en", { ascending: false })),
      ]);
      if (res[0].error) throw res[0].error;
      if (res[1].error) throw res[1].error;
      if (g.fecha !== fecha) return;
      g.lecturas = res[0].data || [];
      g.celulares = res[1].data || [];
      g.error = null;
    } catch (err) {
      if (g.fecha === fecha) g.error = err;
    } finally {
      g.cargando = false;
      if (state.vista === "gestores" && g.fecha === fecha) pintarGestores();
    }
  }

  function tarjetaCelular(c) {
    var aprobado = c.estado === "aprobado";
    var otro = !aprobado && (state.ges.celulares || []).some(function (x) { return x.dni === c.dni && x.estado === "aprobado"; });
    return '<div class="celular" data-estado="' + esc(c.estado) + '">' +
      (/^data:image\//.test(c.selfie || "") ? '<img class="selfie" src="' + esc(c.selfie) + '" alt="Selfie de ' + esc(c.nombre) + '">' : '<span class="selfie"></span>') +
      '<div class="celular-datos"><strong>' + esc(capitalizar(c.nombre || "Sin nombre")) + "</strong>" +
        '<span class="menor">' + esc(capitalizar(c.cargo || "")) + " · cédula " + esc(c.dni) + "</span>" +
        '<span class="menor">' + esc(dispositivoCorto(c.dispositivo)) + " · " +
          (aprobado ? "aprobado el " + esc(momento(c.aprobado_en)) + (c.revisado_por ? " por " + esc(c.revisado_por) : "")
            : "lo pidió el " + esc(momento(c.pedido_en))) + "</span>" +
        (otro ? '<span class="menor aviso-cambio">Ya tiene otro celular aprobado: al aprobar este, el otro deja de servir.</span>' : "") +
        (c.nota ? '<span class="menor">“' + esc(c.nota) + "”</span>" : "") +
      "</div>" +
      (state.revisor
        ? '<div class="acciones">' + (aprobado
            ? '<button class="btn btn-chico" type="button" data-celular-quitar="' + esc(c.id) + '">Quitar el celular</button>'
            : '<button class="btn btn-chico btn-primario" type="button" data-celular-aprobar="' + esc(c.id) + '">Aprobar</button>' +
              '<button class="btn btn-chico" type="button" data-celular-rechazar="' + esc(c.id) + '">Rechazar</button>') + "</div>"
        : "") +
      "</div>";
  }

  function pintarGestores() {
    var g = state.ges;
    var cuerpo = $("gesCuerpo");
    $("gesSub").textContent = fechaLarga(g.fecha) + " (" + textoCorte() + "). El sensor de la puerta cuenta a los gestores " +
      "como pasajeros: con su código, la tarjeta los resta.";
    if (!state.v8) {
      cuerpo.innerHTML = '<p class="caja-error">Falta correr la versión 8 del SQL de la tarjeta en Supabase. Con ella llegan los ' +
        "celulares de los gestores y lo que leen los conductores.</p>";
      return;
    }
    if (!state.revisor) {
      cuerpo.innerHTML = '<p class="vacio">Solo los despachadores (tarjeta_revisores) ven los gestores y aprueban sus celulares.</p>';
      return;
    }
    if (!g.lecturas) {
      cuerpo.innerHTML = g.error ? cajaError("No se pudo traer lo de los gestores: " + textoError(g.error), "recargar-gestores")
        : '<p class="cargando">Trayendo lo de los gestores…</p>';
      return;
    }
    var pendientes = (g.celulares || []).filter(function (c) { return c.estado === "pendiente"; });
    var aprobados = (g.celulares || []).filter(function (c) { return c.estado === "aprobado"; });
    var restadas = g.lecturas.filter(function (x) { return x.resta; }).length;
    var raras = g.lecturas.filter(function (x) { return !x.resta && /^Sospechoso/.test(x.motivo || ""); }).length;
    function caja(titulo, grande, chico, tono) {
      return '<div class="total"' + (tono ? ' data-tono="' + tono + '"' : "") + "><span>" + titulo + "</span><strong>" + grande + "</strong>" +
        (chico ? "<small>" + chico + "</small>" : "") + "</div>";
    }
    var html = '<div class="totales">' +
      caja("Códigos leídos", g.lecturas.length, "por los conductores este día") +
      caja("Se restaron", restadas, "no cuentan como pasajeros", restadas ? "bien" : "") +
      caja("No se restaron", g.lecturas.length - restadas - raras, "el motivo está en cada uno", g.lecturas.length - restadas - raras ? "revisa" : "") +
      caja("Sospechosos", raras, raras ? "revíselos" : "ninguno", raras ? "mal" : "") +
      caja("Celulares por aprobar", pendientes.length, aprobados.length + " aprobados", pendientes.length ? "revisa" : "") +
      "</div>";

    html += '<div class="bloque"><h2 class="titulo-bloque">Celulares por aprobar</h2>' + (pendientes.length
      ? '<p class="nota">Mire que la foto sea de la persona. Al aprobarlo, su código sirve en todos los buses.</p>' +
        '<div class="celulares">' + pendientes.map(tarjetaCelular).join("") + "</div>"
      : '<p class="nota">Ningún celular esperando. El gestor lo pide desde el Portal del Conductor, en Mi código.</p>') + "</div>";

    html += '<div class="bloque"><h2 class="titulo-bloque">Lo que leyeron los conductores</h2>';
    if (!g.lecturas.length) {
      html += '<p class="vacio">Ningún conductor leyó códigos de gestores este día. Lo leído aparece después de la siguiente ' +
        "vuelta del programa de la oficina (cada 5 minutos).</p>";
    } else {
      html += '<div class="tabla-caja"><table><thead><tr><th>Hora</th><th>Bus</th><th>Gestor</th><th>Dónde</th><th>Resultado</th></tr></thead><tbody>' +
        g.lecturas.map(function (x) {
          return '<tr class="fila-link" tabindex="0" data-bus="' + esc(x.interno) + '" data-fecha="' + esc(x.dia) + '">' +
            '<td class="num">' + hora(x.leido_en) + "</td><td><strong>" + esc(x.interno) + "</strong></td>" +
            "<td>" + esc(capitalizar(x.nombre || "Sin nombre")) + '<span class="menor">cédula ···' + esc(String(x.dni || "").slice(-4)) + "</span></td>" +
            "<td>" + esc(x.donde || "—") + "</td>" +
            "<td>" + resultadoGestor(x) + (x.motivo ? '<span class="menor">' + esc(x.motivo) + "</span>" : "") + "</td></tr>";
        }).join("") + "</tbody></table></div>";
    }
    html += "</div>";

    html += '<div class="bloque"><h2 class="titulo-bloque">Celulares aprobados</h2>' + (aprobados.length
      ? '<div class="celulares">' + aprobados.map(tarjetaCelular).join("") + "</div>"
      : '<p class="nota">Todavía no hay celulares aprobados.</p>') + "</div>";
    cuerpo.innerHTML = html;
  }

  // Aprobar, rechazar o quitar el celular de un gestor (gestor_revisar_celular: solo un despachador)
  function abrirRevisarCelular(id, accion) {
    var c = (state.ges.celulares || []).filter(function (x) { return String(x.id) === String(id); })[0];
    if (!c) return;
    var aprobar = accion === "aprobar";
    var titulos = { aprobar: "Aprobar el celular", rechazar: "Rechazar el celular", quitar: "Quitar el celular" };
    var explica = {
      aprobar: "Desde ya, los códigos de " + capitalizar(c.nombre) + " sirven en todos los buses y se restan de los pasajeros." +
        ((state.ges.celulares || []).some(function (x) { return x.dni === c.dni && x.estado === "aprobado"; })
          ? " El celular que tenía aprobado deja de servir." : ""),
      rechazar: "El gestor tiene que activar su celular otra vez (por ejemplo, con otra foto).",
      quitar: "Sus códigos dejan de servir desde ya. Lo de antes se queda como estaba.",
    };
    abrirHoja(titulos[accion],
      (/^data:image\//.test(c.selfie || "") ? '<img class="selfie selfie-grande" src="' + esc(c.selfie) + '" alt="Selfie">' : "") +
      "<p><strong>" + esc(capitalizar(c.nombre)) + "</strong> · " + esc(capitalizar(c.cargo)) + " · cédula " + esc(c.dni) + "</p>" +
      '<p class="nota">' + esc(explica[accion]) + "</p>" +
      '<form id="formCelular" novalidate><label class="campo"><span>Nota' + (aprobar ? " (si quiere)" : " (obligatoria: por qué)") + "</span>" +
        '<textarea id="celularNota" maxlength="300"></textarea></label>' +
        '<p id="celularError" class="error" hidden style="margin-top:10px"></p>' +
        '<div class="acciones"><button class="btn ' + (aprobar ? "btn-primario" : "btn-peligro") + '" type="submit" id="celularGuardar">' +
          esc(titulos[accion].replace(" el celular", "")) + '</button><button class="btn" type="button" data-cerrar-hoja>Cancelar</button></div></form>',
      function (caja) {
        caja.querySelector("#formCelular").addEventListener("submit", async function (ev) {
          ev.preventDefault();
          var nota = $("celularNota").value.trim();
          if (!aprobar && !nota) {
            $("celularError").textContent = "Escriba por qué.";
            $("celularError").hidden = false;
            return;
          }
          $("celularGuardar").disabled = true;
          try {
            var res = await conTiempo(client.rpc("gestor_revisar_celular", { p_id: c.id, p_aprobar: aprobar, p_nota: nota || null }));
            if (res.error) throw res.error;
            cerrarHoja();
            aviso(aprobar ? "Celular aprobado." : accion === "quitar" ? "Celular quitado." : "Celular rechazado.");
            cargarGestores();
          } catch (err) {
            $("celularError").textContent = textoError(err);
            $("celularError").hidden = false;
            $("celularGuardar").disabled = false;
          }
        });
      });
  }

  // ================================================================ MOVILIDAD: la "Base de datos" de Movilidad 2026
  // Un renglón por bus y día con las mismas 25 columnas del Excel de movilidad, como lo sacaba la plantilla
  // 700control (github DesarrolloCombuses/700control) con el archivo de Sonar. Sale de lo que publica el programa
  // de la tarjeta, con la regla de 700control (decidida el 15-oct-2026):
  //   Sonar             = todo lo que contó la puerta entrando en el día: en los viajes y fuera del viaje a viaje
  //   Sin ruta          = lo que entró fuera del viaje a viaje (en la ruta sin viaje, y en el patio o el taller).
  //                       Ya va dentro de Sonar y de los ingresos: la columna solo lo muestra
  //   Descuento>20      = 0: sin tope
  //   Ajustes           = los que escriben aquí los despachadores (taller, despachador...) + los gestores con código
  //                       + lo que control corrigió en un viaje
  //   Ingresos totales  = Sonar - Descuento>20 - Viajes realizados - Ajustes
  //   Viajes realizados = los viajes con despacho (los sin despacho suman en Sonar, pero no restan)
  //   Pasajeros metro   = los usos del Mifare de ese bus (Cargar Mifare, más abajo)
  //   Salidas P1       = lo que contó bajando en los viajes + lo que bajó fuera de ellos;   Salidas P2 = 0
  //   Total salidas     = Salidas P1 + Salidas P2 - Viajes realizados - Ajustes;   Dif = Ingresos - Total salidas
  // En el Excel, Ingresos, Total salidas y Dif van con esas fórmulas. Lo escrito a mano va en movilidad_ajustes y
  // los archivos planos (Metro, cívica) en movilidad_externos (almacentro/enturnes/sql/movilidad.sql, versión 2:
  // trae también las salidas fuera de los viajes). Sin ese SQL se ve igual, pero sin ajustes ni lo de fuera.
  var MOV_COLUMNAS = ["Vehiculo", "Ingresos totales", null, "Salidas P1", " Salidas P2", "Total salidas", "Dif", "Ruta",
    "Fecha", "Mes", "Año", "# Día", "Base", "Ajustes", "Sin ruta", "Barrial", "Pasajeros metro", "Descuento>20", "No labora",
    "Observaciones", "Sonar ", "Viajes realizados", "SUB-RUTA", "A-G", "Observaciones pasajero 20"];
  // En las observaciones van en este orden, como en el Excel ("Taller - Administrativo - Despachador").
  var MOV_MOTIVOS = ["Taller", "Administrativo", "Despachador", "Otro"];
  var MOV_MAX_DIAS = 62;
  var MOV_RUTA = "700";
  var MESES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre",
    "Noviembre", "Diciembre"];
  var DIAS_SEMANA = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
  var CAMPOS_MOV_BUS = "dia,interno,placa,programado,viajes,estado,aviso";
  var CAMPOS_MOV_ENTRADAS = ",entradas_sin_viaje,entradas_fuera_ruta";
  var CAMPOS_MOV_SALIDAS = ",salidas_sin_viaje,salidas_fuera_ruta";
  // En el Excel de movilidad el bus va como texto y con un espacio al final ("703 "), menos estos dos: así lo
  // agrupan las tablas dinámicas, y un "703" sin espacio saldría como otro bus.
  var MOV_SIN_ESPACIO = ["710", "756"];

  function textoDeError(err) { return String((err && ((err.code || "") + " " + (err.message || ""))) || ""); }
  function faltaTabla(err) {
    var m = textoDeError(err);
    return /PGRST205|42P01|Could not find the table|does not exist/i.test(m) && !/column/i.test(m);
  }
  function faltaColumna(err) { return /42703|PGRST204|column/i.test(textoDeError(err)); }

  function abrirMovilidad(desde, hasta) {
    var m = state.mov;
    var cambio = m.desde !== desde || m.hasta !== hasta;
    m.desde = desde;
    m.hasta = hasta;
    $("movDesde").value = desde;
    $("movHasta").value = hasta;
    actualizarPestanas();
    if (cambio || (!m.filas && !m.cargando)) {
      m.filas = null;
      m.error = null;
      if (cambio) m.filtro = filtroMovVacio();
      pintarMovilidad();
      cargarMovilidad();
    } else {
      pintarMovilidad();
    }
  }

  function rangoMovilidadMalo(m) {
    if (!esFecha(m.desde) || !esFecha(m.hasta)) return "Escoja las dos fechas.";
    if (m.desde > m.hasta) return "La fecha de inicio va antes que la final.";
    if (diasEntre(m.desde, m.hasta) >= MOV_MAX_DIAS) return "Máximo " + MOV_MAX_DIAS + " días a la vez.";
    return "";
  }

  async function cargarMovilidad() {
    var m = state.mov, desde = m.desde, hasta = m.hasta;
    if (rangoMovilidadMalo(m)) return pintarMovilidad();
    m.cargando = true;
    $("movExcel").disabled = true;
    function sigue() { return m.desde === desde && m.hasta === hasta; }
    try {
      var entradas = true, salidas = true, tablas = true;
      function rango(q) { return q.gte("dia", desde).lte("dia", hasta); }
      function deBuses(campos) {
        return traerTodo(function () { return rango(client.from("tarjeta_buses_dia").select(campos)).order("dia").order("interno"); });
      }
      // Sin movilidad.sql, tarjeta_buses_dia no trae lo que entró y salió fuera de los viajes, ni están los ajustes.
      // Con la versión 1 trae lo que entró pero no lo que salió.
      var estados = deBuses(CAMPOS_MOV_BUS + CAMPOS_MOV_ENTRADAS + CAMPOS_MOV_SALIDAS).catch(function (err) {
        if (!faltaColumna(err)) throw err;
        salidas = false;
        return deBuses(CAMPOS_MOV_BUS + CAMPOS_MOV_ENTRADAS).catch(function (err2) {
          if (!faltaColumna(err2)) throw err2;
          entradas = false;
          return deBuses(CAMPOS_MOV_BUS);
        });
      });
      // Por tandas de 1.000: el orden tiene que ser por la llave, o una tanda repite o salta renglones.
      function deMovilidad(tabla, campos, orden) {
        return traerTodo(function () {
          return orden.reduce(function (q, c) { return q.order(c); }, rango(client.from(tabla).select(campos)));
        }).catch(function (err) {
          if (!faltaTabla(err)) throw err;
          tablas = false;
          return [];
        });
      }
      var res = await Promise.all([
        traerTodo(function () {
          return rango(client.from("v_tarjeta_viajes").select("dia,interno,clave,sin_despacho,pasajeros,pasajeros_sensor,subidas,recortados," +
            "estado_calculo" + (state.v8 ? ",gestores" : ""))).order("dia").order("interno").order("clave");
        }),
        traerTodo(function () { return rango(client.from("tarjeta_viajes").select("clave,bajadas")).order("clave"); }),
        estados,
        traerBases(desde, hasta).catch(function () { return null; }),
        deMovilidad("movilidad_ajustes", "*", ["id"]),
        deMovilidad("movilidad_externos", "dia,interno,fuente,cantidad,archivo,cargado_por_correo,cargado_en", ["dia", "interno", "fuente"]),
        traerTodo(function () { return rango(client.from("tarjeta_dia_manual").select("dia,interno,observaciones")).order("dia").order("interno"); })
          .catch(function () { return []; }),
      ]);
      if (!sigue()) return;
      m.datos = { viajes: res[0], bajadas: res[1], estados: res[2], porBus: res[3], ajustes: res[4], externos: res[5], manual: res[6] };
      m.entradas = entradas;
      m.salidas = salidas;
      m.tablas = tablas;
      m.filas = armarMovilidad(m.datos);
      m.error = null;
      m.cargadoEn = Date.now();
    } catch (err) {
      if (sigue()) m.error = err;
    } finally {
      m.cargando = false;
      if (state.vista === "movilidad" && sigue()) pintarMovilidad();
    }
  }

  // Después de escribir o anular un ajuste: solo se vuelven a pedir los ajustes.
  async function recargarAjustesMov() {
    var m = state.mov, desde = m.desde, hasta = m.hasta;
    try {
      var ajustes = await traerTodo(function () {
        return client.from("movilidad_ajustes").select("*").gte("dia", desde).lte("dia", hasta).order("id");
      });
      if (m.desde !== desde || m.hasta !== hasta || !m.datos) return;
      m.datos.ajustes = ajustes;
      m.filas = armarMovilidad(m.datos);
    } catch (err) {
      aviso("Quedó guardado, pero no se pudo volver a traer: " + textoError(err), "mal");
    }
    if (state.vista === "movilidad") pintarMovilidad();
  }

  function armarMovilidad(d) {
    var bajadas = {}, filas = {};
    d.bajadas.forEach(function (x) { bajadas[x.clave] = n(x.bajadas); });
    function fila(dia, interno) {
      interno = String(interno == null ? "" : interno).trim();
      var k = dia + "|" + interno;
      return filas[k] || (filas[k] = {
        dia: dia, interno: interno, base: baseEn(d.porBus, interno, dia), viajes: 0, sd: 0, subidas: 0, bajadas: 0,
        recortados: 0, gestores: 0, pasajeros: 0, correccion: 0, enCurso: 0, sinViaje: null, fueraRuta: null,
        salenSinViaje: null, salenFueraRuta: null,
        ajustes: [], manual: 0, metro: null, civica: null, estado: null, aviso: "", obs: "",
      });
    }
    d.estados.forEach(function (e) {
      if (e.interno === "PRUEBA") return;
      var r = fila(e.dia, e.interno);
      r.estado = e.estado;
      r.aviso = e.aviso || "";
      if (e.entradas_sin_viaje != null) r.sinViaje = n(e.entradas_sin_viaje);
      if (e.entradas_fuera_ruta != null) r.fueraRuta = n(e.entradas_fuera_ruta);
      if (e.salidas_sin_viaje != null) r.salenSinViaje = n(e.salidas_sin_viaje);
      if (e.salidas_fuera_ruta != null) r.salenFueraRuta = n(e.salidas_fuera_ruta);
    });
    d.viajes.forEach(function (v) {
      if (v.interno === "PRUEBA") return;
      var r = fila(v.dia, v.interno);
      r.viajes++;
      if (v.sin_despacho) r.sd++;
      r.subidas += n(v.subidas);
      r.bajadas += bajadas[v.clave] || 0;
      r.recortados += n(v.recortados);
      r.gestores += n(v.gestores);
      r.pasajeros += n(v.pasajeros);
      r.correccion += n(v.pasajeros_sensor) - n(v.pasajeros);   // control corrigió el conteo de un viaje
      if (v.estado_calculo === "en_curso") r.enCurso++;
    });
    d.ajustes.forEach(function (a) {
      var r = fila(a.dia, a.interno);
      r.ajustes.push(a);
      if (!a.anulado_en) r.manual += n(a.cantidad);
    });
    // Con el archivo del Metro cargado para un día, el bus que no sale en él tuvo 0 (como en el Excel), no "—".
    var conMetro = {};
    d.externos.forEach(function (x) {
      fila(x.dia, x.interno)[x.fuente === "civica" ? "civica" : "metro"] = n(x.cantidad);
      if (x.fuente !== "civica") conMetro[x.dia] = true;
    });
    Object.keys(filas).forEach(function (k) { if (filas[k].metro == null && conMetro[filas[k].dia]) filas[k].metro = 0; });
    d.manual.forEach(function (x) {
      var r = filas[x.dia + "|" + String(x.interno).trim()];
      if (r && x.observaciones) r.obs = String(x.observaciones).trim();
    });
    return Object.keys(filas).map(function (k) { return calcularMovilidad(filas[k]); }).sort(function (a, b) {
      return a.dia < b.dia ? -1 : a.dia > b.dia ? 1 : compararInternos(a.interno, b.interno);
    });
  }

  function calcularMovilidad(r) {
    r.sinRuta = r.sinViaje == null && r.fueraRuta == null ? null : n(r.sinViaje) + n(r.fueraRuta);
    r.salenFuera = r.salenSinViaje == null && r.salenFueraRuta == null ? null : n(r.salenSinViaje) + n(r.salenFueraRuta);
    r.sonar = r.subidas + n(r.sinRuta);
    r.descuento = 0;                                  // Descuento>20 en cero: sin tope (15-oct-2026)
    r.ajuste = r.manual + r.gestores + r.correccion;
    // Viajes realizados: solo los que tienen despacho. Los sin despacho Sonar los pone como "sin ruta": su gente
    // suma en Sonar, pero no restan 1 (así coincide con la movilidad hecha con 700control, 15-oct-2026).
    r.viajesReal = r.viajes - r.sd;
    r.ingresos = r.sonar - r.descuento - r.viajesReal - r.ajuste;
    r.salidasP1 = r.bajadas + n(r.salenFuera);
    r.salidasP2 = 0;                                  // el sensor no separa las puertas
    r.salidas = r.salidasP1 + r.salidasP2 - r.viajesReal - r.ajuste;
    r.dif = r.ingresos - r.salidas;
    var partes = [];
    MOV_MOTIVOS.forEach(function (motivo) {
      var suyos = r.ajustes.filter(function (a) { return !a.anulado_en && a.motivo === motivo; });
      if (!suyos.length) return;
      if (motivo === "Otro") suyos.forEach(function (a) { partes.push(a.nota || "Otro"); });
      else partes.push(motivo);
    });
    if (r.gestores) partes.push(r.gestores === 1 ? "Gestor" : "Gestores");
    if (r.correccion) partes.push("Corrección de control");
    if (!r.viajes) partes.push("No laboró");
    if (r.obs) partes.push(r.obs);
    r.observaciones = partes.join(" - ");
    r.faltante = r.estado === "no_esta_en_sonar";
    return r;
  }

  function resumenMovilidadPorDia(filas) {
    var dias = {};
    filas.forEach(function (r) {
      var d = dias[r.dia] || (dias[r.dia] = { dia: r.dia, filas: [], buses: 0, trabajaron: 0, viajes: 0, viajesReal: 0, sd: 0, sonar: 0,
        sinRuta: null, salenFuera: null, descuento: 0, ajuste: 0, gestores: 0, ingresos: 0, salidasP1: 0, salidas: 0, dif: 0,
        metro: null, enCurso: 0 });
      d.filas.push(r);
      d.buses++;
      if (r.viajes) d.trabajaron++;
      ["viajes", "viajesReal", "sd", "sonar", "descuento", "ajuste", "gestores", "ingresos", "salidasP1", "salidas", "dif", "enCurso"].forEach(function (c) { d[c] += r[c]; });
      if (r.sinRuta != null) d.sinRuta = n(d.sinRuta) + r.sinRuta;
      if (r.salenFuera != null) d.salenFuera = n(d.salenFuera) + r.salenFuera;
      if (r.metro != null) d.metro = n(d.metro) + r.metro;
    });
    return Object.keys(dias).sort().map(function (k) { return dias[k]; });
  }

  function numMov(x) { return x == null ? "—" : miles(x) === "0" ? "0" : (x < 0 ? "−" : "") + miles(x); }
  function diaSemana(dia) { return DIAS_SEMANA[new Date(dia + "T12:00:00Z").getUTCDay()]; }
  function fechaMov(dia) { var p = dia.split("-"); return p[2] + "/" + p[1] + "/" + p[0]; }   // 14/10/2026, como 700control
  function filtroMovVacio() { return { dia: "", base: "", difNeg: false, metro20: false, texto: "", vehiculos: [] }; }

  // Lo que dejan ver los filtros, como en 700control: día, base, Dif < 0, Metro > 20, el texto y los vehículos.
  function filtrarMovilidad(filas) {
    var f = state.mov.filtro;
    var texto = f.texto.trim().toLowerCase();
    return filas.filter(function (r) {
      if (f.dia && r.dia !== f.dia) return false;
      if (f.base && String(r.base || "") !== f.base) return false;
      if (f.difNeg && !(r.dif < 0)) return false;
      if (f.metro20 && !(n(r.metro) > 20)) return false;
      if (f.vehiculos.length && f.vehiculos.indexOf(r.interno) < 0) return false;
      if (texto && celdasMov(r).join(" ").toLowerCase().indexOf(texto) < 0) return false;
      return true;
    });
  }

  // El renglón como se ve en la pantalla: las columnas de la Base de datos, sin la que no tiene título (la C).
  var MOV_TITULOS = ["Vehiculo", "Ingresos totales", "Salidas P1", "Salidas P2", "Total salidas", "Dif", "Ruta", "Fecha", "Mes",
    "Año", "# Día", "Base", "Ajustes", "Sin ruta", "Barrial", "Pasajeros metro", "Descuento>20", "No labora", "Observaciones",
    "Sonar", "Viajes realizados", "SUB-RUTA", "A-G", "Observaciones pasajero 20"];
  var MOV_COLOR_TITULO = { "Sin ruta": "x-sinruta", "Barrial": "x-barrial", "Pasajeros metro": "x-metro", "Descuento>20": "x-desc" };
  var MOV_NUMEROS = ["Ingresos totales", "Salidas P1", "Salidas P2", "Total salidas", "Dif", "Año", "Ajustes", "Sin ruta",
    "Pasajeros metro", "Descuento>20", "Sonar", "Viajes realizados"];
  function celdasMov(r) {
    var f = new Date(r.dia + "T12:00:00Z");
    return [r.interno, r.ingresos, r.salidasP1, r.salidasP2, r.salidas, r.dif, MOV_RUTA, fechaMov(r.dia), MESES[f.getUTCMonth()],
      f.getUTCFullYear(), DIAS_SEMANA[f.getUTCDay()], baseNumero(r.base), r.ajuste, r.sinRuta, "", r.metro, r.descuento, "",
      r.observaciones || "", r.sonar, r.viajesReal, "", "", r.faltante ? "Vehículo faltante" : ""];
  }

  function pintarMovilidad() {
    var m = state.mov, cuerpo = $("movCuerpo");
    var malo = rangoMovilidadMalo(m);
    $("movMifare").hidden = !(state.revisor && m.tablas);       // cargar el Metro: solo los despachadores
    $("movSub").textContent = malo ? "Un renglón por bus y día, como la Base de datos de Movilidad 2026." :
      "Ruta " + MOV_RUTA + " · del " + fechaCorta(m.desde) + " al " + fechaCorta(m.hasta) + " · cada día va " + textoCorte() + ".";
    if (malo || !m.filas) {
      $("movExcel").disabled = true;
      $("movFiltros").hidden = true;
      $("movTabla").innerHTML = "";
      cuerpo.innerHTML = malo ? '<p class="vacio">' + esc(malo) + "</p>"
        : m.error ? cajaError("No se pudo traer la movilidad: " + textoError(m.error), "recargar-movilidad")
        : '<p class="cargando">Trayendo los viajes y los buses de esos días…</p>';
      return;
    }
    $("movExcel").disabled = !m.filas.length;
    var dias = resumenMovilidadPorDia(m.filas);
    var t = resumenMovilidadPorDia(m.filas.map(function (r) { return Object.assign({}, r, { dia: "todo" }); }))[0];
    var html = "";
    var falta = !m.tablas
      ? "Falta correr <strong>movilidad.sql</strong> en Supabase: sin él no se pueden escribir los ajustes ni cargar el Metro, y Sonar sale solo con lo de los viajes."
      : !m.entradas ? "Sonar sale solo con lo de los viajes: el programa de la oficina todavía no ha publicado lo que entró fuera de ellos (Sin ruta)."
      : !m.salidas ? "Falta correr otra vez <strong>movilidad.sql</strong> (la versión 2) en Supabase: sin ella, Salidas P1 sale solo con lo que bajó en los viajes, y la Dif de los buses que movieron gente fuera del viaje a viaje sale alta."
      : dias.some(function (d) { return d.sinRuta == null; }) ? "Algunos días no tienen lo que entró fuera del viaje a viaje (Sin ruta): en esos, Sonar sale solo con lo de los viajes. Se completan recargando esos días con el programa nuevo."
      : dias.some(function (d) { return d.salenFuera == null; }) ? "Algunos días no tienen lo que bajó fuera de los viajes: en esos, Salidas P1 sale solo con lo de los viajes y la Dif puede salir alta. Se completan recargando esos días con el programa nuevo."
      : "";
    if (falta) html += '<p class="aviso-programa">' + falta + "</p>";
    if (t) {
      html += '<div class="totales">' +
        '<div class="total"><span>Días</span><strong>' + dias.length + "</strong><small>" + miles(t.buses) + " renglones bus-día</small></div>" +
        '<div class="total"><span>Viajes realizados</span><strong>' + miles(t.viajesReal) + "</strong><small>con despacho; " + miles(t.sd) +
          " sin despacho no restan</small></div>" +
        '<div class="total"><span>Sonar</span><strong>' + numMov(t.sonar) + "</strong><small>Sin ruta: " + numMov(t.sinRuta) + "</small></div>" +
        '<div class="total"><span>Ajustes</span><strong>' + numMov(t.ajuste) + "</strong><small>" +
          (t.gestores ? numMov(t.gestores) + " de gestores con código" : "escritos por los despachadores") + "</small></div>" +
        '<div class="total" data-tono="bien"><span>Ingresos totales</span><strong>' + numMov(t.ingresos) + "</strong><small>Total salidas " +
          numMov(t.salidas) + " · Dif " + numMov(t.dif) + "</small></div>" +
        '<div class="total"><span>Pasajeros metro</span><strong>' + numMov(t.metro) + "</strong><small>" +
          (t.metro == null ? "todavía no se ha cargado el archivo" : "de los archivos cargados") + "</small></div>" +
        "</div>";
    }
    var hoy = diaDeHoy(), elegido = m.filtro.dia;
    html += '<details class="mov-resumen" id="movResumen"' + (m.resumenAbierto ? " open" : "") + "><summary>Resumen por día</summary>" +
      '<div class="tabla-caja"><table class="tabla-mov-dias"><thead><tr><th>Día</th><th class="n">Buses</th><th class="n">Viajes</th>' +
      '<th class="n">Sonar</th><th class="n">Sin ruta</th><th class="n">Ajustes</th><th class="n">Ingresos</th>' +
      '<th class="n">Total salidas</th><th class="n">Dif</th><th class="n">Metro</th><th></th></tr></thead><tbody>';
    if (!dias.length) html += '<tr><td colspan="11" class="vacio">No hay nada publicado en esas fechas.</td></tr>';
    dias.forEach(function (d) {
      html += '<tr class="fila-link' + (elegido === d.dia ? " elegida" : "") + '" tabindex="0" data-mov-dia="' + esc(d.dia) + '">' +
        "<td><strong>" + esc(fechaCorta(d.dia)) + '</strong><span class="menor">' + esc(diaSemana(d.dia)) + "</span></td>" +
        '<td class="n">' + d.trabajaron + "/" + d.buses + '</td><td class="n">' + d.viajesReal + '</td><td class="n">' + numMov(d.sonar) +
        '</td><td class="n">' + numMov(d.sinRuta) + '</td><td class="n">' + numMov(d.ajuste) +
        '</td><td class="n"><strong>' + numMov(d.ingresos) + '</strong></td><td class="n">' + numMov(d.salidas) +
        '</td><td class="n">' + numMov(d.dif) + '</td><td class="n">' + numMov(d.metro) + "</td><td>" +
        (d.dia === hoy || d.enCurso ? chip("revisa", d.dia === hoy ? "Hoy: todavía cambia" : "Con viajes en camino") : "") + "</td></tr>";
    });
    html += "</tbody></table></div></details>";
    cuerpo.innerHTML = html;
    pintarFiltrosMov(dias);
    pintarTablaMov();
  }

  function pintarFiltrosMov(dias) {
    var m = state.mov, f = m.filtro;
    var bases = {};
    m.filas.forEach(function (r) { if (r.base) bases[r.base] = true; });
    if (f.dia && !dias.some(function (d) { return d.dia === f.dia; })) f.dia = "";
    if (f.base && !bases[f.base]) f.base = "";
    $("movDia").innerHTML = '<option value="">Todos los días</option>' + dias.map(function (d) {
      return '<option value="' + esc(d.dia) + '">' + esc(diaSemana(d.dia) + " " + fechaMov(d.dia)) + "</option>";
    }).join("");
    $("movDia").value = f.dia;
    $("movBase").innerHTML = '<option value="">Todas las bases</option>' + Object.keys(bases).sort(function (a, b) {
      return a.localeCompare(b, "es", { numeric: true });
    }).map(function (b) { return '<option value="' + esc(b) + '">' + esc(b) + "</option>"; }).join("");
    $("movBase").value = f.base;
    $("movDifNeg").setAttribute("aria-pressed", String(f.difNeg));
    $("movMetro20").setAttribute("aria-pressed", String(f.metro20));
    if ($("movBuscar").value !== f.texto) $("movBuscar").value = f.texto;
    $("movVehiculos").textContent = f.vehiculos.length ? "Vehículos: " + f.vehiculos.length : "Vehículos: todos";
    $("movFiltros").hidden = !m.filas.length;
  }

  // La Base de datos en la pantalla: las mismas columnas del Excel y, abajo, los totales de lo que se ve.
  function pintarTablaMov() {
    var m = state.mov;
    if (!m.filas || !m.filas.length) { $("movTabla").innerHTML = ""; return; }
    var filas = filtrarMovilidad(m.filas);
    var puede = state.revisor && m.tablas;
    var suma = {};
    var html = '<p class="pie">' + (filas.length === m.filas.length ? miles(filas.length) + " renglones" :
      miles(filas.length) + " de " + miles(m.filas.length) + " renglones (con los filtros)") +
      (m.cargadoEn ? " · actualizado a las " + fmtHora.format(new Date(m.cargadoEn)) : "") + "</p>" +
      '<div class="tabla-caja"><table class="tabla-mov"><thead><tr>' + MOV_TITULOS.map(function (c, i) {
        var clases = [i === 0 ? "fijo" : "", MOV_NUMEROS.indexOf(c) >= 0 ? "n" : "", MOV_COLOR_TITULO[c] || ""].filter(Boolean).join(" ");
        return "<th" + (clases ? ' class="' + clases + '"' : "") + ">" + esc(c) + "</th>";
      }).join("") + "</tr></thead><tbody>";
    if (!filas.length) html += '<tr><td colspan="' + MOV_TITULOS.length + '" class="vacio">Ningún renglón con esos filtros.</td></tr>';
    filas.forEach(function (r) {
      var c = celdasMov(r);
      MOV_TITULOS.forEach(function (t, i) { if (MOV_NUMEROS.indexOf(t) >= 0 && t !== "Año" && c[i] != null) suma[t] = n(suma[t]) + c[i]; });
      var vigentes = r.ajustes.filter(function (a) { return !a.anulado_en; });
      var boton = puede || r.ajustes.length
        ? ' <button class="btn btn-chico" type="button" data-mov-ajuste="' + esc(r.interno) + '" data-mov-ajuste-dia="' + esc(r.dia) + '">' +
          (puede ? (vigentes.length ? "Cambiar" : "+ Ajuste") : "Ver") + "</button>" : "";
      html += "<tr" + (r.viajes ? "" : ' class="apagado"') + ">" + MOV_TITULOS.map(function (t, i) {
        var v = c[i];
        if (i === 0) return '<td class="fijo"><a class="bus-num" href="#/bus/' + encodeURIComponent(r.interno) + "/" + r.dia + '">' + esc(v) + "</a></td>";
        if (t === "Ingresos totales") return '<td class="n"><strong>' + numMov(v) + "</strong></td>";
        if (t === "Dif") return '<td class="n' + (v > 30 ? " dif-alta" : "") + '">' + numMov(v) + "</td>";
        if (t === "Ajustes") return '<td class="n mov-ajustes">' + numMov(v) + boton + "</td>";
        if (t === "Viajes realizados") return '<td class="n">' + v + (r.sd ? '<span class="menor">+' + r.sd + " sin desp.</span>" : "") + "</td>";
        if (t === "Año") return '<td class="n">' + v + "</td>";
        if (MOV_NUMEROS.indexOf(t) >= 0) return '<td class="n">' + numMov(v) + "</td>";
        return "<td" + (t === "Observaciones" ? ' class="obs"' : "") + ">" + esc(v == null ? "" : v) + "</td>";
      }).join("") + "</tr>";
    });
    html += "</tbody>";
    if (filas.length) {
      html += "<tfoot><tr>" + MOV_TITULOS.map(function (t, i) {
        if (i === 0) return '<td class="fijo">Total</td>';
        if (t === "Año" || MOV_NUMEROS.indexOf(t) < 0) return "<td></td>";
        return '<td class="n">' + (suma[t] == null ? "—" : numMov(suma[t])) + "</td>";
      }).join("") + "</tr></tfoot>";
    }
    html += "</table></div>" +
      '<p class="pie">Ingresos totales = Sonar − Descuento&gt;20 − Viajes realizados − Ajustes. Total salidas = Salidas P1 + Salidas P2 − ' +
      "Viajes realizados − Ajustes. Dif = Ingresos − Total salidas. Sin ruta (lo de fuera del viaje a viaje) ya va dentro de Sonar. " +
      "Viajes realizados cuenta los viajes con despacho: los sin despacho suman en Sonar, pero no restan." +
      (puede ? " Los ajustes se escriben con el botón de cada bus." : "") + "</p>";
    $("movTabla").innerHTML = html;
  }

  function abrirVehiculosMov() {
    var m = state.mov;
    if (!m.filas) return;
    var internos = [];
    m.filas.forEach(function (r) { if (internos.indexOf(r.interno) < 0) internos.push(r.interno); });
    internos.sort(compararInternos);
    var elegidos = m.filtro.vehiculos;
    abrirHoja("Seleccionar vehículos",
      '<div class="vehiculos-grid">' + internos.map(function (i) {
        return '<label><input type="checkbox" value="' + esc(i) + '"' + (!elegidos.length || elegidos.indexOf(i) >= 0 ? " checked" : "") +
          "> " + esc(i) + "</label>";
      }).join("") + "</div>" +
      '<div class="acciones"><button class="btn" type="button" id="vehTodos">Todos</button>' +
      '<button class="btn" type="button" id="vehNinguno">Ninguno</button>' +
      '<button class="btn btn-primario" type="button" id="vehAplicar">Aplicar</button></div>',
      function (caja) {
        function marcar(si) { Array.prototype.forEach.call(caja.querySelectorAll("input[type=checkbox]"), function (c) { c.checked = si; }); }
        caja.querySelector("#vehTodos").addEventListener("click", function () { marcar(true); });
        caja.querySelector("#vehNinguno").addEventListener("click", function () { marcar(false); });
        caja.querySelector("#vehAplicar").addEventListener("click", function () {
          var marcados = Array.prototype.map.call(caja.querySelectorAll("input[type=checkbox]:checked"), function (c) { return c.value; });
          m.filtro.vehiculos = marcados.length === internos.length ? [] : marcados;     // ninguno o todos: sin filtro
          cerrarHoja();
          pintarMovilidad();
        });
      });
  }

  // ---------------------------------------------------------------- el Metro: los archivos del Mifare
  // LiquidacionUsosTransporteMifare DD-MM-AAAA.xlsx (uno por día, o varios en un .zip), hoja "Liquidación Usos
  // Transporte": un renglón por equipo (la placa del bus) y tipo de recorrido, con su "Total Cantidad", y arriba los
  // tipos de usuario (adulto mayor, frecuentes, metro estándar...). Decidido el 15-oct-2026:
  //   - cada archivo va al DÍA EN QUE SE USARON los pasajes, el que dice "Fecha de Uso de ...": el "01-10" trae del
  //     30-sep 2:30 a. m. al 01-oct 2:29 a. m. (el nombre es el día de la liquidación), y eso es el 30-sep de Sonar;
  //   - la placa se pasa a número de bus con las placas de Sonar (la tabla de los archivos tenía cambiados 708 con
  //     757 y 723 con 751: el 757 no trabajó el 9 ni el 10 de octubre y "su" placa tuvo usos).
  // Cargar otra vez el mismo día lo reemplaza: el bus que ya no sale en el archivo queda en 0.
  function numeroMifare(x) { var v = Number(x); return isFinite(v) ? v : 0; }
  function textoCelda(c) { return String(c == null ? "" : c).trim(); }

  function leerMifare(bytes) {
    var libro = XLSX.read(bytes, { type: "array" });
    var filas = null, iCab = -1;
    libro.SheetNames.some(function (nombre) {
      var f = XLSX.utils.sheet_to_json(libro.Sheets[nombre], { header: 1, defval: null, raw: true });
      var i = f.findIndex(function (r) {
        var t = (r || []).map(textoCelda);
        return t.indexOf("Equipo") >= 0 && t.indexOf("Total Cantidad") >= 0;
      });
      if (i < 0) return false;
      filas = f;
      iCab = i;
      return true;
    });
    if (!filas) throw new Error("no tiene la hoja de la liquidación (con Equipo y Total Cantidad)");
    var arriba = filas.slice(0, iCab).map(function (r) { return (r || []).map(textoCelda).join(" "); }).join(" ").replace(/\s+/g, " ");
    var m = /Fecha de Uso de (\d{1,2})\/(\d{1,2})\/(\d{4})/i.exec(arriba);
    if (!m) throw new Error("no dice de qué fecha son los usos (\"Fecha de Uso de ...\")");
    var rango = (/Fecha de Uso de \S+ \S+ a \S+ \S+/i.exec(arriba) || [m[0]])[0];
    var cab = filas[iCab].map(textoCelda);
    var arribaCab = filas[iCab - 1] || [];
    var iEq = cab.indexOf("Equipo"), iTot = cab.indexOf("Total Cantidad"), iEmp = cab.indexOf("Empresa"), iVal = cab.indexOf("Total Valor");
    var tipos = [];
    arribaCab.forEach(function (c, j) { if (textoCelda(c) && cab[j] === "Cantidad") tipos.push({ nombre: textoCelda(c), j: j }); });
    var por = {}, total = 0;
    filas.slice(iCab + 1).forEach(function (r) {
      var placa = textoCelda(r && r[iEq]).toUpperCase();
      if (!placa) return;                                         // el renglón de los totales
      if (iEmp >= 0 && textoCelda(r[iEmp]) && textoCelda(r[iEmp]).toUpperCase() !== "COMBUSES") return;
      var p = por[placa] || (por[placa] = { cantidad: 0, valor: 0, tipos: {} });
      var c = numeroMifare(r[iTot]);
      p.cantidad += c;
      total += c;
      if (iVal >= 0) p.valor += numeroMifare(r[iVal]);
      tipos.forEach(function (t) { var x = numeroMifare(r[t.j]); if (x) p.tipos[t.nombre] = (p.tipos[t.nombre] || 0) + x; });
    });
    return { dia: m[3] + "-" + ("0" + m[2]).slice(-2) + "-" + ("0" + m[1]).slice(-2), rango: rango, por: por, total: total };
  }

  // Los .xlsx sueltos y los que vengan dentro de un .zip (la herramienta del Excel también abre el zip).
  async function leerArchivosMifare(lista) {
    var leidos = [], errores = [];
    function uno(nombre, bytes) {
      try {
        leidos.push(Object.assign({ archivo: nombre }, leerMifare(bytes)));
      } catch (err) {
        errores.push(nombre + ": " + (err.message || err));
      }
    }
    for (var i = 0; i < lista.length; i++) {
      var f = lista[i];
      var bytes = new Uint8Array(await f.arrayBuffer());
      if (/\.zip$/i.test(f.name)) {
        try {
          var z = XLSX.CFB.read(bytes, { type: "array" });
          var adentro = z.FileIndex.filter(function (e) { return /\.xlsx$/i.test(e.name) && e.content && e.content.length; });
          if (!adentro.length) errores.push(f.name + ": no trae archivos .xlsx");
          adentro.forEach(function (e) { uno(e.name, e.content); });
        } catch (err) {
          errores.push(f.name + ": no se pudo abrir el zip");
        }
      } else {
        uno(f.name, bytes);
      }
    }
    return { leidos: leidos, errores: errores };
  }

  // placa -> bus con las placas de Sonar (tarjeta_buses_dia), la del día más cercano.
  async function placasDeSonar(dias) {
    var desde = sumarDias(dias[0], -20), hasta = sumarDias(dias[dias.length - 1], 20);
    var filas = await traerTodo(function () {
      return client.from("tarjeta_buses_dia").select("dia,interno,placa").gte("dia", desde).lte("dia", hasta).order("dia").order("interno");
    });
    var porPlaca = {};
    filas.forEach(function (f) {
      if (!f.placa || f.interno === "PRUEBA") return;
      var p = textoCelda(f.placa).toUpperCase();
      (porPlaca[p] = porPlaca[p] || []).push({ dia: f.dia, interno: textoCelda(f.interno) });
    });
    return function (placa, dia) {
      var mejor = null, lejos = Infinity;
      (porPlaca[placa] || []).forEach(function (x) {
        var d = Math.abs(diasEntre(x.dia, dia));
        if (d < lejos) { lejos = d; mejor = x.interno; }
      });
      return mejor;
    };
  }

  async function cargarMifare(lista) {
    if (!window.XLSX) return aviso("No cargó la herramienta del Excel. Revise el internet y recargue.", "mal");
    var boton = $("movMifare");
    boton.disabled = true;
    boton.textContent = "Leyendo los archivos…";
    try {
      var r = await leerArchivosMifare(lista);
      var porDia = {}, errores = r.errores.slice();
      r.leidos.sort(function (a, b) { return a.archivo.localeCompare(b.archivo); }).forEach(function (x) {
        if (porDia[x.dia]) errores.push(x.archivo + ": es del mismo día que " + porDia[x.dia].archivo + " (se deja el primero)");
        else porDia[x.dia] = x;
      });
      var dias = Object.keys(porDia).sort();
      if (!dias.length) {
        abrirHoja("Cargar el Metro (Mifare)", '<p class="error">No se pudo leer ningún archivo.</p><ul>' +
          errores.map(function (e) { return "<li>" + esc(e) + "</li>"; }).join("") + "</ul>" +
          '<div class="acciones"><button class="btn" type="button" data-cerrar-hoja>Cerrar</button></div>');
        return;
      }
      var res = await Promise.all([
        placasDeSonar(dias),
        traerTodo(function () {
          return client.from("movilidad_externos").select("dia,interno").eq("fuente", "metro").in("dia", dias).order("dia").order("interno");
        }),
      ]);
      var busDe = res[0], yaHabia = {};
      res[1].forEach(function (a) { (yaHabia[a.dia] = yaHabia[a.dia] || []).push(a.interno); });
      var filas = [], resumen = [];
      dias.forEach(function (dia) {
        var x = porDia[dia], buses = {}, sinBus = [], usos = 0;
        Object.keys(x.por).forEach(function (placa) {
          var p = x.por[placa], interno = busDe(placa, dia);
          if (!interno) { sinBus.push(placa + " (" + p.cantidad + ")"); return; }
          var b = buses[interno] || (buses[interno] = { cantidad: 0, valor: 0, tipos: {}, placas: [] });
          b.cantidad += p.cantidad;
          b.valor += p.valor;
          b.placas.push(placa);
          Object.keys(p.tipos).forEach(function (t) { b.tipos[t] = (b.tipos[t] || 0) + p.tipos[t]; });
          usos += p.cantidad;
        });
        Object.keys(buses).forEach(function (interno) {
          var b = buses[interno];
          filas.push({ dia: dia, interno: interno, fuente: "metro", cantidad: b.cantidad, archivo: x.archivo,
            detalle: { placa: b.placas.join(", "), valor: b.valor, tipos: b.tipos, usos_de: x.rango } });
        });
        (yaHabia[dia] || []).forEach(function (interno) {
          if (!buses[interno]) filas.push({ dia: dia, interno: interno, fuente: "metro", cantidad: 0, archivo: x.archivo,
            detalle: { nota: "No sale en este archivo" } });
        });
        resumen.push({ dia: dia, archivo: x.archivo, rango: x.rango, usos: usos, buses: Object.keys(buses).length, sinBus: sinBus,
          reemplaza: !!(yaHabia[dia] || []).length });
      });
      abrirHoja("Cargar el Metro (Mifare)",
        '<p class="nota">Cada archivo va al día en que se usaron los pasajes (el que dice "Fecha de Uso de"), y la placa se pasa a ' +
          "bus con las placas de Sonar. Cargar otra vez un día lo reemplaza.</p>" +
        '<div class="tabla-caja"><table><thead><tr><th>Día de uso</th><th>Archivo</th><th class="n">Usos</th><th class="n">Buses</th><th></th></tr></thead><tbody>' +
        resumen.map(function (s) {
          return "<tr><td><strong>" + esc(fechaCorta(s.dia)) + '</strong><span class="menor">' + esc(diaSemana(s.dia)) + "</span></td><td>" +
            esc(s.archivo) + '<span class="menor">' + esc(s.rango) + '</span></td><td class="n">' + miles(s.usos) + '</td><td class="n">' + s.buses +
            "</td><td>" + (s.reemplaza ? chip("revisa", "Reemplaza lo cargado") : "") +
            (s.sinBus.length ? chip("mal", "Placas sin bus en Sonar: " + s.sinBus.join(", ")) : "") + "</td></tr>";
        }).join("") + "</tbody></table></div>" +
        (errores.length ? '<p class="error">No se cargan:</p><ul>' + errores.map(function (e) { return "<li>" + esc(e) + "</li>"; }).join("") + "</ul>" : "") +
        '<p id="mifareError" class="error" hidden></p>' +
        '<div class="acciones"><button class="btn btn-primario" type="button" id="mifareGuardar">Guardar ' + dias.length +
          (dias.length === 1 ? " día" : " días") + "</button>" +
        '<button class="btn" type="button" data-cerrar-hoja>Cancelar</button></div>',
        function (caja) {
          caja.querySelector("#mifareGuardar").addEventListener("click", async function () {
            var b = this;
            b.disabled = true;
            b.textContent = "Guardando…";
            try {
              for (var i = 0; i < filas.length; i += 500) {
                var r2 = await conTiempo(client.from("movilidad_externos").upsert(filas.slice(i, i + 500), { onConflict: "dia,interno,fuente" }));
                if (r2.error) throw r2.error;
              }
              cerrarHoja();
              aviso("Metro cargado: " + dias.length + (dias.length === 1 ? " día, " : " días, ") +
                miles(resumen.reduce(function (s, x) { return s + x.usos; }, 0)) + " usos.");
              var m = state.mov;
              if (m.desde && dias.some(function (d) { return d >= m.desde && d <= m.hasta; })) cargarMovilidad();
            } catch (err) {
              $("mifareError").textContent = "No se guardó: " + textoError(err);
              $("mifareError").hidden = false;
              b.disabled = false;
              b.textContent = "Guardar otra vez";
            }
          });
        });
    } catch (err) {
      aviso("No se pudieron leer los archivos del Mifare: " + textoError(err), "mal");
    } finally {
      boton.disabled = false;
      boton.textContent = "Cargar Mifare";
    }
  }

  function abrirAjusteMov(interno, dia) {
    var m = state.mov;
    var r = (m.filas || []).filter(function (f) { return f.dia === dia && f.interno === interno; })[0];
    if (!r) return;
    var puede = state.revisor && m.tablas;
    var lista = r.ajustes.length ? '<ul class="lista-ajustes">' + r.ajustes.map(function (a) {
      return "<li" + (a.anulado_en ? ' class="anulado"' : "") + "><strong>" + a.cantidad + " · " + esc(a.motivo) + "</strong>" +
        (a.nota ? " · " + esc(a.nota) : "") + '<span class="menor">' + esc(a.escrita_por_correo || "") + " · " + esc(momento(a.escrita_en)) + "</span>" +
        (a.anulado_en ? '<span class="menor">Anulado por ' + esc(a.anulado_por_correo || "") + " el " + esc(momento(a.anulado_en)) + ": " + esc(a.anulado_motivo || "") + "</span>"
          : puede ? '<button class="btn btn-chico" type="button" data-mov-anular="' + esc(a.id) + '">Anular</button>' : "") + "</li>";
    }).join("") + "</ul>" : '<p class="nota">Este bus no tiene ajustes este día.</p>';
    abrirHoja("Ajustes del " + interno + " · " + fechaCorta(dia),
      '<p class="nota">Personas que el sensor contó y no son pasajeros. Se restan de los ingresos y de las salidas. ' +
        "Ahora: Sonar " + numMov(r.sonar) + " · Ingresos " + numMov(r.ingresos) + (r.gestores ? " · " + r.gestores + " gestor(es) ya restados" : "") + ".</p>" +
      lista +
      (puede ? '<form id="formAjusteMov" class="form-ajuste" novalidate>' +
        '<label class="campo"><span>Cuántas personas</span><input id="ajusteCantidad" type="number" min="1" max="99" step="1" inputmode="numeric" required></label>' +
        '<label class="campo"><span>Motivo</span><select id="ajusteMotivo">' +
          MOV_MOTIVOS.map(function (x) { return "<option>" + x + "</option>"; }).join("") + "</select></label>" +
        '<label class="campo"><span>Nota (obligatoria si es Otro)</span><input id="ajusteNota" maxlength="300" autocomplete="off"></label>' +
        '<p id="ajusteError" class="error" hidden></p>' +
        '<div class="acciones"><button class="btn btn-primario" type="submit" id="ajusteGuardar">Guardar el ajuste</button>' +
        '<button class="btn" type="button" data-cerrar-hoja>Cerrar</button></div></form>'
        : '<p class="nota">' + (m.tablas ? "Solo los despachadores (tarjeta_revisores) escriben ajustes." : "Falta correr movilidad.sql en Supabase.") + "</p>"),
      function (caja) {
        var form = caja.querySelector("#formAjusteMov");
        if (!form) return;
        form.addEventListener("submit", async function (ev) {
          ev.preventDefault();
          var cantidad = Number($("ajusteCantidad").value);
          var motivo = $("ajusteMotivo").value;
          var nota = $("ajusteNota").value.trim();
          var error = $("ajusteError");
          error.hidden = true;
          if (!(cantidad >= 1 && cantidad <= 99 && Math.floor(cantidad) === cantidad)) {
            error.textContent = "Escriba cuántas personas, de 1 a 99.";
            error.hidden = false;
            return;
          }
          if (motivo === "Otro" && !nota) {
            error.textContent = "Escriba en la nota quién era.";
            error.hidden = false;
            return;
          }
          $("ajusteGuardar").disabled = true;
          try {
            var res = await conTiempo(client.from("movilidad_ajustes").insert({ dia: dia, interno: interno, cantidad: cantidad, motivo: motivo, nota: nota || null }));
            if (res.error) throw res.error;
            cerrarHoja();
            aviso("Ajuste guardado: " + cantidad + " " + motivo + " en el " + interno + ".");
            recargarAjustesMov();
          } catch (err) {
            error.textContent = textoError(err);
            error.hidden = false;
            $("ajusteGuardar").disabled = false;
          }
        });
      });
  }

  function abrirAnularAjuste(id) {
    var a = ((state.mov.datos || {}).ajustes || []).filter(function (x) { return String(x.id) === String(id); })[0];
    if (!a) return;
    abrirHoja("Anular el ajuste",
      "<p><strong>" + a.cantidad + " · " + esc(a.motivo) + "</strong> en el " + esc(a.interno) + " el " + esc(fechaCorta(a.dia)) + "</p>" +
      '<p class="nota">El ajuste no se borra: queda anulado, con quién, cuándo y por qué, y deja de restarse.</p>' +
      '<form id="formAnularAjuste" novalidate><label class="campo"><span>Por qué</span><textarea id="anularMotivo" maxlength="300"></textarea></label>' +
      '<p id="anularError" class="error" hidden></p>' +
      '<div class="acciones"><button class="btn btn-peligro" type="submit" id="anularGuardar">Anular</button>' +
      '<button class="btn" type="button" data-cerrar-hoja>Cancelar</button></div></form>',
      function (caja) {
        caja.querySelector("#formAnularAjuste").addEventListener("submit", async function (ev) {
          ev.preventDefault();
          var motivo = $("anularMotivo").value.trim();
          if (!motivo) {
            $("anularError").textContent = "Escriba por qué.";
            $("anularError").hidden = false;
            return;
          }
          $("anularGuardar").disabled = true;
          try {
            var res = await conTiempo(client.rpc("movilidad_anular_ajuste", { p_id: a.id, p_motivo: motivo }));
            if (res.error) throw res.error;
            cerrarHoja();
            aviso("Ajuste anulado.");
            recargarAjustesMov();
          } catch (err) {
            $("anularError").textContent = textoError(err);
            $("anularError").hidden = false;
            $("anularGuardar").disabled = false;
          }
        });
      });
  }

  // El día como fecha de Excel: medianoche UTC, que ExcelJS escribe como el número del día, sin correrlo.
  function fechaExcel(dia) {
    var p = dia.split("-").map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  }

  function baseNumero(base) {
    var x = /(\d+)/.exec(base || "");
    return x ? Number(x[1]) : base ? "SIN BASE" : "";
  }

  function vehiculoMov(interno) { return MOV_SIN_ESPACIO.indexOf(interno) >= 0 ? interno : interno + " "; }

  // La hoja Base de datos como la de Movilidad 2026: los mismos anchos, los colores del encabezado (los del tema de
  // ese Excel, ya calculados), la letra, los bordes, el filtro y la Dif en rojo cuando pasa de 30 o de 50.
  var MOV_ANCHOS = [10.89, 18.44, 13, 11.66, 12.11, 12.89, 5.11, 6.33, 11.33, 7.89, 6.44, 10.89, 7.33, 7.66, 10, 8, 15.55,
    13.55, 10.89, 40.44, 8, 18.33, 12.44, 8.44, 28.89];
  var MOV_RELLENO = { 5: "FFFFFF", 10: "FFFFFF", 11: "FFFFFF", 12: "FFFFFF", 13: "FFFFFF", 15: "83CBEB", 16: "FFFF00", 17: "B4E5A2",
    18: "D86ECC" };   // columna (A = 1): color
  var BORDE_FINO = { top: { style: "thin" }, left: { style: "thin" }, bottom: { style: "thin" }, right: { style: "thin" } };

  function hojaBaseDeDatos(libro, filas) {
    var ws = libro.addWorksheet("Base de datos", { views: [{ state: "frozen", ySplit: 1, zoomScale: 115 }] });
    MOV_ANCHOS.forEach(function (a, i) { ws.getColumn(i + 1).width = a; });
    var cab = ws.addRow(MOV_COLUMNAS);
    for (var i = 1; i <= MOV_COLUMNAS.length; i++) {
      var c = cab.getCell(i);
      c.font = { name: "Calibri", size: i === 20 ? 10 : 11, bold: i <= 20, color: { argb: "FF000000" } };
      c.alignment = { horizontal: i === 20 ? "left" : "center", vertical: i <= 9 ? "top" : i === 13 ? "middle" : undefined, wrapText: true };
      c.border = BORDE_FINO;
      if (MOV_RELLENO[i]) c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + MOV_RELLENO[i] } };
    }
    // Las fórmulas son la regla: si en el Excel cambian un ajuste o los viajes, se recalcula todo el renglón.
    filas.forEach(function (r) {
      var k = ws.rowCount + 1;
      var f = new Date(r.dia + "T12:00:00Z");
      var fila = ws.addRow([
        vehiculoMov(r.interno),
        formula("U" + k + "-R" + k + "-V" + k + "-N" + k, r.ingresos),     // Ingresos = Sonar - Desc>20 - Viajes - Ajustes
        null,
        r.salidasP1,
        r.salidasP2,
        formula("D" + k + "+E" + k + "-V" + k + "-N" + k, r.salidas),       // Total salidas = P1 + P2 - Viajes - Ajustes
        formula("B" + k + "-F" + k, r.dif),                                // Dif = Ingresos - Total salidas
        MOV_RUTA,
        fechaExcel(r.dia),
        MESES[f.getUTCMonth()],
        f.getUTCFullYear(),
        DIAS_SEMANA[f.getUTCDay()],
        baseNumero(r.base),
        r.ajuste,
        r.sinRuta,
        null,
        r.metro,
        r.descuento,
        null,
        r.observaciones || "",
        r.sonar,
        r.viajesReal,
        "",
        null,
        r.faltante ? "Vehículo faltante" : "",
      ]);
      for (var j = 1; j <= MOV_COLUMNAS.length; j++) {
        var x = fila.getCell(j);
        x.font = { name: j === 6 || j === 7 ? "Calibri" : "Aptos Narrow", size: 11 };
        x.alignment = { horizontal: j === 20 ? "left" : "center" };
        x.border = BORDE_FINO;
      }
      fila.getCell(9).numFmt = "mm-dd-yy";
    });
    ws.autoFilter = "A1:Y" + Math.max(2, ws.rowCount);
    ws.addConditionalFormatting({
      ref: "G2:G1048576",
      rules: [50, 30].map(function (tope, i) {
        return { type: "cellIs", operator: "greaterThan", formulae: [String(tope)], priority: i + 1,
          style: { font: { color: { argb: "FF9C0006" } }, fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FFFFC7CE" } } } };
      }),
    });
  }

  // El resumen por día sale de la Base de datos con fórmulas (SUMAR.SI.CONJUNTO): si la cambian, también cambia.
  function hojaResumenMovilidad(libro, filas) {
    var cols = [["Buses", null], ["Viajes realizados", "V"], ["Sonar ", "U"], ["Sin ruta", "O"], ["Descuento>20", "R"],
      ["Ajustes", "N"], ["Ingresos totales", "B"], ["Salidas P1", "D"], ["Total salidas", "F"], ["Dif", "G"], ["Pasajeros metro", "Q"]];
    var R = hojaVaV(libro, "Resumen por día", ["Fecha", "Día"].concat(cols.map(function (c) { return c[0].trim(); })));
    var BD = "'Base de datos'!";
    var dias = resumenMovilidadPorDia(filas);
    var primera = 2;
    dias.forEach(function (d) {
      var k = R.ultima + 1;
      var valores = { "Buses": d.buses, "V": d.viajesReal, "U": d.sonar, "O": d.sinRuta, "R": d.descuento, "N": d.ajuste, "B": d.ingresos,
        "D": d.salidasP1, "F": d.salidas, "G": d.dif, "Q": d.metro };
      R.poner([fechaExcel(d.dia), diaSemana(d.dia)].concat(cols.map(function (c) {
        return c[1] ? formula("SUMIFS(" + BD + "$" + c[1] + ":$" + c[1] + "," + BD + "$I:$I,$A" + k + ")", n(valores[c[1]]))
          : formula("COUNTIFS(" + BD + "$I:$I,$A" + k + ")", valores.Buses);
      })));
      R.ws.getRow(k).getCell(1).numFmt = "dd/mm/yyyy";
    });
    var ultima = R.ultima;
    if (dias.length) {
      var t = resumenMovilidadPorDia(filas.map(function (r) { return Object.assign({}, r, { dia: "todo" }); }))[0];
      var totales = { "Buses": t.buses, "V": t.viajesReal, "U": t.sonar, "O": t.sinRuta, "R": t.descuento, "N": t.ajuste, "B": t.ingresos,
        "D": t.salidasP1, "F": t.salidas, "G": t.dif, "Q": t.metro };
      R.poner(["Total", null].concat(cols.map(function (c, i) {
        var letra = String.fromCharCode(67 + i);       // las columnas del resumen: C, D, E...
        return formula("SUM(" + letra + primera + ":" + letra + ultima + ")", n(totales[c[1] || "Buses"]));
      })), COLOR_VAV.azul, true);
    }
    R.cerrar();
    R.ws.getColumn(1).width = 12;
  }

  async function excelMovilidad() {
    var m = state.mov;
    if (!m.filas || !m.filas.length || m.armandoExcel) return;
    var boton = $("movExcel");
    m.armandoExcel = true;
    boton.disabled = true;
    boton.textContent = "Armando el Excel…";
    try {
      var ExcelJS = await cargarExcelJS();
      var libro = new ExcelJS.Workbook();
      libro.creator = "Portal de Control · Combuses";
      libro.calcProperties.fullCalcOnLoad = true;
      hojaBaseDeDatos(libro, m.filas);
      hojaResumenMovilidad(libro, m.filas);
      var A = hojaVaV(libro, "Ajustes", ["Día", "Bus", "Cantidad", "Motivo", "Nota", "Escribió", "Cuándo", "Anulado"]);
      var ajustes = m.datos.ajustes || [];
      if (!ajustes.length) A.poner(["Ninguno entre esas fechas"]);
      ajustes.forEach(function (a) {
        A.poner([a.dia, a.interno, a.cantidad, a.motivo, a.nota || "", a.escrita_por_correo || "", momento(a.escrita_en),
          a.anulado_en ? (a.anulado_motivo || "") + " (" + (a.anulado_por_correo || "") + ", " + momento(a.anulado_en) + ")" : ""]);
      });
      A.cerrar();
      var N = libro.addWorksheet("Notas");
      [
        "Movilidad de la ruta " + MOV_RUTA + " sacada del Portal de Control, del " + m.desde + " al " + m.hasta +
          ": un renglón por bus y día, como la hoja Base de datos de Movilidad 2026 (las mismas 25 columnas, en el mismo orden).",
        "Con la regla de la plantilla 700control. Van con fórmula, y se recalculan si cambia un número del renglón:",
        "   Ingresos totales (B) = Sonar (U) - Descuento>20 (R) - Viajes realizados (V) - Ajustes (N)",
        "   Total salidas (F) = Salidas P1 (D) + Salidas P2 (E) - Viajes realizados (V) - Ajustes (N)",
        "   Dif (G) = Ingresos totales (B) - Total salidas (F)",
        "Sonar: todo lo que contó la puerta entrando en el día, en los viajes y fuera del viaje a viaje.",
        "Sin ruta: lo que entró fuera del viaje a viaje (en la ruta sin viaje, y en el patio o el taller). Ya va dentro de Sonar y de los ingresos: la columna solo lo muestra.",
        "Salidas P1: lo que contó bajando en los viajes más lo que bajó fuera de ellos. Salidas P2 va en 0: el sensor no separa las puertas.",
        "Descuento>20 va en 0: sin tope por viaje.",
        "Ajustes: los que escribieron los despachadores en Control (taller, administrativo, despachador...), más los gestores que subieron con su código y lo que control corrigió en un viaje.",
        "Viajes realizados: los viajes con despacho. Los sin despacho Sonar los pone como \"sin ruta\": su gente suma en Sonar, pero no restan 1.",
        "Pasajeros metro: los usos de la tarjeta Mifare (cívica) de ese bus, del archivo de la liquidación. Cada archivo va al día en que se usaron los pasajes (el \"01-10\" trae los del 30 de septiembre) y la placa se pasa a bus con las placas de Sonar.",
        "El bus va como texto y con un espacio al final (\"703 \"), menos el 710 y el 756, igual que en Movilidad 2026.",
        "La hoja Resumen por día suma la Base de datos con fórmulas.",
      ].forEach(function (t) { N.addRow([t]); });
      N.getColumn(1).width = 140;
      var datos = await libro.xlsx.writeBuffer();
      descargar(new Blob([datos], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
        "movilidad_" + MOV_RUTA + "_" + m.desde + "_a_" + m.hasta + ".xlsx");
    } catch (err) {
      aviso("No se pudo armar el Excel: " + textoError(err), "mal");
    } finally {
      m.armandoExcel = false;
      boton.textContent = "Descargar Excel";
      boton.disabled = !(m.filas && m.filas.length);
    }
  }

  // ---------------------------------------------------------------- Excel e imprimir
  function filaExcel(f) {
    return {
      "Día": f.dia, "Bus": f.interno, "Placa": f.placa || "", "Base": f.base || "",
      "Viaje": f.sin_despacho ? "SIN DESPACHO" : f.viaje,
      "Salió": hora(f.hora_salida), "Llegó": f.estado_calculo === "en_curso" ? "en camino" : hora(f.llego_en),
      "Ruta": f.ruta || (f.itinerario_estimado ? f.itinerario_estimado + " (estimada)" : ""), "Itinerario": nombreRuta(f),
      "De dónde salió el viaje": f.sin_despacho ? "viaje a viaje (sin despacho)" : "despacho de Sonar",
      "Punto de salida": f.punto_salida || "", "Punto de llegada": f.punto_llegada || "", "Conductor": f.conductor || "",
      "Pasajeros sensor": n(f.pasajeros_sensor), "Subidas sensor": n(f.subidas),
      "Gestores (no cuentan)": n(f.gestores),
      "Pasajeros conductor": f.pasajeros_conductor == null ? "" : n(f.pasajeros_conductor),
      "Diferencia pasajeros": f.diferencia_con_sensor == null ? "" : n(f.diferencia_con_sensor),
      "Pasaje": f.tarifa == null ? "" : n(f.tarifa),
      "$ sensor": f.plata_sensor == null ? "" : n(f.plata_sensor),
      "$ conductor": f.plata_conductor == null ? "" : n(f.plata_conductor),
      "Diferencia $": f.diferencia_plata == null ? "" : n(f.diferencia_plata),
      "Cívica (lectura)": f.civica_lectura == null ? "" : n(f.civica_lectura),
      "Cívicas": f.civicas == null ? "" : n(f.civicas),
      "Estado cívica": (ESTADO_CIVICA[f.estado_civica] || ["", f.estado_civica || ""])[1],
      "Tiquetes": f.tiquetes_escaneados == null ? "" : n(f.tiquetes_escaneados),
      "Control": f.control || "", "Observaciones": f.observaciones || "",
      "Corregido": [f.lectura_corregida && "cívica", f.pasajeros_conductor_corregidos && "pasajeros", f.tiquetes_corregidos && "tiquetes"].filter(Boolean).join(", "),
      "Estado": f.estado_calculo === "en_curso" ? "en camino" : f.estado_calculo === "definitivo" ? "definitivo" : "provisional",
      "Número de despacho": f.sin_despacho ? "" : f.clave,
    };
  }

  function hojaDe(filas, anchos) {
    var hoja = XLSX.utils.json_to_sheet(filas);
    if (filas.length) {
      hoja["!cols"] = Object.keys(filas[0]).map(function (k) { return { wch: (anchos && anchos[k]) || Math.max(10, Math.min(36, k.length + 2)) }; });
    }
    return hoja;
  }

  function excelBus() {
    if (!window.XLSX) return aviso("No cargó la herramienta del Excel. Revise el internet y recargue.", "mal");
    var b = state.bus;
    var libro = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(libro, hojaDe(b.filas.map(filaExcel), { Conductor: 34, Itinerario: 34 }), "Tarjeta");
    var paradas = [];
    b.filas.forEach(function (f) {
      ((b.extra[f.clave] || {}).detalle || []).forEach(function (p) {
        paradas.push({ "Viaje": f.sin_despacho ? "SIN DESPACHO" : f.viaje, "Salió": hora(f.hora_salida), "Hora": hora(p.hora),
          "Suben": n(p.suben), "Bajan": n(p.bajan), "Dónde": p.donde || "", "Sensor tapado": p.tapado ? "sí" : "",
          "Latitud": p.lat, "Longitud": p.lon });
      });
    });
    if (paradas.length) XLSX.utils.book_append_sheet(libro, hojaDe(paradas, { "Dónde": 40 }), "Puerta por puerta");
    XLSX.writeFile(libro, "tarjeta_bus_" + b.interno + "_" + b.fecha + ".xlsx");
  }

  // ---------------------------------------------------------------- Excel del viaje a viaje (toda la flota)
  // El mismo Excel que arma el programa de Python para los auxiliares (enturnes/viaje_a_viaje.py), con lo
  // que hay en Supabase: cada apertura de puerta y el total de cada viaje con fórmulas, el resumen por viaje
  // y el resumen por bus. Lo que el conductor escribió en "Mi tarjeta" va en TARJETA y manda sobre el
  // sensor; el auxiliar lo puede cambiar en el Excel y todo se recalcula.
  // No trae la hoja "Fuera de la ruta" ni las aperturas sin viaje: de esas Supabase solo sabe cuántas fueron.
  // Va con ExcelJS porque lleva los colores (la herramienta de los otros Excel no los escribe); se carga al
  // tocar el botón, como el mapa.
  var EXCELJS = "https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js";
  var cargaExcelJS = null;
  var TOPE = 19;   // la capacidad del bus: lo que el sensor cuente de más en un viaje es error (igual al programa)
  var COLOR_VAV = { verde: "C6EFCE", ambar: "FFEB9C", rojo: "FFC7CE", azul: "DDEBF7", titulo: "1F4E78" };

  function cargarExcelJS() {
    if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
    if (!cargaExcelJS) {
      cargaExcelJS = new Promise(function (si, no) {
        var js = document.createElement("script");
        js.src = EXCELJS;
        js.onload = function () { if (window.ExcelJS) si(window.ExcelJS); else no(new Error("No cargó la herramienta del Excel")); };
        js.onerror = function () { cargaExcelJS = null; no(new Error("No cargó la herramienta del Excel. Revise el internet.")); };
        document.head.appendChild(js);
      });
    }
    return cargaExcelJS;
  }

  // La hora de Colombia (UTC-5, sin horario de verano) como la escribe el programa: "2026-10-14" y "19:38:22".
  function enColombia(iso) {
    var ms = Date.parse(iso || "");
    return isNaN(ms) ? "" : new Date(ms - 5 * HORA_MS).toISOString();
  }
  function fechaVaV(iso) { return enColombia(iso).slice(0, 10); }
  function horaVaV(iso) { return enColombia(iso).slice(11, 19); }

  function rellenoVaV(color) { return { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + color } }; }

  // Una hoja con el encabezado azul de los auxiliares. poner() agrega un renglón (un valor puede ser
  // { formula, result }: el resultado ya calculado, para que se vea aunque el programa no recalcule) y
  // devuelve su número; cerrar() deja los anchos como el programa (de 9 a 46 letras).
  function hojaVaV(libro, nombre, titulos) {
    var ws = libro.addWorksheet(nombre, { views: [{ state: "frozen", ySplit: 1 }] });
    var h = { ws: ws, ultima: 1, largos: titulos.map(function (t) { return String(t).length; }) };
    var cab = ws.addRow(titulos);
    for (var i = 1; i <= titulos.length; i++) {
      var c = cab.getCell(i);
      c.font = { bold: true, color: { argb: "FFFFFFFF" } };
      c.fill = rellenoVaV(COLOR_VAV.titulo);
      c.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    }
    h.poner = function (valores, color, negrita) {
      var fila = ws.addRow(valores);
      if (color || negrita) {
        for (var i = 1; i <= titulos.length; i++) {
          var c = fila.getCell(i);
          if (color) c.fill = rellenoVaV(color);
          if (negrita) c.font = { bold: true };
        }
      }
      if (fila.number <= 501) {
        valores.forEach(function (v, i) {
          var x = v && typeof v === "object" ? v.result : v;
          if (x != null && i < h.largos.length) h.largos[i] = Math.max(h.largos[i], String(x).length);
        });
      }
      h.ultima = fila.number;
      return fila.number;
    };
    h.pintar = function (renglon, columna, color) { ws.getRow(renglon).getCell(columna).fill = rellenoVaV(color); };
    h.cerrar = function () {
      h.largos.forEach(function (l, i) { ws.getColumn(i + 1).width = Math.min(Math.max(9, l + 2), 46); });
    };
    return h;
  }

  function formula(texto, resultado) { return { formula: texto, result: resultado }; }

  // Lo que va en la columna Itinerario, como el programa.
  function itinerarioVaV(f, x, eventos) {
    if (f.sin_despacho) {
      var suben = eventos.filter(function (e) { return n(e.suben); });
      var bajan = eventos.filter(function (e) { return n(e.bajan); });
      var desde = f.punto_salida || (suben[0] && suben[0].donde) || "?";
      var hasta = f.punto_llegada || (bajan.length && bajan[bajan.length - 1].donde) || "?";
      return "Sin despacho: se subieron en " + desde + ", se bajaron en " + hasta +
        (f.itinerario_estimado ? " (como el " + f.itinerario_estimado + ")" : "");
    }
    var texto = f.itinerario || (f.ruta ? "Ruta " + f.ruta : "Sin itinerario");
    if (f.salio_cancelado) return texto + " (lo cancelaron en Sonar pero salió con gente)";
    return texto + (x.cancelado_sonar ? " (cancelado en Sonar)" : "");
  }

  function armarViajeAViaje(libro, filas, extra, sinViajes) {
    var V = hojaVaV(libro, "Viaje a viaje", ["Vehiculo", "Viaje", "Fecha", "Hora", "Entradas", "Salidas", "Combuses",
      "No pasajeros", "TARJETA (si la escribe, manda)", "CONTEO SENSOR", "EVIDENCIA VIDEO", "Bloqueos", "Direccion",
      "Conductor", "Itinerario", "Gestores (no cuentan)", "Base"]);
    var viajes = [], buses = [], bus = null;
    filas.forEach(function (f) {
      if (!bus || bus.interno !== f.interno) {
        if (bus) V.poner([]);
        bus = { interno: f.interno, base: f.base || "", viajes: [] };
        buses.push(bus);
      }
      var x = extra[f.clave] || {};
      var eventos = (x.detalle || []).slice().sort(function (a, b) { return String(a.hora).localeCompare(String(b.hora)); });
      var primero = 0, ultimo = 0, entran = 0, salen = 0;
      eventos.forEach(function (e) {
        var r = V.poner([f.interno, null, fechaVaV(e.hora), horaVaV(e.hora), n(e.suben), n(e.bajan), null, null, null, null,
          null, e.tapado ? "Sensor tapado" : null, e.donde || null, f.conductor || null, null, n(e.gestores) || null, null],
          n(e.suben) ? COLOR_VAV.verde : null);
        if (!primero) primero = r;
        ultimo = r;
        entran += n(e.suben);
        salen += n(e.bajan);
      });
      // El total del viaje. La TARJETA se puede escribir en cualquier renglón del viaje (así la anotan los
      // auxiliares); si hay un número, aunque sea 0, manda sobre el sensor. El conteo del sensor ya va sin
      // los gestores y con el tope de 19, como lo calcula el programa.
      var r = V.ultima + 1;
      var bloque = primero ? "I" + primero + ":I" + r : "I" + r;
      var gestores = n(f.gestores);
      var tarjeta = f.pasajeros_conductor == null ? null : n(f.pasajeros_conductor);
      var sensor = Math.min(Math.max(0, entran - gestores), TOPE);
      var combuses = tarjeta == null ? sensor : tarjeta;
      var notas = [];
      if (f.sin_despacho) notas.push("VIAJE SIN DESPACHO: el bus llevó gente y nadie lo despachó");
      else if (n(f.recortados)) notas.push("REVISAR: el sensor pasó de " + TOPE);
      if (gestores) notas.push(gestores === 1 ? "1 gestor subió con su código: no cuenta" : gestores + " gestores subieron con su código: no cuentan");
      if (f.pasajeros != null && n(f.pasajeros) !== n(f.pasajeros_sensor)) notas.push("Control corrigió el sensor a " + n(f.pasajeros));
      if (f.estado_calculo === "en_curso") notas.push("EN CAMINO: el sensor todavía puede contar");
      V.poner([f.interno, f.sin_despacho ? "SIN DESPACHO" : f.viaje, fechaVaV(f.hora_salida),
        horaVaV(f.hora_salida) + " a " + (f.estado_calculo === "en_curso" ? "en camino" : horaVaV(f.llego_en)),
        primero ? formula("SUM(E" + primero + ":E" + ultimo + ")", entran) : 0,
        primero ? formula("SUM(F" + primero + ":F" + ultimo + ")", salen) : 0,
        formula("IF(COUNT(" + bloque + ")>0,SUM(" + bloque + "),J" + r + ")", combuses),
        formula("MAX(0,E" + r + "-G" + r + ")", Math.max(0, entran - combuses)),
        tarjeta,
        formula("MIN(MAX(0,E" + r + "-P" + r + ")," + TOPE + ")", sensor),
        null, null, notas.join(". ") || null, f.conductor || null, itinerarioVaV(f, x, eventos), gestores || null, f.base || null],
        f.sin_despacho ? COLOR_VAV.ambar : n(f.recortados) ? COLOR_VAV.rojo : COLOR_VAV.azul, true);
      V.poner([]);
      viajes.push({ f: f, x: x, eventos: eventos, r: r, bloque: bloque, entran: entran, salen: salen, gestores: gestores,
        tarjeta: tarjeta, sensor: sensor, combuses: combuses, no: Math.max(0, entran - combuses) });
      bus.viajes.push(viajes[viajes.length - 1]);
    });
    V.cerrar();
    V.ws.autoFilter = "A1:Q" + Math.max(2, V.ultima);

    // ------------------------------------------------------------------ resumen por viaje
    var VV = "'Viaje a viaje'!";
    var R = hojaVaV(libro, "Resumen por viaje", ["Vehiculo", "Viaje", "Fecha", "Salio", "Cerro", "Itinerario",
      "Cancelado en Sonar", "Entradas del sensor", "Salidas", "PERSONAS MOVILIZADAS", "No pasajeros", "Alerta",
      "TARJETA (conductor)", "CONTEO SENSOR", "Gestores (no cuentan)", "Conductor", "Base", "Numero de despacho"]);
    viajes.forEach(function (v) {
      var f = v.f, r = v.r;
      var alerta = f.sin_despacho ? "Viaje SIN DESPACHO: nadie lo despachó"
        : n(f.recortados) ? "El sensor contó " + (v.entran - v.gestores) + ", más que la capacidad (" + TOPE + ")"
        : f.estado_calculo === "en_curso" ? "En camino: todavía puede cambiar" : "";
      v.rr = R.poner([f.interno, f.sin_despacho ? "SIN DESPACHO" : f.viaje, fechaVaV(f.hora_salida), horaVaV(f.hora_salida),
        f.estado_calculo === "en_curso" ? "en camino" : horaVaV(f.llego_en), itinerarioVaV(f, v.x, v.eventos),
        v.x.cancelado_sonar || f.salio_cancelado ? "Si" : null,
        formula(VV + "E" + r, v.entran), formula(VV + "F" + r, v.salen), formula(VV + "G" + r, v.combuses),
        formula(VV + "H" + r, v.no), alerta || null,
        formula("IF(COUNT(" + VV + v.bloque + ")>0,SUM(" + VV + v.bloque + "),\"\")", v.tarjeta == null ? "" : v.tarjeta),
        formula(VV + "J" + r, v.sensor), v.gestores || null, f.conductor || null, f.base || null,
        f.sin_despacho ? null : f.clave]);
      R.pintar(v.rr, 10, COLOR_VAV.verde);
      if (alerta) R.pintar(v.rr, 12, COLOR_VAV.rojo);
    });
    R.cerrar();

    // ------------------------------------------------------------------ resumen por bus
    var RV = "'Resumen por viaje'!";
    var B = hojaVaV(libro, "Resumen por bus", ["Vehiculo", "Viajes", "PERSONAS MOVILIZADAS", "Promedio por viaje",
      "No pasajeros", "Viajes SIN DESPACHO", "Personas en viajes sin despacho", "Gestores (no cuentan)", "Base"]);
    sinViajes.forEach(function (e) {
      if (!buses.some(function (b) { return b.interno === e.interno; })) buses.push({ interno: e.interno, base: e.base || "", viajes: [] });
    });
    buses.forEach(function (b) {
      b.movilizados = 0; b.no = 0; b.sd = 0; b.sdPersonas = 0; b.gestores = 0;
      b.viajes.forEach(function (v) {
        b.movilizados += v.combuses;
        b.no += v.no;
        b.gestores += v.gestores;
        if (v.f.sin_despacho) { b.sd++; b.sdPersonas += v.combuses; }
      });
    });
    buses.sort(function (a, b) { return b.movilizados - a.movilizados || compararInternos(a.interno, b.interno); });
    buses.forEach(function (b) {
      var k = B.ultima + 1, cuantos = b.viajes.length;
      if (cuantos) {
        var a = b.viajes[0].rr, z = b.viajes[cuantos - 1].rr;
        var col = function (c) { return RV + c + a + ":" + c + z; };
        B.poner([b.interno, cuantos,
          formula("SUM(" + col("J") + ")", b.movilizados),
          formula("IFERROR(ROUND(C" + k + "/B" + k + ",1),0)", Math.round(b.movilizados / cuantos * 10) / 10),
          formula("SUM(" + col("K") + ")", b.no),
          formula("COUNTIF(" + col("B") + ",\"SIN DESPACHO\")", b.sd),
          formula("SUMIF(" + col("B") + ",\"SIN DESPACHO\"," + col("J") + ")", b.sdPersonas),
          formula("SUM(" + col("O") + ")", b.gestores), b.base || null]);
      } else {
        B.poner([b.interno, 0, 0, 0, 0, 0, 0, 0, b.base || null]);
      }
      B.pintar(k, 3, COLOR_VAV.verde);
      if (b.sd) B.pintar(k, 6, COLOR_VAV.rojo);
    });
    if (buses.length) {
      var u = B.ultima, t = B.ultima + 1;
      var suma = function (c, valor) { return formula("SUM(" + c + "2:" + c + u + ")", valor); };
      var total = function (campo) { return buses.reduce(function (s, b) { return s + b[campo]; }, 0); };
      var todos = viajes.length, movilizados = total("movilizados");
      B.poner(["TODA LA FLOTA", suma("B", todos), suma("C", movilizados),
        formula("IFERROR(ROUND(C" + t + "/B" + t + ",1),0)", todos ? Math.round(movilizados / todos * 10) / 10 : 0),
        suma("E", total("no")), suma("F", total("sd")), suma("G", total("sdPersonas")), suma("H", total("gestores")), null],
        null, true);
    }
    B.cerrar();

    // ------------------------------------------------------------------ cómo se lee
    var N = libro.addWorksheet("Notas");
    [
      "Viaje a viaje sacado del Portal de Control, con lo que publica el programa de la tarjeta en Supabase.",
      "Renglones verdes: cada vez que se abrió la puerta y subió alguien. Renglón azul: el total del viaje (ámbar: sin despacho; rojo: el sensor pasó de " + TOPE + ").",
      "TARJETA: viene con los pasajeros que el conductor escribió en \"Mi tarjeta\". Si hay un número, aunque sea 0, manda sobre el sensor. Se puede cambiar o borrar y todo se recalcula.",
      "CONTEO SENSOR: lo que contó la puerta, sin los gestores que subieron con su código y con el tope de " + TOPE + " por viaje.",
      "No trae la hoja \"Fuera de la ruta\" ni las aperturas de puerta sin viaje (patio, taller, aseo): esas solo salen en el Excel del programa de Python.",
    ].forEach(function (t) { N.addRow([t]); });
    N.getColumn(1).width = 120;
  }

  // Descarga un archivo armado en el navegador.
  function descargar(blob, nombre) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = nombre;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }

  // Toda la flota del día, o solo la base escogida (los otros filtros no cuentan: es el informe del día).
  async function excelViajeAViaje() {
    var d = state.dia;
    if (!d.filas || !d.filas.length || d.armandoExcel) return;
    var fecha = d.fecha;
    var base = d.conBases ? $("diaBase").value : "";
    var boton = $("diaExcel");
    d.armandoExcel = true;
    boton.disabled = true;
    boton.textContent = "Armando el Excel…";
    try {
      var res = await Promise.all([
        cargarExcelJS(),
        traerTodo(function () {
          return client.from("tarjeta_viajes").select("clave,detalle,cancelado_sonar").eq("dia", fecha).order("clave");
        }),
      ]);
      if (d.fecha !== fecha) return;
      var extra = {};
      res[1].forEach(function (x) { extra[x.clave] = x; });
      var filas = (base ? d.filas.filter(function (f) { return f.base === base; }) : d.filas).slice().sort(function (a, b) {
        return compararInternos(a.interno, b.interno) || String(a.hora_salida).localeCompare(String(b.hora_salida)) ||
          String(a.clave).localeCompare(String(b.clave));
      });
      var sinViajes = (d.sinViajes || []).filter(function (e) { return !base || e.base === base; });
      var libro = new res[0].Workbook();
      libro.creator = "Portal de Control · Combuses";
      libro.calcProperties.fullCalcOnLoad = true;
      armarViajeAViaje(libro, filas, extra, sinViajes);
      var datos = await libro.xlsx.writeBuffer();
      descargar(new Blob([datos], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
        "viaje_a_viaje_" + fecha + (base ? "_" + base.replace(/\s+/g, "") : "") + ".xlsx");
    } catch (err) {
      aviso("No se pudo armar el Excel: " + textoError(err), "mal");
    } finally {
      d.armandoExcel = false;
      boton.textContent = "Excel viaje a viaje";
      boton.disabled = !(state.dia.filas && state.dia.filas.length);
    }
  }

  // ================================================================ INFORMES
  function abrirInformes() {
    if (!$("infHasta").value) {
      var hasta = state.dia.fecha || diaDeHoy();
      $("infHasta").value = hasta;
      $("infDesde").value = sumarDias(hasta, -6);
    }
    pintarInforme();
  }

  var POR = {
    interno: { titulo: "Bus", clave: function (f) { return f.interno; } },
    conductor: { titulo: "Conductor", clave: function (f) { return f.conductor || "(sin nombre en Sonar)"; } },
    ruta: { titulo: "Ruta", clave: function (f) {
      if (f.sin_despacho) return f.itinerario_estimado ? f.itinerario_estimado + " · " + nombreItinerario(f.itinerario_estimado) + " (sin despacho)" : "Sin despacho";
      return f.ruta ? f.ruta + " · " + (rutaLegible(f.itinerario) || "") : "Sin itinerario";
    } },
    dia: { titulo: "Día", clave: function (f) { return f.dia; } },
    base: { titulo: "Base", clave: function (f) { return f.base || SIN_BASE; } },
  };

  // La base escogida para el informe ("" = todas). Agrupado por base salen todas.
  function baseDelInforme() {
    var inf = state.inf;
    return inf.conBases && inf.por !== "base" ? inf.base : "";
  }

  // Los viajes del informe, solo de la base escogida si hay una.
  function filasInforme() {
    var base = baseDelInforme();
    if (!state.inf.filas || !base) return state.inf.filas;
    return state.inf.filas.filter(function (f) { return f.base === base; });
  }

  function esDeLaBase(interno, dia) {
    var base = baseDelInforme();
    return !base || baseEn(state.inf.porBus, interno, dia) === base;
  }

  // Los días en que un bus tuvo un aviso (dejó de reportar, sensor sin datos...), de la base escogida.
  function avisosInforme() {
    return (state.inf.estados || []).filter(function (e) { return tieneAvisos(e) && esDeLaBase(e.interno, e.dia); });
  }

  async function consultarInforme(ev) {
    if (ev) ev.preventDefault();
    var inf = state.inf;
    var desde = $("infDesde").value, hasta = $("infHasta").value;
    if (!esFecha(desde) || !esFecha(hasta)) return aviso("Escoja las dos fechas.", "mal");
    if (desde > hasta) return aviso("La fecha de inicio va antes que la final.", "mal");
    if (diasEntre(desde, hasta) + 1 > cfg.INFORME_MAX_DIAS) return aviso("Son muchos días: máximo " + cfg.INFORME_MAX_DIAS + " por informe.", "mal");
    inf.desde = desde;
    inf.hasta = hasta;
    inf.por = $("infPor").value;
    inf.orden = inf.por === "conductor" ? { campo: "difPlata", desc: false } : inf.por === "dia" ? { campo: "clave", desc: false } : { campo: "clave", desc: false };
    inf.filas = null;
    inf.error = null;
    inf.cargando = true;
    inf.progreso = 0;
    $("infExcel").disabled = true;
    pintarInforme();
    try {
      var bases = traerBases(desde, hasta).catch(function () { return null; });
      var estados = traerTodo(function () {
        return client.from("tarjeta_buses_dia").select(CAMPOS_ESTADO_BUS).gte("dia", desde).lte("dia", hasta)
          .order("dia").order("interno");
      }).catch(function () { return null; });
      var filas = await traerTodo(function () {
        return client.from("v_tarjeta_viajes").select(CAMPOS_VIAJE).gte("dia", desde).lte("dia", hasta)
          .order("dia").order("interno").order("hora_salida").order("clave");
      }, function (cuantos) {
        inf.progreso = cuantos;
        pintarInforme();
      });
      var porBus = await bases;
      var lista = await estados;
      if (inf.desde !== desde || inf.hasta !== hasta) return;
      ponerBases(filas, porBus);
      inf.estados = lista;
      inf.porBus = porBus;
      inf.conBases = !!porBus;
      inf.filas = filas;
    } catch (err) {
      inf.error = err;
    } finally {
      inf.cargando = false;
      $("infExcel").disabled = !inf.filas || !inf.filas.length;
      pintarInforme();
    }
  }

  function pintarInforme() {
    var inf = state.inf;
    var cuerpo = $("infCuerpo");
    if (inf.cargando) {
      cuerpo.innerHTML = '<p class="progreso">Trayendo los viajes… ' + (inf.progreso ? miles(inf.progreso) + " hasta ahora" : "") + "</p>";
      return;
    }
    if (inf.error) {
      cuerpo.innerHTML = cajaError("No se pudo hacer el informe: " + textoError(inf.error), "recargar-informe");
      return;
    }
    if (!inf.filas) {
      cuerpo.innerHTML = '<p class="vacio">Escoja las fechas y cómo agrupar, y toque Consultar.<br>' +
        "Por conductor sale primero el que más plata dice de menos frente al sensor.</p>";
      return;
    }
    if (!inf.filas.length) {
      cuerpo.innerHTML = '<p class="vacio">No hay viajes publicados entre esas fechas.</p>';
      return;
    }
    var selBase = $("infBase");
    selBase.closest("label").hidden = !inf.conBases || inf.por === "base";
    if (inf.conBases) opcionesBases(selBase, inf.filas, inf.base);
    if (inf.conBases && inf.por !== "base") inf.base = selBase.value;
    var base = baseDelInforme();
    var filas = filasInforme();
    var por = POR[inf.por];
    var grupos = resumir(filas, por.clave);
    var todo = nuevoResumen("todo");
    filas.forEach(function (f) { sumarViaje(todo, f); });
    var o = inf.orden;
    var html = '<div class="totales">' + totalesHtml(todo,
      '<div class="total"><span>' + (inf.desde === inf.hasta ? "Día" : "Días") + "</span><strong>" + (diasEntre(inf.desde, inf.hasta) + 1) +
        "</strong><small>" + esc(inf.desde === inf.hasta ? fechaCorta(inf.desde) : fechaCorta(inf.desde) + " a " + fechaCorta(inf.hasta)) +
        (base ? " · " + esc(base) : "") + "</small></div>" + cajaAvisosInforme()) + "</div>";
    html += '<div class="tabla-caja"><table><thead><tr>' +
      thOrden("clave", por.titulo, o) +
      (inf.por === "interno" ? "<th>Conductores</th>" : inf.por === "conductor" ? "<th>Buses</th>" : "<th>Buses</th>") +
      thOrden("viajes", "Viajes", o, true) + thOrden("sensor", "Sensor", o, true) + thOrden("plataSensor", "$ Sensor", o, true) +
      thOrden("conductorP", "Conductor dice", o, true) + thOrden("plataConductor", "$ Conductor", o, true) +
      thOrden("difPlata", "Diferencia", o, true) + thOrden("civicas", "Cívicas", o, true) + thOrden("tiquetes", "Tiquetes", o, true) +
      thOrden("estado", "Por revisar", o) + "</tr></thead><tbody>";
    ordenar(grupos, o, inf.por === "interno").forEach(function (r) {
      var nombre = inf.por === "dia" ? fechaLarga(r.clave) : inf.por === "conductor" ? capitalizar(r.clave) : r.clave;
      var quienes = inf.por === "interno" ? r.conductores.map(capitalizar).join(", ") : r.buses.slice().sort(compararInternos).join(", ");
      var enlace = inf.por === "interno" && r.dias.length === 1 ? ' class="fila-link" tabindex="0" data-bus="' + esc(r.clave) + '" data-fecha="' + esc(r.dias[0]) + '"'
        : inf.por === "dia" ? ' class="fila-link" tabindex="0" data-dia="' + esc(r.clave) + '"' : "";
      var debajo = inf.por === "interno" ? [r.placa].concat(inf.conBases && !base ? r.bases : []).filter(Boolean).join(" · ") : "";
      html += "<tr" + enlace + "><td><strong>" + esc(nombre) + "</strong>" + (debajo ? '<span class="menor">' + esc(debajo) + "</span>" : "") + "</td>" +
        '<td><span class="menor" style="font-size:13px">' + esc(quienes) + "</span></td>" +
        celdasNumeros(r) + "<td>" + chipsEstado(r) + "</td></tr>";
    });
    html += '</tbody><tfoot><tr><td colspan="2">' + grupos.length + " " + (grupos.length === 1 ? "renglón" : "renglones") + "</td>" +
      celdasNumeros(todo) + "<td></td></tr></tfoot></table></div>";
    html += '<p class="pie">' + miles(filas.length) + " viajes" + (base ? " de la " + esc(base) : "") + ". Diferencia = lo que dice el conductor menos lo del sensor, en los viajes que ya llegaron y en que el conductor escribió." +
      " El Excel trae este resumen, cada viaje, las correcciones y los daños del validador.</p>";
    cuerpo.innerHTML = html;
  }

  function cajaAvisosInforme() {
    if (!state.inf.estados) {
      return '<div class="total"><span>Avisos de los buses</span><strong>—</strong><small>todavía no está el estado de los buses</small></div>';
    }
    var avisos = avisosInforme();
    var buses = {};
    avisos.forEach(function (e) { buses[e.interno] = true; });
    var nb = Object.keys(buses).length;
    return '<div class="total"' + (avisos.length ? ' data-tono="mal"' : ' data-tono="bien"') + "><span>Avisos de los buses</span><strong>" +
      avisos.length + "</strong><small>" + (avisos.length ? "en " + nb + (nb === 1 ? " bus" : " buses") + " · el detalle va en el Excel"
        : "todos reportaron bien") + "</small></div>";
  }

  // Lo que se corrigió entre esas fechas: cada corrección con el número de antes.
  async function correccionesEntre(desde, hasta) {
    var salida = [];
    for (var tipo in TIPOS) {
      var t = TIPOS[tipo];
      var campos = CAMPOS_REGISTRO + "," + t.columna;
      var corr = await traerTodo(function () {
        return client.from(t.tabla).select(campos).not("corrige_a", "is", null).gte("dia", desde).lte("dia", hasta).order("id");
      });
      if (!corr.length) continue;
      var ids = corr.map(function (x) { return x.corrige_a; });
      var antes = {};
      for (var i = 0; i < ids.length; i += 200) {
        var res = await conTiempo(client.from(t.tabla).select("id," + t.columna).in("id", ids.slice(i, i + 200)));
        if (res.error) throw res.error;
        (res.data || []).forEach(function (x) { antes[x.id] = x[t.columna]; });
      }
      corr.forEach(function (x) {
        salida.push({ "Día": x.dia, "Bus": x.interno, "Viaje (número de despacho)": x.clave_viaje, "Qué": t.nombre,
          "Decía": antes[x.corrige_a], "Quedó": x[t.columna], "Por qué": x.motivo || "", "Quién": x.escrita_por_correo || "",
          "Cuándo": momento(x.escrita_en) });
      });
    }
    return salida;
  }

  async function excelInforme() {
    if (!window.XLSX) return aviso("No cargó la herramienta del Excel. Revise el internet y recargue.", "mal");
    var inf = state.inf;
    if (!inf.filas || !inf.filas.length) return;
    var boton = $("infExcel");
    boton.disabled = true;
    boton.textContent = "Armando el Excel…";
    try {
      var por = POR[inf.por];
      var filas = filasInforme();
      var resumen = ordenar(resumir(filas, por.clave), inf.orden, inf.por === "interno").map(function (r) {
        var fila = {};
        fila[por.titulo] = inf.por === "conductor" ? capitalizar(r.clave) : r.clave;
        if (inf.conBases && inf.por !== "base") fila["Base"] = r.bases.slice().sort(compararBases).join(", ");
        fila["Viajes"] = r.viajes;
        fila["Sin despacho"] = r.sd;
        fila["Pasajeros sensor"] = r.sensor;
        fila["$ sensor"] = r.plataSensor;
        fila["Pasajeros conductor"] = r.escribio ? r.conductor : "";
        fila["$ conductor"] = r.escribio ? r.plataConductor : "";
        fila["Viajes sin pasajeros del conductor"] = r.faltaPasajeros;
        fila["Diferencia pasajeros"] = r.comparados ? r.dif : "";
        fila["Diferencia $"] = r.comparados ? r.difPlata : "";
        fila["Viajes que no cuadran"] = r.noCuadran;
        fila["Cívicas"] = r.civicas;
        fila["Tiquetes"] = r.tiquetes;
        fila["Daños por revisar"] = r.danos;
        fila["Cívica por revisar"] = r.revisarCivica;
        fila["Viajes corregidos"] = r.corregidos;
        if (inf.por === "interno") fila["Conductores"] = r.conductores.map(capitalizar).join(", ");
        else fila["Buses"] = r.buses.slice().sort(compararInternos).join(", ");
        return fila;
      });
      var res = await Promise.all([
        correccionesEntre(inf.desde, inf.hasta),
        traerTodo(function () {
          return client.from("civica_danos").select("*").gte("dia", inf.desde).lte("dia", inf.hasta).order("dia").order("interno");
        }),
      ]);
      var correcciones = res[0].filter(function (x) { return esDeLaBase(x["Bus"], x["Día"]); });
      var danos = res[1].filter(function (d) { return esDeLaBase(d.interno, d.dia); }).map(function (d) {
        return { "Día": d.dia, "Bus": d.interno, "Viaje (número de despacho)": d.clave_viaje,
          "El viejo quedó en": d.lectura_final_viejo == null ? "" : d.lectura_final_viejo, "El nuevo arrancó en": d.lectura_inicial_nuevo,
          "Qué pasó": d.descripcion, "Estado": d.estado, "Reportó": d.nombre || d.reportado_por_correo || "",
          "Cuándo": momento(d.reportado_en), "Revisó": d.revisado_por_correo || "", "Nota": d.nota_revision || "" };
      });
      var libro = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(libro, hojaDe(resumen, { Conductores: 50, Buses: 30, Conductor: 34 }), "Resumen por " + por.titulo.toLowerCase());
      XLSX.utils.book_append_sheet(libro, hojaDe(filas.map(filaExcel), { Conductor: 34, Itinerario: 34 }), "Viajes");
      XLSX.utils.book_append_sheet(libro, hojaDe(correcciones.length ? correcciones : [{ "Correcciones": "Ninguna entre esas fechas" }], { "Por qué": 40 }), "Correcciones");
      XLSX.utils.book_append_sheet(libro, hojaDe(danos.length ? danos : [{ "Daños del validador": "Ninguno entre esas fechas" }], { "Qué pasó": 40 }), "Daños del validador");
      var avisos = avisosInforme().map(function (e) {
        var eb = ESTADO_BUS[e.estado];
        return { "Día": e.dia, "Bus": e.interno, "Base": inf.conBases ? baseEn(inf.porBus, e.interno, e.dia) : "",
          "Cómo quedó": eb ? eb[1] : e.estado === "ok" ? "Bien (se arregló)" : e.estado, "Qué pasó": textoAvisos(e),
          "Último GPS que tenía Sonar": e.ultimo_gps ? momento(e.ultimo_gps) : "",
          "Viajes": e.viajes == null ? "" : e.viajes, "Pasajeros sensor": e.pasajeros == null ? "" : e.pasajeros,
          "Revisado": momento(e.revisado_en || e.intento_en) };
      });
      XLSX.utils.book_append_sheet(libro, hojaDe(avisos.length ? avisos : [{ "Avisos de los buses": inf.estados
        ? "Ningún bus dejó de reportar entre esas fechas" : "Todavía no está el estado de los buses" }], { "Qué pasó": 70 }), "Avisos de los buses");
      var base = baseDelInforme();
      XLSX.writeFile(libro, "informe_" + inf.por + (base ? "_" + base.replace(/\s+/g, "") : "") + "_" + inf.desde + "_a_" + inf.hasta + ".xlsx");
    } catch (err) {
      aviso("No se pudo armar el Excel: " + textoError(err), "mal");
    } finally {
      boton.disabled = false;
      boton.textContent = "Descargar Excel";
    }
  }

  // ================================================================ aplicación
  // Instalarlo como aplicación (PWA) y las versiones nuevas. El service worker (sw.js) guarda la página
  // para que abra rápido; lo de Supabase nunca lo guarda. Una versión nueva queda en espera hasta que la
  // persona toca "Actualizar": así no se recarga a mitad de una corrección.
  var app = { esperando: null, aplicando: false, instalar: null };

  function nuevaVersionLista(worker) {
    app.esperando = worker;
    $("nuevaVersion").hidden = false;
    try {                                   // la versión que trae, para decirla
      var canal = new MessageChannel();
      canal.port1.onmessage = function (ev) {
        if (ev.data) $("nuevaVersionTexto").textContent = "Hay una versión nueva del portal (" + ev.data + ").";
      };
      worker.postMessage({ type: "VERSION" }, [canal.port2]);
    } catch (_) {}
  }

  function seguirInstalacion(worker) {
    if (!worker) return;
    function revisar() {
      // Sin controlador es la primera instalación: no hay versión vieja que cambiar.
      if (worker.state === "installed" && navigator.serviceWorker.controller) nuevaVersionLista(worker);
    }
    worker.addEventListener("statechange", revisar);
    revisar();
  }

  function iniciarAplicacion() {
    $("entrarVersion").textContent = cfg.VERSION || "";
    $("btnActualizar").addEventListener("click", function () {
      // Si otra pestaña ya la activó, basta con recargar esta.
      if (!app.esperando || app.esperando.state === "activated") { location.reload(); return; }
      app.aplicando = true;
      this.disabled = true;
      app.esperando.postMessage({ type: "SKIP_WAITING" });
    });

    // Instalar: Chrome y Edge lo ofrecen; el botón sale solo cuando se puede.
    window.addEventListener("beforeinstallprompt", function (ev) {
      ev.preventDefault();
      app.instalar = ev;
      $("btnInstalar").hidden = false;
    });
    $("btnInstalar").addEventListener("click", function () {
      if (!app.instalar) return;
      app.instalar.prompt();
      app.instalar.userChoice.then(function () { app.instalar = null; $("btnInstalar").hidden = true; });
    });
    window.addEventListener("appinstalled", function () {
      app.instalar = null;
      $("btnInstalar").hidden = true;
      aviso("Quedó instalado: búsquelo como \"Control\" en el menú Inicio o en el escritorio.");
    });

    if (!("serviceWorker" in navigator)) return;
    var sw = navigator.serviceWorker;
    var teniaControlador = !!sw.controller;
    sw.addEventListener("controllerchange", function () {
      if (app.aplicando) { location.reload(); return; }
      // Otra pestaña activó la versión nueva: esta sigue con la vieja hasta recargar.
      if (teniaControlador) { app.esperando = null; $("nuevaVersion").hidden = false; }
      teniaControlador = true;
    });
    function buscar() {
      if (app.reg && !document.hidden && navigator.onLine) app.reg.update().catch(function () {});
    }
    function registrar() {
      sw.register("./sw.js", { scope: "./", updateViaCache: "none" }).then(function (reg) {
        app.reg = reg;
        if (reg.waiting && sw.controller) nuevaVersionLista(reg.waiting);
        seguirInstalacion(reg.installing);  // revisión que el navegador ya había empezado
        reg.addEventListener("updatefound", function () { seguirInstalacion(reg.installing); });
        setInterval(buscar, cfg.ACTUALIZACION_VERIFICAR_MS || 30 * 60 * 1000);
        document.addEventListener("visibilitychange", buscar);
      }).catch(function (err) { console.warn("[control] service worker no registrado:", err); });
    }
    if (document.readyState === "complete") registrar();
    else window.addEventListener("load", registrar);
  }

  // ================================================================ eventos
  function iniciar() {
    iniciarAplicacion();
    $("infSub").textContent += " Cada día va " + textoCorte() + ".";
    $("formEntrar").addEventListener("submit", alEntrar);
    $("btnSalir").addEventListener("click", async function () {
      // Solo este navegador: la misma cuenta puede estar abierta en otros PC (y signOut() sin
      // nada cierra la sesión en todos).
      try { await client.auth.signOut({ scope: "local" }); } catch (_) {}
      mostrarEntrar();
    });
    window.addEventListener("hashchange", enrutar);

    // Día
    $("diaFecha").addEventListener("change", function () { if (esFecha(this.value)) location.hash = "#/dia/" + this.value; });
    $("diaAntes").addEventListener("click", function () { location.hash = "#/dia/" + sumarDias(state.dia.fecha, -1); });
    $("diaDespues").addEventListener("click", function () { location.hash = "#/dia/" + sumarDias(state.dia.fecha, 1); });
    $("diaHoy").addEventListener("click", function () { location.hash = "#/dia/" + diaDeHoy(); });
    $("diaActualizar").addEventListener("click", function () { cargarDia(); });
    $("diaExcel").addEventListener("click", excelViajeAViaje);
    $("diaBuscar").addEventListener("input", function () { state.dia.buscar = this.value; pintarDia(); });
    $("diaRuta").addEventListener("change", function () { state.dia.ruta = this.value; pintarDia(); });
    $("diaBase").addEventListener("change", function () {
      state.dia.base = state.inf.base = this.value;
      guardarBase(this.value);
      pintarDia();
    });
    $("diaFiltros").addEventListener("click", function (ev) {
      var b = ev.target.closest("[data-filtro]");
      if (!b) return;
      state.dia.filtro = b.getAttribute("data-filtro");
      Array.prototype.forEach.call(this.querySelectorAll("[data-filtro]"), function (x) {
        x.setAttribute("aria-pressed", String(x === b));
      });
      pintarDia();
    });

    // Bus
    $("busForm").addEventListener("submit", function (ev) {
      ev.preventDefault();
      var interno = $("busNumero").value.trim();
      var fecha = $("busFecha").value;
      if (!interno || !esFecha(fecha)) return aviso("Escriba el bus y el día.", "mal");
      var destino = "#/bus/" + encodeURIComponent(interno) + "/" + fecha;
      if (location.hash === destino) {
        state.bus.filas = null;
        state.bus.error = null;
        pintarBus();
        cargarBus();
      } else {
        location.hash = destino;
      }
    });
    $("busExcel").addEventListener("click", excelBus);
    $("busImprimir").addEventListener("click", function () { window.print(); });

    // Informes
    $("infForm").addEventListener("submit", consultarInforme);
    $("infBase").addEventListener("change", function () {
      state.inf.base = state.dia.base = this.value;
      guardarBase(this.value);
      pintarInforme();
    });
    $("infExcel").addEventListener("click", excelInforme);

    // Gestores
    $("gesFecha").addEventListener("change", function () { if (esFecha(this.value)) location.hash = "#/gestores/" + this.value; });
    $("gesAntes").addEventListener("click", function () { location.hash = "#/gestores/" + sumarDias(state.ges.fecha, -1); });
    $("gesDespues").addEventListener("click", function () { location.hash = "#/gestores/" + sumarDias(state.ges.fecha, 1); });
    $("gesHoy").addEventListener("click", function () { location.hash = "#/gestores/" + diaDeHoy(); });
    $("gesActualizar").addEventListener("click", function () { cargarGestores(); });

    // Movilidad
    $("movForm").addEventListener("submit", function (ev) {
      ev.preventDefault();
      var desde = $("movDesde").value, hasta = $("movHasta").value;
      if (!esFecha(desde) || !esFecha(hasta)) return aviso("Escoja las dos fechas.", "mal");
      var nuevo = "#/movilidad/" + desde + "/" + hasta;
      if (location.hash === nuevo) { state.mov.filas = null; pintarMovilidad(); cargarMovilidad(); }
      else location.hash = nuevo;
    });
    $("movExcel").addEventListener("click", excelMovilidad);
    // Los filtros de la Base de datos, como en 700control
    $("movDia").addEventListener("change", function () { state.mov.filtro.dia = this.value; pintarMovilidad(); });
    $("movBase").addEventListener("change", function () { state.mov.filtro.base = this.value; pintarMovilidad(); });
    $("movDifNeg").addEventListener("click", function () { state.mov.filtro.difNeg = !state.mov.filtro.difNeg; pintarMovilidad(); });
    $("movMetro20").addEventListener("click", function () { state.mov.filtro.metro20 = !state.mov.filtro.metro20; pintarMovilidad(); });
    $("movBuscar").addEventListener("input", function () { state.mov.filtro.texto = this.value; pintarTablaMov(); });
    $("movVehiculos").addEventListener("click", abrirVehiculosMov);
    $("movMifare").addEventListener("click", function () { $("movMifareArchivo").click(); });
    $("movMifareArchivo").addEventListener("change", function () {
      var lista = Array.prototype.slice.call(this.files || []);
      this.value = "";                                        // para poder escoger el mismo archivo otra vez
      if (lista.length) cargarMifare(lista);
    });
    $("movLimpiar").addEventListener("click", function () { state.mov.filtro = filtroMovVacio(); pintarMovilidad(); });
    $("movCuerpo").addEventListener("toggle", function (ev) {
      if (ev.target.id === "movResumen") state.mov.resumenAbierto = ev.target.open;
    }, true);

    // Clics dentro de las tablas y la tarjeta
    document.addEventListener("click", function (ev) {
      var t = ev.target;
      var el;
      if ((el = t.closest("[data-accion]"))) {
        var accion = el.getAttribute("data-accion");
        if (accion === "recargar-dia") cargarDia();
        else if (accion === "recargar-bus") { state.bus.error = null; pintarBus(); cargarBus(); }
        else if (accion === "recargar-informe") consultarInforme();
        else if (accion === "recargar-gestores") cargarGestores();
        else if (accion === "recargar-movilidad") cargarMovilidad();
        return;
      }
      if (t.closest("[data-cerrar-hoja]") || t === $("hoja")) return cerrarHoja();
      if ((el = t.closest("[data-mov-ajuste]"))) return abrirAjusteMov(el.getAttribute("data-mov-ajuste"), el.getAttribute("data-mov-ajuste-dia"));
      if ((el = t.closest("[data-mov-anular]"))) return abrirAnularAjuste(el.getAttribute("data-mov-anular"));
      if ((el = t.closest("th[data-orden]"))) {
        var orden = state.vista === "informes" ? state.inf.orden : state.dia.orden;
        cambiarOrden(orden, el.getAttribute("data-orden"));
        return state.vista === "informes" ? pintarInforme() : pintarDia();
      }
      if ((el = t.closest("[data-corregir]"))) return abrirCorregir(el.getAttribute("data-corregir"), el.getAttribute("data-clave"));
      if ((el = t.closest("[data-foto]"))) return verFoto(el.getAttribute("data-foto"));
      if ((el = t.closest("[data-dano-aprobar]"))) return abrirRevisarDano(el.getAttribute("data-dano-aprobar"), true);
      if ((el = t.closest("[data-dano-rechazar]"))) return abrirRevisarDano(el.getAttribute("data-dano-rechazar"), false);
      if ((el = t.closest("[data-celular-aprobar]"))) return abrirRevisarCelular(el.getAttribute("data-celular-aprobar"), "aprobar");
      if ((el = t.closest("[data-celular-rechazar]"))) return abrirRevisarCelular(el.getAttribute("data-celular-rechazar"), "rechazar");
      if ((el = t.closest("[data-celular-quitar]"))) return abrirRevisarCelular(el.getAttribute("data-celular-quitar"), "quitar");
      if (t.closest("a, input, textarea, select, form")) return;
      if ((el = t.closest("tr[data-mov-dia]"))) {
        var dia = el.getAttribute("data-mov-dia");
        state.mov.filtro.dia = state.mov.filtro.dia === dia ? "" : dia;     // el mismo otra vez: todos los días
        return pintarMovilidad();
      }
      if ((el = t.closest("tr[data-viaje]"))) {
        var clave = el.getAttribute("data-viaje");
        state.bus.abiertos[clave] = !state.bus.abiertos[clave];
        return pintarBus();
      }
      if ((el = t.closest("tr[data-base]"))) {
        var cual = el.getAttribute("data-base");
        state.dia.base = state.inf.base = cual && cual === state.dia.base ? "" : cual;     // la misma otra vez: todas
        guardarBase(state.dia.base);
        return pintarDia();
      }
      if ((el = t.closest("tr[data-bus]"))) {
        location.hash = "#/bus/" + encodeURIComponent(el.getAttribute("data-bus")) + "/" + (el.getAttribute("data-fecha") || state.dia.fecha);
        return;
      }
      if ((el = t.closest("tr[data-dia]"))) {
        location.hash = "#/dia/" + el.getAttribute("data-dia");
      }
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && !$("hoja").hidden) return cerrarHoja();
      if (ev.key === "Enter" && ev.target.matches && ev.target.matches("tr.fila-link")) {
        ev.preventDefault();
        ev.target.click();
      }
    });
    document.addEventListener("submit", function (ev) {
      var form = ev.target;
      var cual = form.getAttribute && form.getAttribute("data-form");
      if (!cual) return;
      ev.preventDefault();
      if (cual === "viaje-manual") guardarManualViaje(form);
      else if (cual === "dia-manual") guardarManualDia(form);
    });
    $("hojaCerrar").addEventListener("click", cerrarHoja);

    // El día de hoy se vuelve a pedir solo cada 2 minutos mientras se ve.
    setInterval(function () {
      if (state.user && state.vista === "dia" && !document.hidden && state.dia.fecha === diaDeHoy() && !state.dia.cargando) cargarDia();
    }, cfg.REFRESCO_MS);

    client.auth.getSession().then(function (r) {
      var s = r && r.data && r.data.session;
      if (s) entrar(s.user); else mostrarEntrar();
    }, mostrarEntrar);
    client.auth.onAuthStateChange(function (evento) {
      if (evento === "SIGNED_OUT" && state.user) mostrarEntrar();
    });
  }

  iniciar();
})();
