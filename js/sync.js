// sync.js — Sincronización entre el almacenamiento local (storage.js) y el
// servidor (api.js). Enfoque 1 ("sincronización completa"):
//   - PULL al arrancar (con internet): baja del servidor y fusiona en local
//     por updatedAt (last-write-wins). Luego refresca la UI.
//   - PUSH al registrar: la UI llama a las funciones push*; si hay internet se
//     sube al momento; si no, se ENCOLA y se sube al reconectar.
//   - COLA de pendientes en localStorage (clave propia, separada del modelo).
//
// Diseño defensivo: NADA de esto debe romper el modo local. Si el servidor no
// responde, todo sigue funcionando en local y queda pendiente de subir.

import { store } from "./storage.js";
import * as api from "./api.js";
import { mergeServerUsers } from "./auth.js";

const QUEUE_KEY = "inv_sync_queue_v1";
const LASTSYNC_KEY = "inv_sync_last";

let _refresh = () => {};     // callback para refrescar la UI (refreshAll de app.js)
let _syncing = false;
let _onStatus = () => {};    // callback para avisar del estado (badge)

// --- Cola de pendientes (operaciones que no se pudieron subir) ---
function readQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]"); } catch (e) { return []; }
}
function writeQueue(q) {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch (e) {}
  _onStatus(syncStatus());
}
export function pendingCount() { return readQueue().length; }

// Encola una operación. type: 'vehicle'|'event'|'stage'|'part'|'partConteo'|'agencies'.
// key: identificador para deduplicar (p. ej. vin, numParte); los eventos NO se
// deduplican (cada uno es único por id).
function enqueue(op) {
  const q = readQueue();
  // Deduplicar por (type,key) salvo eventos: para vehicle/part basta la última versión.
  if (op.key && op.type !== "event") {
    const i = q.findIndex(x => x.type === op.type && x.key === op.key);
    if (i >= 0) { q[i] = op; writeQueue(q); return; }
  }
  q.push(op);
  writeQueue(q);
}

// --- Estado de sincronización (para el badge) ---
export function syncStatus() {
  return {
    online: navigator.onLine,
    authed: api.hasToken(),
    pending: readQueue().length,
    syncing: _syncing,
    lastSync: (() => { try { return localStorage.getItem(LASTSYNC_KEY) || ""; } catch (e) { return ""; } })(),
  };
}
export function onSyncStatus(cb) { _onStatus = cb || (() => {}); }

// ===================== PUSH (subir cambios) =====================
// Las funciones push* las llama la UI tras mutar el storage. Intentan subir al
// momento; si el servidor no responde, encolan para después. NO lanzan (nunca
// deben interrumpir el flujo local).

export async function pushVehicle(vin) {
  const v = store.getVehicle(vin);
  if (!v) return;
  await trySend({ type: "vehicle", key: vin, data: v }, () => api.putVehicle(vin, v));
}
export async function pushEvent(ev) {
  await trySend({ type: "event", data: ev }, () => api.postEvent(ev));
}
export async function pushStage(vin, stage) {
  await trySend({ type: "stage", key: vin, data: { vin, stage } }, () => api.setVehicleStage(vin, stage));
}
export async function pushPart(numParte) {
  const p = store.getPart(numParte);
  if (!p) return;
  await trySend({ type: "part", key: numParte, data: p }, () => api.putPart(numParte, p));
}
export async function pushParts(partsArr) {
  // Carga masiva: se intenta en bloque; si falla, se encola como bulk.
  await trySend({ type: "partsBulk", data: partsArr }, () => api.bulkParts(partsArr));
}
export async function pushPartConteo(numParte, conteo) {
  await trySend({ type: "partConteo", key: numParte, data: { numParte, conteo } }, () => api.setPartConteo(numParte, conteo));
}
export async function pushAgencies() {
  const ag = store.listAgencies();
  await trySend({ type: "agencies", key: "all", data: ag }, () => api.saveAgencies(ag));
}

// Intenta ejecutar una llamada; si el servidor está offline, encola la operación.
async function trySend(op, fn) {
  if (!api.hasToken()) { enqueue(op); return; }   // sin sesión de servidor → pendiente
  try {
    await fn();
  } catch (e) {
    if (e && e.offline) { enqueue(op); }           // sin conexión → pendiente
    // Si es error de la API (400/500), NO encolamos en bucle: se descarta y se
    // reintentará en el próximo pull/push manual. (Evita colas envenenadas.)
  }
}

