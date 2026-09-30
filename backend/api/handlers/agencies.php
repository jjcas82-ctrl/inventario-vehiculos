<?php
// handlers/agencies.php — Listar y guardar agencias (con áreas y coordenadas).

function agency_row_to_api(array $r): array {
  return [
    'id'      => (int)$r['id'],
    'name'    => $r['nombre'],
    'address' => $r['direccion'],
    'lat'     => $r['lat'] !== null ? (float)$r['lat'] : null,
    'lng'     => $r['lng'] !== null ? (float)$r['lng'] : null,
    'radius'  => (int)$r['radio_m'],
    'areas'   => $r['areas'] ? json_decode($r['areas'], true) : [],
  ];
}

function handle_agencies(array $user, string $method, array $parts): void {
  // GET /agencies — cualquier usuario autenticado que pueda ver inventario o registrar.
  if ($method === 'GET') {
    if (!role_can($user['role'], 'inventory.view') && !role_can($user['role'], 'event.register')) {
      json_error(403, 'Sin permiso.');
    }
    $rows = db()->query('SELECT * FROM agencias ORDER BY nombre')->fetchAll();
    json_ok(['agencies' => array_map('agency_row_to_api', $rows)]);
  }

  // PUT /agencies — reemplaza/guarda una agencia. Solo admin.
  if ($method === 'PUT') {
    require_perm($user, 'agencies.manage');
    $b = body();
    $name = trim((string)($b['name'] ?? ''));
    if ($name === '') json_error(422, 'El nombre de la agencia es obligatorio.');
    $areasJson = isset($b['areas']) ? json_encode($b['areas'], JSON_UNESCAPED_UNICODE) : '[]';
    $lat = isset($b['lat']) && $b['lat'] !== '' ? (float)$b['lat'] : null;
    $lng = isset($b['lng']) && $b['lng'] !== '' ? (float)$b['lng'] : null;
    $radius = (int)($b['radius'] ?? 200);

    if (!empty($b['id'])) {
      db()->prepare('UPDATE agencias SET nombre=?, direccion=?, lat=?, lng=?, radio_m=?, areas=? WHERE id=?')
          ->execute([$name, (string)($b['address'] ?? ''), $lat, $lng, $radius, $areasJson, (int)$b['id']]);
      $id = (int)$b['id'];
    } else {
      db()->prepare('INSERT INTO agencias (nombre, direccion, lat, lng, radio_m, areas) VALUES (?,?,?,?,?,?)')
          ->execute([$name, (string)($b['address'] ?? ''), $lat, $lng, $radius, $areasJson]);
      $id = (int)db()->lastInsertId();
    }
    $st = db()->prepare('SELECT * FROM agencias WHERE id=?');
    $st->execute([$id]);
    json_ok(['agency' => agency_row_to_api($st->fetch())]);
  }

  // DELETE /agencies/{id} — solo admin.
  if ($method === 'DELETE' && !empty($parts[1])) {
    require_perm($user, 'agencies.manage');
    db()->prepare('DELETE FROM agencias WHERE id=?')->execute([(int)$parts[1]]);
    json_ok();
  }

  json_error(405, 'Método no permitido.');
}
