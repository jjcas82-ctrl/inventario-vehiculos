# Guía de instalación en Synology DS420j — Backend Inventario de Vehículos

Esta guía te lleva paso a paso para poner a funcionar la **base de datos (MariaDB)** y la
**API (PHP)** en tu Synology **NAS-AEROPLASA** (DS420j, DSM 7.4).

> El DS420j no soporta Docker, por eso usamos **Web Station + PHP + MariaDB**, que sí son
> nativos de este modelo.

---

## PARTE 1 — Instalar los paquetes necesarios

En **DSM → Centro de paquetes**, instala (si no los tienes):

1. **MariaDB 10** — la base de datos.
2. **Web Station** — el servidor web para la API PHP.
3. **PHP 8.x** (aparece al instalar Web Station, o como paquete aparte). Elige **PHP 8.0 o superior**.
4. **phpMyAdmin** — para administrar la base de datos con el navegador.

---

## PARTE 2 — Crear la base de datos

1. Abre **MariaDB 10** desde el menú de DSM y **anota/define la contraseña de root** si te la pide.
2. Abre **phpMyAdmin** (ícono en DSM). Entra con usuario `root` y esa contraseña.
3. En phpMyAdmin:
   - Pestaña **Bases de datos** → crea una llamada **`inventario_vehiculos`** con
     cotejamiento **`utf8mb4_unicode_ci`**.
   - Selecciónala (menú izquierdo) → pestaña **Importar** → **Seleccionar archivo** →
     sube **`sql/schema.sql`** (el archivo de este proyecto) → **Continuar**.
   - Esto crea todas las tablas y el usuario administrador inicial **`jcabrera` / `1234`**.

4. **Crear un usuario de base de datos para la app** (más seguro que usar root):
   - En phpMyAdmin → pestaña **Cuentas de usuario** → **Agregar cuenta de usuario**.
   - Nombre de usuario: **`inv_app`** — Host: **`localhost`** — define una **contraseña fuerte**.
   - En "Base de datos para esta cuenta", NO marques crear; abajo en **Privilegios globales**
     no marques nada. Mejor: crea el usuario y luego en la pestaña **Privilegios** de la BD
     `inventario_vehiculos`, otórgale a `inv_app` los permisos **SELECT, INSERT, UPDATE, DELETE**.

---

## PARTE 3 — Subir la API

1. Abre **File Station**. Dentro de la carpeta **`web`** (la raíz de Web Station), crea una
   carpeta llamada **`api`**.
2. Sube ahí **todo el contenido de la carpeta `api/`** de este proyecto:
   `index.php`, `.htaccess`, la carpeta `lib/` y la carpeta `handlers/`.
3. Copia **`config.example.php`** y renómbralo a **`config.php`** (en la misma carpeta `api`).
4. Edita **`config.php`** (File Station → clic derecho → Editar, o vía Text Editor):
   ```php
   'db_host' => '127.0.0.1',
   'db_port' => 3306,
   'db_name' => 'inventario_vehiculos',
   'db_user' => 'inv_app',
   'db_pass' => 'LA_CONTRASEÑA_QUE_PUSISTE',
   ```
   Y en `cors_origins`, asegúrate de tener la URL desde donde se abre la app
   (ej. `https://jjcas82-ctrl.github.io`).

### Configurar el "Portal web" en Web Station
- Abre **Web Station → Portal web (o Servicio web)** → crea un portal:
  - **Servicio back-end:** el PHP que instalaste (Apache HTTP Server + PHP 8.x).
  - **Documento raíz:** la carpeta `web` (o donde pusiste `api`).
- Verifica que **PHP** tenga habilitadas las extensiones **pdo_mysql** (suele venir activa).

---

## PARTE 4 — Probar que la API responde

Desde un navegador en la misma red del Synology, entra a:
```
http://IP-DEL-SYNOLOGY/api/?r=ping
```
Debe responder algo como: `{"ok":true,"pong":true,...}`.

Si ves ese mensaje, **la API y la base de datos ya funcionan.** 🎉

---

## PARTE 5 — Acceso desde internet con HTTPS (para las agencias remotas)

La app necesita **HTTPS**. En Synology es gratis:

1. **DDNS:** DSM → **Panel de control → Conectividad externa → DDNS** → Agregar.
   - Proveedor: **Synology**. Te dan un dominio tipo `aeroplasaauto326.synology.me`.
   - (Ya tienes QuickConnect; el DDNS es lo que sirve para HTTPS con dominio.)
2. **Certificado SSL:** DSM → **Panel de control → Seguridad → Certificado** → Agregar →
   **Let's Encrypt** con tu dominio DDNS. Synology lo renueva solo.
3. **Reverse Proxy:** DSM → **Panel de control → Portal de inicio de sesión → Avanzado →
   Proxy inverso** (o Seguridad → Proxy inverso, según versión):
   - **Origen:** `https://aeroplasaauto326.synology.me` puerto **443**.
   - **Destino:** `http://localhost:PUERTO_DE_WEB_STATION` (el puerto del portal PHP).
   - Así, `https://aeroplasaauto326.synology.me/api/?r=ping` llega a tu API por HTTPS.
4. **Router:** reenvía el **puerto 443** de tu módem hacia el Synology (port forwarding),
   o usa el asistente **EZ-Internet** de Synology.

La URL final de tu API quedará así (ejemplo):
```
https://aeroplasaauto326.synology.me/api/
```

---

## PARTE 6 — Conectar la app (frontend)

En la app (pantalla de configuración que agregaremos, o en el código), se define la
**URL de la API**. Cuando esté lista, la app enviará login y registros a tu Synology y todos
los dispositivos compartirán el mismo inventario.

> El siguiente paso del proyecto es crear el "cliente" en la app que habla con esta API,
> manteniendo el modo sin conexión (si no hay internet, guarda local y sincroniza después).

---

## Seguridad — recuerda
- **Cambia la contraseña del usuario `jcabrera`** (entra a la app como admin → Usuarios).
- Usa una **contraseña fuerte** para `inv_app` y para `root` de MariaDB.
- No compartas el archivo `config.php` (contiene la clave de la BD).
- Mantén DSM actualizado.

## Rendimiento (DS420j, 1 GB RAM)
Para un inventario de vehículos con varios usuarios es suficiente. Si el equipo crece mucho,
se puede migrar la base de datos y la API a la nube sin perder datos (mismo esquema).
