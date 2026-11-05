<?php
// handlers/parts.php — Inventario de REFACCIONES SEPARADO POR AGENCIA.
// Clave compuesta (agencia, num_parte): el mismo número de parte puede existir en
// varias agencias con existencias distintas y NUNCA se mezcla.
//
// La agencia llega en el BODY (data.agency) en PUT/POST/bulk/conteo, y como
// parámetro ?agency=... en GET/DELETE. Si no viene, se usa '' (archivo anterior).
//
// Rutas:
//   GET    /parts[?agency=..]          (listar; filtra por agencia si se indica) [refacciones.view]
//   GET    /parts/{numParte}?agency=.. (una parte de una agencia)                [refacciones.view]
//   PUT    /parts/{numParte}           (crear/editar; agency en el body)         [refacciones.edit]
//   POST   /parts/bulk                 (carga masiva; cada parte trae agency)    [refacciones.edit]
//   POST   /parts/{numParte}/conteo    (conteo; agency en el body) FUSIÓN por parte [refacciones.count]
//   DELETE /parts[?agency=..]          (vaciar inventario de una agencia)        [refacciones.edit]

function part_row_to_api(array $r): array {
  return [
    'agency'        => $r['agencia'] ?? '',
    'numParte'      => $r['num_parte'],
    'descripcion'   => $r['descripcion'],
    'ubicacion'     => $r['ubicacion'],
    'grupo'         => $r['grupo'],
    'marbete'       => $r['marbete'],
    'existencia'    => $r['existencia'] !== null ? (int)$r['existencia'] : null,
    'conteo'        => $r['conteo'] !== null ? (int)$r['conteo'] : null,
    'conteoBy'      => $r['conteo_by'],
    'conteoAt'      => $r['conteo_at'],
    'conteos'       => part_json_decode($r['conteos'] ?? null),
    'exhibiciones'  => part_json_decode($r['exhibiciones'] ?? null),
    'exhibicion'    => isset($r['exhibicion']) && $r['exhibicion'] !== null ? (int)$r['exhibicion'] : null,
    'precioUnit'    => isset($r['precio_unit']) && $r['precio_unit'] !== null ? (float)$r['precio_unit'] : null,
    'clasificacion' => $r['clasificacion'] ?? '',
    'rotativoSesion'=> $r['rotativo_sesion'] ?? '',
    'enMarbetes'    => (bool)$r['en_marbetes'],
    'enExistencias' => (bool)$r['en_existencias'],
    'origin'        => $r['origin'],
    'updatedAt'     => $r['updated_at'],
  ];
}

function part_int_or_null($v) {
  if ($v === null || $v === '') return null;
  return (int)$v;
}
function part_num_or_null($v) {
  if ($v === null || $v === '') return null;
  return (float)$v;
}
// Decodifica un campo JSON de la BD a arreglo asociativo (o null).
function part_json_decode($v) {
  if ($v === null || $v === '') return null;
  $d = json_decode($v, true);
  return is_array($d) ? $d : null;
}
// Serializa un valor (arreglo) a JSON para guardar, o null.
function part_json_encode($v) {
  if ($v === null) return null;
  if (is_string($v)) return $v;            // ya viene serializado
  return json_encode($v, JSON_UNESCAPED_UNICODE);
}

