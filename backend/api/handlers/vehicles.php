<?php
// handlers/vehicles.php — Inventario de vehículos.

function vehicle_row_to_api(array $r): array {
  return [
    'vin'             => $r['vin'],
    'make'            => $r['make'],
    'model'           => $r['model'],
    'year'            => $r['year'],
    'color'           => $r['color'],
    'engineNo'        => $r['engine_no'],
    'mileage'         => $r['mileage'] !== null ? (int)$r['mileage'] : '',
    'vehType'         => $r['veh_type'],
    'plate'           => $r['plate'],
    'country'         => $r['country'],
    'condition'       => $r['condition_'],
    'stage'           => $r['stage'],
    'notes'           => $r['notes'],
    'status'          => $r['status'],
    'currentAgency'   => $r['current_agency'],
    'currentArea'     => $r['current_area'],
    'currentLocation' => $r['current_location'],
    'entryAt'         => $r['entry_at'],
    'entryBy'         => $r['entry_by'],
    'exitAt'          => $r['exit_at'],
    'exitBy'          => $r['exit_by'],
    'lastBy'          => $r['last_by'],
    'lastSinGps'      => (bool)$r['last_sin_gps'],
    'stageHistory'    => $r['stage_history'] ? json_decode($r['stage_history'], true) : [],
    'updatedAt'       => $r['updated_at'],
  ];
}

function handle_vehicles(array $user, string $method, array $parts): void {
  $vin = isset($parts[1]) ? strtoupper(trim($parts[1])) : null;

  // GET /vehicles  o  GET /vehicles/{vin}
  if ($method === 'GET') {
    require_perm($user, 'inventory.view');
    if ($vin) {
      $st = db()->prepare('SELECT * FROM vehiculos WHERE vin=?');
      $st->execute([$vin]);
      $r = $st->fetch();
      if (!$r) json_error(404, 'Vehículo no encontrado.');
      json_ok(['vehicle' => vehicle_row_to_api($r)]);
    }
    $rows = db()->query('SELECT * FROM vehiculos ORDER BY updated_at DESC')->fetchAll();
    json_ok(['vehicles' => array_map('vehicle_row_to_api', $rows)]);
  }

  // PUT /vehicles/{vin} — crear o editar ficha (no cambia el VIN).
  if ($method === 'PUT' && $vin) {
    require_perm($user, 'vehicle.edit');
    if (strlen($vin) !== 17) json_error(422, 'VIN inválido (17 caracteres).');
    $b = body();
    $exists = db()->prepare('SELECT vin FROM vehiculos WHERE vin=?');
    $exists->execute([$vin]);
    $mileage = (isset($b['mileage']) && $b['mileage'] !== '') ? (int)$b['mileage'] : null;

    if ($exists->fetch()) {
      db()->prepare(
        'UPDATE vehiculos SET make=?, model=?, year=?, color=?, engine_no=?, mileage=?, veh_type=?,
         plate=?, country=?, condition_=?, notes=? WHERE vin=?')
        ->execute([
          (string)($b['make'] ?? ''), (string)($b['model'] ?? ''), (string)($b['year'] ?? ''),
          (string)($b['color'] ?? ''), (string)($b['engineNo'] ?? ''), $mileage,
          (string)($b['vehType'] ?? ''), (string)($b['plate'] ?? ''), (string)($b['country'] ?? ''),
          (string)($b['condition'] ?? 'nuevo'), (string)($b['notes'] ?? ''), $vin,
        ]);
    } else {
      db()->prepare(
        'INSERT INTO vehiculos (vin, make, model, year, color, engine_no, mileage, veh_type, plate,
         country, condition_, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        ->execute([
          $vin, (string)($b['make'] ?? ''), (string)($b['model'] ?? ''), (string)($b['year'] ?? ''),
          (string)($b['color'] ?? ''), (string)($b['engineNo'] ?? ''), $mileage,
          (string)($b['vehType'] ?? ''), (string)($b['plate'] ?? ''), (string)($b['country'] ?? ''),
          (string)($b['condition'] ?? 'nuevo'), (string)($b['notes'] ?? ''),
        ]);
    }
    $st = db()->prepare('SELECT * FROM vehiculos WHERE vin=?'); $st->execute([$vin]);
    json_ok(['vehicle' => vehicle_row_to_api($st->fetch())]);
  }

  // POST /vehicles/{vin}/stage — actualizar etapa (con bitácora).  [vehicle.edit]
  if ($method === 'POST' && $vin && ($parts[2] ?? '') === 'stage') {
    require_perm($user, 'vehicle.edit');
    $b = body();
    $stage = (string)($b['stage'] ?? '');
    $st = db()->prepare('SELECT stage, stage_history FROM vehiculos WHERE vin=?'); $st->execute([$vin]);
    $r = $st->fetch();
    if (!$r) json_error(404, 'Vehículo no encontrado.');
    if ($r['stage'] !== $stage) {
      $hist = $r['stage_history'] ? json_decode($r['stage_history'], true) : [];
      $hist[] = ['stage' => $stage, 'by' => $user['name'], 'at' => date('c'), 'from' => $r['stage'] ?: null];
      db()->prepare('UPDATE vehiculos SET stage=?, stage_history=? WHERE vin=?')
          ->execute([$stage, json_encode($hist, JSON_UNESCAPED_UNICODE), $vin]);
    }
    json_ok();
  }

  // POST /vehicles/{vin}/vin — cambiar el VIN (solo admin).  [vehicle.editVin]
  if ($method === 'POST' && $vin && ($parts[2] ?? '') === 'vin') {
    require_perm($user, 'vehicle.editVin');
    $b = body();
    $newVin = strtoupper(trim((string)($b['newVin'] ?? '')));
    if (strlen($newVin) !== 17) json_error(422, 'VIN nuevo inválido.');
    $chk = db()->prepare('SELECT vin FROM vehiculos WHERE vin=?'); $chk->execute([$newVin]);
    if ($chk->fetch()) json_error(409, 'Ya existe un vehículo con el VIN nuevo.');
    // La FK de eventos tiene ON UPDATE CASCADE → los eventos se reasignan solos.
    db()->prepare('UPDATE vehiculos SET vin=? WHERE vin=?')->execute([$newVin, $vin]);
    json_ok();
  }

  json_error(405, 'Método no permitido.');
}
