-- Esquema equivalente en SQLite SOLO para pruebas locales de la API.
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name TEXT NOT NULL DEFAULT '', last_name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '', username TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'operador',
  activo INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sesiones (
  token TEXT PRIMARY KEY, usuario_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agencias (
  id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL UNIQUE,
  direccion TEXT NOT NULL DEFAULT '', lat REAL, lng REAL,
  radio_m INTEGER NOT NULL DEFAULT 200, areas TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS vehiculos (
  vin TEXT PRIMARY KEY, make TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
  year TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '', engine_no TEXT NOT NULL DEFAULT '',
  mileage INTEGER, veh_type TEXT NOT NULL DEFAULT '', plate TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '', condition_ TEXT NOT NULL DEFAULT 'nuevo',
  stage TEXT NOT NULL DEFAULT '', notes TEXT, status TEXT NOT NULL DEFAULT '',
  current_agency TEXT NOT NULL DEFAULT '', current_area TEXT NOT NULL DEFAULT '',
  current_location TEXT NOT NULL DEFAULT '', entry_at TEXT, entry_by TEXT NOT NULL DEFAULT '',
  exit_at TEXT, exit_by TEXT NOT NULL DEFAULT '', last_by TEXT NOT NULL DEFAULT '',
  last_sin_gps INTEGER NOT NULL DEFAULT 0, stage_history TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS eventos (
  id INTEGER PRIMARY KEY AUTOINCREMENT, vin TEXT NOT NULL, tipo TEXT NOT NULL,
  agency TEXT NOT NULL DEFAULT '', area TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '',
  condition_ TEXT NOT NULL DEFAULT '', usuario TEXT NOT NULL DEFAULT '',
  lat REAL, lng REAL, accuracy REAL, sin_gps INTEGER NOT NULL DEFAULT 0,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS auditorias (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agency TEXT NOT NULL DEFAULT '',
  modo TEXT NOT NULL DEFAULT 'full', usuario TEXT NOT NULL DEFAULT '',
  total_esperado INTEGER NOT NULL DEFAULT 0, presentes TEXT, faltantes TEXT, sobrantes TEXT,
  started_at TEXT, finished_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS bitacora (
  id INTEGER PRIMARY KEY AUTOINCREMENT, usuario TEXT NOT NULL DEFAULT '',
  accion TEXT NOT NULL DEFAULT '', detalle TEXT, at TEXT NOT NULL DEFAULT (datetime('now'))
);
