<?php
// handlers/audits.php — Conteos físicos / auditorías.

function audit_row_to_api(array $r): array {
  return [
    'id'            => (int)$r['id'],
    'agency'        => $r['agency'],
    'mode'          => $r['modo'],
    'by'            => $r['usuario'],
    'totalExpected' => (int)$r['total_esperado'],
    'presentes'     => $r['presentes'] ? json_decode($r['presentes'], true) : [],
    'faltantes'     => $r['faltantes'] ? json_decode($r['faltantes'], true) : [],
    'sobrantes'     => $r['sobrantes'] ? json_decode($r['sobrantes'], true) : [],
    'startedAt'     => $r['started_at'],
    'finishedAt'    => $r['finished_at'],
    'createdAt'     => $r['created_at'],
  ];
}

function handle_audits(array $user, string $method, array $parts): void {
  require_perm($user, 'audit.run');

  if ($method === 'GET') {
    $rows = db()->query('SELECT * FROM auditorias ORDER BY created_at DESC LIMIT 200')->fetchAll();
    json_ok(['audits' => array_map('audit_row_to_api', $rows)]);
  }

  if ($method === 'POST') {
    $b = body();
    db()->prepare('INSERT INTO auditorias (agency, modo, usuario, total_esperado, presentes, faltantes, sobrantes, started_at, finished_at)
                   VALUES (?,?,?,?,?,?,?,?,?)')
        ->execute([
          (string)($b['agency'] ?? ''), (string)($b['mode'] ?? 'full'), $user['name'],
          (int)($b['totalExpected'] ?? 0),
          json_encode($b['presentes'] ?? [], JSON_UNESCAPED_UNICODE),
          json_encode($b['faltantes'] ?? [], JSON_UNESCAPED_UNICODE),
          json_encode($b['sobrantes'] ?? [], JSON_UNESCAPED_UNICODE),
          !empty($b['startedAt']) ? date('Y-m-d H:i:s', strtotime($b['startedAt'])) : null,
          !empty($b['finishedAt']) ? date('Y-m-d H:i:s', strtotime($b['finishedAt'])) : date('Y-m-d H:i:s'),
        ]);
    json_ok(['id' => (int)db()->lastInsertId()]);
  }

  json_error(405, 'Método no permitido.');
}
