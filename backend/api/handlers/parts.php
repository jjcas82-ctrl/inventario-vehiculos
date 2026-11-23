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
//   POST   /parts/{numParte}/exhibicion (exhibición por punto) FUSIÓN por punto  [refacciones.count]
//   DELETE /parts[?agency=..]          (vaciar inventario de una agencia)        [refacciones.edit + candado]
//
// Un PUT/bulk normal NUNCA pisa conteos ni exhibiciones de una parte existente;
// solo bulk con resetCounts (nueva muestra) los reinicia.

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
    'exhibObs'      => part_json_decode($r['exhib_obs'] ?? null),
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

// ¿Existe la columna en la tabla refacciones? (para columnas opcionales que se
// agregan con ALTER, como exhib_obs: si aún no existe, se ignora sin fallar).
function part_has_col(string $col): bool {
  static $cache = null;
  if ($cache === null) {
    $cache = [];
    try {
      if (db()->getAttribute(PDO::ATTR_DRIVER_NAME) === 'sqlite') {
        foreach (db()->query('PRAGMA table_info(refacciones)')->fetchAll() as $c) $cache[$c['name']] = true;
      } else {
        foreach (db()->query('SHOW COLUMNS FROM refacciones')->fetchAll() as $c) $cache[$c['Field']] = true;
      }
    } catch (Throwable $e) { /* sin info: se asume que no existe */ }
  }
  return !empty($cache[$col]);
}

// Valores de una parte (del body) por columna.
function part_values(array $b): array {
  $v = [
    'descripcion'    => (string)($b['descripcion'] ?? ''),
    'ubicacion'      => (string)($b['ubicacion'] ?? ''),
    'grupo'          => (string)($b['grupo'] ?? ''),
    'marbete'        => (string)($b['marbete'] ?? ''),
    'existencia'     => part_int_or_null($b['existencia'] ?? null),
    'precio_unit'    => part_num_or_null($b['precioUnit'] ?? null),
    'clasificacion'  => (string)($b['clasificacion'] ?? ''),
    'en_marbetes'    => !empty($b['enMarbetes']) ? 1 : 0,
    'en_existencias' => !empty($b['enExistencias']) ? 1 : 0,
    'origin'         => (string)($b['origin'] ?? ''),
    // --- Datos de CONTEO (solo se escriben al dar de alta o al reiniciar) ---
    'conteo'         => part_int_or_null($b['conteo'] ?? null),
    'conteo_by'      => (string)($b['conteoBy'] ?? ''),
    'conteo_at'      => ($b['conteoAt'] ?? null) ?: null,
    'conteos'        => part_json_encode($b['conteos'] ?? null),
    'exhibiciones'   => part_json_encode($b['exhibiciones'] ?? null),
    'exhibicion'     => part_int_or_null($b['exhibicion'] ?? null),
    'rotativo_sesion'=> (string)($b['rotativoSesion'] ?? ''),
  ];
  if (part_has_col('exhib_obs')) $v['exhib_obs'] = part_json_encode($b['exhibObs'] ?? null);
  return $v;
}
// Columnas de conteo/auditoría: un PUT o bulk NORMAL nunca las pisa en una parte
// que ya existe (así un equipo desactualizado no borra lo que otro contó). Solo se
// escriben al dar de alta la parte o cuando se pide reiniciar (nueva muestra).
const PART_COUNT_COLS = ['conteo', 'conteo_by', 'conteo_at', 'conteos', 'exhibiciones',
                         'exhibicion', 'rotativo_sesion', 'exhib_obs'];

// Alta o actualización de una parte (clave: agencia + num_parte).
//   $reset = false → actualiza SOLO los datos descriptivos (existencia, precio…).
//   $reset = true  → además reemplaza conteos/exhibiciones/sello con lo enviado.
function part_upsert(string $agencia, array $b, bool $reset = false): void {
  $numParte = trim((string)($b['numParte'] ?? ''));
  if ($numParte === '') json_error(422, 'El número de parte es obligatorio.');
  $vals = part_values($b);

  $chk = db()->prepare('SELECT 1 FROM refacciones WHERE agencia=? AND num_parte=?');
  $chk->execute([$agencia, $numParte]);
  if ($chk->fetchColumn()) {
    $set = []; $args = [];
    foreach ($vals as $col => $v) {
      if (!$reset && in_array($col, PART_COUNT_COLS, true)) continue;
      $set[] = "$col = ?"; $args[] = $v;
    }
    $args[] = $agencia; $args[] = $numParte;
    db()->prepare('UPDATE refacciones SET ' . implode(', ', $set) . ' WHERE agencia=? AND num_parte=?')
      ->execute($args);
  } else {
    $cols = array_merge(['agencia', 'num_parte'], array_keys($vals));
    $args = array_merge([$agencia, $numParte], array_values($vals));
    db()->prepare('INSERT INTO refacciones (' . implode(', ', $cols) . ') VALUES (' .
                  implode(',', array_fill(0, count($cols), '?')) . ')')
      ->execute($args);
  }
}

