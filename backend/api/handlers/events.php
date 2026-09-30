<?php
// handlers/events.php — Registro de entradas, salidas y movimientos + historial.

function handle_events(array $user, string $method, array $parts): void {

  // GET /events?vin=XXXX — historial de un vehículo (o últimos eventos).
  if ($method === 'GET') {
    require_perm($user, 'inventory.view');
    $vin = isset($_GET['vin']) ? strtoupper(trim($_GET['vin'])) : '';
    if ($vin !== '') {
      $st = db()->prepare('SELECT * FROM eventos WHERE vin=? ORDER BY at ASC');
      $st->execute([$vin]);
    } else {
      $st = db()->query('SELECT * FROM eventos ORDER BY at DESC LIMIT 500');
    }
    json_ok(['events' => array_map('event_row_to_api', $st->fetchAll())]);
  }

  // POST /events — registrar un evento. [event.register]
  if ($method === 'POST') {
    require_perm($user, 'event.register');
    $b = body();
    $vin  = strtoupper(trim((string)($b['vin'] ?? '')));
    $tipo = (string)($b['type'] ?? '');   // entry | exit | move
    if (strlen($vin) !== 17) json_error(422, 'VIN inválido.');
    if (!in_array($tipo, ['entry', 'exit', 'move'], true)) json_error(422, 'Tipo de evento inválido.');

    $agency    = (string)($b['agency'] ?? '');
    $area      = (string)($b['area'] ?? '');
    $location  = (string)($b['location'] ?? '');
    $condition = (string)($b['condition'] ?? '');
    $lat = isset($b['lat']) && $b['lat'] !== null ? (float)$b['lat'] : null;
    $lng = isset($b['lng']) && $b['lng'] !== null ? (float)$b['lng'] : null;
    $acc = isset($b['accuracy']) && $b['accuracy'] !== null ? (float)$b['accuracy'] : null;
    $sinGps = !empty($b['sinGps']) ? 1 : 0;
    $by = $user['name'];
    $now = date('Y-m-d H:i:s');

    $pdo = db();
    $pdo->beginTransaction();
    try {
      // Asegurar que el vehículo exista (crear con datos básicos si es nuevo).
      $st = $pdo->prepare('SELECT * FROM vehiculos WHERE vin=?'); $st->execute([$vin]);
      $v = $st->fetch();
      if (!$v) {
        $pdo->prepare('INSERT INTO vehiculos (vin, make, year, country, condition_) VALUES (?,?,?,?,?)')
            ->execute([$vin, (string)($b['make'] ?? ''), (string)($b['year'] ?? ''),
                       (string)($b['country'] ?? ''), $condition ?: 'nuevo']);
        $v = ['vin' => $vin, 'stage' => '', 'stage_history' => null, 'created_at' => $now];
      }

      // Insertar el evento.
      $pdo->prepare('INSERT INTO eventos (vin, tipo, agency, area, location, condition_, usuario, lat, lng, accuracy, sin_gps, at)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
          ->execute([$vin, $tipo, $agency, $area, $location, $condition, $by, $lat, $lng, $acc, $sinGps, $now]);

      // Actualizar estado del vehículo según el tipo.
      if ($tipo === 'entry' || $tipo === 'move') {
        $set = 'current_agency=?, current_area=?, current_location=?, status="dentro", last_by=?, last_sin_gps=?';
        $params = [$agency, $area, $location, $by, $sinGps];
        if ($tipo === 'entry') {
          $set .= ', entry_at=?, entry_by=?';
          $params[] = $now; $params[] = $by;
          // Etapa inicial "Recepción" si no tenía.
          if (empty($v['stage'])) {
            $hist = $v['stage_history'] ? json_decode($v['stage_history'], true) : [];
            $hist[] = ['stage' => 'Recepción', 'by' => $by, 'at' => date('c'), 'from' => null];
            $set .= ', stage="Recepción", stage_history=?';
            $params[] = json_encode($hist, JSON_UNESCAPED_UNICODE);
          }
        }
        if ($condition) { $set .= ', condition_=?'; $params[] = $condition; }
        $params[] = $vin;
        $pdo->prepare("UPDATE vehiculos SET $set WHERE vin=?")->execute($params);
      } else { // exit
        $p = [$by, $sinGps, $now, $by];
        $extra = '';
        if ($condition) { $extra = ', condition_=?'; array_splice($p, 2, 0, [$condition]); }
        $pdo->prepare("UPDATE vehiculos SET status=\"fuera\", last_by=?, last_sin_gps=?$extra, exit_at=?, exit_by=? WHERE vin=?")
            ->execute(array_merge($p, [$vin]));
      }

      $pdo->commit();
    } catch (Throwable $e) {
      $pdo->rollBack();
      throw $e;
    }

    json_ok(['registered' => $tipo, 'vin' => $vin]);
  }

  json_error(405, 'Método no permitido.');
}

function event_row_to_api(array $r): array {
  return [
    'id'        => (int)$r['id'],
    'vin'       => $r['vin'],
    'type'      => $r['tipo'],
    'agency'    => $r['agency'],
    'area'      => $r['area'],
    'location'  => $r['location'],
    'condition' => $r['condition_'],
    'by'        => $r['usuario'],
    'lat'       => $r['lat'] !== null ? (float)$r['lat'] : null,
    'lng'       => $r['lng'] !== null ? (float)$r['lng'] : null,
    'accuracy'  => $r['accuracy'] !== null ? (float)$r['accuracy'] : null,
    'sinGps'    => (bool)$r['sin_gps'],
    'at'        => $r['at'],
  ];
}