// INSERT ... ON DUPLICATE KEY UPDATE para una parte (clave: agencia + num_parte).
function part_upsert(string $agencia, array $b): void {
  $numParte = trim((string)($b['numParte'] ?? ''));
  if ($numParte === '') json_error(422, 'El número de parte es obligatorio.');

  db()->prepare(
    'INSERT INTO refacciones
       (agencia, num_parte, descripcion, ubicacion, grupo, marbete, existencia, conteo,
        conteo_by, conteo_at, conteos, exhibiciones, exhibicion, precio_unit, clasificacion,
        rotativo_sesion, en_marbetes, en_existencias, origin)
     VALUES (:ag,:np,:desc,:ubic,:grupo,:marb,:exist,:cont,
             :cby,:cat,:conteos,:exhs,:exh,:pu,:clas,:rses,:enm,:ene,:org)
     ON DUPLICATE KEY UPDATE
       descripcion   = VALUES(descripcion),
       ubicacion     = VALUES(ubicacion),
       grupo         = VALUES(grupo),
       marbete       = VALUES(marbete),
       existencia    = VALUES(existencia),
       precio_unit   = VALUES(precio_unit),
       clasificacion = VALUES(clasificacion),
       rotativo_sesion = VALUES(rotativo_sesion),
       en_marbetes   = VALUES(en_marbetes),
       en_existencias= VALUES(en_existencias),
       origin        = VALUES(origin)')
    ->execute([
      ':ag'    => $agencia,
      ':np'    => $numParte,
      ':desc'  => (string)($b['descripcion'] ?? ''),
      ':ubic'  => (string)($b['ubicacion'] ?? ''),
      ':grupo' => (string)($b['grupo'] ?? ''),
      ':marb'  => (string)($b['marbete'] ?? ''),
      ':exist' => part_int_or_null($b['existencia'] ?? null),
      ':cont'  => part_int_or_null($b['conteo'] ?? null),
      ':cby'   => (string)($b['conteoBy'] ?? ''),
      ':cat'   => ($b['conteoAt'] ?? null) ?: null,
      ':conteos' => part_json_encode($b['conteos'] ?? null),
      ':exhs'  => part_json_encode($b['exhibiciones'] ?? null),
      ':exh'   => part_int_or_null($b['exhibicion'] ?? null),
      ':pu'    => part_num_or_null($b['precioUnit'] ?? null),
      ':clas'  => (string)($b['clasificacion'] ?? ''),
      ':rses'  => (string)($b['rotativoSesion'] ?? ''),
      ':enm'   => !empty($b['enMarbetes']) ? 1 : 0,
      ':ene'   => !empty($b['enExistencias']) ? 1 : 0,
      ':org'   => (string)($b['origin'] ?? ''),
    ]);
}

// Agencia de la petición: ?agency=... (GET/DELETE) o del body (PUT/POST).
function part_agency(array $b = []): string {
  $a = isset($_GET['agency']) ? trim((string)$_GET['agency']) : '';
  if ($a === '' && isset($b['agency'])) $a = trim((string)$b['agency']);
  return $a;
}

function handle_parts(array $user, string $method, array $parts): void {
  $seg = isset($parts[1]) ? trim($parts[1]) : null;   // {numParte} | 'bulk' | 'audit'

  // ---- Sesión de AUDITORÍA de refacciones por agencia (para continuar en otro
  //      dispositivo). GET /parts/audit?agency=..  y  PUT /parts/audit ----
  if ($seg === 'audit') {
    if ($method === 'GET') {
      require_perm($user, 'refacciones.view');
      $agencia = part_agency();
      if ($agencia === '') json_error(422, 'Falta la agencia.');
      $st = db()->prepare('SELECT datos, updated_at FROM refacciones_auditoria WHERE agencia=?');
      $st->execute([$agencia]);
      $r = $st->fetch();
      if (!$r) { json_ok(['audit' => null]); }
      $datos = part_json_decode($r['datos']);
      if (is_array($datos)) $datos['updatedAt'] = $r['updated_at'];   // para last-write-wins
      json_ok(['audit' => $datos]);
    }
    if ($method === 'PUT') {
      require_perm($user, 'refacciones.edit');
      $b = body();
      $agencia = part_agency($b);
      if ($agencia === '') json_error(422, 'Falta la agencia.');
      $datos = $b['datos'] ?? null;
      db()->prepare(
        'INSERT INTO refacciones_auditoria (agencia, datos) VALUES (:ag, :d)
         ON DUPLICATE KEY UPDATE datos = VALUES(datos)')
        ->execute([':ag' => $agencia, ':d' => part_json_encode($datos)]);
      json_ok();
    }
    json_error(405, 'Método no permitido.');
  }

  // GET /parts[?agency=..]  o  GET /parts/{numParte}?agency=..
  if ($method === 'GET') {
    require_perm($user, 'refacciones.view');
    $agencia = part_agency();
    if ($seg !== null && $seg !== '') {
      // Una parte concreta de una agencia (si no se indica agencia, la 1ª que haya).
      if ($agencia !== '') {
        $st = db()->prepare('SELECT * FROM refacciones WHERE agencia=? AND num_parte=?');
        $st->execute([$agencia, $seg]);
      } else {
        $st = db()->prepare('SELECT * FROM refacciones WHERE num_parte=? LIMIT 1');
        $st->execute([$seg]);
      }
      $r = $st->fetch();
      if (!$r) json_error(404, 'Refacción no encontrada.');
      json_ok(['part' => part_row_to_api($r)]);
    }
    // Listado: todas, o filtradas por agencia. El front fusiona por (agency,parte).
    if ($agencia !== '') {
      $st = db()->prepare('SELECT * FROM refacciones WHERE agencia=? ORDER BY updated_at DESC');
      $st->execute([$agencia]);
      $rows = $st->fetchAll();
    } else {
      $rows = db()->query('SELECT * FROM refacciones ORDER BY updated_at DESC')->fetchAll();
    }
    json_ok(['parts' => array_map('part_row_to_api', $rows)]);
  }

  // POST /parts/bulk — alta/actualización MASIVA. Cada parte trae su agency.
  if ($method === 'POST' && $seg === 'bulk') {
    require_perm($user, 'refacciones.edit');
    $b = body();
    $arr = $b['parts'] ?? [];
    if (!is_array($arr)) json_error(422, 'Se esperaba un arreglo "parts".');
    $agenciaDefault = part_agency($b);
    $added = 0; $updated = 0;
    db()->beginTransaction();
    try {
      foreach ($arr as $p) {
        if (!is_array($p) || trim((string)($p['numParte'] ?? '')) === '') continue;
        $ag = trim((string)($p['agency'] ?? '')) ?: $agenciaDefault;
        $chk = db()->prepare('SELECT 1 FROM refacciones WHERE agencia=? AND num_parte=?');
        $chk->execute([$ag, trim((string)$p['numParte'])]);
        $existe = (bool)$chk->fetchColumn();
        part_upsert($ag, $p);
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
  // FUSIÓN POR PARTE: solo toca ESA parte de ESA agencia; nunca pisa las demás.
  // Esto habilita el conteo MULTI-DISPOSITIVO (cada equipo aporta sus partes).
  if ($method === 'POST' && $seg !== null && ($parts[2] ?? '') === 'conteo') {
    require_perm($user, 'refacciones.count');
    $b = body();
    $agencia = part_agency($b);
    $conteo = part_int_or_null($b['conteo'] ?? null);
    $ronda  = part_int_or_null($b['ronda'] ?? null) ?: 1;
    if ($conteo === null || $conteo < 0) json_error(422, 'La cantidad contada debe ser 0 o más.');
    $st = db()->prepare('SELECT conteos FROM refacciones WHERE agencia=? AND num_parte=?');
    $st->execute([$agencia, $seg]);
    $row = $st->fetch();
    if (!$row) {
      // Parte contada que no estaba en el inventario de esa agencia: alta mínima.
      part_upsert($agencia, ['numParte' => $seg, 'origin' => 'conteo']);
      $conteos = [];
    } else {
      $conteos = part_json_decode($row['conteos']) ?: [];
    }
    // Guarda el conteo en la ronda indicada + el último valor, sin pisar otras partes.
    $conteos[(string)$ronda] = $conteo;
    db()->prepare(
      'UPDATE refacciones
         SET conteo=?, conteo_by=?, conteo_at=?, conteos=?
       WHERE agencia=? AND num_parte=?')
      ->execute([$conteo, $user['name'], date('Y-m-d H:i:s'),
                 json_encode($conteos, JSON_UNESCAPED_UNICODE), $agencia, $seg]);
    json_ok();
  }

  // PUT /parts/{numParte} — crear/editar una parte. [refacciones.edit]
  if ($method === 'PUT' && $seg !== null && $seg !== '') {
    require_perm($user, 'refacciones.edit');
    $b = body();
    $agencia = part_agency($b);
    $b['numParte'] = $seg;
    part_upsert($agencia, $b);
    $st = db()->prepare('SELECT * FROM refacciones WHERE agencia=? AND num_parte=?');
    $st->execute([$agencia, $seg]);
    json_ok(['part' => part_row_to_api($st->fetch())]);
  }

  // DELETE /parts[?agency=..] — vaciar el inventario de una agencia (o todo si
  // no se indica agencia). [refacciones.edit]
  if ($method === 'DELETE' && ($seg === null || $seg === '')) {
    require_perm($user, 'refacciones.edit');
    $agencia = part_agency();
    if ($agencia !== '') {
      db()->prepare('DELETE FROM refacciones WHERE agencia=?')->execute([$agencia]);
    } else {
      db()->exec('DELETE FROM refacciones');
    }
    json_ok();
  }

  json_error(405, 'Método no permitido.');
}
