# Fase 2 — Plan de implementación y análisis detallado

> Documento de planeación. Objetivo de la Fase 2: pasar de una app **por dispositivo**
> (datos en el navegador) a un **sistema central compartido** entre todas las agencias,
> con base de datos en el servidor y respaldos.

Fecha de elaboración: con la app en versión de pruebas **v72**.

---

## 1. Punto de partida (qué ya existe)

### Frontend (PWA) — MUY avanzado ✅
- App completa funcionando: login por roles, escaneo QR/código de barras, OCR en la nube
  (OCR.space) y local, decodificación de VIN (tabla WMI local + NHTSA en línea), registro de
  entradas/salidas/movimientos con GPS, inventario con filtros tipo Excel, reportes,
  etiquetas QR (generación 100% local), fotos de unidades (IndexedDB), catálogos de
  autocompletar, dashboard con indicadores y centro de alertas, auditoría/conteo físico.
- Toda la persistencia hoy es **local** (`localStorage` para datos, `IndexedDB` para fotos),
  mediante la capa `js/storage.js`. **No hay cliente de API todavía** (no existe `js/api.js`).

### Backend (PHP + MariaDB) — ya construido, listo para desplegar ✅
Carpeta `backend/`:
- `sql/schema.sql` — esquema completo (usuarios, sesiones, agencias, vehículos, eventos,
  auditorías, bitácora) + datos semilla (admin `jcabrera/1234` y las 5 agencias con GPS).
- `api/index.php` — router REST por `?r=ruta`.
- `api/lib/db.php` — conexión PDO (MariaDB en producción, SQLite en pruebas) + CORS + JSON.
- `api/lib/auth.php` — login con token Bearer (64 hex), sesiones con expiración, matriz de
  permisos por rol **idéntica a la del frontend**.
- `api/handlers/` — agencies, vehicles, events, users, audits.
- Documentación: `INSTALACION-SYNOLOGY.md`, `README.md`.

### Diagnóstico de la brecha (lo que falta para Fase 2)
1. **Cliente de API en el frontend** (`js/api.js`) — NO existe. Es la pieza central a crear.
2. **Modo online/offline** en `js/storage.js`: hoy solo lee/escribe local; falta que, con
   conexión, lea/escriba contra la API y, sin conexión, siga funcionando y **sincronice**
   después (cola de cambios pendientes).
3. **Campos nuevos** agregados en pruebas que faltan en el esquema SQL:
   `powertrain`, `transmission`, y los datos de **persona que entrega/recibe** del evento
   (`person_name`, `person_type`, `person_contact`). Las **fotos** no están en el esquema.
4. **Despliegue del backend** en el servidor nuevo.

---

## 2. El servidor nuevo (RS1221RP+ / "BACKUP-AERO")

| Característica | Valor | Implicación |
|---|---|---|
| CPU | AMD Ryzen V1500B (x86-64, 4 núcleos) | **Soporta Container Manager (Docker)** ✅ |
| RAM | 4 GB (ampliable) | Suficiente para empezar; ampliar si crece |
| Fuente | Doble (redundante, RP) | Fiable como servidor central |
| Discos USB | HD650 + HD710 PRO | Ideales para **respaldos (Hyper Backup)** |
| DSM | 7.3.2 | Soporta todo lo necesario |

**Cambio clave vs. el DS420j anterior:** al ser x86-64, este equipo **sí puede usar Docker**.
Eso nos da dos caminos de despliegue (ver sección 4).

> Observación: el equipo se llama "BACKUP-AERO" y la cuenta sugiere rol de **respaldo**.
> Decisión a confirmar: ¿será el **servidor principal** de la app, o el de **respaldo**?
> Recomendación: usarlo como principal de la app **y** aprovechar sus discos USB para los
> respaldos automáticos. Si en el futuro hay un segundo NAS, replicar entre ambos.

---

## 3. Arquitectura objetivo de la Fase 2

```
   [ Celulares / PC de las agencias ]
        │  (HTTPS)
        ▼
   [ PWA servida por el NAS / GitHub Pages ]
        │  fetch JSON (token Bearer)
        ▼
   [ API PHP en el NAS ]  ──► [ MariaDB en el NAS ]
        │                           │
        └── respaldos ──► [ Hyper Backup → discos USB / nube ]
```

