// auth.js — Roles, permisos, usuarios y sesión con login usuario+contraseña (local).
//
// Modelo de usuario:
//   { id, firstName, lastName, email, username, role, passHash, salt, createdAt }
//
// Roles:
//   operador   → solo registrar entradas/salidas/movimientos.
//   capturista → operador + inventario/reportes/mapa + editar ficha (SIN cambiar VIN, SIN borrar).
//   admin      → acceso total (VIN, agencias, usuarios, borrar, auditorías).
//
// Seguridad: sin servidor todavía, la validación es LOCAL. Las contraseñas se
// guardan como HASH SHA-256 + salt (nunca en texto plano). En la Fase 2 el login
// se valida en el servidor.

import { store } from "./storage.js";

export const ROLES = {
  operador:   { label: "Operador",      desc: "Registra entradas, salidas y movimientos." },
  consultor:  { label: "Consultor",     desc: "Solo consulta inventario/mapa y emite reportes (sin editar)." },
  capturista: { label: "Capturista",    desc: "Registra y edita fichas; ve inventario y reportes." },
  admin:      { label: "Administrador", desc: "Acceso total, incluye VIN, agencias y usuarios." },
};

const PERMISSIONS = {
  operador:   ["event.register"],
  consultor:  ["inventory.view", "reports.view", "map.view"],
  capturista: ["event.register", "inventory.view", "reports.view", "map.view", "vehicle.edit"],
  admin:      ["event.register", "inventory.view", "reports.view", "map.view", "vehicle.edit",
               "vehicle.editVin", "agencies.manage", "users.manage", "data.wipe", "audit.run"],
};

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

export function logout() { setSession(null); }

// ---- Login ----
export async function login(username, password) {
  const u = store.listUsers().find(x => (x.username || "").toLowerCase() === String(username).toLowerCase().trim());
  if (!u) return { ok: false, error: "Usuario no encontrado." };
  if (!u.passHash || !u.salt) return { ok: false, error: "El usuario no tiene contraseña configurada." };
  const h = await hashPassword(password, u.salt);
  if (h !== u.passHash) return { ok: false, error: "Contraseña incorrecta." };
  setSession(u);
  return { ok: true, user: _session };
}

// ---- Permisos ----
export function can(permission) {
  const u = currentUser();
  if (!u) return false;
  return (PERMISSIONS[u.role] || []).includes(permission);
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
  const user = store.addUser({
    firstName: (data.firstName || "").trim(),
    lastName: (data.lastName || "").trim(),
    email: (data.email || "").trim(),
    username, role: data.role || "operador",
    salt, passHash,
  });
  return { ok: true, user };
}

export function updateUser(id, patch) { return store.updateUser(id, patch); }
export function removeUser(id) { return store.removeUser(id); }

// Restablecer contraseña (admin). Devuelve {ok}.
export async function resetPassword(id, newPassword) {
  if (!newPassword || newPassword.length < 4) return { ok: false, error: "Mínimo 4 caracteres." };
  const salt = randomSalt();
  const passHash = await hashPassword(newPassword, salt);
  store.updateUser(id, { salt, passHash });
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
      email: admin.email || "", username: "jcabrera", salt, passHash,
    });
  } else {
    store.addUser({ firstName: "Administrador", lastName: "", email: "", username: "jcabrera", role: "admin", salt, passHash });
  }
}
