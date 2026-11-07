<?php
// handlers/users.php — Gestión de usuarios (solo admin).

function user_row_to_api(array $r): array {
  return [
    'id'        => (int)$r['id'],
    'firstName' => $r['first_name'],
    'lastName'  => $r['last_name'],
    'email'     => $r['email'],
    'username'  => $r['username'],
    'role'      => $r['role'],
    'activo'    => (bool)$r['activo'],
    'accessParts' => isset($r['access_parts']) && $r['access_parts'] !== null ? (bool)$r['access_parts'] : null,
    'accessVeh'   => isset($r['access_veh']) && $r['access_veh'] !== null ? (bool)$r['access_veh'] : null,
    'canEdit'     => isset($r['can_edit']) ? (bool)$r['can_edit'] : false,
  ];
}

// ¿Existe ya la columna usuarios.access_veh? Permite subir este archivo antes de
// correr el ALTER sin romper el alta/edición de usuarios (simplemente no guarda
// el ajuste de vehículos hasta que la columna exista).
function usuarios_tiene_access_veh(): bool {
  static $ok = null;
  if ($ok !== null) return $ok;
  try { db()->query('SELECT access_veh FROM usuarios LIMIT 1'); $ok = true; }
  catch (Throwable $e) { $ok = false; }
  return $ok;
}

