// api.js — Capa de conexión con el servidor (backend PHP en el Synology).
//
// Es un módulo AISLADO: no toca storage.js ni auth.js. Solo sabe hablar HTTP con
// la API y manejar el token de sesión. El resto de la app lo usará a través de
// la capa de sincronización (sync.js), que se añade en un paso posterior.
//
// Diseño pensado para una PWA con modo offline:
//   - Si no hay internet o el servidor no responde, los métodos lanzan un error
//     de tipo "offline" para que quien llame decida usar el modo local.
//   - El token de sesión se guarda en localStorage para recordar al usuario.

// URL base de la API. Fija en el código (decisión del proyecto: nadie configura
// nada). Puede sobreescribirse en localStorage ("inv_api_base") por si algún día
// cambia el dominio, sin tener que recompilar.
const DEFAULT_API_BASE = "https://backup-aero.synology.me/api/";
const API_BASE_KEY = "inv_api_base";
const TOKEN_KEY = "inv_api_token";

// Tiempo máximo de espera por respuesta del servidor (ms). Si se excede, se trata
// como "sin conexión" para no colgar la app.
const TIMEOUT_MS = 8000;

export function apiBase() {
  try { return localStorage.getItem(API_BASE_KEY) || DEFAULT_API_BASE; }
  catch (e) { return DEFAULT_API_BASE; }
}
export function setApiBase(url) {
  try {
    if (url) localStorage.setItem(API_BASE_KEY, url);
    else localStorage.removeItem(API_BASE_KEY);
  } catch (e) {}
}

// --- Token de sesión ---
export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch (e) { return ""; }
}
export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch (e) {}
}
export function hasToken() { return !!getToken(); }

// Error tipado: distingue "sin conexión / servidor caído" de "error de la API".
export class ApiError extends Error {
  constructor(message, { offline = false, status = 0, detail = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.offline = offline;   // true → no se pudo contactar al servidor
    this.status = status;     // código HTTP (0 si no hubo respuesta)
    this.detail = detail;
  }
}

// Construye la URL de una ruta: apiBase + "?r=<ruta>".
function routeUrl(route) {
  const base = apiBase();
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}r=${encodeURIComponent(route)}`;
}

// Llamada genérica a la API. Devuelve el JSON ya parseado (objeto).
// Lanza ApiError{offline:true} si el servidor no responde (para caer a local).
export async function apiFetch(route, { method = "GET", body = null, auth = true } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (auth && hasToken()) headers["Authorization"] = "Bearer " + getToken();

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  let res;
  try {
    res = await fetch(routeUrl(route), {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
      // No mandamos cookies; la sesión va por token en el header.
      credentials: "omit",
      mode: "cors",
    });
  } catch (e) {
    // fetch falla por red caída, CORS, timeout (abort), DNS, etc. → offline.
    throw new ApiError("No se pudo contactar al servidor.", { offline: true, detail: String(e && e.message || e) });
  } finally {
    clearTimeout(timer);
  }

  // Intentar parsear JSON siempre (la API responde JSON incluso en errores).
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }

  if (!res.ok) {
    const msg = (data && data.error) ? data.error : `Error del servidor (${res.status}).`;
    // 401 → token inválido/expirado: lo limpiamos para forzar re-login.
    if (res.status === 401) setToken("");
    throw new ApiError(msg, { status: res.status, detail: data && data.detail });
  }
  return data || {};
}

// --- Salud del servidor ---
// ping(): true si el servidor responde; false si está offline. No lanza.
export async function ping() {
  try {
    const r = await apiFetch("ping", { auth: false });
    return !!(r && r.ok);
  } catch (e) {
    return false;
  }
}

// --- Autenticación ---
// login(usuario, contraseña): guarda el token y devuelve { ok, user } o lanza ApiError.
export async function login(username, password) {
  const r = await apiFetch("login", { method: "POST", auth: false, body: { username, password } });
  if (r && r.token) setToken(r.token);
  return r; // { ok:true, token, user:{id,username,name,role} }
}
export async function logout() {
  try { await apiFetch("logout", { method: "POST" }); } catch (e) { /* da igual si falla */ }
  setToken("");
}
// me(): datos del usuario de la sesión actual (valida el token contra el servidor).
export async function me() {
  return apiFetch("me");
}

// --- Recursos (lectura/escritura). Se usarán desde la capa de sincronización. ---

// Vehículos
export async function listVehicles() { return (await apiFetch("vehicles")).vehicles || []; }
export async function putVehicle(vin, data) { return apiFetch(`vehicles/${encodeURIComponent(vin)}`, { method: "PUT", body: data }); }
export async function setVehicleStage(vin, stage) { return apiFetch(`vehicles/${encodeURIComponent(vin)}/stage`, { method: "POST", body: { stage } }); }

// Eventos
export async function listEvents(vin) { return (await apiFetch("events" + (vin ? `?vin=${encodeURIComponent(vin)}` : ""))).events || []; }
export async function postEvent(ev) { return apiFetch("events", { method: "POST", body: ev }); }

// Agencias
export async function listAgencies() { return (await apiFetch("agencies")).agencies || []; }
export async function saveAgencies(agencies) { return apiFetch("agencies", { method: "PUT", body: { agencies } }); }

// Usuarios
export async function listUsers() { return (await apiFetch("users")).users || []; }

// Auditorías
export async function listAudits() { return (await apiFetch("audits")).audits || []; }

// Refacciones (parts)
export async function listParts() { return (await apiFetch("parts")).parts || []; }
export async function putPart(numParte, data) { return apiFetch(`parts/${encodeURIComponent(numParte)}`, { method: "PUT", body: data }); }
export async function bulkParts(parts) { return apiFetch("parts/bulk", { method: "POST", body: { parts } }); }
export async function setPartConteo(numParte, conteo) { return apiFetch(`parts/${encodeURIComponent(numParte)}/conteo`, { method: "POST", body: { conteo } }); }