- La PWA sigue siendo la misma; solo cambia **de dónde** lee/escribe los datos.
- **Online:** la app habla con la API; los datos son compartidos por todas las agencias.
- **Offline (contingencia):** la app sigue registrando en local y **sincroniza** al volver
  la conexión (cola de pendientes). Esto respeta la regla ya acordada del proyecto
  (contingencia sin internet).

---

## 4. Dos opciones de despliegue del backend

### Opción A — Docker / Container Manager (RECOMENDADA) 🟢
Aprovecha que el servidor nuevo es x86-64.
- Contenedores: **PHP-FPM + Nginx** (API) y **MariaDB** (base de datos). Opcional:
  phpMyAdmin para administración.
- Un archivo `docker-compose.yml` define todo; se levanta con un clic/línea.
- Ventajas: limpio, portable, fácil de actualizar y mover; aislado del resto del NAS.
- Entregable nuevo a crear: `backend/docker/` con `docker-compose.yml`, `Dockerfile` de PHP,
  configuración de Nginx y variables de entorno.

### Opción B — Web Station + MariaDB nativos (el camino ya documentado)
Es lo que describe `INSTALACION-SYNOLOGY.md` (pensado para el DS420j).
- Ventaja: ya está documentado y no requiere Docker.
- Desventaja: más pasos manuales, menos portable.

> Recomendación: **Opción A (Docker)** por el servidor nuevo. Mantener la Opción B como
> alternativa/fallback. El código PHP actual sirve para ambas sin cambios.

---

## 5. Cambios necesarios en el esquema de base de datos

Agregar a `sql/schema.sql` lo que se añadió durante las pruebas:

- Tabla `vehiculos`: columnas `powertrain VARCHAR(40)`, `transmission VARCHAR(40)`.
- Tabla `eventos`: columnas `person_name VARCHAR(120)`, `person_type VARCHAR(40)`,
  `person_contact VARCHAR(80)`.
- Catálogos: nueva tabla `catalogos (nombre, valor)` para color/tipo/versión/transmisión
  (hoy viven en localStorage), para que se compartan entre dispositivos.
- Fotos: nueva tabla `fotos (id, vin, kind, note, by, at, data_mediumblob | ruta_archivo)`.
  Decisión: guardar la imagen como archivo en el NAS y en la BD solo la ruta (más eficiente
  que BLOB). Las fotos ya se comprimen en el cliente (~1280px JPEG).
- Umbrales de alertas y otras preferencias: tabla `config (clave, valor)`.

Todos los cambios son **aditivos** (no rompen datos). Se entregará un `migracion-fase2.sql`.

---

## 6. Trabajo en el frontend

1. **`js/api.js` (nuevo)** — cliente REST: login/logout, y métodos para vehículos, eventos,
   agencias, usuarios, auditorías, catálogos y fotos. Maneja el token Bearer y errores.
2. **`js/storage.js` (refactor a modo híbrido)** — misma interfaz pública (`store.*`) para no
   tocar el resto de la app, pero por dentro:
   - Si hay sesión de servidor y conexión → usa la API.
   - Si no → usa local y **encola** los cambios para sincronizar después.
3. **Sincronización** — al recuperar conexión, enviar la cola de cambios pendientes y
   refrescar desde el servidor. Resolver conflictos por "última escritura gana" + bitácora.
4. **Login** — pasar del login local al login contra la API (ya existe `do_login` en el
   backend con la misma matriz de roles).
5. **Config** — pantalla para fijar la URL del servidor (QuickConnect/engine) y recordarla.

---

## 7. Seguridad (imprescindible antes de producción)

