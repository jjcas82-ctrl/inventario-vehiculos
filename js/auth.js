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

export const ROLES = {
  admin:       { label: "Administrador",               desc: "Acceso total: VIN, agencias, usuarios, refacciones y auditorías." },
  gerente:     { label: "Gerente / Director",          desc: "Ve todas las pestañas (veh. y refacciones). Edición opcional." },
  auditor:     { label: "Auditor",                     desc: "Ve inventario de unidades y refacciones; realiza auditorías." },
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
  // El auditor ve ambos inventarios (solo lectura) y corre auditorías.
  auditor:     ["inventory.view", "inventory.viewValue", "reports.view", "map.view",
                "refacciones.view", "audit.run", "audit.schedule"],
  // Contabilidad ve ambos inventarios; edición OPCIONAL (se concede con canEdit).
  contabilidad:["inventory.view", "inventory.viewValue", "reports.view", "map.view", "refacciones.view"],
  // Gerente/Director ve TODO; edición OPCIONAL (se concede con canEdit).
  gerente:     ["inventory.view", "inventory.viewValue", "reports.view", "map.view",
                "event.register", "refacciones.view", "audit.run", "audit.schedule"],
  // Rol dedicado a refacciones: solo el inventario de partes (ver + editar).
  refacciones: ["refacciones.view", "refacciones.edit"],
  admin:       ["event.register", "inventory.view", "inventory.viewValue", "reports.view", "map.view",
                "vehicle.edit", "vehicle.editVin", "agencies.manage", "users.manage", "data.wipe",
                "audit.run", "audit.override", "audit.schedule", "refacciones.view", "refacciones.edit"],
};

// Roles cuya EDICIÓN es opcional (se activa con el switch canEdit por usuario).
// Al activarse, obtienen permiso de editar fichas de vehículos (como capturista),
// pero NUNCA VIN/agencias/usuarios (eso es exclusivo de admin).
const OPTIONAL_EDIT_ROLES = ["gerente", "contabilidad"];

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
}

// ---- Login ----
export async function login(username, password) {
  const u = store.listUsers().find(x => (x.username || "").toLowerCase() === String(username).toLowerCase().trim());
  if (!u) return { ok: false, error: "Usuario no encontrado." };
  if (!u.passHash || !u.salt) return { ok: false, error: "El usuario no tiene contraseña configurada." };
  const h = await hashPassword(password, u.salt);
  if (h !== u.passHash) return { ok: false, error: "Contraseña incorrecta." };
  setSession(u);
  logAction("login", `Rol: ${u.role}`, _session.name);
  return { ok: true, user: _session };
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
  if (typeof u.accessParts === "boolean") return u.accessParts;
  return !!PARTS_DEFAULT[u.role];
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

  // Refacciones: ver/editar depende del switch accessParts (o el valor por rol).
  if (permission === "refacciones.view" || permission === "refacciones.edit") {
    if (!hasPartsAccess(u)) return false;
    // Si tiene acceso: 'view' siempre; 'edit' según el permiso base del rol
    // (p. ej. admin y rol refacciones editan; auditor/contabilidad solo ven),
    // o si el rol tiene edición opcional activada.
    if (permission === "refacciones.view") return true;
    return base.includes("refacciones.edit") || hasOptionalEdit(u);
  }

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
    canEdit: roleHasOptionalEdit(role) ? !!data.canEdit : undefined,
    salt, passHash,
  });
  logAction("user.create", `${username} (${user.role})`, currentUser()?.name || "—");
  return { ok: true, user };
}

export function updateUser(id, patch) {
  const r = store.updateUser(id, patch);
  logAction("user.edit", `Usuario ${r?.username || id}`, currentUser()?.name || "—");
  return r;
}
export function removeUser(id) {
  const u = store.listUsers().find(x => x.id === id);
  logAction("user.delete", `Usuario ${u?.username || id}`, currentUser()?.name || "—");
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
  return { ok: true };
}

// Asegura que exista el admin inicial jcabrera/1234 si no hay ningún usuario con contraseña.
export async function ensureSeedAdmin() {
  const users = store.listUsers();
  const hasCredentialed = users.some(u => u.username && u.passHash);
  if (hasCredentialed) return;

  // Migrar: si existe un usuario admin viejo sin credenciales, lo dejamos y creamos jcabrera.
  const salt = randomSalt();
  const passHash = await hashPassword("1234", salt);
  // Reutiliza un registro admin existente si lo hay; si no, crea uno nuevo.
  const admin = users.find(u => u.role === "admin");
  if (admin) {
    store.updateUser(admin.id, {
      firstName: admin.firstName || "Administrador", lastName: admin.lastName || "",
      email: admin.email || "", username: "jcabrera", salt, passHash, mustChangePassword: true,
    });
  } else {
    store.addUser({ firstName: "Administrador", lastName: "", email: "", username: "jcabrera", role: "admin", salt, passHash, mustChangePassword: true });
  }
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
  return { ok: true };
}
