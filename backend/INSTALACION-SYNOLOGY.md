# Guía de instalación en Synology RS1221RP+ — Backend Inventario (vehículos + refacciones)

Esta guía pone a funcionar la **base de datos (MariaDB)** y la **API (PHP)** en tu
Synology **RS1221RP+** (DSM 7.x), para que todos los dispositivos compartan el mismo
inventario de **unidades** y **refacciones**.

> El RS1221RP+ es un equipo potente (sí soporta Docker/Container Manager), pero **no lo
> necesitamos**: con **Web Station + PHP + MariaDB** (todo nativo de DSM) es más simple y
> suficiente. Mantenemos QuickConnect como respaldo y usamos **DDNS** como acceso principal.

Datos de tu equipo (confirmados):
- **QuickConnect ID:** `backup-aero` → portal `https://quickconnect.to/backup-aero`
  (abre con HTTPS, p. ej. `https://backup-aero.us6.quickconnect.to/`).
- **DDNS que activaremos:** `backup-aero.synology.me` (acceso principal de la API).

---

## PARTE 1 — Instalar los paquetes necesarios

En **DSM → Centro de paquetes**, instala (si no los tienes):

1. **MariaDB 10** — la base de datos.
2. **Web Station** — el servidor web para la API PHP.
3. **PHP 8.x** (aparece con Web Station o como paquete aparte). Elige **PHP 8.0 o superior**.
4. **phpMyAdmin** — para administrar la base de datos desde el navegador.

---

## PARTE 2 — Crear la base de datos

1. Abre **MariaDB 10** desde el menú de DSM y define/anota la **contraseña de root**.
2. Abre **phpMyAdmin**. Entra con usuario `root` y esa contraseña.
3. En phpMyAdmin:
   - Pestaña **Bases de datos** → crea **`inventario_vehiculos`** con cotejamiento
     **`utf8mb4_unicode_ci`**.
   - Selecciónala → pestaña **Importar** → **Seleccionar archivo** → sube
     **`sql/schema.sql`** de este proyecto → **Continuar**.
   - Esto crea TODAS las tablas (incluida **`refacciones`**) y el administrador inicial
     **`jcabrera` / `1234`**. El script es idempotente: puedes volver a importarlo para
     aplicar migraciones (p. ej. las columnas nuevas de usuario) sin perder datos.

4. **Crear un usuario de BD para la app** (más seguro que usar root):
   - phpMyAdmin → **Cuentas de usuario** → **Agregar cuenta**.
   - Usuario: **`inv_app`** — Host: **`localhost`** — define una **contraseña fuerte**.
   - Luego, en la pestaña **Privilegios** de la base `inventario_vehiculos`, otorga a
     `inv_app`: **SELECT, INSERT, UPDATE, DELETE** (y **ALTER** si quieres que pueda
     aplicar migraciones del schema).

---

## PARTE 3 — Subir la API

1. Abre **File Station**. Dentro de la carpeta **`web`** (raíz de Web Station), crea una
   carpeta **`api`**.
2. Sube ahí **todo el contenido de la carpeta `api/`** de este proyecto:
   `index.php`, `.htaccess`, y las carpetas `lib/` y `handlers/` (incluye el nuevo
   **`handlers/parts.php`** de refacciones).
3. Copia **`config.example.php`** y renómbralo a **`config.php`** (misma carpeta `api`).
4. Edita **`config.php`**:
   ```php
   'db_host' => '127.0.0.1',
   'db_port' => 3306,
   'db_name' => 'inventario_vehiculos',
   'db_user' => 'inv_app',
   'db_pass' => 'LA_CONTRASEÑA_QUE_PUSISTE',
   ```
   En `cors_origins`, deja la URL desde donde se abre la PWA
   (`https://jjcas82-ctrl.github.io`). Si algún día sirves la app desde el propio
   Synology, agrega también `https://backup-aero.synology.me`.

