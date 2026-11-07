// auth.js — Roles, permisos, usuarios y sesión con login usuario+contraseña (local).
//
// Modelo de usuario:
//   { id, firstName, lastName, email, username, role, passHash, salt, createdAt,
//     accessParts (bool|undefined), canEdit (bool|undefined) }
//
// Dos AJUSTES por usuario (los controla el Administrador en la pestaña Usuarios):
//   - accessParts: acceso al inventario de REFACCIONES (anula/activa por usuario,
//       sin cambiar el rol). Si es undefined, se usa el valor por defecto del rol.
//   - canEdit: edición OPCIONAL para roles cuya edición es opcional
//       (gerente/director y administrativo de contabilidad). No aplica a otros.
//
// Seguridad: sin servidor todavía, la validación es LOCAL. Las contraseñas se
// guardan como HASH SHA-256 + salt (nunca en texto plano). En la Fase 2 el login
// se valida en el servidor.

import { store } from "./storage.js";
import { logAction } from "./syslog.js";
import * as api from "./api.js";

// Cuenta de EMERGENCIA local: funciona SIEMPRE, incluso sin servidor ni internet,
// en cualquier dispositivo (aunque sea nuevo). Pensada para seguir operando una
// recepción o auditoría si el Synology/internet se cae. Es un admin local.
//   - username fijo. La contraseña se puede cambiar (se guarda como usuario local
//     normal); por defecto es la inicial y obliga a cambiarla en el primer uso.
const EMERGENCY_USERNAME = "emergencia";
const EMERGENCY_DEFAULT_PASS = "aeroplasa";   // cámbiala en el primer acceso

export const ROLES = {
  admin:       { label: "Administrador",               desc: "Acceso total: VIN, agencias, usuarios, refacciones y auditorías." },
  gerente:     { label: "Gerente / Director",          desc: "Ve vehículos y refacciones en solo lectura. No edita, no escanea ni audita." },
  auditor:     { label: "Auditor",                     desc: "Ve vehículos y refacciones; realiza auditorías, escanea y mueve unidades." },
  contabilidad:{ label: "Administrativo de contabilidad", desc: "Ve vehículos y refacciones. Edición opcional." },
  ventas_admin:{ label: "Administrativo de ventas",    desc: "Pestañas de vehículos; puede editar fichas." },
  capturista:  { label: "Capturista",                  desc: "Inventario de vehículos; registra y edita fichas." },
  consultor:   { label: "Consultor",                   desc: "Consulta inventario, mapa y reportes (sin editar)." },
  asesor:      { label: "Asesor de ventas",            desc: "Solo Inventario y Reportes (sin montos $, sin editar)." },
  operador:    { label: "Operador",                    desc: "Solo entradas, salidas y movimiento interno (Escanear)." },
  refacciones: { label: "Refacciones",                 desc: "Solo acceso al inventario de refacciones." },
};

// Permisos BASE por rol. Los ajustes por usuario (accessParts/canEdit) se aplican
// encima en can() — ver más abajo.
//   inventory.view      → ver inventario de vehículos (pestañas Inicio/Inventario).
//   inventory.viewValue → ver los MONTOS $ (valor del inventario).
//   refacciones.view    → ver el inventario de refacciones.
//   refacciones.edit    → cargar/contar/editar refacciones.
//   vehicle.edit        → editar fichas de vehículos.
const PERMISSIONS = {
  operador:    ["event.register"],
  consultor:   ["inventory.view", "inventory.viewValue", "reports.view", "map.view"],
  asesor:      ["inventory.view", "reports.view"],                 // SIN inventory.viewValue (montos ocultos)
  capturista:  ["event.register", "inventory.view", "inventory.viewValue", "reports.view", "map.view", "vehicle.edit"],
  ventas_admin:["event.register", "inventory.view", "inventory.viewValue", "reports.view", "map.view", "vehicle.edit"],
  // El auditor ve ambos inventarios (sin editar fichas), corre auditorías y puede
  // escanear / mover por zona (event.register).
  auditor:     ["event.register", "inventory.view", "inventory.viewValue", "reports.view", "map.view",
                "refacciones.view", "audit.run", "audit.schedule"],
  // Contabilidad ve ambos inventarios; edición OPCIONAL (se concede con canEdit).
  contabilidad:["inventory.view", "inventory.viewValue", "reports.view", "map.view", "refacciones.view"],
  // Gerente/Director: SOLO LECTURA en ambos inventarios. Sin Escanear, Mover por
  // zona ni Auditoría, y sin edición.
  gerente:     ["inventory.view", "inventory.viewValue", "reports.view", "map.view", "refacciones.view"],
  // Rol dedicado a refacciones: solo el inventario de partes (ver + editar).
  refacciones: ["refacciones.view", "refacciones.edit"],
  admin:       ["event.register", "inventory.view", "inventory.viewValue", "reports.view", "map.view",
                "vehicle.edit", "vehicle.editVin", "vehicle.delete", "agencies.manage", "users.manage", "data.wipe",
                "audit.run", "audit.override", "audit.schedule", "refacciones.view", "refacciones.edit"],
};

