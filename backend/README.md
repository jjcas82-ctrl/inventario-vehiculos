# Backend — Inventario (vehículos + refacciones) (PHP + MariaDB)

API REST para que todos los dispositivos compartan el mismo inventario de **unidades** y
**refacciones**, con login validado en servidor. Pensada para **Synology RS1221RP+**
(Web Station + PHP + MariaDB; también sirve en otros modelos DSM 7.x).

## Estructura

```
backend/
├── sql/
│   └── schema.sql              # Crea todas las tablas + datos iniciales (importar en phpMyAdmin)
├── api/
│   ├── index.php               # Router principal (rutas ?r=...)
│   ├── config.example.php      # Copiar a config.php y poner los datos de la BD
│   ├── .htaccess               # Reescritura de rutas (Apache)
│   ├── lib/
│   │   ├── db.php              # Conexión PDO + helpers JSON + CORS
│   │   └── auth.php            # Login, tokens de sesión, permisos por rol
│   └── handlers/
│       ├── agencies.php        # Agencias (listar/guardar)
│       ├── vehicles.php        # Vehículos (listar/editar/cambiar VIN/etapa)
│       ├── events.php          # Entradas/salidas/movimientos + historial
│       ├── users.php           # Gestión de usuarios (admin)
│       ├── audits.php          # Conteos físicos / auditorías
│       └── parts.php           # Refacciones (listar/editar/carga masiva/conteo)
├── INSTALACION-SYNOLOGY.md     # Guía paso a paso para el Synology
└── test/                       # Solo para pruebas locales (no se usa en producción)
```

## Endpoints (todas bajo la base, ej. `/api/`)

| Método | Ruta | Permiso | Descripción |
|--------|------|---------|-------------|
| GET  | `?r=ping` | — | Prueba de vida |
| POST | `?r=login` | — | `{username, password}` → token |
| POST | `?r=logout` | sesión | Cierra sesión |
| GET  | `?r=me` | sesión | Usuario actual |
| GET  | `?r=agencies` | inventory.view/event.register | Listar agencias |
| PUT  | `?r=agencies` | agencies.manage | Crear/editar agencia |
| GET  | `?r=vehicles` | inventory.view | Listar inventario |
| GET  | `?r=vehicles/{VIN}` | inventory.view | Ver un vehículo |
| PUT  | `?r=vehicles/{VIN}` | vehicle.edit | Crear/editar ficha |
| POST | `?r=vehicles/{VIN}/stage` | vehicle.edit | Cambiar etapa |
| POST | `?r=vehicles/{VIN}/vin` | vehicle.editVin | Cambiar VIN (admin) |
| GET  | `?r=events&vin={VIN}` | inventory.view | Historial |
| POST | `?r=events` | event.register | Registrar entrada/salida/movimiento |
| GET/POST/PUT/DELETE | `?r=users` | users.manage | Usuarios |
| GET/POST | `?r=audits` | audit.run | Auditorías |
| GET  | `?r=parts` | refacciones.view | Listar refacciones |
| GET  | `?r=parts/{numParte}` | refacciones.view | Ver una refacción |
| PUT  | `?r=parts/{numParte}` | refacciones.edit | Crear/editar refacción |
| POST | `?r=parts/bulk` | refacciones.edit | Carga masiva (cruce) |
| POST | `?r=parts/{numParte}/conteo` | refacciones.count | Registrar conteo físico |
| DELETE | `?r=parts` | refacciones.edit | Vaciar inventario de refacciones |

## Autenticación
- Login devuelve un **token** (64 hex). El cliente lo envía en cada petición:
  `Authorization: Bearer <token>`.
- Los tokens caducan según `session_hours` de `config.php` (12 h por defecto).
- Contraseñas guardadas con **bcrypt** (`password_hash`).

## Roles y permisos
La matriz del backend (`lib/auth.php`) se mantiene en sync con el frontend (`js/auth.js`).
Roles: **admin, gerente, auditor, contabilidad, ventas_admin, capturista, consultor,
asesor, operador, refacciones**.

Ajustes POR USUARIO (columnas `access_parts` y `can_edit` en `usuarios`):
- **access_parts** (`NULL` = valor por defecto del rol; `0/1` = forzar): da o quita el
  acceso a **refacciones** a cualquier usuario sin cambiarle el rol.
- **can_edit**: activa la **edición opcional** de **gerente** y **contabilidad**
  (editan fichas como capturista; nunca VIN/agencias/usuarios).

Notas clave:
- **asesor** ve Inventario y Reportes pero **sin** `inventory.viewValue` (montos ocultos).
- **auditor** puede **contar** refacciones (`refacciones.count`) aunque no las edite.

## Instalación
Ver **[INSTALACION-SYNOLOGY.md](INSTALACION-SYNOLOGY.md)**.

## Usuario inicial
`jcabrera` / `1234` (rol admin). **Cámbialo tras el primer acceso.**
