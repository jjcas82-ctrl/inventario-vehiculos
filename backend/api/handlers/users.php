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
  ];
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
    db()->prepare('INSERT INTO usuarios (first_name, last_name, email, username, pass_hash, role) VALUES (?,?,?,?,?,?)')
        ->execute([
          (string)($b['firstName'] ?? ''), (string)($b['lastName'] ?? ''),
          (string)($b['email'] ?? ''), $username,
          password_hash($pass, PASSWORD_DEFAULT), (string)($b['role'] ?? 'operador'),
        ]);
    json_ok(['id' => (int)db()->lastInsertId()]);
  }

  // PUT /users/{id} — editar rol / datos / contraseña
  if ($method === 'PUT' && $id) {
    $b = body();
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
