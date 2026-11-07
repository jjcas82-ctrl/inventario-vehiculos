# Permisos por rol + acceso a vehículos por usuario

## Qué cambia
- Nueva casilla **Acceso a vehículos** por usuario (igual que la de refacciones).
- Gerente/Director: solo lectura en vehículos y refacciones. Sin Escanear, Mover por zona ni Auditoría.
- Auditor: además puede Escanear y Mover por zona.
- Edición opcional ("Puede editar"): solo Contabilidad.
- Un usuario no puede quedarse sin ningún módulo. El admin siempre tiene ambos.

## Pasos en el Synology (en este orden)
1. **Ejecutar el SQL** (una sola vez) en la base de datos:

   ```sql
   ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS access_veh TINYINT(1) NULL DEFAULT NULL;
   ```

2. **Subir estos 2 archivos** por File Station (reemplazan a los existentes):
   - `backend/api/lib/auth.php`
   - `backend/api/handlers/users.php`

Si se suben los PHP antes del SQL, la app sigue funcionando; solo no se guardará
la casilla de vehículos en el servidor hasta que exista la columna.

## Qué NO cambia
- Los usuarios existentes conservan su acceso actual: sin ajuste explícito se usa el valor por
  defecto del rol (todos los roles ven vehículos salvo "Refacciones").
- Los gerentes que tenían "Puede editar" activado dejan de editar (el gerente es solo lectura).
- Los ajustes por usuario llegan al equipo al **iniciar sesión**; un usuario con la sesión ya
  abierta los toma la próxima vez que entre.
