<?php
// auth.php — Autenticación por token y control de permisos por rol.

// Matriz de permisos por rol (igual que en el frontend).
const PERMISSIONS = [
  'operador'   => ['event.register'],
  'consultor'  => ['inventory.view', 'reports.view', 'map.view'],
  'capturista' => ['event.register', 'inventory.view', 'reports.view', 'map.view', 'vehicle.edit'],
  'admin'      => ['event.register', 'inventory.view', 'reports.view', 'map.view', 'vehicle.edit',
                   'vehicle.editVin', 'agencies.manage', 'users.manage', 'data.wipe', 'audit.run'],
];

function role_can(string $role, string $perm): bool {
  return in_array($perm, PERMISSIONS[$role] ?? [], true);
}

// Genera un token aleatorio de 64 hex.
function new_token(): string {
  return bin2hex(random_bytes(32));
}

// Login: valida usuario/contraseña, crea sesión y devuelve token + datos del usuario.
function do_login(string $username, string $password): array {
  $st = db()->prepare('SELECT * FROM usuarios WHERE username = ? AND activo = 1 LIMIT 1');
  $st->execute([trim($username)]);
  $u = $st->fetch();
  if (!$u || !password_verify($password, $u['pass_hash'])) {
    json_error(401, 'Usuario o contraseña incorrectos.');
  }
  $token = new_token();
  $hours = (int)(cfg()['session_hours'] ?? 12);
  $exp = (new DateTime("+{$hours} hours"))->format('Y-m-d H:i:s');
  db()->prepare('INSERT INTO sesiones (token, usuario_id, expires_at) VALUES (?,?,?)')
      ->execute([$token, $u['id'], $exp]);
  return [
    'token' => $token,
    'user'  => [
      'id' => (int)$u['id'],
      'username' => $u['username'],
      'name' => trim($u['first_name'] . ' ' . $u['last_name']) ?: $u['username'],
      'role' => $u['role'],
    ],
  ];
}

// Obtiene el usuario autenticado a partir del token (header Authorization: Bearer ...).
function current_user(): ?array {
  $hdr = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
  if (!$hdr && function_exists('apache_request_headers')) {
    $h = apache_request_headers();
    $hdr = $h['Authorization'] ?? $h['authorization'] ?? '';
  }
  if (!preg_match('/Bearer\s+([a-f0-9]{64})/i', $hdr, $m)) return null;
  $token = $m[1];

  $st = db()->prepare(
    'SELECT u.id, u.username, u.first_name, u.last_name, u.role, s.expires_at
       FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id
      WHERE s.token = ? LIMIT 1');
  $st->execute([$token]);
  $r = $st->fetch();
  if (!$r) return null;
  if (strtotime($r['expires_at']) < time()) {
    db()->prepare('DELETE FROM sesiones WHERE token = ?')->execute([$token]);
    return null;
  }
  return [
    'id' => (int)$r['id'],
    'username' => $r['username'],
    'name' => trim($r['first_name'] . ' ' . $r['last_name']) ?: $r['username'],
    'role' => $r['role'],
  ];
}

// Exige sesión válida; corta con 401 si no hay.
function require_auth(): array {
  $u = current_user();
  if (!$u) json_error(401, 'No autenticado. Inicia sesión.');
  return $u;
}

// Exige un permiso; corta con 403 si el rol no lo tiene.
function require_perm(array $user, string $perm): void {
  if (!role_can($user['role'], $perm)) {
    json_error(403, 'Tu rol no tiene permiso para esta acción.');
  }
}

function do_logout(): void {
  $hdr = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
  if (preg_match('/Bearer\s+([a-f0-9]{64})/i', $hdr, $m)) {
    db()->prepare('DELETE FROM sesiones WHERE token = ?')->execute([$m[1]]);
  }
}