// Roles cuya EDICIÓN es opcional (se activa con el switch canEdit por usuario).
// Al activarse, obtienen permiso de editar fichas de vehículos (como capturista),
// pero NUNCA VIN/agencias/usuarios (eso es exclusivo de admin).
// Solo contabilidad: el gerente/director es siempre de solo lectura.
const OPTIONAL_EDIT_ROLES = ["contabilidad"];

// Permisos del módulo de VEHÍCULOS: sin acceso a vehículos no se concede ninguno.
const VEH_PERMS = ["inventory.view", "inventory.viewValue", "reports.view", "map.view",
  "event.register", "vehicle.edit", "vehicle.editVin", "vehicle.delete",
  "audit.run", "audit.override", "audit.schedule"];

// Acceso a VEHÍCULOS por defecto: todos los roles menos "refacciones".
const VEH_DEFAULT_EXCEPT = ["refacciones"];

// Valor POR DEFECTO del acceso a refacciones según el rol (si el usuario no tiene
// un ajuste explícito accessParts). El Administrador puede activarlo/quitarlo por
// usuario desde la pestaña Usuarios.
const PARTS_DEFAULT = {
  admin: true, auditor: true, contabilidad: true, gerente: true, refacciones: true,
  // El resto, por defecto, SIN refacciones.
};

// ¿Un rol puede, en principio, tener acceso a refacciones? (para mostrar el switch).
export function roleCanHaveParts(role) {
  // Cualquiera puede recibir acceso a refacciones por decisión del admin, salvo
  // el rol "refacciones" (que ya es exclusivo de refacciones).
  return role !== "refacciones";
}
export function roleHasOptionalEdit(role) { return OPTIONAL_EDIT_ROLES.includes(role); }

let _session = null; // { id, username, name, role }

