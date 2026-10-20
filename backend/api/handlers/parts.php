<?php
// handlers/parts.php — Inventario de REFACCIONES (clave = num_parte).
// Espejo de vehicles.php: usa los mismos helpers (db, body, json_ok, require_perm).
//
// Rutas:
//   GET    /parts                      (listar)                 [refacciones.view]
//   GET    /parts/{numParte}                                    [refacciones.view]
//   PUT    /parts/{numParte}           (crear/editar una parte) [refacciones.edit]
//   POST   /parts/bulk                 (alta/actualización masiva del cruce) [refacciones.edit]
//   POST   /parts/{numParte}/conteo    (registrar conteo físico) [refacciones.count]
//   DELETE /parts                      (vaciar inventario de refacciones) [refacciones.edit]

function part_row_to_api(array $r): array {
  return [
    'numParte'      => $r['num_parte'],
    'descripcion'   => $r['descripcion'],
    'ubicacion'     => $r['ubicacion'],
    'grupo'         => $r['grupo'],
    'marbete'       => $r['marbete'],
    'existencia'    => $r['existencia'] !== null ? (int)$r['existencia'] : null,
    'conteo'        => $r['conteo'] !== null ? (int)$r['conteo'] : null,
    'conteoBy'      => $r['conteo_by'],
    'conteoAt'      => $r['conteo_at'],
    'enMarbetes'    => (bool)$r['en_marbetes'],
    'enExistencias' => (bool)$r['en_existencias'],
    'origin'        => $r['origin'],
    'updatedAt'     => $r['updated_at'],
  ];
}

// Convierte un valor entero opcional del cuerpo (acepta '' / null → NULL).
function part_int_or_null($v) {
  if ($v === null || $v === '') return null;
  return (int)$v;
}

// INSERT ... ON DUPLICATE KEY UPDATE para una parte. $merge=true conserva campos
// no provistos (no los pisa con vacío) emulando el comportamiento del frontend.
function part_upsert(array $b): void {
  $numParte = trim((string)($b['numParte'] ?? ''));
  if ($numParte === '') json_error(422, 'El número de parte es obligatorio.');

  db()->prepare(
    'INSERT INTO refacciones
       (num_parte, descripcion, ubicacion, grupo, marbete, existencia, conteo,
        conteo_by, conteo_at, en_marbetes, en_existencias, origin)
     VALUES (:np,:desc,:ubic,:grupo,:marb,:exist,:cont,:cby,:cat,:enm,:ene,:org)
     ON DUPLICATE KEY UPDATE
       descripcion   = VALUES(descripcion),
       ubicacion     = VALUES(ubicacion),
       grupo         = VALUES(grupo),
       marbete       = VALUES(marbete),
       existencia    = VALUES(existencia),
       en_marbetes   = VALUES(en_marbetes),
       en_existencias= VALUES(en_existencias),
       origin        = VALUES(origin)')
    ->execute([
      ':np'    => $numParte,
      ':desc'  => (string)($b['descripcion'] ?? ''),
      ':ubic'  => (string)($b['ubicacion'] ?? ''),
      ':grupo' => (string)($b['grupo'] ?? ''),
      ':marb'  => (string)($b['marbete'] ?? ''),
      ':exist' => part_int_or_null($b['existencia'] ?? null),
      ':cont'  => part_int_or_null($b['conteo'] ?? null),
      ':cby'   => (string)($b['conteoBy'] ?? ''),
      ':cat'   => ($b['conteoAt'] ?? null) ?: null,
      ':enm'   => !empty($b['enMarbetes']) ? 1 : 0,
      ':ene'   => !empty($b['enExistencias']) ? 1 : 0,
      ':org'   => (string)($b['origin'] ?? ''),
    ]);
}

function handle_parts(array $user, string $method, array $parts): void {
  $seg = isset($parts[1]) ? trim($parts[1]) : null;   // {numParte} o 'bulk'

  // GET /parts  o  GET /parts/{numParte}
  if ($method === 'GET') {
    require_perm($user, 'refacciones.view');
    if ($seg !== null && $seg !== '') {
      $st = db()->prepare('SELECT * FROM refacciones WHERE num_parte=?');
      $st->execute([$seg]);
      $r = $st->fetch();
      if (!$r) json_error(404, 'Refacción no encontrada.');
      json_ok(['part' => part_row_to_api($r)]);
    }
    $rows = db()->query('SELECT * FROM refacciones ORDER BY updated_at DESC')->fetchAll();
    json_ok(['parts' => array_map('part_row_to_api', $rows)]);
  }

  // POST /parts/bulk — alta/actualización MASIVA (cargar el cruce). [refacciones.edit]
  if ($method === 'POST' && $seg === 'bulk') {
    require_perm($user, 'refacciones.edit');
    $b = body();
    $arr = $b['parts'] ?? [];
    if (!is_array($arr)) json_error(422, 'Se esperaba un arreglo "parts".');
    $added = 0; $updated = 0;
    db()->beginTransaction();
    try {
      foreach ($arr as $p) {
        if (!is_array($p) || trim((string)($p['numParte'] ?? '')) === '') continue;
        $chk = db()->prepare('SELECT 1 FROM refacciones WHERE num_parte=?');
        $chk->execute([trim((string)$p['numParte'])]);
        $existe = (bool)$chk->fetchColumn();
        part_upsert($p);
        if ($existe) $updated++; else $added++;
      }
      db()->commit();
    } catch (Throwable $e) {
      db()->rollBack();
      json_error(500, 'No se pudo guardar el lote de refacciones.', $e->getMessage());
    }
    json_ok(['added' => $added, 'updated' => $updated]);
  }

  // POST /parts/{numParte}/conteo — registrar conteo físico. [refacciones.count]
  if ($method === 'POST' && $seg !== null && ($parts[2] ?? '') === 'conteo') {
    require_perm($user, 'refacciones.count');
    $b = body();
    $conteo = part_int_or_null($b['conteo'] ?? null);
    if ($conteo === null || $conteo < 0) json_error(422, 'La cantidad contada debe ser 0 o más.');
    $st = db()->prepare('SELECT 1 FROM refacciones WHERE num_parte=?');
    $st->execute([$seg]);
    if (!$st->fetchColumn()) {
      // Parte contada que no estaba en el inventario: se da de alta mínima.
      part_upsert(['numParte' => $seg, 'origin' => 'conteo']);
    }
    db()->prepare('UPDATE refacciones SET conteo=?, conteo_by=?, conteo_at=? WHERE num_parte=?')
        ->execute([$conteo, $user['name'], date('Y-m-d H:i:s'), $seg]);
    json_ok();
  }

  // PUT /parts/{numParte} — crear/editar una parte. [refacciones.edit]
  if ($method === 'PUT' && $seg !== null && $seg !== '') {
    require_perm($user, 'refacciones.edit');
    $b = body();
    $b['numParte'] = $seg;
    part_upsert($b);
    $st = db()->prepare('SELECT * FROM refacciones WHERE num_parte=?'); $st->execute([$seg]);
    json_ok(['part' => part_row_to_api($st->fetch())]);
  }

  // DELETE /parts — vaciar el inventario de refacciones. [refacciones.edit]
  if ($method === 'DELETE' && ($seg === null || $seg === '')) {
    require_perm($user, 'refacciones.edit');
    db()->exec('DELETE FROM refacciones');
    json_ok();
  }

  json_error(405, 'Método no permitido.');
}
