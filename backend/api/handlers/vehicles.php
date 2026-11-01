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

// Convierte una fecha ISO 8601 (del frontend, p. ej. "2026-10-30T13:26:00.000Z")
// a formato DATETIME de MySQL ("2026-10-30 13:26:00"). Devuelve null si viene
// vacía o no se puede parsear (para no romper el INSERT con un valor inválido).
function iso_to_mysql_datetime($v): ?string {
  if ($v === null || $v === '' ) return null;
  $s = (string)$v;
  // Ya viene en formato MySQL.
  if (preg_match('/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/', $s)) return $s;
  $ts = strtotime($s);
  if ($ts === false) return null;
  return date('Y-m-d H:i:s', $ts);
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

    // Campos de ESTADO/ubicación. Se guardan también desde el PUT para que al
    // sincronizar un vehículo (pushVehicle del frontend: CDO, ediciones, etc.)
    // NO se pierda su estado (status, agencia, entradas/salidas). Antes el PUT
    // solo guardaba la ficha y dejaba status/current_agency vacíos en el server,
    // por lo que otros equipos lo bajaban "incompleto" y el dashboard lo contaba
    // en 0. Si el body no trae un campo, usamos "" (o el existente en UPDATE).
    $status  = (string)($b['status'] ?? '');
    $cAgency = (string)($b['currentAgency'] ?? '');
    $cArea   = (string)($b['currentArea'] ?? '');
    $cLoc    = (string)($b['currentLocation'] ?? '');
    $stage   = (string)($b['stage'] ?? '');
    // Las fechas llegan en ISO 8601 ("2026-10-30T13:26:00.000Z") pero la columna
    // es DATETIME de MySQL ("2026-10-30 13:26:00"). Insertar el ISO directo
    // provoca ERROR INTERNO (500) en modo estricto. Convertimos a DATETIME.
    $entryAt = iso_to_mysql_datetime($b['entryAt'] ?? null);
    $entryBy = (string)($b['entryBy'] ?? '');
    $exitAt  = iso_to_mysql_datetime($b['exitAt'] ?? null);
    $exitBy  = (string)($b['exitBy'] ?? '');
    $lastBy  = (string)($b['lastBy'] ?? '');
    $stageHistory = isset($b['stageHistory']) ? json_encode($b['stageHistory'], JSON_UNESCAPED_UNICODE) : null;

    if ($exists->fetch()) {
      // En UPDATE, solo pisamos los campos de estado si el body los trae
      // (COALESCE con NULLIF: si llega "", conserva el valor actual del server).
      db()->prepare(
        'UPDATE vehiculos SET make=?, model=?, year=?, color=?, engine_no=?, mileage=?, veh_type=?,
         plate=?, country=?, condition_=?, notes=?,
         status=COALESCE(NULLIF(?,""), status),
         current_agency=COALESCE(NULLIF(?,""), current_agency),
         current_area=COALESCE(NULLIF(?,""), current_area),
         current_location=COALESCE(NULLIF(?,""), current_location),
         stage=COALESCE(NULLIF(?,""), stage),
         entry_at=COALESCE(?, entry_at),
         entry_by=COALESCE(NULLIF(?,""), entry_by),
         exit_at=COALESCE(?, exit_at),
         exit_by=COALESCE(NULLIF(?,""), exit_by),
         last_by=COALESCE(NULLIF(?,""), last_by),
         stage_history=COALESCE(?, stage_history)
         WHERE vin=?')
        ->execute([
          (string)($b['make'] ?? ''), (string)($b['model'] ?? ''), (string)($b['year'] ?? ''),
          (string)($b['color'] ?? ''), (string)($b['engineNo'] ?? ''), $mileage,
          (string)($b['vehType'] ?? ''), (string)($b['plate'] ?? ''), (string)($b['country'] ?? ''),
          (string)($b['condition'] ?? 'nuevo'), (string)($b['notes'] ?? ''),
          $status, $cAgency, $cArea, $cLoc, $stage,
          $entryAt, $entryBy, $exitAt, $exitBy, $lastBy, $stageHistory,
          $vin,
        ]);
    } else {
      db()->prepare(
        'INSERT INTO vehiculos (vin, make, model, year, color, engine_no, mileage, veh_type, plate,
         country, condition_, notes, status, current_agency, current_area, current_location,
         stage, entry_at, entry_by, exit_at, exit_by, last_by, stage_history)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        ->execute([
          $vin, (string)($b['make'] ?? ''), (string)($b['model'] ?? ''), (string)($b['year'] ?? ''),
          (string)($b['color'] ?? ''), (string)($b['engineNo'] ?? ''), $mileage,
          (string)($b['vehType'] ?? ''), (string)($b['plate'] ?? ''), (string)($b['country'] ?? ''),
          (string)($b['condition'] ?? 'nuevo'), (string)($b['notes'] ?? ''),
          ($status ?: null), ($cAgency ?: null), ($cArea ?: null), ($cLoc ?: null),
          ($stage ?: null), $entryAt, ($entryBy ?: null), $exitAt, ($exitBy ?: null),
          ($lastBy ?: null), $stageHistory,
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

  // DELETE /vehicles/{vin} — eliminar unidad y sus eventos (solo admin).
  if ($method === 'DELETE' && $vin) {
    require_perm($user, 'vehicle.delete');
    // La FK de eventos tiene ON DELETE CASCADE → los eventos se borran solos.
    // (Por si acaso, borramos eventos explícitamente antes del vehículo.)
    db()->prepare('DELETE FROM eventos WHERE vin=?')->execute([$vin]);
    db()->prepare('DELETE FROM vehiculos WHERE vin=?')->execute([$vin]);
    json_ok();
  }

  json_error(405, 'Método no permitido.');
}