function handle_users(array $user, string $method, array $parts): void {
  require_perm($user, 'users.manage');
  $id = isset($parts[1]) ? (int)$parts[1] : null;

  // GET /users
  if ($method === 'GET') {
    $rows = db()->query('SELECT * FROM usuarios ORDER BY username')->fetchAll();
    json_ok(['users' => array_map('user_row_to_api', $rows)]);
  }

  // POST /users — crear
  if ($method === 'POST') {
    $b = body();
    $username = trim((string)($b['username'] ?? ''));
    $pass = (string)($b['password'] ?? '');
    if ($username === '') json_error(422, 'El nombre de usuario es obligatorio.');
    if (strlen($pass) < 4) json_error(422, 'La contraseña debe tener al menos 4 caracteres.');
    $dup = db()->prepare('SELECT id FROM usuarios WHERE username=?'); $dup->execute([$username]);
    if ($dup->fetch()) json_error(409, 'Ya existe ese nombre de usuario.');
    $accessParts = array_key_exists('accessParts', $b) && $b['accessParts'] !== null ? (int)(bool)$b['accessParts'] : null;
    $accessVeh = array_key_exists('accessVeh', $b) && $b['accessVeh'] !== null ? (int)(bool)$b['accessVeh'] : null;
    $role = (string)($b['role'] ?? 'operador');
    // Un usuario (no admin) debe tener acceso al menos a un módulo.
    $tmp = ['role' => $role, 'access_parts' => $accessParts, 'access_veh' => $accessVeh];
    if (!user_has_parts($tmp) && !user_has_veh($tmp)) {
      json_error(422, 'El usuario debe tener acceso al menos a un módulo (vehículos o refacciones).');
    }
    $canEdit = !empty($b['canEdit']) ? 1 : 0;
    $cols = 'first_name, last_name, email, username, pass_hash, role, access_parts, can_edit';
    $vals = [
      (string)($b['firstName'] ?? ''), (string)($b['lastName'] ?? ''),
      (string)($b['email'] ?? ''), $username,
      password_hash($pass, PASSWORD_DEFAULT), $role,
      $accessParts, $canEdit,
    ];
    if (usuarios_tiene_access_veh()) { $cols .= ', access_veh'; $vals[] = $accessVeh; }
    $marks = implode(',', array_fill(0, count($vals), '?'));
    db()->prepare("INSERT INTO usuarios ($cols) VALUES ($marks)")->execute($vals);
    json_ok(['id' => (int)db()->lastInsertId()]);
  }

  // PUT /users/{id} — editar rol / datos / contraseña
  if ($method === 'PUT' && $id) {
    $b = body();
    // Protección: tras el cambio, el usuario debe conservar al menos un módulo
    // (vehículos o refacciones). El admin siempre tiene ambos.
    if (isset($b['role']) || array_key_exists('accessParts', $b) || array_key_exists('accessVeh', $b)) {
      $curU = db()->prepare('SELECT * FROM usuarios WHERE id=?'); $curU->execute([$id]);
      $tmp = $curU->fetch();
      if ($tmp) {
        if (isset($b['role'])) $tmp['role'] = (string)$b['role'];
        if (array_key_exists('accessParts', $b)) $tmp['access_parts'] = $b['accessParts'] === null ? null : (int)(bool)$b['accessParts'];
        if (array_key_exists('accessVeh', $b))   $tmp['access_veh']   = $b['accessVeh'] === null ? null : (int)(bool)$b['accessVeh'];
        if (!user_has_parts($tmp) && !user_has_veh($tmp)) {
          json_error(422, 'El usuario debe conservar acceso al menos a un módulo (vehículos o refacciones).');
        }
      }
    }
    if (isset($b['role'])) {
      // Evitar quedarse sin administradores.
      if ($b['role'] !== 'admin') {
        $cur = db()->prepare('SELECT role FROM usuarios WHERE id=?'); $cur->execute([$id]);
        $row = $cur->fetch();
        if ($row && $row['role'] === 'admin') {
          $n = (int)db()->query('SELECT COUNT(*) c FROM usuarios WHERE role="admin"')->fetch()['c'];
          if ($n <= 1) json_error(409, 'Debe existir al menos un administrador.');
        }
      }
      db()->prepare('UPDATE usuarios SET role=? WHERE id=?')->execute([(string)$b['role'], $id]);
    }
    foreach (['firstName'=>'first_name','lastName'=>'last_name','email'=>'email'] as $k=>$col) {
      if (isset($b[$k])) db()->prepare("UPDATE usuarios SET $col=? WHERE id=?")->execute([(string)$b[$k], $id]);
    }
    if (array_key_exists('accessParts', $b)) {
      $ap = $b['accessParts'] === null ? null : (int)(bool)$b['accessParts'];
      db()->prepare('UPDATE usuarios SET access_parts=? WHERE id=?')->execute([$ap, $id]);
    }
    if (array_key_exists('accessVeh', $b) && usuarios_tiene_access_veh()) {
      $av = $b['accessVeh'] === null ? null : (int)(bool)$b['accessVeh'];
      db()->prepare('UPDATE usuarios SET access_veh=? WHERE id=?')->execute([$av, $id]);
    }
    if (array_key_exists('canEdit', $b)) {
      db()->prepare('UPDATE usuarios SET can_edit=? WHERE id=?')->execute([!empty($b['canEdit']) ? 1 : 0, $id]);
    }
    if (!empty($b['password'])) {
      if (strlen($b['password']) < 4) json_error(422, 'Contraseña muy corta.');
      db()->prepare('UPDATE usuarios SET pass_hash=? WHERE id=?')
          ->execute([password_hash($b['password'], PASSWORD_DEFAULT), $id]);
    }
    json_ok();
  }

  // DELETE /users/{id}
  if ($method === 'DELETE' && $id) {
    $cur = db()->prepare('SELECT role FROM usuarios WHERE id=?'); $cur->execute([$id]);
    $row = $cur->fetch();
    if ($row && $row['role'] === 'admin') {
      $n = (int)db()->query('SELECT COUNT(*) c FROM usuarios WHERE role="admin"')->fetch()['c'];
      if ($n <= 1) json_error(409, 'Debe existir al menos un administrador.');
    }
    if ($id === $user['id']) json_error(409, 'No puedes eliminar tu propio usuario.');
    db()->prepare('DELETE FROM usuarios WHERE id=?')->execute([$id]);
    json_ok();
  }

  json_error(405, 'Método no permitido.');
}
