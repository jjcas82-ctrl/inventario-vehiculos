# vendor/ — Librerías locales (para que el escáner funcione SIN internet)

El escáner de QR / código de barras usa **ZXing**. Para que funcione **offline**
(p. ej. en el patio con señal débil, donde fallaba la lectura), guardamos aquí una
copia local de la librería en vez de bajarla del CDN en cada uso.

> El código ya está preparado: `js/scanner.js` intenta cargar primero estos
> archivos locales y, si no existen, recurre al CDN como respaldo. Así que la app
> **funciona igual** aunque todavía no hayas puesto los archivos; solo que hasta
> entonces seguirá dependiendo de internet para el escáner.

## Archivos a colocar aquí

Descarga estos **2 archivos** y guárdalos en esta carpeta con EXACTAMENTE estos nombres:

| Guardar como | Descargar de (abrir en el navegador y guardar) |
|---|---|
| `vendor/zxing-browser.js`  | https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/+esm |
| `vendor/zxing-library.js`  | https://cdn.jsdelivr.net/npm/@zxing/library@0.20.0/+esm |

### Cómo descargarlos (una sola vez)

**Opción rápida (desde una PC con internet):**

```bash
curl -L "https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/+esm"  -o vendor/zxing-browser.js
curl -L "https://cdn.jsdelivr.net/npm/@zxing/library@0.20.0/+esm" -o vendor/zxing-library.js
```

**Opción navegador:** abre cada URL, y usa "Guardar como…" con el nombre indicado.

### Verificación

Cada archivo debe pesar varios cientos de KB y empezar con código JavaScript
(no una página de error). Si abres `zxing-browser.js` debe contener `export`.

## Después de colocarlos

1. Súbelos al repositorio (y al servidor Synology junto con el resto de la app).
2. En `sw.js`, ya están incluidos en la lista de archivos cacheados, así que el
   service worker los guardará para uso offline. Si cambias de versión, sube el
   número de `CACHE` en `sw.js`.
3. Prueba el escáner en el patio en **modo avión**: debe leer igual de rápido.

## Nota técnica

Estos archivos son el build **ESM** de ZXing (el mismo que servía el CDN). Al estar
en el mismo origen que la app, cargan más rápido y sin depender de la red.
