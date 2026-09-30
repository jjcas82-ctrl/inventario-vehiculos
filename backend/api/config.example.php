<?php
// config.example.php — Copia este archivo como "config.php" y ajusta los valores.
// config.php NO debe subirse a GitHub (está en .gitignore).

return [
  // --- Base de datos MariaDB (Synology) ---
  'db_host' => '127.0.0.1',           // en el Synology suele ser 127.0.0.1
  'db_port' => 3306,                   // MariaDB 10 en Synology usa 3306
  'db_name' => 'inventario_vehiculos',
  'db_user' => 'inv_app',              // usuario de BD (crear en phpMyAdmin)
  'db_pass' => 'CAMBIA_ESTA_CLAVE',    // contraseña del usuario de BD

  // --- Seguridad ---
  // Duración de la sesión (token) en horas.
  'session_hours' => 12,

  // --- CORS: dominios del frontend autorizados a consumir la API ---
  // Agrega aquí la URL desde donde se sirve la PWA (GitHub Pages, Synology, etc.)
  'cors_origins' => [
    'https://jjcas82-ctrl.github.io',
    'http://localhost:8000',
  ],
];
