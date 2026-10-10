# Herramientas de datos

## `csv-a-json.mjs` — Generar `data/modelos.json` desde los CSV

Convierte los catálogos CSV de marcas y modelos en el archivo `data/modelos.json`
que la app usa para el autocompletar de modelos por marca (catálogo offline).

### Estructura esperada de los CSV

- **`brand.csv`** (marcas): columnas `id`, `Nombre`, `Slug`
- **`modelos.csv`** (modelos): columnas `id_marca`, `id`, `Nombre`, `slug`
  - `id_marca` apunta a `brand.csv.id` (así se agrupa cada modelo bajo su marca).

El script es tolerante a:
- Separador coma (`,`) o punto y coma (`;`) — autodetectado.
- Comillas dobles y comas dentro de comillas.
- BOM al inicio del archivo (típico de Excel).
- Nombres de columna en cualquier mayúscula/minúscula y con/sin acentos.

### Uso

```bash
node tools/csv-a-json.mjs <brand.csv> <modelos.csv> [salida.json]
```

Ejemplo (coloca tus CSV en `data/csv/`):

```bash
node tools/csv-a-json.mjs data/csv/brand.csv data/csv/modelos.csv data/modelos.json
```

Salida de ejemplo:

```
✅ Generado data/modelos.json
   Marcas:  48
   Modelos: 1234 (únicos por marca)
   Tamaño:  32.1 KB
   ⚠️  3 modelos sin marca válida (id_marca no está en brand.csv) — se omitieron.
```

### Después de generarlo

1. Revisa el resumen (nº de marcas/modelos y tamaño).
2. Si el tamaño es grande (varios cientos de KB), avísame y lo optimizamos
   (p. ej. filtrar marcas sin presencia en México). La app lo carga de forma
   **diferida** (solo al entrar a captura), así que no afecta el arranque.
3. Sube la versión de `CACHE` en `sw.js` para que el service worker sirva el
   JSON nuevo.