// Ejecuta una operación de la cola según su tipo.
async function runOp(op) {
  switch (op.type) {
    case "vehicle":    return api.putVehicle(op.data.vin, op.data);
    case "event":      return api.postEvent(op.data);
    case "stage":      return api.setVehicleStage(op.data.vin, op.data.stage);
    case "part":       return api.putPart(op.data.numParte, op.data);
    case "partsBulk":  return api.bulkParts(op.data);
    case "partConteo": return api.setPartConteo(op.data.numParte, op.data.conteo);
    case "agencies":   return api.saveAgencies(op.data);
    default: return;
  }
}

// Drena la cola de pendientes (al reconectar). Devuelve cuántas se subieron.
export async function flushQueue() {
  if (!api.hasToken()) return 0;
  let q = readQueue();
  if (!q.length) return 0;
  let done = 0;
  const rest = [];
  for (const op of q) {
    try {
      await runOp(op);
      done++;
    } catch (e) {
      if (e && e.offline) { rest.push(op); }   // sigue sin conexión → conservar
      // error de API → descartar la operación (no reintentar en bucle)
    }
  }
  writeQueue(rest);
  return done;
}

// ===================== PULL (bajar cambios) =====================
// Baja del servidor y fusiona en local por updatedAt (last-write-wins) para
// vehículos y partes; eventos por id (idempotente); agencias por reemplazo.
export async function pullAll() {
  if (!api.hasToken()) return { ok: false, reason: "no-auth" };
  _syncing = true; _onStatus(syncStatus());
  try {
    // Primero drena lo pendiente (para no pisar cambios locales con lo viejo del server).
    await flushQueue();

    const [vehicles, parts, events, agencies, users] = await Promise.all([
      api.listVehicles().catch(() => null),
      api.listParts().catch(() => null),
      api.listEvents().catch(() => null),
      api.listAgencies().catch(() => null),
      api.listUsers().catch(() => null),
    ]);

    if (Array.isArray(vehicles)) mergeVehicles(vehicles);
    if (Array.isArray(parts)) mergeParts(parts);
    // Usuarios: merge ADITIVO solo-metadatos (ver auth.mergeServerUsers). Nunca
    // toca credenciales locales (salt/passHash) ni borra la cuenta de emergencia.
    // El push de altas/bajas/cambios va directo desde auth.js (fire-and-forget),
    // no por la cola; aquí solo reconciliamos la lista bajada del servidor.
    if (Array.isArray(users)) {
      try { mergeServerUsers(users); } catch (e) {}
    }
    // Eventos: por ahora NO se fusionan en el pull (son históricos e inmutables y
    // storage.js no expone una inserción segura sin recalcular el estado del
    // vehículo). Se suben al registrarse (pushEvent). La fusión de históricos se
    // habilitará cuando storage exponga un insertEventRaw. `events` queda leído
    // para futura referencia sin aplicarse.
    void events;
    // Agencias: NO se pisan las locales (tienen GPS afinado). Se omiten en el pull.

    try { localStorage.setItem(LASTSYNC_KEY, new Date().toISOString()); } catch (e) {}
    _syncing = false; _onStatus(syncStatus());
    _refresh();
    return { ok: true };
  } catch (e) {
    _syncing = false; _onStatus(syncStatus());
    return { ok: false, reason: e && e.offline ? "offline" : "error", detail: e && e.message };
  }
}

// Fusión last-write-wins por updatedAt. El servidor gana solo si su updatedAt es
// más reciente que el local (o si la entidad no existe en local).
function mergeVehicles(serverList) {
  for (const sv of serverList) {
    if (!sv || !sv.vin) continue;
    const local = store.getVehicle(sv.vin);
    if (!local || isNewer(sv.updatedAt, local.updatedAt)) {
      store.upsertVehicle(sv);
    }
  }
}
function mergeParts(serverList) {
  for (const sp of serverList) {
    if (!sp || !sp.numParte) continue;
    const local = store.getPart(sp.numParte);
    if (!local || isNewer(sp.updatedAt, local.updatedAt)) {
      store.upsertPart(sp);
    }
  }
}
function isNewer(a, b) {
  if (!a) return false;
  if (!b) return true;
  return String(a) > String(b);  // ISO 8601 compara bien lexicográficamente
}

// ===================== ARRANQUE =====================
// initSync(refreshAll): guarda el callback de refresco y engancha el reintento
// automático al recuperar conexión. Hace un pull inicial si hay sesión de servidor.
export function initSync(refreshCallback) {
  _refresh = refreshCallback || (() => {});

  // Al recuperar internet: drenar la cola y bajar novedades.
  window.addEventListener("online", async () => {
    const n = await flushQueue();
    await pullAll();
    _onStatus(syncStatus());
  });
  window.addEventListener("offline", () => _onStatus(syncStatus()));

  // Pull inicial (en segundo plano, sin bloquear el arranque).
  if (api.hasToken() && navigator.onLine) {
    pullAll();
  }
  _onStatus(syncStatus());
}
