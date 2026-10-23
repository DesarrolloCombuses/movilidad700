# Portal de Control · Combuses

Aplicación web (PWA) para las personas de control. Muestra la tarjeta de despacho de todos los buses:
- los viajes;
- lo que dijo cada conductor contra lo que contó el sensor;
- la plata de cada viaje (pasajeros × pasaje);
- los avisos de cada bus;
- informes por fechas en Excel.

**Dirección:** https://desarrollocombuses.github.io/movilidad700/

Se entra con una cuenta de Supabase de Combuses. Sin cuenta solo se ve la pantalla de entrada.

## Instalarlo como aplicación

En el PC, con **Chrome** o **Edge**, abra la dirección y entre con su cuenta. Después instálelo de una de estas dos formas:
- con el botón **Instalar** de arriba a la derecha;
- con el ícono de instalar que sale al final de la barra de direcciones.

Queda como **"Control"** en el menú Inicio y abre en su propia ventana.

Cuando se publica una versión nueva, arriba sale **"Hay una versión nueva del portal"**. Toque **Actualizar**. No se recarga solo, para no cortar una corrección a la mitad.

## Qué tiene

| Sección | Para qué |
|---|---|
| **Día** | Todos los buses de un día: viajes, pasajeros y plata del sensor y del conductor, la diferencia, cívicas, tiquetes y qué falta o hay que revisar, en tiempo real (se vuelve a pedir solo cada 2 minutos). Filtros: con aviso, no cuadran, por revisar, sin llenar, sin despacho, por base y por ruta. El botón **Excel viaje a viaje** descarga el día completo como lo arman los auxiliares. |
| **Por base** | Un renglón por base con sus totales del día (buses, viajes, sensor, lo que dice el conductor, la diferencia, cívicas, tiquetes y estado) y el de todas las bases. Al tocar una base se abre el Día solo con esa base. |
| **Tarjeta del bus** | La tarjeta de papel completa, viaje por viaje. Al abrir un viaje se ve **el mapa de su recorrido** y por qué itinerario fue, cada apertura de puerta (hora, suben, bajan, dónde, bloqueo), quién escribió cada número y sus correcciones, y el daño del validador con su foto. Excel e imprimir con firmas. |
| **Informes** | Entre dos fechas, agrupado por bus, conductor, ruta, día o base, o de una sola base. Por conductor sale primero el que más plata dice de menos. El Excel trae el resumen, cada viaje, las correcciones, los daños y los avisos de los buses. |
| **Movilidad** | La "Base de datos" de Movilidad 2026, como la sacaba 700control: un renglón por bus y día, con las mismas 25 columnas, entre dos fechas y con sus filtros. Los despachadores escriben los **ajustes** (taller, administrativo, despachador). **Descargar Excel** la deja igual al maestro, con las fórmulas, para pegar debajo. |
| **Novedades** | Las que reportan los conductores desde su app: número, hora, bus, qué pasó (trasbordo con cuántos y de qué bus, varado, accidente u otra, con la nota), conductor y dónde. Los despachadores ven el **video** y pueden **anular** una novedad diciendo por qué. Entre dos fechas y por tipo. |
| **Personal** | El personal de la empresa que se registró en los buses cada día (leyó el código del bus en el celular del conductor): hora, bus, a qué viaje se pegó (o **sin viaje**, para revisar) y quién. Los despachadores ven además la **selfie** (al tocarla se agranda) y **dónde** estaba. Antes se llamaba Gestores (el enlace sigue siendo `#/gestores`). |

## De dónde salen los datos

