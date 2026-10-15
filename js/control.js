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
    "ruta", "itinerario", "conductor", "pasajeros", "pasajeros_sensor", "subidas", "recortados", "estado_calculo",
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
  // El día de la tarjeta va de 3 a. m. a 3 a. m.: a la 1 de la mañana todavía es "ayer".
  function diaDeHoy() { return fechaDe(Date.now() - 3 * HORA_MS); }
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
  function nombreRuta(f) {
    if (f.sin_despacho) return "Sin despacho";
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
    var vista = ["dia", "bus", "informes"].indexOf(partes[0]) >= 0 ? partes[0] : "dia";
    mostrarVista(vista);
    if (vista === "dia") {
      abrirDia(esFecha(partes[1]) ? partes[1] : state.dia.fecha || diaDeHoy());
    } else if (vista === "bus") {
      abrirBus(partes[1] || state.bus.interno, esFecha(partes[2]) ? partes[2] : state.bus.fecha || state.dia.fecha || diaDeHoy());
    } else {
      abrirInformes();
    }
  }

  function mostrarVista(vista) {
    state.vista = vista;
    $("vistaDia").hidden = vista !== "dia";
    $("vistaBus").hidden = vista !== "bus";
    $("vistaInformes").hidden = vista !== "informes";
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
    $("diaSub").textContent = fechaLarga(fecha) +
      (fecha === diaDeHoy() ? " · hoy (el día de la tarjeta va de 3 a. m. a 3 a. m.)" : "");
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
      ]);
      if (res[0].error) throw res[0].error;
      if (b.interno !== interno || b.fecha !== fecha) return;
      b.filas = res[0].data || [];
      ponerBases(b.filas, res[7]);
      b.base = baseEn(res[7], interno, fecha);
      b.estadoBus = res[8] && res[8].data || null;
      b.extra = {};
      (res[1].data || []).forEach(function (x) { b.extra[x.clave] = x; });
      b.historial = { civica: res[2].data || [], pasajeros: res[3].data || [], tiquetes: res[4].data || [] };
      b.danos = res[5].data || [];
      b.diaManual = res[6].data || null;
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
    $("busSub").textContent = fechaLarga(b.fecha) + (r.placa ? " · placa " + r.placa : "") + (b.base ? " · " + b.base : "");
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
    cuerpo.innerHTML = html;
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
      "<td>" + esc(nombreRuta(f)) + (f.ruta ? '<span class="menor">' + esc(f.ruta) + "</span>" : "") + "</td>" +
      "<td>" + esc(capitalizar(f.conductor || "—")) + "</td>" +
      '<td class="n"><strong>' + n(f.pasajeros_sensor) + '</strong><span class="menor">subieron ' + n(f.subidas) +
        (f.estado_calculo === "en_curso" ? ", hasta ahora" : "") + "</span></td>" +
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
    return '<div class="detalle">' + izq + der + "</div>";
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

  // ---------------------------------------------------------------- Excel e imprimir
  function filaExcel(f) {
    return {
      "Día": f.dia, "Bus": f.interno, "Placa": f.placa || "", "Base": f.base || "",
      "Viaje": f.sin_despacho ? "SIN DESPACHO" : f.viaje,
      "Salió": hora(f.hora_salida), "Llegó": f.estado_calculo === "en_curso" ? "en camino" : hora(f.llego_en),
      "Ruta": f.ruta || "", "Itinerario": nombreRuta(f), "Conductor": f.conductor || "",
      "Pasajeros sensor": n(f.pasajeros_sensor), "Subidas sensor": n(f.subidas),
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
    ruta: { titulo: "Ruta", clave: function (f) { return f.sin_despacho ? "Sin despacho" : f.ruta ? f.ruta + " · " + (rutaLegible(f.itinerario) || "") : "Sin itinerario"; } },
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

    // Clics dentro de las tablas y la tarjeta
    document.addEventListener("click", function (ev) {
      var t = ev.target;
      var el;
      if ((el = t.closest("[data-accion]"))) {
        var accion = el.getAttribute("data-accion");
        if (accion === "recargar-dia") cargarDia();
        else if (accion === "recargar-bus") { state.bus.error = null; pintarBus(); cargarBus(); }
        else if (accion === "recargar-informe") consultarInforme();
        return;
      }
      if (t.closest("[data-cerrar-hoja]") || t === $("hoja")) return cerrarHoja();
      if ((el = t.closest("th[data-orden]"))) {
        var orden = state.vista === "informes" ? state.inf.orden : state.dia.orden;
        cambiarOrden(orden, el.getAttribute("data-orden"));
        return state.vista === "informes" ? pintarInforme() : pintarDia();
      }
      if ((el = t.closest("[data-corregir]"))) return abrirCorregir(el.getAttribute("data-corregir"), el.getAttribute("data-clave"));
      if ((el = t.closest("[data-foto]"))) return verFoto(el.getAttribute("data-foto"));
      if ((el = t.closest("[data-dano-aprobar]"))) return abrirRevisarDano(el.getAttribute("data-dano-aprobar"), true);
      if ((el = t.closest("[data-dano-rechazar]"))) return abrirRevisarDano(el.getAttribute("data-dano-rechazar"), false);
      if (t.closest("a, input, textarea, select, form")) return;
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
