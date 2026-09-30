<?php
// db.php — Conexión PDO a MariaDB y helpers de respuesta JSON.

function cfg(): array {
  static $c = null;
  if ($c === null) {
    $path = __DIR__ . '/../config.php';
    if (!file_exists($path)) {
      // En modo prueba (SQLite) usamos config por defecto; en producción exige config.php.
      if (getenv('INV_SQLITE')) {
        return $c = ['session_hours' => 12, 'cors_origins' => ['*']];
      }
      json_error(500, 'Falta config.php. Copia config.example.php a config.php y ajusta los datos.');
    }
    $c = require $path;
  }
  return $c;
}

function db(): PDO {
  static $pdo = null;
  if ($pdo === null) {
    // Modo prueba local con SQLite (solo si se define INV_SQLITE). No afecta producción.
    $sqlite = getenv('INV_SQLITE');
    try {
      if ($sqlite) {
        $pdo = new PDO('sqlite:' . $sqlite, null, null, [
          PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
          PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]);
      } else {
        $c = cfg();
        $dsn = sprintf('mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4',
          $c['db_host'], $c['db_port'], $c['db_name']);
        $pdo = new PDO($dsn, $c['db_user'], $c['db_pass'], [
          PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
          PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
          PDO::ATTR_EMULATE_PREPARES   => false,
        ]);
      }
    } catch (Throwable $e) {
      json_error(500, 'No se pudo conectar a la base de datos.');
    }
  }
  return $pdo;
}

// ---- Respuestas JSON ----
function json_out($data, int $code = 200): void {
  http_response_code($code);
  header('Content-Type: application/json; charset=utf-8');
  echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
  exit;
}

function json_error(int $code, string $msg, $extra = null): void {
  $out = ['ok' => false, 'error' => $msg];
  if ($extra !== null) $out['detail'] = $extra;
  json_out($out, $code);
}

function json_ok($data = []): void {
  if (is_array($data)) $data = ['ok' => true] + $data;
  json_out($data, 200);
}

// ---- Cuerpo JSON de la petición ----
function body(): array {
  $raw = file_get_contents('php://input');
  if (!$raw) return [];
  $j = json_decode($raw, true);
  return is_array($j) ? $j : [];
}

// ---- CORS ----
function apply_cors(): void {
  $c = cfg();
  $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
  if ($origin && in_array($origin, $c['cors_origins'], true)) {
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Vary: Origin');
  }
  header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
  header('Access-Control-Allow-Headers: Content-Type, Authorization');
  header('Access-Control-Max-Age: 86400');
  if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    http_response_code(204);
    exit;
  }
}