Todo sale de Supabase:
- **Los viajes y los pasajeros del sensor:** los escribe cada 5 minutos el programa de la tarjeta, que corre en el PC de la oficina (`tarjeta_viajes`).
- **El estado de cada bus:** el mismo programa lo deja en `tarjeta_buses_dia`. Pasadas las 2:50 a. m. cierra el día anterior y lo deja definitivo.
- **El recorrido GPS de cada viaje:** el mismo programa se lo pide a Sonar cuando el viaje llega y lo deja en `tarjeta_recorridos` (versión 7 del SQL).
- **La cívica, los pasajeros y los tiquetes:** los escribe el conductor en **"Mi tarjeta"** de su aplicación (https://desarrollocombuses.github.io/combuconductores/).

### El mapa de cada viaje

Al abrir un viaje en la tarjeta del bus sale un mapa con:
- **el recorrido GPS** desde el despacho hasta la llegada: verde si tuvo despacho, naranja si fue sin despacho;
- **las paradas** donde se abrió la puerta: verde donde se subió gente, ámbar donde solo se bajó (al tocarlas dicen la hora y cuántos);
- **"Salió" y "Llegó"** con su hora;
- **arriba, por qué itinerario fue.**

El recorrido aparece cuando el viaje llega. Mientras tanto, o si el viaje es de antes de la versión 7, salen solo las paradas.

### Los viajes sin despacho

Siguen marcados **SIN DESPACHO**, pero ahora dicen a qué itinerario se parecen, por ejemplo *"Aeropuerto → Túnel → CC San Diego · como el 4507 · lo encontró el viaje a viaje"*. Sonar no lo sabe, porque nadie los despachó. Lo deduce el viaje a viaje por el punto donde se subió la gente y el punto donde se bajó. En Informes por ruta van aparte, por ejemplo *"4507 · Aeropuerto → Túnel → CC San Diego (sin despacho)"*. El Excel dice de dónde salió cada viaje: el despacho de Sonar o el viaje a viaje.

### El personal de la empresa (v0.10.0, versión 10 del SQL)

Desde el 16-oct-2026 el personal de la empresa (gestoras, auxiliares, mecánicos...) se registra al subir: el conductor muestra en su celular un código que cambia cada 20 segundos y la persona lo lee con la app del personal y se toma una selfie. En el viaje **suma en los pasajeros pero su pasaje no se cobra** (la plata de la tarjeta ya viene sin él).

- **En la tarjeta del bus:** el viaje dice *"incluye 1 del personal (no se cobra)"* y en observaciones *"Personal: María Gómez (Gestor De Movilidad) 10:42"*. Al abrir el viaje sale la persona con su selfie, la hora y dónde estaba.
- **En el Excel de la tarjeta:** la columna *Personal de la empresa (no se cobra)* y quién fue en Observaciones.
- **En la movilidad** (v0.11.1, lo pidió el usuario el 16-oct): va a los **Ajustes** del bus ese día, como el trasbordo. En Observaciones sale *"Personal de la empresa (2)"*, la hoja de ajustes del bus dice en qué viaje y quién, y la hoja *Ajustes* del Excel lo trae viaje por viaje.
- Lo de aprobar celulares (lo de abajo, v0.6.0) se quitó: la huella ya no se usa.

### Las novedades del conductor (v0.11.0, novedades.sql: la versión 11)

Desde el 16-oct-2026 el conductor reporta novedades en su app: trasbordo, bus varado o daño, accidente o incidente, u otra. Cada una tiene su número (N° 1001...) y puede traer un video de máximo 1 minuto en calidad media.

- **El trasbordo** lo reporta el bus que **recibe** los pasajeros (el 722 se vara y sus 15 pasan al 735: lo reporta el 735). Va **de una vez** a los **Ajustes** de la movilidad de ese bus y ese día: en Observaciones sale *"Trasbordo 15 del 722 (N° 1001)"*, la hoja de ajustes del bus los lista y la hoja *Ajustes* del Excel los trae uno por uno.
- **Cada novedad va pegada a su viaje** (v0.12.0, sql v11.1): el conductor la reporta desde el viaje en su tarjeta. En la **tarjeta del bus** sale en las observaciones del viaje (*"Novedad N° 1001: Trasbordo 15 del 722"*) y, al abrir el viaje, con su video y el botón de anular; las que no tienen viaje (reportadas sin señal a una hora sin viaje) van debajo de la tabla. El Excel de la tarjeta las trae en Observaciones.
- **Anular:** solo un despachador, en la pestaña Novedades o en la tarjeta del bus, con el porqué. La novedad no se borra; deja de restar.
- **Los videos** solo los ven los despachadores (enlace firmado de 1 hora). A los **90 días** se borran: lo hace Control cuando entra un despachador (una vez por sesión), y la novedad queda con *Borrado a los 90 días*.

### Los gestores (v0.6.0, versión 8 del SQL; ya no se usa desde el 16-oct)

El sensor de la puerta cuenta a los gestores como pasajeros. Ahora el gestor muestra en su celular un código firmado con su huella y el conductor lo lee con su aplicación. El programa de la oficina lo revisa y, si cuadra, lo resta del viaje.

- **Aprobar celulares:** en **Gestores**, cada celular nuevo sale con la selfie, el cargo, la cédula y el teléfono. Mire que la foto sea la persona y toque **Aprobar**; si no, **Rechazar** con el porqué. Un gestor tiene un solo celular: al aprobar uno nuevo, el anterior deja de servir. **Quitar el celular** lo deja sin código desde ya.
- **Lo que leyeron los conductores:** cada código del día con su bus, hora, dónde y el resultado: **Se restó**, **No se restó** (con el motivo, por ejemplo "el sensor no contó a nadie subiendo a esa hora") o **Sospechoso** (el mismo código en dos buses, o el mismo gestor en dos buses a la vez). Al tocarlo abre la tarjeta del bus.
- **En la tarjeta del bus:** los pasajeros del viaje ya vienen sin los gestores y dicen *"+1 gestor (no cuenta)"*. Al abrir el viaje sale quién subió, a qué hora y dónde, y un punto morado en el mapa.

Sin la versión 8 del SQL, la pestaña lo dice y la tarjeta sale como antes.

### El Excel del viaje a viaje (v0.7.0)

En **Día**, el botón **Excel viaje a viaje** descarga el mismo Excel que arma el programa de Python para los auxiliares (`viaje_a_viaje_<día>.xlsx`), de toda la flota o solo de la base escogida:
- **Viaje a viaje:** cada vez que se abrió la puerta (hora, entradas, salidas, dirección, conductor; en verde si subió alguien) y debajo **el total del viaje** con fórmulas. Azul es normal, ámbar es sin despacho y rojo es que el sensor pasó de 19.
- **TARJETA** viene con los pasajeros que el conductor escribió en "Mi tarjeta". Si hay un número, aunque sea 0, manda sobre el sensor en la columna **Combuses**. Se puede escribir en cualquier renglón del viaje, cambiar o borrar, y todo se recalcula.
- **CONTEO SENSOR** ya va sin los gestores y con el tope de 19, igual que la tarjeta.
- **CONDUCTOR REPORTA pasajeros** y **CONDUCTOR REPORTA tiquetes** (v0.15.2): en el renglón del total de cada viaje,
  lo que el conductor reportó en el portal. Vacío si no lo ha escrito. No cambian aunque cambien la TARJETA; si Control
  corrigió lo del conductor, el viaje lo dice. También van en el Resumen por viaje.
- **Resumen por viaje** y **Resumen por bus**, con TODA LA FLOTA al final.

No trae la hoja **"Fuera de la ruta"** ni las aperturas sin viaje (patio, taller, aseo): Supabase solo guarda cuántas fueron. Esas siguen saliendo en el Excel del programa de Python.

### La movilidad (v0.9.5, movilidad.sql versión 2)

Hasta agosto, la "Base de datos" de Movilidad 2026 se armaba con la plantilla [700control](https://github.com/DesarrolloCombuses/700control) (el archivo de Sonar, el del Metro y el de ajustes). Ahora sale sola en **Movilidad**, de lo que publica el programa de la tarjeta, **con la regla de 700control**, el Descuento>20 en cero, y restando el Metro y 2 por viaje (15-oct-2026):

| Columna | De dónde sale |
|---|---|
| **Sonar** | Todo lo que contó la puerta entrando en el día: en los viajes y fuera del viaje a viaje. |
| **Sin ruta** | Lo que entró fuera del viaje a viaje: en la ruta sin viaje, y en el patio o el taller. Ya va dentro de Sonar y de los ingresos; la columna solo lo muestra. |
| **Descuento>20** | 0: sin tope por viaje. |
| **Ajustes** | Los que escriben los despachadores aquí (taller, administrativo, despachador u otro, con nota), más los gestores que subieron con su código y lo que control corrigió en un viaje. |
| **Ingresos totales** | Sonar − Descuento>20 − Pasajeros metro − 2 × Viajes realizados − Ajustes. Ejemplo: el 703 del 1 de octubre, 163 − 31 − 18 = 114. |
| **Salidas P1** | Lo que bajó en los viajes más lo que bajó fuera de ellos. **Salidas P2** va en 0: el sensor no separa las puertas. |
| **Total salidas** | Salidas P1 + Salidas P2 − Pasajeros metro − 2 × Viajes realizados − Ajustes (lo mismo que a los ingresos, para que la Dif compare parejo). |
| **Dif** | Ingresos totales − Total salidas. En rojo cuando pasa de 30, como en el Excel. |
| **Viajes realizados** | Los viajes **con despacho**. Los sin despacho Sonar los pone como "sin ruta": su gente suma en Sonar, pero no restan (así coincide con la movilidad del 1 al 5 de octubre hecha con 700control). |
| **Observaciones** | Los motivos de los ajustes, en el orden del Excel ("Taller - Administrativo - Despachador"), "Gestor", "Corrección de control" y "No laboró" si no hizo viajes. |
| **Pasajeros metro** | Los usos de la tarjeta Mifare (cívica) de cada bus: de la **plantilla metro** (fecha, vehiculo, total) o de los archivos *LiquidacionUsosTransporteMifare*. En los días con Metro cargado, el bus sin usos va en 0; el día sin Metro va vacío y no resta. Se resta de los ingresos y de las salidas. |

- **La ayuda** (arriba, plegada: "¿Cómo funciona la movilidad y cómo se carga el Metro?") explica en la misma pantalla cómo sale cada número, con el ejemplo del 703 del 1 de octubre, cómo armar y cargar la plantilla metro, cómo cruza y qué quiere decir cada aviso.
- **Despachos no realizados** (15-oct-2026; **solo en el Excel desde v0.14.2**: el 20-oct el usuario pidió quitarlos de la pantalla porque no son necesarios ahí). Se revisan con el GPS al descargar el Excel, no al abrir Movilidad. Un despacho **no se realizó** cuando Sonar lo canceló **y** su recorrido GPS (tarjeta_recorridos) anduvo menos de la mitad de lo normal de esa ruta (`KM_NORMAL` en control.js: la mediana de cada itinerario del 1 al 14 de octubre). Solo cancelado no basta: del 1 al 14 de octubre, 674 de 920 cancelados hicieron la ruta completa. Ejemplo: el 703 del 1-oct, viaje 3, a las 10:32 a. m.: 0 km en 1 minuto. Del 1 al 14 de octubre fueron 164 (110 suben, 54 bajan), y 55 cancelados no tienen GPS (van aparte: no se sabe). **Siguen contando en Viajes realizados**: solo se ven. El Excel los trae en las hojas *Despachos no realizados* (la lista) y *No realizados por bus y día* (la tabla).
- **La pantalla** es la Base de datos: las mismas columnas del Excel, en el mismo orden, con la fila de totales abajo. Se filtra como en 700control: por **día**, **base**, **Dif < 0**, **Metro > 20**, texto y **vehículos**. Arriba van los totales y el **Resumen por día** (tocar un día deja solo ese día).
- **Escribir un ajuste:** en el renglón del bus, **+ Ajuste**: cuántas personas y el motivo. No se borra: se **anula** con el porqué, y queda quién y cuándo.
- **Cargar Metro** (solo despachadores). Antes de guardar muestra qué día, cuántos usos y cuántos buses trae cada archivo, y avisa si un bus no está en Sonar ese día o tiene Metro un día en que no hizo viajes. Recibe (15-oct-2026):
  - **la plantilla metro**: una hoja con las columnas `fecha`, `vehiculo` y `total`, un renglón por bus y día (pueden ir varios días). Se guarda **tal cual**: la fecha es el día de la movilidad. Si un renglón no tiene bien la fecha, el vehículo o el total, no se carga nada de ese archivo y dice cuál renglón es;
  - o los archivos `LiquidacionUsosTransporteMifare DD-MM-AAAA.xlsx`, sueltos o en el `.zip`. Cada uno va al **día de su nombre**, como en la plantilla: el "01-10" (usos del 30-sep 2:30 a. m. al 01-oct 2:29 a. m.) es el **1 de octubre**. La placa (*Equipo*) se pasa a número de bus con **las placas de Sonar** (la tabla de los archivos tenía cambiados 708 con 757 y 723 con 751);
  - cargar otra vez un día lo reemplaza: el bus que ya no sale queda en 0.
- **Descargar Excel:** la hoja *Base de datos* igual a la de Movilidad 2026: las 25 columnas en el mismo orden, los mismos anchos y colores del encabezado, el filtro y la Dif en rojo. El bus va como texto con un espacio al final ("703 "), menos el 710 y el 756, como en el maestro. **Van con fórmula** Ingresos totales (`=U-R-Q-2*V-N`), Total salidas (`=D+E-Q-2*V-N`) y Dif (`=B-F`): si en el Excel cambian un ajuste, el Metro o los viajes, se recalcula. Trae también *Resumen por día* (con `SUMAR.SI.CONJUNTO` sobre la Base de datos), *Ajustes* (con quién y cuándo) y *Notas*.
- Hace falta `almacentro/enturnes/sql/movilidad.sql` **versión 2** en Supabase. Con la versión 1, Salidas P1 sale solo con lo que bajó en los viajes y la pestaña lo avisa; sin ninguna, no hay ajustes y Sonar sale solo con lo de los viajes.

### Avisos de los buses

| Aviso | Cuándo |
|---|---|
| No reporta GPS | Más de 1 hora sin GPS cuando debía estar trabajando, en su turno o en un viaje. |
| Sensor sin datos | Hizo viajes y el sensor de la puerta no mandó nada. |
| Programado sin viajes | Estaba programado y a las 2 horas de empezar el turno no lleva viajes, o terminó el día sin viajes. |
| No está en Sonar | Está en la programación o tenía viajes, pero no aparece en la lista de buses de Sonar. |
| Sonar no contestó | Sonar no respondió al revisarlo; se vuelve a intentar en 5 minutos. |

Un aviso que se arregla queda en el historial del día ("Tuvo: … visto de 10:05 a 11:40"). Si el programa lleva 15 minutos sin revisar los buses de hoy, el Día lo dice: puede estar apagado o sin internet.

### Viajes sin llenar (v0.13.0)

Debajo de los avisos, el Día dice **qué buses tienen viajes que el conductor no llenó** en Mi tarjeta del
portal: un viaje que ya llegó y al que le falta la cívica, los pasajeros o los tiquetes. Los viajes en camino
no cuentan. Por cada bus salen los conductores con cuántos viajes le faltan a cada uno (*"conductor del turno 1 (6) ·
conductor del turno 2 (5)"*), *"11 de 11"* y qué falta. Van primero los que más tienen sin llenar; se ven los 8 primeros y
"Ver los N buses" muestra el resto. "Filtrar la lista de abajo" deja en la tabla solo esos buses (es el mismo
filtro "Sin llenar", que antes se llamaba "Falta algo" y contaba también los viajes en camino).

### Por base aparte (v0.14.0)

La tabla de las bases salió del Día y es una pestaña arriba, **Por base** (`#/bases/AAAA-MM-DD`), para que el
Día quede solo con el viaje a viaje de los buses. Las dos miran el mismo día: cambiar la fecha en una la cambia
en la otra, y Actualizar o el refresco de cada 2 minutos sirven para las dos. Tocar una base abre el Día solo
con esa base (queda escogida en "Todas las bases" de los filtros); "Todas las bases" abre el Día con todos.

### El personal de la empresa queda como novedad (v0.14.1)

Cuando una persona de la empresa lee el código del bus, se ve en el Estado del Día y de Por base
(*"Personal de la empresa 1"*) y hay un filtro **Personal de la empresa** en el Día. Si leyó el código con el bus
parqueado entre dos viajes (más de 30 minutos antes del despacho o después de que llegó), no se pega a ningún viaje
ni suma a los pasajeros: el chip dice *"(1 sin viaje)"* y la tarjeta del bus lo muestra en el recuadro
**Personal de la empresa sin viaje**, con la hora (y la selfie y el lugar para los despachadores). Así pasó el
18-oct con 5 registros en 5 buses, que antes no salían en ninguna tarjeta.

### Las fechas se ven solas (v0.14.3)

Al cambiar una fecha, la pantalla se actualiza sola, sin tocar Ver ni Consultar: Día, Por base, Tarjeta del bus
(con el bus escrito), Informes, Movilidad, Personal y Novedades. Espera medio segundo por si la persona sigue
escribiendo, y un año a medio escribir (0202…) no cuenta. Si la fecha de inicio queda después de la final, espera
a que se cambie la otra. En Informes, cambiar "Agrupar por" reagrupa de una vez sin volver a traer los viajes, y si
se cambian las fechas mientras trae, queda el último pedido. Los botones Ver y Consultar siguen, para volver a traer.

### El inicio de labores del conductor (v0.14.4)

Control dice si el conductor de cada bus hizo el **inicio de labores**: la entrada en la asistencia (tabla
`asistencias`), marcada desde su celular en el portal (*celular*) o en un equipo con sesión de administrador en la
oficina (*oficina*).
- **Día:** debajo de cada conductor, *"Inicio 04:52 · oficina"* o, en rojo, *"Sin inicio de labores"*; el aviso
  *Sin inicio de labores* en el Estado, el filtro con ese nombre y, arriba, el cuadro *Inicio de labores: 88 de 90*.
- **Por base:** cuántos conductores de cada base no lo hicieron.
- **Tarjeta del bus:** la hora de inicio y de salida de cada conductor.

El cruce es por el nombre que trae Sonar contra la lista del personal (`colaboradores`). Si no es idéntico, toma el
nombre con más palabras iguales (al menos 3) y, si empatan, el que reportó ese bus. Cuentan las marcas del día y las
del día siguiente antes de las 2:30. Con los datos reales: 19-oct 90 de 90; 18-oct 91 de 93.

### Conductores por base y el conductor programado (v0.15.0)

- **Por base → Conductores por base:** de la programación del día (`v_programacion_turnos`), cada base con sus
  conductores: bus, turno y horario, puesto, si hizo el inicio de labores (o *"Entra a las 12:00"* si su turno no ha
  empezado) y **En Sonar**: cuántos viajes hizo el bus en ese turno y si Sonar los tiene a nombre de otro conductor.
  Las bases con alguien sin inicio salen abiertas.
- **Sonar con otro conductor:** si el conductor que trae Sonar no marcó, pero a esa hora el bus estaba programado para
  otro conductor que sí hizo el inicio, no sale *Sin inicio de labores*: sale *"Sonar lo pone, pero el turno 1 es de …:
  inicio 03:46 · oficina"* y el aviso **Sonar con otro conductor**. Ejemplo: el 756 del 20-oct salía con el
  conductor del turno 2 (entra a las 12:00) y manejaba el del turno 1, que marcó a las 03:46. Ese día pasó en 6 buses,
  y el 18-oct en el 735 y el 736.
- **La tarjeta del bus** muestra la programación (cada turno con su inicio de labores).
- **Cédula:** junto a *Sin inicio de labores* sale la cédula (de `colaboradores`), **solo para las cuentas que pueden
  corregir**. Si el conductor no está en la lista del personal, dice *"no está en la lista del personal"*: así no
  puede marcar (el 15-oct, 2 programados de la Base 3).

### Escoger por base y por bus, y el aviso de "cargando" (v0.15.1)

- **Tarjeta del bus:** dos listas, **Base** (con cuántos buses tiene) y **Bus** (solo los de esa base), más **‹ ›**
  para el bus anterior o siguiente. Escoger un bus lo abre de una vez; escoger otra base abre su primer bus. Los buses
  salen de la programación del día y de los que tienen viajes. La base se recuerda, como en el Día.
- **Aviso de cargando:** mientras trae datos (Día, Por base, Tarjeta del bus, Informes, Movilidad, Personal,
  Novedades y los Excel) sale un aviso encima de la pantalla, por ejemplo *"Trayendo la tarjeta del bus 736…"*, y no
  deja tocar otra cosa hasta que termina. Sale si tarda más de un cuarto de segundo, nunca dura más de 90 s, y la
  recarga sola del día (cada 2 minutos) no lo muestra. Informes dice cuántos viajes lleva.
- **Arreglo:** si se cambiaba de bus o de día mientras el anterior todavía cargaba, la pantalla se quedaba en
  "Trayendo…". Ahora, al terminar, trae el que se escogió.

### Lo que reporta el conductor en el Excel viaje a viaje (v0.15.2)

- En **Día → Excel viaje a viaje**, cada viaje trae dos casillas nuevas al lado del CONTEO SENSOR:
  **CONDUCTOR REPORTA pasajeros** y **CONDUCTOR REPORTA tiquetes**, con lo que el conductor escribió en su tarjeta del
  portal. Vacías si no lo ha escrito. Van también en la hoja Resumen por viaje.

### La plata del conductor repartida: tiquete, cívica y efectivo (v0.16.0)

Igual que Mi tarjeta del portal del conductor (v1.16.1). Los pasajeros que dice el conductor (máximo 19, el cupo del
bus) se reparten entre los que pagaron con **tiquete**, con la **cívica** y en **efectivo**, más el personal de la
empresa (no paga). Los tres valen el pasaje. Las cívicas de un viaje son la lectura del despacho siguiente menos la
suya. Ej.: 19 pasajeros, 4 tiquetes y 1 cívica a $20.000 = $80.000 + $20.000 + $280.000 en efectivo (14). Sin lectura
siguiente, lo que no es tiquete sale como *"cívica o efectivo"* (se separa en el próximo despacho).

- **Totales** (Día, Por base, Informes, tarjeta del bus): caja nueva **Efectivo según los conductores**, con
  *"tiquetes … · cívica …"* y lo que falta separar o repartir.
- **Tablas** del Día e Informes: debajo de *$ Conductor*, el efectivo.
- **Tarjeta del bus:** en cada viaje, debajo de *$ Conductor*, tiquetes, cívica y efectivo (cuántos y cuánto).
- **Cuenta mal:** más de 19 pasajeros, o más tiquetes y cívicas que pasajeros: chip *"1 viaje con la cuenta mal"*.
- **Corregir** pasajeros o tiquetes: la cuenta sale mientras se escribe, y más de 19 o una cuenta que no da no deja
  guardar. Corregir la cívica dice cómo quedan las cívicas de ese viaje y del anterior (si no cuadran, solo avisa).
- **Excel** de la tarjeta del bus y de Informes: columnas *$ tiquetes*, *$ cívica*, *$ efectivo*, *$ cívica o
  efectivo (sin separar)* y la cuenta mal.

### La cívica de cada viaje: su lectura menos la del anterior (v0.17.0)

Desde el 20-oct-2026 (pedido del usuario, bus 710: "cuando se repite el validador no debe contar, solo cuando cambia
positivamente") las cívicas de un viaje son su lectura menos la del despacho anterior del bus (vista
`v_tarjeta_viajes` v12, `civica_lectura_anterior.sql`): el conductor escribe la lectura ya hecho el viaje. Ej.: viaje
1 en 2773, viaje 2 en 2773, viaje 3 en 2774 → el 2 tuvo 0 y el 3 tuvo 1. Estados nuevos: "Falta la del viaje
anterior" y "Sin lectura anterior del bus" (ya no "Se completa en el próximo despacho"). Al corregir una cívica, la
cuenta en vivo dice cómo quedan este viaje y el siguiente. Igual que el portal del conductor v1.18.0.

### Bloqueo, no "sensor tapado" (v0.17.1)

Desde el 22-oct-2026 (pedido del usuario) donde decía *sensor tapado* dice **bloqueo**: el aviso de la parada en
*Puerta por puerta*, la nota de abajo, el mapa del recorrido, el Excel de la tarjeta del bus (columna *Bloqueos*) y
la columna *Bloqueos* del Excel viaje a viaje. Solo cambia la palabra: el dato es el mismo (`tapado`).

### Por conductor (v0.18.0)

Pedido del usuario el 22-oct-2026: *"necesito saber quién llenó la tarjeta y quién no, de acuerdo al biométrico, los
que trabajaron"*. Pestaña **Por conductor** (`#/conductores/fecha`):

- **Quiénes:** los conductores con **entrada** en el biométrico ese día (de 2:30 a 2:30), más los que manejaron sin
  marcar (sus viajes salen por el turno programado). Gestores y oficina no salen.
- **Sus viajes:** los de `tarjeta_viajes_conductor` (SQL v15), la misma regla de la liquidación del portal del
  conductor v1.22.0: el último conductor del bus que marcó entrada antes de que saliera; si nadie había marcado, el del
  turno programado.
- **Estado:** *No llenó* (nada escrito en los viajes que ya llegaron), *A medias*, *Llenó todo*, *En camino* (su primer
  viaje no ha llegado) o *Sin viajes*. Arriba: Trabajaron, No llenaron, A medias y Llenaron todo.
- **Columnas:** conductor (la cédula solo para despachadores), bus y turno programado, base, entrada y salida del
  biométrico (celular u oficina), *Viajes llenos* (X de los que ya llegaron, más los que van en camino) y *Le falta*
  (en cuántos viajes falta la cívica, los pasajeros y los tiquetes). Tocar una fila abre la tarjeta del bus.
- Filtros por base y por estado. **Excel** con dos hojas: *Por conductor* y *Viajes* (cada viaje con su conductor y si
  salió por el biométrico o por la programación).
- Sin la función en la base dice *"Falta correr tarjeta_viajes_conductor.sql"*.

### El alistamiento de cada bus (v0.20.0, SQL v16)

Pedido del usuario el 22-oct-2026: integrar la app de alistamiento, la revisión diaria del bus que va a la
Supertransporte por GESMOVIL (*"va atada a todo"*). Es una por placa y por día. El bus sale de la flota por la placa
(la misma lista que ve el conductor: *"KTO059 — interno 708"*).

- **Lo lee** `control_alistamientos(desde, hasta)` y `control_alistamiento_detalle(id)`
  (`almacentro/enturnes/sql/control_alistamientos.sql`): solo leen; las tablas del SICOV no se tocan. Sin ese SQL,
  todo sale como antes y la pestaña dice que falta correrlo.
- **Día:** columna *Alistamiento* (Hecho, Con novedad, **Salió sin alistamiento** en rojo, Falta o No salió), el
  cuadro *"Alistamiento 43 de 51 · 8 salieron sin alistamiento"* y el filtro *Sin alistamiento*.
- **Salió sin alistamiento** = el primer despacho del bus fue antes de tenerlo (o no lo tiene). Ej. 22-oct: el 723
  alistó a las 2:33 y salió a las 2:56 (bien).
- **Pestaña Alistamiento** (`#/alistamiento/fecha`): todos los buses del día, con la hora, el primer despacho, quién lo
  registró, los puntos con falla y las observaciones. Filtros por base y estado. **Excel** con dos hojas: *Alistamiento* y
  *Fallas*.
- **Tarjeta del bus:** el bloque *Alistamiento del día* con lo de arriba y los 40 puntos (los de falla en rojo).
- **Datos sensibles:** lo que declara el conductor de descanso y de alcohol/sustancias, y su cédula, solo lo ven los
  despachadores (`tarjeta_revisores`). Los demás ven *Con novedad* sin el motivo.
- Con nueve pestañas, por debajo de 1600 px van en su propio renglón.

### Los días que faltan por cargar el Metro (v0.19.0)

Pedido del usuario el 22-oct-2026: *"mostrar en la movilidad qué días faltan por adicionar la cívica del metro, esto es
importante"*. En **Movilidad**, arriba de los totales:

- **En rojo:** *"Metro (cívica): faltan por cargar N días"* y un cuadrito por cada día de las fechas escogidas que tiene
  viajes y todavía no tiene el Metro. Esos días los Ingresos totales y el Total salidas salen sin restarlo.
- **En verde**, cuando todos los días con viajes ya lo tienen.
- El total *Pasajeros metro* dice cuántos días están cargados (*"1 de 22 días cargados"*), y en el Resumen por día la
  columna Metro dice *Falta*.
- El Excel trae la misma lista en rojo, arriba de la hoja Notas.
- Un día cuenta como cargado cuando tiene al menos un renglón de `movilidad_externos` con fuente `metro` (Cargar Metro
  deja en 0 los buses que trabajaron y no salen en el archivo).

### El día de la tarjeta

Es el día de la empresa: **de 2:30 a. m. a 2:30 a. m. del día siguiente**. Un viaje va al día de la hora de su
despacho. Por ejemplo, el 718 despachado a las 2:43 a. m. del 15-oct es el primer viaje del 15, y uno despachado a
la 1:00 a. m. todavía es del día anterior. El Día, la tarjeta del bus y los Informes lo dicen. La hora está en
`js/control-config.js` (`DIA_EMPIEZA_MIN`) y tiene que ser la misma del programa que publica la tarjeta.

### La base

Sale de la programación del día. Si un bus no estaba programado ese día, toma la última base que tuvo en los 7 días anteriores. Si no tiene, sale "Sin base". La base escogida se recuerda en ese navegador.

## Quién puede qué

Lo decide Supabase con la cuenta con la que se entra, no esta página:
- **Ver:** cualquier cuenta de Combuses.
- **Corregir, aprobar daños y escribir control y despachadores:** solo las cuentas que están en `tarjeta_revisores`. Para agregar una, en el editor SQL de Supabase:

  ```sql
  insert into public.tarjeta_revisores (correo, nombre) values ('correo@combuses.com.co', 'Nombre');
  ```

- **Nada se borra:** una corrección es otro renglón, con quién, cuándo y por qué.
- **El botón Salir** cierra la sesión solo en ese navegador; si la cuenta está abierta en otros PC, allá sigue abierta.

La llave de Supabase en `js/control-config.js` es la **pública**, la misma de la aplicación del conductor: está hecha para ir en el navegador. Aquí **nunca** va una clave de cuenta ni la llave de servicio.

## Archivos

```
index.html              la página
manifest.webmanifest    nombre, colores e iconos de la aplicación instalada
sw.js                   service worker: guarda la página para abrir rápido; lo de Supabase nunca
css/control.css         los estilos (los colores de la aplicación del conductor)
js/control-config.js    la conexión a Supabase (llave pública) y la versión
js/control.js           todo lo demás
assets/                 iconos
nueva-version.ps1       cambia la versión en todos los sitios a la vez
```

## Publicar una versión nueva

1. Haga los cambios y pruébelos en el PC:

   ```
   python -m http.server 8766 --bind 127.0.0.1
   ```

   y abra http://127.0.0.1:8766

2. Suba la versión en los tres sitios a la vez (configuración, service worker y `?v=` del HTML):

   ```
   powershell -ExecutionPolicy Bypass -File .\nueva-version.ps1 0.4.1
   ```

3. `git commit` y `git push` a `main`. GitHub Pages lo publica en uno o dos minutos, y los PC ven el aviso "Hay una versión nueva".

## Falta

- **Liquidación:** el efectivo que entrega el conductor, los descuentos y el cierre del día con firma. Faltan las reglas de la plata.
