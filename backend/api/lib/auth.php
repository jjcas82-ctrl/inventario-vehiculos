<?php
// auth.php — Autenticación por token y control de permisos por rol.

// Matriz de permisos BASE por rol (debe mantenerse en sync con js/auth.js).
const PERMISSIONS = [
  'operador'    => ['event.register'],
  'consultor'   => ['inventory.view', 'inventory.viewValue', 'reports.view', 'map.view'],
  'asesor'      => ['inventory.view', 'reports.view'],  // sin inventory.viewValue (montos ocultos)
  'capturista'  => ['event.register', 'inventory.view', 'inventory.viewValue', 'reports.view', 'map.view', 'vehicle.edit'],
  'ventas_admin'=> ['event.register', 'inventory.view', 'inventory.viewValue', 'reports.view', 'map.view', 'vehicle.edit'],
  // Auditor: ve ambos inventarios, corre auditorías y puede escanear/mover (no edita fichas).
  'auditor'     => ['event.register', 'inventory.view', 'inventory.viewValue', 'reports.view', 'map.view',
                    'refacciones.view', 'audit.run', 'audit.schedule'],
  'contabilidad'=> ['inventory.view', 'inventory.viewValue', 'reports.view', 'map.view', 'refacciones.view'],
  // Gerente/Director: SOLO LECTURA en ambos inventarios. Sin Escanear, Mover por
  // zona ni Auditoría, y sin edición.
  'gerente'     => ['inventory.view', 'inventory.viewValue', 'reports.view', 'map.view', 'refacciones.view'],
  'refacciones' => ['refacciones.view', 'refacciones.edit'],
  'admin'       => ['event.register', 'inventory.view', 'inventory.viewValue', 'reports.view', 'map.view',
                    'vehicle.edit', 'vehicle.editVin', 'vehicle.delete', 'agencies.manage', 'users.manage', 'data.wipe',
                    'audit.run', 'audit.override', 'audit.schedule', 'refacciones.view', 'refacciones.edit'],
];

// Roles con edición OPCIONAL (se concede con el switch can_edit por usuario).
// Solo contabilidad: el gerente/director es de solo lectura.
const OPTIONAL_EDIT_ROLES = ['contabilidad'];

// Acceso a refacciones POR DEFECTO según el rol (si el usuario no tiene ajuste
// explícito access_parts). El admin puede activarlo/quitarlo por usuario.
const PARTS_DEFAULT = ['admin' => true, 'auditor' => true, 'contabilidad' => true,
                       'gerente' => true, 'refacciones' => true];

// Acceso a VEHÍCULOS por defecto: todos los roles menos "refacciones".
const VEH_DEFAULT_EXCEPT = ['refacciones'];

// Permisos que pertenecen al módulo de VEHÍCULOS: si el usuario no tiene acceso a
// vehículos, ninguno de estos se concede (ni siquiera por rol).
const VEH_PERMS = ['inventory.view', 'inventory.viewValue', 'reports.view', 'map.view',
                   'event.register', 'vehicle.edit', 'vehicle.editVin', 'vehicle.delete',
                   'audit.run', 'audit.override', 'audit.schedule'];

// ¿El usuario tiene acceso a refacciones? Usa access_parts si está definido;
// si no, el valor por defecto del rol. El administrador SIEMPRE tiene acceso.
function user_has_parts(array $u): bool {
  if (($u['role'] ?? '') === 'admin') return true;
  if (array_key_exists('access_parts', $u) && $u['access_parts'] !== null) {
    return (bool)$u['access_parts'];
  }
  return !empty(PARTS_DEFAULT[$u['role']] ?? false);
}

// ¿El usuario tiene acceso a vehículos? Usa access_veh si está definido; si no,
// el valor por defecto del rol. El administrador SIEMPRE tiene acceso.
function user_has_veh(array $u): bool {
  $role = $u['role'] ?? '';
  if ($role === 'admin') return true;
  if (array_key_exists('access_veh', $u) && $u['access_veh'] !== null) {
    return (bool)$u['access_veh'];
  }
  return !in_array($role, VEH_DEFAULT_EXCEPT, true);
}

// ¿El usuario tiene edición opcional concedida?
function user_has_optional_edit(array $u): bool {
  return in_array($u['role'], OPTIONAL_EDIT_ROLES, true) && !empty($u['can_edit']);
}

// Evalúa un permiso para un USUARIO (aplica los ajustes access_parts/can_edit).
function user_can(array $u, string $perm): bool {
  $role = $u['role'] ?? '';
  $base = PERMISSIONS[$role] ?? [];

  // Refacciones: ver/editar/contar dependen del acceso a refacciones.
  if ($perm === 'refacciones.view' || $perm === 'refacciones.edit' || $perm === 'refacciones.count') {
    if (!user_has_parts($u)) return false;
    if ($perm === 'refacciones.view') return true;
    if ($perm === 'refacciones.edit') {
      return in_array('refacciones.edit', $base, true) || user_has_optional_edit($u);
    }
    // Contar: quien edita refacciones O el auditor.
    return in_array('refacciones.edit', $base, true) || user_has_optional_edit($u)
        || in_array('audit.run', $base, true);
  }

  // Módulo de VEHÍCULOS: sin acceso a vehículos no se concede ningún permiso suyo.
  if (in_array($perm, VEH_PERMS, true) && !user_has_veh($u)) return false;

  // Edición de fichas de vehículos: permiso base O edición opcional concedida.
  if ($perm === 'vehicle.edit') {
    return in_array('vehicle.edit', $base, true) || user_has_optional_edit($u);
  }

  return in_array($perm, $base, true);
}

// Compat: evaluación solo por rol (sin ajustes por usuario).
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
      // Ajustes por usuario: el equipo los necesita para mostrar solo los módulos
      // que le corresponden (antes solo los conocía el servidor).
      'accessParts' => (array_key_exists('access_parts', $u) && $u['access_parts'] !== null) ? (bool)$u['access_parts'] : null,
      'accessVeh'   => (array_key_exists('access_veh', $u) && $u['access_veh'] !== null) ? (bool)$u['access_veh'] : null,
      'canEdit'     => !empty($u['can_edit']),
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
    // u.* (no columnas sueltas): así sigue funcionando aunque la columna access_veh
    // aún no exista en la base (se lee con ?? null).
    'SELECT u.*, s.expires_at
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
    // Ajustes por usuario (pueden ser NULL si no se definieron).
    'access_parts' => ($r['access_parts'] ?? null) === null ? null : (bool)$r['access_parts'],
    'access_veh'   => ($r['access_veh'] ?? null) === null ? null : (bool)$r['access_veh'],
    'can_edit' => !empty($r['can_edit']),
  ];
}

// Exige sesión válida; corta con 401 si no hay.
function require_auth(): array {
  $u = current_user();
  if (!$u) json_error(401, 'No autenticado. Inicia sesión.');
  return $u;
}

// Exige un permiso; corta con 403 si el usuario no lo tiene (aplica los ajustes
// por usuario access_parts/can_edit además del rol).
function require_perm(array $user, string $perm): void {
  if (!user_can($user, $perm)) {
    json_error(403, 'Tu rol no tiene permiso para esta acción.');
  }
}

function do_logout(): void {
  $hdr = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
  if (preg_match('/Bearer\s+([a-f0-9]{64})/i', $hdr, $m)) {
    db()->prepare('DELETE FROM sesiones WHERE token = ?')->execute([$m[1]]);
  }
}
