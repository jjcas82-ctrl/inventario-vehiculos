# Fase B — Refacciones por agencia (pasos para el servidor Synology)

Esta fase hace que el inventario de **refacciones** quede separado por agencia
también **en el servidor**, y habilita el **conteo multi-dispositivo** (varios
equipos contando en paralelo sin pisarse).

> El inventario de **unidades/vehículos NO cambia** con esto. Solo refacciones.

Hay que hacer **2 cosas** en el Synology, en este orden:

---

## Paso 1 · Actualizar la base de datos (phpMyAdmin)

1. Entra a **phpMyAdmin** en el Synology.
2. Selecciona la base **`inventario_vehiculos`** (columna izquierda).
3. Abre la pestaña **SQL** y pega **este bloque**, luego pulsa **Continuar**:

```sql
-- Columnas nuevas (no borra datos). Repetible sin problema.
ALTER TABLE refacciones ADD COLUMN IF NOT EXISTS agencia       VARCHAR(120) NOT NULL DEFAULT '';
ALTER TABLE refacciones ADD COLUMN IF NOT EXISTS conteos       LONGTEXT NULL;
ALTER TABLE refacciones ADD COLUMN IF NOT EXISTS exhibiciones  LONGTEXT NULL;
ALTER TABLE refacciones ADD COLUMN IF NOT EXISTS exhibicion    INT NULL;
ALTER TABLE refacciones ADD COLUMN IF NOT EXISTS precio_unit   DECIMAL(12,2) NULL;
ALTER TABLE refacciones ADD COLUMN IF NOT EXISTS clasificacion VARCHAR(4) NOT NULL DEFAULT '';
```

4. Después, **otra ejecución** para cambiar la llave primaria a la compuesta
   (agencia + número de parte). Pega esto y pulsa **Continuar**:

```sql
ALTER TABLE refacciones DROP PRIMARY KEY, ADD PRIMARY KEY (agencia, num_parte);
```

   - Si sale el error *"Multiple primary key defined"* o *"Duplicate entry"*,
     significa que había el **mismo número de parte repetido sin agencia**.
     En ese caso, primero vacía la tabla (los datos de refacciones son de
     trabajo, no se pierde el histórico que vive en la app) con:
     ```sql
     DELETE FROM refacciones;
     ```
     y vuelve a ejecutar el `ALTER TABLE ... ADD PRIMARY KEY (agencia, num_parte);`.

> **Nota:** si prefieres partir limpio, basta con `DELETE FROM refacciones;` y
> luego el `ALTER ... ADD PRIMARY KEY`. El inventario se vuelve a cargar desde la
> app por agencia; el **histórico de inventarios cerrados** está guardado en la
> app (no en esta tabla), así que no se pierde.

---

## Paso 2 · Subir el archivo PHP (File Station)

Sube **un solo archivo** (reemplaza el que está):

- **`backend/api/handlers/parts.php`**  →  a la carpeta `.../api/handlers/` del
  servidor (donde ya están `vehicles.php`, `users.php`, etc.).

Después, en **Web Station**, reinicia el servicio (o espera a que tome el cambio)
para que PHP recargue el archivo (OPcache).

---

## Paso 3 · Comprobar

1. En la app (ya actualizada), entra a **Refacciones**, elige una agencia,
   carga existencias y haz un conteo.
2. Abre la app en **otro equipo**, misma agencia, y cuenta **otras** partes
   (anaqueles distintos). Al sincronizar, **ambos conteos deben sumarse** sin
   pisarse.
3. Cambia de agencia y verifica que el mismo número de parte puede tener
   existencias distintas en cada agencia **sin mezclarse**.

---

## Qué cambió por dentro (resumen técnico)

- Tabla `refacciones`: clave primaria **(agencia, num_parte)** + columnas
  `precio_unit`, `clasificacion`, `conteos` (JSON por ronda), `exhibiciones`
  (JSON por punto) y `exhibicion` (total).
- `parts.php`: todos los endpoints reciben la **agencia** (`?agency=` en GET/DELETE,
  en el cuerpo en PUT/POST). El **conteo fusiona por parte** (solo toca esa parte
  de esa agencia), lo que permite el conteo en varios dispositivos a la vez.
- Front (`api.js`, `sync.js`): envían/reciben la agencia; la fusión al bajar del
  servidor es por **(agencia, número de parte)**.
