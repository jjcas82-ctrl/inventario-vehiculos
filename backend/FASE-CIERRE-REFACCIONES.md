# Cierre del módulo de refacciones (correcciones de sincronización y candado)

## Qué cambia
- **No se pierden conteos entre equipos.** Guardar o recargar una parte (PUT o carga
  masiva) ya no borra el conteo ni la exhibición que otro equipo registró. Solo
  se reinician al generar una muestra nueva o al reiniciar el conteo.
- **Candado en el servidor.** Con un inventario en curso, solo el administrador puede
  vaciarlo, generar otra muestra o reiniciar los conteos (antes solo lo bloqueaba la pantalla).
- **Capturas de una muestra anterior no se aplican.** Si un conteo o una exhibición se
  quedó pendiente en un celular sin internet y mientras tanto se generó otra muestra,
  el servidor la rechaza y el celular avisa.
- **Exhibición del auditor.** Se guarda en el servidor con el permiso de contar
  (antes exigía permiso de edición y se rechazaba sin avisar).
- **Observaciones de exhibición en el servidor** (columna nueva `exhib_obs`), para que la
  evidencia de los reportes salga igual en todos los equipos.
- **Nueva muestra = inventario igual al archivo.** Las partes que ya no vienen en el
  archivo se borran del servidor y no vuelven a aparecer.
- **Rol no válido** al crear o editar un usuario: se rechaza.

## Pasos en el Synology (en este orden)
1. **Ejecutar el SQL** (una sola vez):

   ```sql
   ALTER TABLE refacciones ADD COLUMN IF NOT EXISTS exhib_obs LONGTEXT NULL;
   ```

2. **Subir estos 3 archivos** por File Station (reemplazan a los existentes):
   - `backend/api/handlers/parts.php`
   - `backend/api/handlers/users.php`
   - `backend/api/index.php` (solo cambia la lista de rutas en los comentarios)

Si se suben los PHP antes del SQL, todo funciona; solo las observaciones de exhibición
no se guardan en el servidor hasta que exista la columna.

## Importante
- Sube los PHP **antes** de usar la versión v185 de la app en los celulares: la app
  nueva guarda la exhibición en una ruta nueva (`/parts/{nº}/exhibicion`) que el PHP
  anterior no tiene.
- Antes de subir, termina o cierra los conteos que estén en curso, por si algún
  celular tiene capturas pendientes con la versión anterior.