### Configurar el "Portal web" en Web Station
- **Web Station → Portal web** → crea un portal:
  - **Servicio back-end:** Apache HTTP Server + **PHP 8.x**.
  - **Documento raíz:** la carpeta `web` (o donde pusiste `api`).
- Verifica que **PHP** tenga activa la extensión **pdo_mysql**.

---

## PARTE 4 — Probar que la API responde (en red local)

Desde un navegador en la misma red del Synology:
```
http://IP-DEL-SYNOLOGY/api/?r=ping
```
Debe responder: `{"ok":true,"pong":true,...}`.

Prueba también refacciones (requiere login; de momento solo confirma que la ruta existe):
```
http://IP-DEL-SYNOLOGY/api/?r=parts
```
Debe responder `401 No autenticado` (correcto: la ruta existe y pide sesión).

Si ves esas respuestas, **la API y la base de datos ya funcionan.** 🎉

---

## PARTE 5 — Acceso desde internet con HTTPS (DDNS — acceso principal)

La app necesita **HTTPS**. En Synology es gratis:

1. **DDNS:** DSM → **Panel de control → Conectividad externa → DDNS** → **Agregar**.
   - Proveedor: **Synology**. Nombre de host: **`backup-aero`** → te queda
     **`backup-aero.synology.me`**.
   - (QuickConnect `backup-aero` sigue activo como respaldo para administrar el NAS.)
2. **Certificado SSL:** DSM → **Panel de control → Seguridad → Certificado** → **Agregar**
   → **Let's Encrypt** con el dominio `backup-aero.synology.me`. DSM lo renueva solo.
3. **Reverse Proxy:** DSM → **Panel de control → Portal de inicio de sesión → Avanzado →
   Proxy inverso** (o Seguridad → Proxy inverso):
   - **Origen:** `https://backup-aero.synology.me` puerto **443**.
   - **Destino:** `http://localhost:PUERTO_DE_WEB_STATION` (el puerto del portal PHP).
4. **Router:** reenvía el **puerto 443** del módem hacia el Synology (port forwarding),
   o usa el asistente **EZ-Internet** de Synology.
   - Si tu módem (Telmex/Izzi/etc.) no permite abrir el 443, usa **QuickConnect como plan B**
     para la API: `https://backup-aero.us6.quickconnect.to/api/?r=ping`.

La URL final de tu API quedará así:
```
https://backup-aero.synology.me/api/
```

> ⚠️ **Importante:** la PWA se sirve por HTTPS, así que la API **debe** ser HTTPS. Un
> navegador bloquea llamadas de una página HTTPS a una API HTTP ("contenido mixto").

---

## PARTE 6 — Conectar la app (frontend)

En la app se definirá la **URL de la API** (`https://backup-aero.synology.me/api/`).
Cuando el cliente de sincronización esté listo, la app:
- Enviará login y datos al Synology (vehículos, eventos, usuarios, auditorías y refacciones).
- Mantendrá el **modo sin conexión**: si no hay internet, guarda local y **sincroniza al
  reconectar** (servidor como fuente única).

> Antes de la primera sincronización conviene usar **"Exportar respaldo (JSON)"** en cada
> dispositivo que tenga datos, para subirlos sin pérdidas.

---

## Seguridad — recuerda
- **Cambia la contraseña de `jcabrera`** tras el primer acceso (app → Usuarios).
- Contraseñas **fuertes** para `inv_app` y para `root` de MariaDB.
- No compartas `config.php` (contiene la clave de la BD; está en `.gitignore`).
- Activa **2FA** en las cuentas de DSM y mantén DSM actualizado.
- Expón a internet **solo** el reverse proxy de la API (no abras más puertos de los necesarios).

## Rendimiento (RS1221RP+)
Sobra capacidad para el inventario de unidades y refacciones con varios usuarios
concurrentes. Si el equipo crece mucho, el mismo esquema se migra a la nube sin perder datos.
