# Grifos en ruta · v2 (cualquier ruta del Perú)

Página: `https://TU_USUARIO.github.io/grifos-ruta/v2/`. La v1 (Lima – Ica) sigue igual en `/grifos-ruta/`.

## Cómo funciona

1. **Precios de todo el Perú, cada madrugada.** La Action "v2: Actualizar precios" baja a las 3:00 h (Lima) los grifos y precios de las 196 provincias de Facilito y los guarda en `v2/data/precios.json`. Tarda unos 10 minutos.
2. **Tú eliges A y B.** Por nombre (búsqueda de OpenStreetMap), tocando el mapa o con tu ubicación. Al tocar **Calcular ruta**, la página pide la ruta de ida y la de vuelta (OSRM) y calcula ahí mismo, en unos segundos, qué grifos están en tu sentido, cuáles por confirmar y cuáles del otro lado. No se guarda nada en GitHub.
3. **Antigüedad de los precios.** Arriba se ve de cuándo son los precios de las provincias por donde pasa tu ruta.
4. **Actualizar precios de esta ruta.** El botón abre un formulario de GitHub ya lleno con esas provincias: tocas **Submit new issue** y vuelves a la página. La Action baja solo esas provincias, publica y cierra el formulario. La página muestra el tiempo que va (suele tardar 3 a 5 min) y se actualiza sola al terminar.

Solo el dueño del repo puede disparar la actualización con el formulario; si otra persona abre uno, la Action no hace nada.

## Archivos

- `v2/index.html`, `v2/app.js`, `v2/styles.css`, `v2/sw.js`, `v2/manifest.webmanifest`: la página.
- `v2/provincias.json`: las 196 provincias con su código INEI (fuente: [ubigeo-peru-aumentado](https://github.com/jmcastagnetto/ubigeo-peru-aumentado)). Facilito usa los mismos códigos.
- `v2/data/precios.json`: grifos y precios de todo el Perú, un grifo por línea. Guarda la fecha de actualización de cada provincia.
- `scripts/v2/precios.mjs`: baja los precios. `node scripts/v2/precios.mjs` para todo el Perú, o `node scripts/v2/precios.mjs 150100,150500` para algunas provincias.
- `.github/workflows/v2-precios.yml`: la Action (madrugada, formulario y botón manual en la pestaña Actions).
- `.github/ISSUE_TEMPLATE/v2-precios.yml`: el formulario que abre el botón.

## Límites

- La ruta y la búsqueda usan servicios públicos gratuitos (OSRM y Nominatim). Si no responden, espera un momento y vuelve a intentar.
- La última ruta calculada queda guardada en el navegador: al volver a abrir la página se recalcula con los precios del día sin pedir la ruta otra vez.
- El lado de cada grifo se calcula con la ubicación que registró en Osinergmin, igual que en v1. En carreteras sin separador casi todo queda "de tu sentido" o "por confirmar", porque ahí sí se puede cruzar.