- **HTTPS obligatorio** (certificado del NAS vía Synology/Let's Encrypt). Sin HTTPS, el
  token y las contraseñas viajarían expuestos.
- **Cambiar la contraseña** del admin inicial `jcabrera/1234` tras el primer acceso.
- **Usuario de BD** con permisos mínimos (SELECT/INSERT/UPDATE/DELETE), no root
  (ya indicado en la guía).
- **CORS** restringido al origen real de la PWA (hoy el ejemplo permite `*`).
- Copias de seguridad **cifradas** y probar la **restauración** (un respaldo no verificado
  no es respaldo).
- Expiración de sesión y cierre de sesión (ya implementado en el backend).

---

## 8. Respaldos (aprovechando los discos USB del servidor)

- **Hyper Backup** (paquete de Synology): respaldo programado de la base de datos y de la
  carpeta de fotos hacia los discos USB (HD650 / HD710 PRO) y, opcionalmente, a la nube.
- Frecuencia sugerida: diario, con retención (p. ej. 30 días) y versión semanal.
- Export JSON manual de la app se conserva como respaldo de emergencia adicional.

---

## 9. Plan por pasos (orden sugerido)

**Preparación del servidor**
1. Confirmar rol del RS1221RP+ (principal de la app + respaldos).
2. Instalar Container Manager (Docker) — o Web Station + MariaDB si se elige la Opción B.
3. Configurar HTTPS en el NAS.

**Base de datos y API**
4. Aplicar `schema.sql` + `migracion-fase2.sql` (campos y tablas nuevas).
5. Desplegar la API (contenedor o Web Station); crear usuario `inv_app` de BD.
6. Probar `GET /ping` y `POST /login` desde el navegador.

**Frontend**
7. Crear `js/api.js` y refactorizar `js/storage.js` a modo híbrido online/offline.
8. Conectar login a la API; añadir pantalla de configuración de URL del servidor.
9. Migrar los datos de prueba (import del JSON de respaldo a la BD, si se desea conservarlos).

**Pruebas y puesta en marcha**
10. Pruebas con 2+ dispositivos a la vez (ver datos compartidos en tiempo real).
11. Prueba de contingencia (sin internet) y sincronización al reconectar.
12. Configurar Hyper Backup y **verificar una restauración**.
13. Cambiar contraseñas, cerrar CORS, revisar permisos y pasar a producción.

---

## 10. Mejoras que conviene incluir en/junto a la Fase 2

Ordenadas por valor:

1. **Sincronización offline robusta** (cola de pendientes) — núcleo de la Fase 2.
2. **Fotos en el servidor** — que las fotos de daños se compartan entre agencias (hoy son
   por dispositivo). Alto valor para evidencia.
3. **Catálogos y umbrales centralizados** — que el admin los defina una vez para todos.
4. **Bitácora de auditoría del sistema** (tabla `bitacora` ya existe) — registrar quién
   cambió qué (ediciones de ficha, cambios de VIN, borrados). Trazabilidad.
5. **Reportes/ficha en PDF con logo** — para imprimir/archivar/entregar.
6. **Recordatorio de fotos al registrar la entrada** (opción B ya acordada).
7. **Firma en pantalla** en entregas (ya anotada para versión futura).
8. **Panel de administración web** (opcional) para gestión masiva desde PC.
9. **Notificaciones push** de alertas (estancadas, etc.) — requiere HTTPS y permisos del
   navegador; evaluable una vez estable el backend.
10. **Ubicación por piso/cajón + plano** del Aeropuerto (ya documentada en su propia
    propuesta) — encaja mejor una vez centralizados los datos.

---

## 11. Riesgos y cómo mitigarlos

- **Pérdida de datos en la migración** → hacer respaldo (export JSON) antes de migrar; la
  migración de BD es aditiva.
- **Conflictos de edición simultánea** → política "última escritura gana" + bitácora; evaluar
  bloqueos por VIN si se vuelve necesario.
- **Caída del servidor** → la PWA sigue operando offline y sincroniza al volver; doble fuente
  del NAS reduce el riesgo de corte eléctrico.
- **Exposición de la API** → HTTPS + CORS cerrado + usuario de BD mínimo + contraseñas fuertes.

---

## 12. Resumen ejecutivo

El proyecto está **listo para la Fase 2**: el frontend es completo y el backend ya está
escrito y probado con SQLite. El servidor nuevo (x86-64, doble fuente, discos USB) es ideal
y permite usar **Docker**. El trabajo principal es: (1) desplegar el backend, (2) crear el
cliente `js/api.js` y volver `storage.js` híbrido online/offline con sincronización, y
(3) asegurar HTTPS, permisos y respaldos. Con eso, las agencias compartirán un inventario
central en tiempo real, manteniendo la operación offline en contingencia.
