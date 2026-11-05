# Fase B.2 — Refacciones multi-dispositivo (continuar un inventario en otro equipo)

Esta actualización hace que un inventario de refacciones (sobre todo el ROTATIVO)
se pueda **iniciar en un equipo y continuar/contar en otro** sin que aparezcan
datos viejos y sin perder conteos. Resuelve lo que viste: el celular mostraba
partes de pruebas anteriores y no podía continuar el rotativo de la PC.

> Solo toca **refacciones**. Unidades y usuarios no cambian.

Hay que hacer **2 cosas** en el Synology, en este orden.

---

## Paso 1 · Base de datos (phpMyAdmin)

Entra a phpMyAdmin → base **`inventario_vehiculos`** → pestaña **SQL**, y ejecuta
**cada línea por separado** (pulsa Continuar después de cada una; si las pegas
todas juntas phpMyAdmin puede quejarse del delimitador):

```sql
ALTER TABLE refacciones ADD COLUMN IF NOT EXISTS rotativo_sesion VARCHAR(40) NOT NULL DEFAULT '';
```

```sql
CREATE TABLE IF NOT EXISTS refacciones_auditoria (
  agencia     VARCHAR(120) NOT NULL,
  datos       LONGTEXT     NULL,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (agencia)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

Ambas son seguras y repetibles (no borran datos). La primera agrega una columna
a la tabla `refacciones`; la segunda crea una tabla nueva para la "sesión" del
inventario (qué tipo es y cuáles partes forman la muestra rotativa).

---

## Paso 2 · Subir el archivo PHP (File Station)

Sube **un solo archivo**, reemplazando el que está:

- **`backend/api/handlers/parts.php`**  →  carpeta `.../api/handlers/`

Este archivo nuevo:
- Guarda y devuelve el sello de la muestra rotativa (`rotativo_sesion`).
- Añade los endpoints `GET /parts/audit?agency=..` y `PUT /parts/audit` para la
  sesión del inventario.

No hace falta reiniciar nada; en 1–2 minutos el servidor toma el archivo (si no,
en el Centro de paquetes: PHP 8.2 → Detener/Iniciar).

---

## Paso 3 · Probar (lo que te falló antes)

1. En la **PC**: Refacciones → agencia → Rotativo → elige 15 → genera la muestra.
2. En el **celular** (misma agencia): espera ~20 s (se sincroniza solo) o cambia
   de pestaña y vuelve. Debe aparecer el **mismo** inventario rotativo de 15, sin
   datos viejos.
3. Cuenta unas partes en el celular y otras en la PC (anaqueles distintos): los
   conteos **se suman** sin pisarse.
4. Cierra el inventario en un equipo: el otro, al sincronizar, verá el cierre.

---

## Qué cambió por dentro (resumen técnico)

- **Pull con reemplazo por agencia:** al bajar refacciones, el inventario local de
  cada agencia se **reemplaza** por el del servidor (ya no se acumulan datos
  viejos). Se conservan los conteos locales más nuevos aún sin subir (se re-suben).
- **`rotativo_sesion`** persiste en la tabla `refacciones` → la muestra viaja entre
  equipos y el flujo rotativo solo "ve" las partes de esa muestra.
- **Sesión por agencia** en `refacciones_auditoria` (tipo, rondas, muestra,
  firmas, cierre) → se sincroniza con "gana el más reciente". Así el rotativo se
  continúa en otro equipo y el cierre se propaga.
- **Regla operativa recomendada:** si dos equipos cuentan en paralelo, que se
  repartan anaqueles **sin solaparse**. Si por error dos cuentan la MISMA parte,
  gana el último conteo guardado (comportamiento esperado).
