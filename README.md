# Grifos en ruta · Lima – Ica

Página web (sin servidor) que muestra los grifos de la Panamericana Sur entre Lima e Ica, separados por **sentido de circulación**, con precios de [Facilito (Osinergmin)](https://www.facilito.gob.pe/facilito/pages/facilito/buscadorEESS.jsp), mapa de OpenStreetMap y **GPS** para saber por dónde vas y cuál es el próximo grifo barato de tu lado de la pista.

## Qué hace

- **GPS**: con "Activar GPS" te ubica en la ruta, calcula el km por el que vas y te dice el grifo más barato en los próximos 30/60/100 km y el próximo de tu sentido, con distancia y minutos aproximados. Mantiene la pantalla encendida mientras está activo. Si detecta que el km baja, te avisa que quizá vas en el otro sentido.
- **Sentido**: un grifo es "de tu sentido" si está a tu derecha **y** más cerca de tu calzada que de la contraria. Los del otro sentido (necesitas retorno) y los dudosos van aparte.
- **Precios**: se actualizan solos 4 veces al día (6, 10, 14 y 18 h de Lima) y también cuando tú quieras.

## Cómo publicarlo (una sola vez, ~10 minutos)

1. **Crea el repositorio.** En GitHub: *New repository* → nombre, por ejemplo `grifos-ruta` → **Public** → *Create repository*.
2. **Sube los archivos.** Lo más seguro es con [GitHub Desktop](https://desktop.github.com/) o con git:
   ```bash
   cd grifos-ruta
   git init -b main
   git add .
   git commit -m "Primera versión"
   git remote add origin https://github.com/TU_USUARIO/grifos-ruta.git
   git push -u origin main
   ```
   > Si prefieres subirlos desde la web (*Add file → Upload files*), revisa que se haya subido la carpeta oculta `.github/workflows/update.yml`. Si no aparece, créala con *Add file → Create new file*, escribe la ruta `.github/workflows/update.yml` y pega el contenido del archivo.
3. **Activa GitHub Pages.** *Settings → Pages → Build and deployment → Source:* **GitHub Actions**.
4. **Permite que la Action guarde los precios.** *Settings → Actions → General → Workflow permissions:* **Read and write permissions** → *Save*.
5. **Primera actualización.** Pestaña *Actions* → "Actualizar precios y publicar" → **Run workflow**. Al terminar (1–2 min) tu página queda en
   `https://TU_USUARIO.github.io/grifos-ruta/`
6. **En el celular**, abre ese enlace en Chrome o Safari, toca "Activar GPS" y acepta el permiso de ubicación. Puedes añadirla a la pantalla de inicio (*Compartir → Añadir a pantalla de inicio*).

## Actualizar precios cuando quieras

En la página, el botón **Actualizar precios** te lleva a la Action de tu repo: toca **Run workflow** (con tu sesión de GitHub iniciada) y en 1–2 minutos la página tiene precios nuevos. Recarga la página para verlos.

El botón no dispara la Action directamente porque eso exigiría poner un token de tu cuenta en el código público.

## Si la Action no puede descargar los precios

Facilito no es una API oficial y podría rechazar las consultas desde los servidores de GitHub. En ese caso la Action termina con un aviso y la página sigue funcionando con los últimos precios guardados. Puedes actualizar desde tu computadora (Node 20 o superior):

```bash
node scripts/build.mjs
git add data && git commit -m "Precios actualizados" && git push
```

## Cambiar la ruta

Edita `config.json`: coordenadas de origen y destino, y las provincias por las que pasa (códigos de Facilito). La próxima ejecución de la Action recalcula la ruta y los grifos.

| Provincia | departamento | provincia |
|---|---|---|
| Lima | 150000 | 150100 |
| Cañete | 150000 | 150500 |
| Chincha | 110000 | 110200 |
| Pisco | 110000 | 110500 |
| Ica | 110000 | 110100 |
| Nazca | 110000 | 110300 |

## Archivos

- `index.html`, `styles.css`, `app.js`: la página.
- `config.json`: ruta y provincias.
- `data/`: grifos, ruta y fecha de actualización (los genera `scripts/build.mjs`).
- `scripts/build.mjs`: descarga la ruta (OSRM) y los precios (Facilito) y calcula el km, la distancia y el lado de cada grifo.
- `.github/workflows/update.yml`: actualización automática y publicación en GitHub Pages.

## Límites

- El lado de la pista se calcula con la ubicación que cada grifo registró en Osinergmin; si una está mal puesta, el grifo puede caer en la lista equivocada. Confírmalo con "Cómo llegar".
- Los precios los reporta cada grifo y pueden cambiar durante el día.
- La ruta se calcula con el servidor público de OSRM; es la misma que marca Google Maps para este trayecto (unos 290 km por la autopista, que pasa por fuera de Cañete, Chincha y Pisco).
