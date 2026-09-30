<?php
// index.php — Punto de entrada de la API. Enruta las peticiones a los handlers.
//
// Rutas (todas bajo la base donde se instale, p. ej. /api/):
//   POST   /login                 { username, password }
//   POST   /logout
//   GET    /me
//   GET    /agencies              (listar)         [inventory.view]
//   PUT    /agencies              (guardar lista)  [agencies.manage]
//   GET    /vehicles              (listar)         [inventory.view]
//   GET    /vehicles/{vin}                          [inventory.view]
//   PUT    /vehicles/{vin}        (crear/editar)   [vehicle.edit]
//   POST   /vehicles/{vin}/vin    (cambiar VIN)    [vehicle.editVin]
//   POST   /events                (registrar)      [event.register]
//   GET    /events?vin=...        (historial)      [inventory.view]
//   GET    /users                                  [users.manage]
//   POST   /users                                  [users.manage]
//   PUT    /users/{id}                             [users.manage]
//   DELETE /users/{id}                             [users.manage]
//   GET    /audits                                 [audit.run]
//   POST   /audits                                 [audit.run]
//   GET    /ping                  (prueba de vida)

require __DIR__ . '/lib/db.php';
require __DIR__ . '/lib/auth.php';

apply_cors();

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
// Ruta relativa: usamos el parámetro ?r= (configurado por reglas de reescritura o llamado directo)
$route = $_GET['r'] ?? '';
$route = '/' . trim($route, '/');
$parts = $route === '/' ? [] : explode('/', trim($route, '/'));

try {
  // --- Rutas públicas ---
  if ($route === '/ping') {
    json_ok(['pong' => true, 'time' => date('c')]);
  }
  if ($route === '/login' && $method === 'POST') {
    $b = body();
    json_ok(do_login((string)($b['username'] ?? ''), (string)($b['password'] ?? '')));
  }
  if ($route === '/logout' && $method === 'POST') {
    do_logout();
    json_ok();
  }

  // --- A partir de aquí, requiere sesión ---
  $user = require_auth();

  if ($route === '/me') {
    json_ok(['user' => $user]);
  }

  $res = $parts[0] ?? '';
  switch ($res) {
    case 'agencies':  require __DIR__ . '/handlers/agencies.php';  handle_agencies($user, $method, $parts);  break;
    case 'vehicles':  require __DIR__ . '/handlers/vehicles.php';  handle_vehicles($user, $method, $parts);  break;
    case 'events':    require __DIR__ . '/handlers/events.php';    handle_events($user, $method, $parts);    break;
    case 'users':     require __DIR__ . '/handlers/users.php';     handle_users($user, $method, $parts);     break;
    case 'audits':    require __DIR__ . '/handlers/audits.php';    handle_audits($user, $method, $parts);    break;
    default:          json_error(404, 'Ruta no encontrada: ' . $route);
  }
} catch (Throwable $e) {
  json_error(500, 'Error interno del servidor.', $e->getMessage());
}
