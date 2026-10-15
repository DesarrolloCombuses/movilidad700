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
| **Día** | Todos los buses de un día: viajes, pasajeros y plata del sensor y del conductor, la diferencia, cívicas, tiquetes y qué falta o hay que revisar. Una tabla **por base** con sus totales; al tocar una base queda solo esa. Filtros: con aviso, no cuadran, por revisar, falta algo, sin despacho, por base y por ruta. |
| **Tarjeta del bus** | La tarjeta de papel completa, viaje por viaje. Al abrir un viaje se ve cada apertura de puerta (hora, suben, bajan, dónde, sensor tapado), quién escribió cada número y sus correcciones, y el daño del validador con su foto. Excel e imprimir con firmas. |
| **Informes** | Entre dos fechas, agrupado por bus, conductor, ruta, día o base, o de una sola base. Por conductor sale primero el que más plata dice de menos. El Excel trae el resumen, cada viaje, las correcciones, los daños y los avisos de los buses. |

## De dónde salen los datos

Todo sale de Supabase:
- **Los viajes y los pasajeros del sensor:** los escribe cada 5 minutos el programa de la tarjeta, que corre en el PC de la oficina (`tarjeta_viajes`).
- **El estado de cada bus:** el mismo programa lo deja en `tarjeta_buses_dia`. Pasadas las 3:20 a. m. cierra el día anterior y lo deja definitivo.
- **La cívica, los pasajeros y los tiquetes:** los escribe el conductor en **"Mi tarjeta"** de su aplicación (https://desarrollocombuses.github.io/combuconductores/).

### Avisos de los buses

| Aviso | Cuándo |
|---|---|
| No reporta GPS | Más de 1 hora sin GPS cuando debía estar trabajando, en su turno o en un viaje. |
| Sensor sin datos | Hizo viajes y el sensor de la puerta no mandó nada. |
| Programado sin viajes | Estaba programado y a las 2 horas de empezar el turno no lleva viajes, o terminó el día sin viajes. |
| No está en Sonar | Está en la programación o tenía viajes, pero no aparece en la lista de buses de Sonar. |
| Sonar no contestó | Sonar no respondió al revisarlo; se vuelve a intentar en 5 minutos. |

Un aviso que se arregla queda en el historial del día ("Tuvo: … visto de 10:05 a 11:40"). Si el programa lleva 15 minutos sin revisar los buses de hoy, el Día lo dice: puede estar apagado o sin internet.

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
