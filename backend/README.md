# Backend — Inventario de Vehículos (PHP + MariaDB)

API REST para que todos los dispositivos compartan el mismo inventario, con login
validado en servidor. Pensada para **Synology DS420j** (Web Station + PHP + MariaDB).

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
│       └── audits.php          # Conteos físicos / auditorías
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

## Autenticación
- Login devuelve un **token** (64 hex). El cliente lo envía en cada petición:
  `Authorization: Bearer <token>`.
- Los tokens caducan según `session_hours` de `config.php` (12 h por defecto).
- Contraseñas guardadas con **bcrypt** (`password_hash`).

## Roles y permisos
- **operador:** registrar eventos.
- **consultor:** ver inventario/mapa/reportes.
- **capturista:** operador + ver + editar fichas (sin cambiar VIN ni borrar).
- **admin:** todo (VIN, agencias, usuarios, auditorías).

## Instalación
Ver **[INSTALACION-SYNOLOGY.md](INSTALACION-SYNOLOGY.md)**.

## Usuario inicial
`jcabrera` / `1234` (rol admin). **Cámbialo tras el primer acceso.**