// ---- Hash de contraseña (SHA-256 + salt) ----
function randomSalt() {
  const a = new Uint8Array(16);
  (crypto.getRandomValues ? crypto : window.crypto).getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function hashPassword(password, salt) {
  const data = new TextEncoder().encode(salt + ":" + password);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// ---- Sesión ----
export function currentUser() {
  if (_session) return _session;
  try {
    const raw = localStorage.getItem("inv_session");
    if (raw) _session = JSON.parse(raw);
  } catch (e) {}
  return _session;
}

function fullName(u) {
  return [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username;
}

function setSession(u) {
  _session = u ? { id: u.id, username: u.username, name: fullName(u), role: u.role } : null;
  try {
    if (_session) localStorage.setItem("inv_session", JSON.stringify(_session));
    else localStorage.removeItem("inv_session");
  } catch (e) {}
  if (_session) store.setUser(_session.name);
}

export function logout() {
  const name = _session?.name;
  if (name) logAction("logout", "", name);
  setSession(null);
  // Cierra también la sesión del servidor (best-effort; no bloquea ni importa si falla).
  try { api.logout(); } catch (e) {}
}

// ---- Login MIXTO ----
// Orden de intento:
//   1) Cuenta de EMERGENCIA local (siempre, sin red).
//   2) SERVIDOR (si hay internet y responde): valida contra la API, guarda token
//      y CACHEA las credenciales localmente para permitir login offline futuro.
//   3) LOCAL (si el servidor no responde / offline): valida contra el usuario
//      cacheado en este dispositivo (como hasta ahora).
// Mantiene la firma (username, password) y el retorno { ok, user, error }.
export async function login(username, password) {
  const uname = String(username || "").toLowerCase().trim();

  // 1) Cuenta de emergencia: se valida siempre localmente (nunca contra el servidor).
  if (uname === EMERGENCY_USERNAME) {
    return loginLocal(uname, password);
  }

  // 2) Intento contra el SERVIDOR (si responde).
  try {
    const r = await api.login(username, password);   // guarda token si ok
    if (r && r.ok && r.user) {
      // Fusiona/actualiza el usuario local con lo que dice el servidor y CACHEA
      // la contraseña (hash local) para permitir login offline en este equipo.
      const local = await cacheServerUser(r.user, password);
      setSession(local);
      logAction("login", `Rol: ${local.role} (servidor)`, _session.name);
      return { ok: true, user: _session };
    }
    // El servidor respondió pero sin ok → credenciales inválidas en el servidor.
    return { ok: false, error: (r && r.error) || "Usuario o contraseña incorrectos." };
  } catch (e) {
    // Si el servidor NO respondió (offline/caído) → caer al login local.
    if (e && e.offline) {
      const res = await loginLocal(uname, password);
      if (!res.ok && res._notFound) {
        // El usuario no existe localmente y no hay servidor para validarlo:
        // es el caso "primer login en equipo nuevo sin internet".
        return { ok: false, error: "Sin conexión al servidor y este usuario no ha iniciado sesión antes en este equipo. Conéctate a internet para el primer acceso." };
      }
      return res;
    }
    // Error de la API distinto de 401 (p. ej. 500): lo informamos.
    if (e && e.status === 401) return { ok: false, error: "Usuario o contraseña incorrectos." };
    return { ok: false, error: e && e.message ? e.message : "No se pudo iniciar sesión." };
  }
}

// Valida contra el usuario LOCAL (cacheado). Devuelve { ok, user } o { ok:false, error }.
// _notFound:true cuando el usuario no existe localmente (para distinguir ese caso).
async function loginLocal(uname, password) {
  const u = store.listUsers().find(x => (x.username || "").toLowerCase() === uname);
  if (!u) return { ok: false, error: "Usuario no encontrado.", _notFound: true };
  if (!u.passHash || !u.salt) return { ok: false, error: "El usuario no tiene contraseña configurada en este equipo." };
  const h = await hashPassword(password, u.salt);
  if (h !== u.passHash) return { ok: false, error: "Contraseña incorrecta." };
  setSession(u);
  logAction("login", `Rol: ${u.role} (local)`, _session.name);
  return { ok: true, user: _session };
}

// Toma el usuario que devolvió el servidor y lo guarda/actualiza localmente,
// cacheando la contraseña (hash local SHA-256) para habilitar login offline.
// Devuelve el registro local completo (para setSession).
async function cacheServerUser(serverUser, plainPassword) {
  const salt = randomSalt();
  const passHash = await hashPassword(plainPassword, salt);
  // Datos que el servidor conoce. El shape del server es {id,username,name,role,
  // accessParts?, canEdit?}. Partimos el "name" en nombre/apellido para la vista.
  const [firstName, ...rest] = String(serverUser.name || serverUser.username || "").split(" ");
  const patch = {
    username: serverUser.username,
    role: serverUser.role,
    firstName: firstName || serverUser.username,
    lastName: rest.join(" "),
    salt, passHash,
    source: "server",
    cachedAt: new Date().toISOString(),
  };
  if (serverUser.id != null) patch.serverId = Number(serverUser.id);
  // El servidor manda los ajustes por usuario al iniciar sesión (null = usar el
  // valor por defecto del rol). Se guardan SIEMPRE, incluso null, para que un
  // ajuste que el admin quitó no se quede pegado en este equipo.
  if (typeof serverUser.accessParts === "boolean") patch.accessParts = serverUser.accessParts;
  else if (serverUser.accessParts === null) patch.accessParts = undefined;
  if (typeof serverUser.accessVeh === "boolean") patch.accessVeh = serverUser.accessVeh;
  else if (serverUser.accessVeh === null) patch.accessVeh = undefined;
  if (typeof serverUser.canEdit === "boolean") patch.canEdit = serverUser.canEdit;
  // El servidor YA validó la credencial real, así que el flag de "cambia tu
  // contraseña inicial" (sembrado localmente con el seed jcabrera/1234) ya no
  // aplica para un login de servidor. Si no se limpiara, cada equipo lo pediría
  // en bucle aunque la contraseña ya se haya cambiado en el servidor.
  patch.mustChangePassword = false;

  // Buscar por username (la clave estable entre servidor y local).
  const existing = store.listUsers().find(x => (x.username || "").toLowerCase() === String(serverUser.username).toLowerCase());
  if (existing) {
    store.updateUser(existing.id, patch);
    return store.listUsers().find(x => x.id === existing.id);
  }
  return store.addUser(patch);
}

// Fusiona la lista de usuarios que devuelve el SERVIDOR con los usuarios locales.
// Reglas (ver notas del proyecto):
//   - Casa por `username` (clave estable; el id local es uuid y el del server int).
//   - Merge ADITIVO: no borra locales que no vengan del servidor (protege la cuenta
//     de emergencia y el seed jcabrera que aún no haya subido).
//   - Solo actualiza METADATOS (firstName/lastName/email/role/accessParts/canEdit/serverId).
//     NUNCA toca salt/passHash/mustChangePassword (la credencial local manda para el
//     login offline; las contraseñas del server son bcrypt e incompatibles con el hash local).
//   - Si el usuario del server no existe localmente, se crea SOLO con metadatos (sin
//     credencial local todavía): podrá hacer su primer login contra el servidor, que
//     cacheará la contraseña vía cacheServerUser.
//   - Salta SIEMPRE la cuenta de emergencia.
// Candado anti-revertido: tras un cambio local de usuario (crear/editar/borrar)
// suprimimos el merge del pull unos segundos, para que un pull periódico no pise
// el cambio recién hecho antes de que el servidor lo refleje.
let _userMergeSuppressUntil = 0;
function suppressUserMerge(ms = 4000) { _userMergeSuppressUntil = Date.now() + ms; }

export function mergeServerUsers(list) {
  if (!Array.isArray(list)) return;
  if (Date.now() < _userMergeSuppressUntil) return;   // cambio local reciente: no pisar
  const locals = store.listUsers();
  for (const su of list) {
    const uname = String(su.username || "").toLowerCase();
    if (!uname || uname === EMERGENCY_USERNAME) continue;

    const [firstName, ...rest] = String(su.name || `${su.firstName || ""} ${su.lastName || ""}`.trim() || su.username || "").split(" ");
    const meta = {};
    if (su.role) meta.role = su.role;
    // Nombre/apellido: prioriza campos explícitos del server; si no, parte "name".
    if (su.firstName != null) meta.firstName = String(su.firstName);
    else if (firstName) meta.firstName = firstName;
    if (su.lastName != null) meta.lastName = String(su.lastName);
    else if (rest.length) meta.lastName = rest.join(" ");
    if (su.email != null) meta.email = String(su.email);
    if (typeof su.accessParts === "boolean") meta.accessParts = su.accessParts;
    else if (su.accessParts === null) meta.accessParts = undefined;
    if (typeof su.accessVeh === "boolean") meta.accessVeh = su.accessVeh;
    else if (su.accessVeh === null) meta.accessVeh = undefined;
    if (typeof su.canEdit === "boolean") meta.canEdit = su.canEdit;
    if (su.id != null) meta.serverId = Number(su.id);

    const existing = locals.find(x => (x.username || "").toLowerCase() === uname);
    if (existing) {
      if (existing.source === "emergency") continue;  // no tocar emergencia aunque coincida
      // Update IN-PLACE (no recrear: rompería currentFullUser / la sesión activa).
      store.updateUser(existing.id, meta);
    } else {
      // Nuevo usuario del server sin credencial local todavía.
      store.addUser({
        username: su.username,
        source: "server",
        cachedAt: new Date().toISOString(),
        ...meta,
      });
    }
  }
}

// Resuelve el serverId de un usuario local (por id local). Devuelve number|null.
function serverIdFor(localId) {
  const u = store.listUsers().find(x => x.id === localId);
  return u && u.serverId != null ? Number(u.serverId) : null;
}

// ---- Push de usuarios al servidor (fire-and-forget, silencioso si no hay red) ----
// No bloquean la UI: la operación local ya quedó guardada. Si el servidor no está
// disponible, el cambio simplemente no sube (no hay cola de reintento para usuarios;
// el pull periódico reconcilia metadatos, y la credencial local sigue funcionando).
function pushCreateUser(localId, payload) {
  api.createUser(payload).then(r => {
    if (r && r.id != null) store.updateUser(localId, { serverId: Number(r.id) });
  }).catch(() => {});
}
function pushUpdateUser(serverId, patch) {
  api.updateUser(serverId, patch).catch(() => {});
}
function pushDeleteUser(serverId) {
  api.deleteUser(serverId).catch(() => {});
}

// ---- Permisos ----
// Devuelve el registro COMPLETO del usuario actual (con accessParts/canEdit).
function currentFullUser() {
  const s = currentUser();
  if (!s) return null;
  return store.listUsers().find(x => x.id === s.id) || null;
}

// ¿El usuario tiene acceso a refacciones? Usa el ajuste explícito accessParts si
// existe; si no, el valor por defecto del rol.
export function hasPartsAccess(user) {
  const u = user || currentFullUser();
  if (!u) return false;
  if (u.role === "admin") return true;          // el administrador siempre tiene acceso
  if (typeof u.accessParts === "boolean") return u.accessParts;
  return !!PARTS_DEFAULT[u.role];
}

// ¿El usuario tiene acceso al módulo de VEHÍCULOS? Usa el ajuste explícito
// accessVeh si existe; si no, el valor por defecto del rol (todos menos
// "refacciones"). El administrador siempre tiene acceso.
export function hasVehAccess(user) {
  const u = user || currentFullUser();
  if (!u) return false;
  if (u.role === "admin") return true;
  if (typeof u.accessVeh === "boolean") return u.accessVeh;
  return !VEH_DEFAULT_EXCEPT.includes(u.role);
}

// ¿Un rol puede tener acceso a vehículos? (para mostrar la casilla). El rol
// "refacciones" es exclusivo de refacciones.
export function roleCanHaveVeh(role) { return role !== "refacciones"; }

// ¿Las casillas de acceso a módulos son EDITABLES para este rol? El admin siempre
// tiene ambos módulos y el rol "refacciones" es exclusivo de refacciones: en esos
// casos no hay nada que elegir.
export function roleAccessEditable(role) {
  const locked = role === "admin" || role === "refacciones";
  return { veh: !locked, parts: !locked };
}

// Valor POR DEFECTO de cada módulo según el rol (para preseleccionar las casillas
// en el alta y como referencia de lo que se hereda cuando no hay ajuste).
export function roleDefaultAccess(role) {
  return { veh: !VEH_DEFAULT_EXCEPT.includes(role), parts: !!PARTS_DEFAULT[role] };
}

// ¿El usuario puede editar (para roles de edición opcional)?
export function hasOptionalEdit(user) {
  const u = user || currentFullUser();
  if (!u) return false;
  return roleHasOptionalEdit(u.role) && u.canEdit === true;
}

export function can(permission) {
  const u = currentFullUser() || currentUser();
  if (!u) return false;
  const base = PERMISSIONS[u.role] || [];

  // Refacciones: ver/editar/contar depende del switch accessParts (o el valor por rol).
  if (permission === "refacciones.view" || permission === "refacciones.edit" || permission === "refacciones.count") {
    if (!hasPartsAccess(u)) return false;
    // Si tiene acceso: 'view' siempre; 'edit' según el permiso base del rol
    // (p. ej. admin y rol refacciones editan; auditor/contabilidad solo ven),
    // o si el rol tiene edición opcional activada.
    if (permission === "refacciones.view") return true;
    if (permission === "refacciones.edit") return base.includes("refacciones.edit") || hasOptionalEdit(u);
    // Contar: quien edita refacciones O el auditor. NO depende del acceso a
    // vehículos (un auditor con solo refacciones debe poder contar).
    return base.includes("refacciones.edit") || hasOptionalEdit(u) || base.includes("audit.run");
  }

  // Módulo de VEHÍCULOS: sin acceso a vehículos no se concede ningún permiso suyo.
  if (VEH_PERMS.includes(permission) && !hasVehAccess(u)) return false;

  // Edición de fichas de vehículos: permiso base O edición opcional concedida.
  if (permission === "vehicle.edit") {
    return base.includes("vehicle.edit") || hasOptionalEdit(u);
  }

  return base.includes(permission);
}
export function isAdmin() { return currentUser()?.role === "admin"; }

// ---- Gestión de usuarios ----
export function listUsers() { return store.listUsers(); }

// Crea un usuario con contraseña (hash). data: {firstName,lastName,email,username,role,password}
export async function createUser(data) {
  const username = (data.username || "").trim();
  if (!username) return { ok: false, error: "El nombre de usuario es obligatorio." };
  if (store.listUsers().some(u => (u.username || "").toLowerCase() === username.toLowerCase()))
    return { ok: false, error: "Ya existe ese nombre de usuario." };
  if (!data.password || data.password.length < 4)
    return { ok: false, error: "La contraseña debe tener al menos 4 caracteres." };

  const salt = randomSalt();
  const passHash = await hashPassword(data.password, salt);
  const role = data.role || "operador";
  const user = store.addUser({
    firstName: (data.firstName || "").trim(),
    lastName: (data.lastName || "").trim(),
    email: (data.email || "").trim(),
    username, role,
    // Ajustes por usuario: acceso a refacciones y edición opcional.
    // Si no se indica accessParts, se deja undefined (usa el valor por defecto del rol).
    accessParts: typeof data.accessParts === "boolean" ? data.accessParts : undefined,
    accessVeh: typeof data.accessVeh === "boolean" ? data.accessVeh : undefined,
    canEdit: roleHasOptionalEdit(role) ? !!data.canEdit : undefined,
    salt, passHash,
  });
  suppressUserMerge();   // no dejar que el pull revierta el alta recién hecha
  logAction("user.create", `${username} (${user.role})`, currentUser()?.name || "—");
  // Push al servidor (fire-and-forget): manda la contraseña EN CLARO (el server la
  // re-hashea con bcrypt). Al volver guarda el serverId para futuras ediciones/borrados.
  pushCreateUser(user.id, {
    username: user.username, firstName: user.firstName, lastName: user.lastName,
    email: user.email, role: user.role, password: data.password,
    accessParts: typeof user.accessParts === "boolean" ? user.accessParts : null,
    accessVeh: typeof user.accessVeh === "boolean" ? user.accessVeh : null,
    canEdit: typeof user.canEdit === "boolean" ? user.canEdit : false,
  });
  return { ok: true, user };
}

export function updateUser(id, patch) {
  const r = store.updateUser(id, patch);
  suppressUserMerge();   // no dejar que el pull revierta este cambio
  logAction("user.edit", `Usuario ${r?.username || id}`, currentUser()?.name || "—");
  // Push de metadatos al servidor (nunca la credencial local).
  const sid = serverIdFor(id);
  if (sid != null) {
    const serverPatch = {};
    for (const k of ["firstName", "lastName", "email", "role"]) {
      if (patch[k] !== undefined) serverPatch[k] = patch[k];
    }
    if (patch.accessParts !== undefined) serverPatch.accessParts = patch.accessParts === undefined ? null : patch.accessParts;
    if (patch.accessVeh !== undefined) serverPatch.accessVeh = patch.accessVeh;
    if (patch.canEdit !== undefined) serverPatch.canEdit = patch.canEdit;
    if (Object.keys(serverPatch).length) pushUpdateUser(sid, serverPatch);
  }
  return r;
}
export function removeUser(id) {
  const u = store.listUsers().find(x => x.id === id);
  suppressUserMerge();
  logAction("user.delete", `Usuario ${u?.username || id}`, currentUser()?.name || "—");
  const sid = u && u.serverId != null ? Number(u.serverId) : null;
  if (sid != null) pushDeleteUser(sid);
  return store.removeUser(id);
}

// Restablecer contraseña (admin). Devuelve {ok}.
export async function resetPassword(id, newPassword) {
  if (!newPassword || newPassword.length < 4) return { ok: false, error: "Mínimo 4 caracteres." };
  const salt = randomSalt();
  const passHash = await hashPassword(newPassword, salt);
  store.updateUser(id, { salt, passHash, mustChangePassword: false });
  const u = store.listUsers().find(x => x.id === id);
  logAction("user.password", `Contraseña restablecida para ${u?.username || id}`, currentUser()?.name || "—");
  // Push al servidor: la nueva contraseña en claro (el server re-hashea con bcrypt).
  const sid = u && u.serverId != null ? Number(u.serverId) : null;
  if (sid != null) pushUpdateUser(sid, { password: newPassword });
  return { ok: true };
}

// Asegura que exista el admin inicial jcabrera/1234 si no hay ningún usuario con contraseña,
// y SIEMPRE que exista la cuenta de EMERGENCIA local (en cualquier dispositivo).
export async function ensureSeedAdmin() {
  await ensureEmergencyUser();

  const users = store.listUsers();
  // ¿Hay algún usuario "real" con credenciales (que no sea la cuenta de emergencia)?
  const hasCredentialed = users.some(u => u.username && u.passHash && u.username !== EMERGENCY_USERNAME);
  if (hasCredentialed) return;

  // Migrar: si existe un usuario admin viejo sin credenciales, lo dejamos y creamos jcabrera.
  const salt = randomSalt();
  const passHash = await hashPassword("1234", salt);
  const admin = users.find(u => u.role === "admin" && u.username !== EMERGENCY_USERNAME);
  if (admin) {
    store.updateUser(admin.id, {
      firstName: admin.firstName || "Administrador", lastName: admin.lastName || "",
      email: admin.email || "", username: "jcabrera", salt, passHash, mustChangePassword: true,
    });
  } else {
    store.addUser({ firstName: "Administrador", lastName: "", email: "", username: "jcabrera", role: "admin", salt, passHash, mustChangePassword: true });
  }
}

// Crea la cuenta de EMERGENCIA local si no existe en este dispositivo. Es un admin
// que funciona siempre offline. Obliga a cambiar la contraseña en el primer uso.
async function ensureEmergencyUser() {
  const exists = store.listUsers().some(u => (u.username || "").toLowerCase() === EMERGENCY_USERNAME);
  if (exists) return;
  const salt = randomSalt();
  const passHash = await hashPassword(EMERGENCY_DEFAULT_PASS, salt);
  store.addUser({
    firstName: "Acceso", lastName: "de Emergencia",
    email: "", username: EMERGENCY_USERNAME, role: "admin",
    salt, passHash, mustChangePassword: true, source: "emergency",
  });
}

// ¿El usuario actual debe cambiar su contraseña (p. ej. el admin inicial 1234)?
export function mustChangePassword() {
  const u = currentUser();
  if (!u) return false;
  const full = store.listUsers().find(x => x.id === u.id);
  return !!(full && full.mustChangePassword);
}

// Cambia la contraseña del usuario ACTUAL (requiere la actual) y quita la marca
// de cambio obligatorio. Devuelve {ok, error}.
export async function changeOwnPassword(currentPassword, newPassword) {
  const u = currentUser();
  if (!u) return { ok: false, error: "No hay sesión." };
  const full = store.listUsers().find(x => x.id === u.id);
  if (!full) return { ok: false, error: "Usuario no encontrado." };
  const h = await hashPassword(currentPassword, full.salt);
  if (h !== full.passHash) return { ok: false, error: "La contraseña actual es incorrecta." };
  if (!newPassword || newPassword.length < 4) return { ok: false, error: "La nueva contraseña debe tener al menos 4 caracteres." };
  if (newPassword === currentPassword) return { ok: false, error: "La nueva contraseña debe ser distinta a la actual." };
  const salt = randomSalt();
  const passHash = await hashPassword(newPassword, salt);
  store.updateUser(u.id, { salt, passHash, mustChangePassword: false });
  logAction("user.password", "Cambió su propia contraseña", u.name);
  // Push al servidor: la nueva contraseña en claro (el server re-hashea con bcrypt).
  const sid = serverIdFor(u.id);
  if (sid != null) pushUpdateUser(sid, { password: newPassword });
  return { ok: true };
}
