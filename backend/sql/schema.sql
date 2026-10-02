-- ============================================================================
--  Inventario de Vehículos — Esquema de base de datos (MariaDB 10 / MySQL)
--  Para Synology DS420j (paquete MariaDB 10).
--
--  Cómo usarlo:
--    1) En phpMyAdmin, crea la base de datos "inventario_vehiculos"
--       con cotejamiento utf8mb4_unicode_ci.
--    2) Selecciona esa base de datos y ejecuta este archivo (pestaña Importar).
--  Este script es idempotente: se puede volver a ejecutar sin borrar datos
--  (usa CREATE TABLE IF NOT EXISTS).
-- ============================================================================

SET NAMES utf8mb4;
SET time_zone = '+00:00';

-- ---------------------------------------------------------------------------
-- Usuarios y roles
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usuarios (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  first_name    VARCHAR(80)  NOT NULL DEFAULT '',
  last_name     VARCHAR(80)  NOT NULL DEFAULT '',
  email         VARCHAR(160) NOT NULL DEFAULT '',
  username      VARCHAR(60)  NOT NULL,
  -- Contraseña con hash (password_hash de PHP, bcrypt).
  pass_hash     VARCHAR(255) NOT NULL,
  -- Roles: operador | consultor | capturista | admin
  role          VARCHAR(20)  NOT NULL DEFAULT 'operador',
  activo        TINYINT(1)   NOT NULL DEFAULT 1,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_usuarios_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Tokens de sesión (autenticación por token, se validan en cada petición)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sesiones (
  token       CHAR(64)     NOT NULL,
  usuario_id  INT UNSIGNED NOT NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at  DATETIME     NOT NULL,
  PRIMARY KEY (token),
  KEY idx_sesiones_usuario (usuario_id),
  CONSTRAINT fk_sesiones_usuario FOREIGN KEY (usuario_id)
    REFERENCES usuarios (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Agencias / sitios (con coordenadas para detección por GPS)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agencias (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  nombre      VARCHAR(120) NOT NULL,
  direccion   VARCHAR(255) NOT NULL DEFAULT '',
  lat         DECIMAL(10,7) NULL,
  lng         DECIMAL(10,7) NULL,
  radio_m     INT UNSIGNED NOT NULL DEFAULT 200,  -- radio de detección en metros
  -- Áreas internas jerárquicas en JSON: [{ "name": "...", "subs": ["..."] }]
  areas       LONGTEXT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_agencias_nombre (nombre)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Vehículos (clave = VIN)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vehiculos (
  vin              CHAR(17)     NOT NULL,
  make             VARCHAR(60)  NOT NULL DEFAULT '',
  model            VARCHAR(80)  NOT NULL DEFAULT '',
  year             VARCHAR(6)   NOT NULL DEFAULT '',
  color            VARCHAR(40)  NOT NULL DEFAULT '',
  engine_no        VARCHAR(60)  NOT NULL DEFAULT '',
  mileage          INT UNSIGNED NULL,
  veh_type         VARCHAR(60)  NOT NULL DEFAULT '',   -- carrocería / tipo
  plate            VARCHAR(20)  NOT NULL DEFAULT '',
  country          VARCHAR(60)  NOT NULL DEFAULT '',
  condition_       VARCHAR(10)  NOT NULL DEFAULT 'nuevo', -- nuevo | usado
  stage            VARCHAR(40)  NOT NULL DEFAULT '',     -- etapa comercial
  notes            TEXT         NULL,
  -- Estado actual
  status           VARCHAR(10)  NOT NULL DEFAULT '',     -- dentro | fuera
  current_agency   VARCHAR(120) NOT NULL DEFAULT '',
  current_area     VARCHAR(120) NOT NULL DEFAULT '',
  current_location VARCHAR(160) NOT NULL DEFAULT '',
  -- Ingreso / salida
  entry_at         DATETIME NULL,
  entry_by         VARCHAR(120) NOT NULL DEFAULT '',
  exit_at          DATETIME NULL,
  exit_by          VARCHAR(120) NOT NULL DEFAULT '',
  last_by          VARCHAR(120) NOT NULL DEFAULT '',
  last_sin_gps     TINYINT(1) NOT NULL DEFAULT 0,
  -- Etapa: bitácora en JSON [{stage, by, at, from}]
  stage_history    LONGTEXT NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (vin),
  KEY idx_vehiculos_status (status),
  KEY idx_vehiculos_agency (current_agency),
  KEY idx_vehiculos_stage (stage)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Eventos (entradas, salidas y movimientos)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS eventos (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  vin         CHAR(17)    NOT NULL,
  tipo        VARCHAR(10) NOT NULL,   -- entry | exit | move
  agency      VARCHAR(120) NOT NULL DEFAULT '',
  area        VARCHAR(120) NOT NULL DEFAULT '',
  location    VARCHAR(160) NOT NULL DEFAULT '',
  condition_  VARCHAR(10)  NOT NULL DEFAULT '',
  usuario     VARCHAR(120) NOT NULL DEFAULT '',   -- quién registró (nombre)
  lat         DECIMAL(10,7) NULL,
  lng         DECIMAL(10,7) NULL,
  accuracy    FLOAT NULL,
  sin_gps     TINYINT(1) NOT NULL DEFAULT 0,
  at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_eventos_vin (vin),
  KEY idx_eventos_tipo (tipo),
  KEY idx_eventos_at (at),
  CONSTRAINT fk_eventos_vehiculo FOREIGN KEY (vin)
    REFERENCES vehiculos (vin) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Auditorías / conteos físicos
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auditorias (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  agency         VARCHAR(120) NOT NULL DEFAULT '',
  modo           VARCHAR(10)  NOT NULL DEFAULT 'full', -- full | random
  usuario        VARCHAR(120) NOT NULL DEFAULT '',
  total_esperado INT UNSIGNED NOT NULL DEFAULT 0,
  presentes      LONGTEXT NULL,  -- JSON array de VINs
  faltantes      LONGTEXT NULL,
  sobrantes      LONGTEXT NULL,
  started_at     DATETIME NULL,
  finished_at    DATETIME NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_auditorias_agency (agency)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Bitácora de auditoría del sistema (quién cambió qué)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bitacora (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  usuario     VARCHAR(120) NOT NULL DEFAULT '',
  accion      VARCHAR(60)  NOT NULL DEFAULT '',
  detalle     TEXT NULL,
  at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_bitacora_at (at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
--  Datos iniciales (semilla)
-- ============================================================================

-- Usuario administrador inicial: jcabrera / 1234
-- (el hash corresponde a la contraseña "1234"; cámbiala tras el primer acceso)
INSERT INTO usuarios (first_name, last_name, email, username, pass_hash, role)
SELECT 'Administrador', '', '', 'jcabrera',
       '$2y$12$MpXribQUPBhIv6Z/zNsrQu.sVsZ7Zux5amhjub3drhDxKWylph672', 'admin'
WHERE NOT EXISTS (SELECT 1 FROM usuarios WHERE username = 'jcabrera');

-- Agencias con sus coordenadas reales
INSERT INTO agencias (nombre, direccion, lat, lng, radio_m, areas)
SELECT 'Agencia Aeropuerto',
       'Blvd. Puerto Aéreo 141, Col. Federal, Venustiano Carranza, 15700 CDMX',
       19.4252220, -99.0932190, 200,
       '[{"name":"Sala de Exhibición","subs":["Ventas Chevrolet","Ventas Buick"]},{"name":"Servicio","subs":["Taller","Preparación","Lavado"]},{"name":"Estacionamiento","subs":["Piso 1","Piso 2","Piso 3"]},{"name":"Área de Entrega","subs":[]}]'
WHERE NOT EXISTS (SELECT 1 FROM agencias WHERE nombre = 'Agencia Aeropuerto');

INSERT INTO agencias (nombre, direccion, lat, lng, radio_m, areas)
SELECT 'Agencia Aeroplasa Auto',
       'Carretera Federal México-Tuxpan Km 190 S/N, Col. El Potro, 73176 Huauchinango, Puebla',
       20.1731220, -98.0708280, 200,
       '[{"name":"Sala de Exhibición de Ventas","subs":[]},{"name":"Servicio","subs":["Taller","Preparación","Lavado"]},{"name":"Patio","subs":[]},{"name":"Estacionamiento Seminuevos","subs":[]},{"name":"Área de Entregas","subs":[]}]'
WHERE NOT EXISTS (SELECT 1 FROM agencias WHERE nombre = 'Agencia Aeroplasa Auto');

-- Bodega Aeroplasa Auto (sitio independiente; falta su dirección/GPS, se fija desde la app)
INSERT INTO agencias (nombre, direccion, lat, lng, radio_m, areas)
SELECT 'Bodega Aeroplasa Auto', '', NULL, NULL, 150,
       '[{"name":"Recepción","subs":[]},{"name":"Almacén","subs":[]}]'
WHERE NOT EXISTS (SELECT 1 FROM agencias WHERE nombre = 'Bodega Aeroplasa Auto');

INSERT INTO agencias (nombre, direccion, lat, lng, radio_m, areas)
SELECT 'Punto de Venta Zacatlán',
       '5 de Mayo LB, Cabañas del Mirador, 73310 Zacatlán, Pue.',
       19.9300120, -97.9599830, 150,
       '[{"name":"Exhibición","subs":[]},{"name":"Entrega","subs":[]}]'
WHERE NOT EXISTS (SELECT 1 FROM agencias WHERE nombre = 'Punto de Venta Zacatlán');

INSERT INTO agencias (nombre, direccion, lat, lng, radio_m, areas)
SELECT 'Punto de Venta Chignahuapan',
       'Vicente Guerrero 31, Centro, 73300 Chignahuapan, Pue.',
       19.8401800, -98.0319880, 150,
       '[{"name":"Exhibición","subs":[]},{"name":"Entrega","subs":[]}]'
WHERE NOT EXISTS (SELECT 1 FROM agencias WHERE nombre = 'Punto de Venta Chignahuapan');
