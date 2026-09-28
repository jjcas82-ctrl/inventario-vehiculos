// auth.js — Roles, permisos, usuarios y sesión (local, offline).
//
// Roles:
//   operador     → solo registrar entradas/salidas/movimientos (pestaña Escanear).
//   capturista   → operador + ver Inventario/Reportes + editar ficha (SIN cambiar VIN, SIN borrar).
//   admin        → todo: cambiar VIN, gestionar agencias, usuarios, borrar datos, auditorías.
//
// Nota de seguridad: sin base de datos central, esto es control de acceso LOCAL
// (por dispositivo). El admin se protege con un PIN. En la Fase 2 se conecta a
// usuarios reales con login validado en el servidor.

import { store } from "./storage.js";

export const ROLES = {
  operador:   { label: "Operador",       desc: "Registra entradas, salidas y movimientos." },
  capturista: { label: "Capturista",     desc: "Registra y edita fichas; ve inventario y reportes." },
  admin:      { label: "Administrador",  desc: "Acceso total, incluye VIN, agencias y usuarios." },
};

// Matriz de permisos por rol.
const PERMISSIONS = {
  operador:   ["event.register"],
  capturista: ["event.register", "inventory.view", "reports.view", "vehicle.edit"],
  admin:      ["event.register", "inventory.view", "reports.view", "vehicle.edit",
               "vehicle.editVin", "agencies.manage", "users.manage", "data.wipe",
               "audit.run", "map.view"],
};
// El capturista también ve el mapa (útil para su trabajo).
PERMISSIONS.capturista.push("map.view");

let _session = null; // { name, role }

// ---- Sesión actual ----
export function currentUser() {
  if (_session) return _session;
  // Reanudar sesión previa del dispositivo
  try {
    const raw = localStorage.getItem("inv_session");
    if (raw) _session = JSON.parse(raw);
  } catch (e) {}
  return _session;
}

export function setSession(user) {
  _session = user ? { name: user.name, role: user.role } : null;
  try {
    if (_session) localStorage.setItem("inv_session", JSON.stringify(_session));
    else localStorage.removeItem("inv_session");
  } catch (e) {}
  if (_session) store.setUser(_session.name); // mantener compat con "quién registra"
}

export function logout() { setSession(null); }

export function can(permission) {
  const u = currentUser();
  if (!u) return false;
  return (PERMISSIONS[u.role] || []).includes(permission);
}

export function isAdmin() { return currentUser()?.role === "admin"; }

// ---- Gestión de usuarios (se guardan en el store para respaldarse) ----
export function listUsers() { return store.listUsers(); }
export function addUser(name, role) { return store.addUser(name, role); }
export function updateUser(id, patch) { return store.updateUser(id, patch); }
export function removeUser(id) { return store.removeUser(id); }

// ---- PIN de administrador ----
export function hasAdminPin() { return !!store.getAdminPin(); }
export function setAdminPin(pin) { store.setAdminPin(pin); }
export function checkAdminPin(pin) { return store.getAdminPin() === String(pin); }