// ¿Hay un inventario EN CURSO en la agencia? (misma regla que el frontend: sesión
// con tipo, sin cerrar, y con partes; en rotativo, solo cuentan las de la muestra).
// Se usa para el CANDADO en el servidor: solo el administrador puede vaciar o
// reiniciar un inventario activo.
function part_inventario_activo(string $agencia): bool {
  $st = db()->prepare('SELECT datos FROM refacciones_auditoria WHERE agencia=?');
  $st->execute([$agencia]);
  $r = $st->fetch();
  $d = $r ? part_json_decode($r['datos']) : null;
  if (!is_array($d) || empty($d['tipo']) || !empty($d['finishedAt'])) return false;
  if ($d['tipo'] === 'rotativo') {
    $sello = (string)($d['rotativoSesion'] ?? '');
    if ($sello === '') return false;
    $c = db()->prepare('SELECT COUNT(*) FROM refacciones WHERE agencia=? AND rotativo_sesion=?');
    $c->execute([$agencia, $sello]);
  } else {
    $c = db()->prepare('SELECT COUNT(*) FROM refacciones WHERE agencia=?');
    $c->execute([$agencia]);
  }
  return (int)$c->fetchColumn() > 0;
}
function part_require_candado(array $user, string $agencia): void {
  if (($user['role'] ?? '') === 'admin') return;
  if ($agencia === '' || part_inventario_activo($agencia)) {
    json_error(403, 'Hay un inventario en curso en esta agencia: solo el administrador puede reiniciarlo.');
  }
}
// Sello rotativo: un conteo/exhibición que trae el sello de una muestra ANTERIOR
// (p. ej. quedó en la cola de un equipo sin internet) no se aplica a la nueva.
function part_check_sello(?array $row, array $b): void {
  $sello = trim((string)($b['rotativoSesion'] ?? ''));
  if ($sello === '') return;
  $actual = $row ? (string)($row['rotativo_sesion'] ?? '') : '';
  if ($actual !== $sello) {
    json_error(409, 'Esta captura es de una muestra rotativa anterior; no se aplicó al inventario actual.');
  }
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
      // Quien cuenta (auditor) también avanza rondas o cierra: basta con contar.
      if (!user_can($user, 'refacciones.edit') && !user_can($user, 'refacciones.count')) {
        json_error(403, 'Tu rol no tiene permiso para esta acción.');
      }
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
  //   resetCounts: true → reinicia conteos/exhibiciones/sello (nueva muestra).
  //   replace: true     → además BORRA de esa agencia las partes que no vienen
  //                       en el lote (el inventario queda igual al archivo).
  //   Ambas opciones respetan el candado (solo admin con inventario en curso).
  if ($method === 'POST' && $seg === 'bulk') {
    require_perm($user, 'refacciones.edit');
    $b = body();
    $arr = $b['parts'] ?? [];
    if (!is_array($arr)) json_error(422, 'Se esperaba un arreglo "parts".');
    $agenciaDefault = part_agency($b);
    $reset = !empty($b['resetCounts']);
    $replace = !empty($b['replace']);
    if ($reset || $replace) {
      $ags = [];
      foreach ($arr as $p) {
        if (is_array($p)) $ags[trim((string)($p['agency'] ?? '')) ?: $agenciaDefault] = true;
      }
      foreach (array_keys($ags) as $ag) part_require_candado($user, $ag);
    }
    $added = 0; $updated = 0; $removed = 0;
    $vistos = [];   // agencia => [num_parte => true]
    db()->beginTransaction();
    try {
      foreach ($arr as $p) {
        if (!is_array($p) || trim((string)($p['numParte'] ?? '')) === '') continue;
        $ag = trim((string)($p['agency'] ?? '')) ?: $agenciaDefault;
        $np = trim((string)$p['numParte']);
        $chk = db()->prepare('SELECT 1 FROM refacciones WHERE agencia=? AND num_parte=?');
        $chk->execute([$ag, $np]);
        $existe = (bool)$chk->fetchColumn();
        part_upsert($ag, $p, $reset);
        $vistos[$ag][$np] = true;
        if ($existe) $updated++; else $added++;
      }
      if ($replace) {
        foreach ($vistos as $ag => $set) {
          $st = db()->prepare('SELECT num_parte FROM refacciones WHERE agencia=?');
          $st->execute([$ag]);
          $del = db()->prepare('DELETE FROM refacciones WHERE agencia=? AND num_parte=?');
          foreach ($st->fetchAll(PDO::FETCH_COLUMN) as $np) {
            if (!isset($set[$np])) { $del->execute([$ag, $np]); $removed++; }
          }
        }
      }
      db()->commit();
    } catch (Throwable $e) {
      db()->rollBack();
      json_error(500, 'No se pudo guardar el lote de refacciones.', $e->getMessage());
    }
    json_ok(['added' => $added, 'updated' => $updated, 'removed' => $removed]);
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
    $st = db()->prepare('SELECT conteos, rotativo_sesion FROM refacciones WHERE agencia=? AND num_parte=?');
    $st->execute([$agencia, $seg]);
    $row = $st->fetch() ?: null;
    part_check_sello($row, $b);
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

  // POST /parts/{numParte}/exhibicion — piezas en exhibición / punto de venta.
  // [refacciones.count] FUSIÓN POR PUNTO: solo cambia ese punto de esa parte.
  // Body: { agency, punto, cantidad, observacion?, rotativoSesion? }. cantidad 0 = quitar.
  if ($method === 'POST' && $seg !== null && ($parts[2] ?? '') === 'exhibicion') {
    require_perm($user, 'refacciones.count');
    $b = body();
    $agencia = part_agency($b);
    $punto = trim((string)($b['punto'] ?? ''));
    $cant = part_int_or_null($b['cantidad'] ?? null);
    if ($punto === '') json_error(422, 'Falta el punto de venta / ubicación.');
    if ($cant === null || $cant < 0) json_error(422, 'La cantidad debe ser 0 o más.');
    $obsCol = part_has_col('exhib_obs');
    $st = db()->prepare('SELECT * FROM refacciones WHERE agencia=? AND num_parte=?');
    $st->execute([$agencia, $seg]);
    $row = $st->fetch() ?: null;
    // Solo se rechaza si la parte YA está en otra muestra (captura vieja en cola).
    if ($row && (string)($row['rotativo_sesion'] ?? '') !== '') part_check_sello($row, $b);
    if (!$row) {
      part_upsert($agencia, ['numParte' => $seg, 'origin' => 'exhibicion']);
      $row = ['exhibiciones' => null, 'exhib_obs' => null];
    }
    $det = part_json_decode($row['exhibiciones'] ?? null) ?: [];
    $obs = $obsCol ? (part_json_decode($row['exhib_obs'] ?? null) ?: []) : [];
    if ($cant > 0) {
      $det[$punto] = $cant;
      $o = trim((string)($b['observacion'] ?? ''));
      if ($o !== '') $obs[$punto] = $o;
    } else {
      unset($det[$punto], $obs[$punto]);
    }
    $total = array_sum(array_map('intval', $det));
    $detJson = $det ? json_encode($det, JSON_UNESCAPED_UNICODE) : null;
    if ($obsCol) {
      db()->prepare('UPDATE refacciones SET exhibiciones=?, exhibicion=?, exhib_obs=? WHERE agencia=? AND num_parte=?')
        ->execute([$detJson, $total, $obs ? json_encode($obs, JSON_UNESCAPED_UNICODE) : null, $agencia, $seg]);
    } else {
      db()->prepare('UPDATE refacciones SET exhibiciones=?, exhibicion=? WHERE agencia=? AND num_parte=?')
        ->execute([$detJson, $total, $agencia, $seg]);
    }
    json_ok(['exhibicion' => $total, 'exhibiciones' => (object)$det]);
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
    // Candado: vaciar un inventario en curso (o TODAS las agencias) es solo de admin.
    part_require_candado($user, $agencia);
    if ($agencia !== '') {
      db()->prepare('DELETE FROM refacciones WHERE agencia=?')->execute([$agencia]);
    } else {
      db()->exec('DELETE FROM refacciones');
    }
    json_ok();
  }

  json_error(405, 'Método no permitido.');
}
