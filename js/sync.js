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
let _onError = () => {};     // callback para avisar un error de sincronización (toast)

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
export function onSyncError(cb) { _onError = cb || (() => {}); }

// ===================== PUSH (subir cambios) =====================
// Las funciones push* las llama la UI tras mutar el storage. Intentan subir al
// momento; si el servidor no responde, encolan para después. NO lanzan (nunca
// deben interrumpir el flujo local).

export async function pushVehicle(vin) {
  const v = store.getVehicle(vin);
  if (!v) return;
  await trySend({ type: "vehicle", key: vin, data: v }, () => api.putVehicle(vin, v));
}
export async function pushDeleteVehicle(vin) {
  await trySend({ type: "vehicleDelete", key: vin, data: { vin } }, () => api.deleteVehicle(vin));
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

// Etiqueta legible de una operación, para los avisos al usuario.
function opLabel(op) {
  switch (op && op.type) {
    case "vehicle":    return "la unidad " + (op.key || "");
    case "vehicleDelete": return "el borrado de la unidad " + (op.key || "");
    case "event":      return "un movimiento";
    case "stage":      return "la etapa de " + (op.key || "");
    case "part":       return "la refacción " + (op.key || "");
    case "partsBulk":  return `la carga de refacciones (${Array.isArray(op.data) ? op.data.length : "?"} partes)`;
    case "partConteo": return "el conteo de " + (op.key || "");
    case "agencies":   return "las agencias";
    default:           return "un cambio";
  }
}

// Intenta ejecutar una llamada; si el servidor está offline, encola la operación.
async function trySend(op, fn) {
  if (!api.hasToken()) { enqueue(op); return; }   // sin sesión de servidor → pendiente
  try {
    await fn();
  } catch (e) {
    if (e && e.offline) { enqueue(op); return; }   // sin conexión → pendiente
    // Error de la API (400/500): NO encolamos en bucle (evita colas envenenadas),
    // pero AVISAMOS al usuario para que no crea que se guardó en el servidor.
    // Incluimos el DETALLE técnico (p. ej. el error SQL del backend) para poder
    // diagnosticar errores 500 sin adivinar.
    const motivo = (e && e.message) ? e.message : "el servidor rechazó la operación";
    const det = (e && e.detail) ? ` [detalle: ${e.detail}]` : "";
    try { _onError(`No se pudo sincronizar ${opLabel(op)} con el servidor: ${motivo}${det}. El cambio quedó guardado solo en este equipo.`); } catch (e2) {}
  }
}

// Ejecuta una operación de la cola según su tipo.
async function runOp(op) {
  switch (op.type) {
    case "vehicle":    return api.putVehicle(op.data.vin, op.data);
    case "vehicleDelete": return api.deleteVehicle(op.data.vin);
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

    if (Array.isArray(vehicles)) {
      const serverVins = mergeVehicles(vehicles);
      // Sube los vehículos locales que faltan en el servidor (p. ej. registrados
      // en modo local antes de tener sesión). Resuelve "este equipo tiene más
      // que el servidor" sin intervención manual.
      pushMissingVehicles(serverVins);
    }
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
  const serverVins = new Set();
  for (const sv of serverList) {
    if (!sv || !sv.vin) continue;
    serverVins.add(sv.vin);
    const local = store.getVehicle(sv.vin);
    if (!local || isNewer(sv.updatedAt, local.updatedAt)) {
      store.upsertVehicle(sv);
    }
  }
  return serverVins;
}

// Reconciliación de SUBIDA: sube al servidor los vehículos LOCALES que NO están
// en el servidor. Cubre el caso de unidades registradas en modo local (sin token)
// que nunca se subieron: al recuperar sesión, el pull las detecta y las empuja.
// No bloquea (cada push es best-effort y encola si falla).
function pushMissingVehicles(serverVins) {
  if (!(serverVins instanceof Set)) return;
  for (const v of store.listVehicles()) {
    if (!v || !v.vin) continue;
    if (!serverVins.has(v.vin)) {
      try { pushVehicle(v.vin); } catch (e) {}
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
// ¿La fecha 'a' (servidor) es MÁS NUEVA que 'b' (local)?
// Normaliza ambos formatos: el servidor MySQL usa "YYYY-MM-DD HH:MM:SS" (con
// ESPACIO) y el local usa ISO "YYYY-MM-DDTHH:MM:SS.sssZ" (con 'T'). Comparar
// como texto daba resultados erróneos (el espacio 0x20 < 'T' 0x54), así que el
// registro del servidor "nunca ganaba" aunque fuera más reciente. Parseamos a
// timestamp y comparamos numéricamente; si no se puede parsear, caemos a texto.
function toTime(v) {
  if (!v) return NaN;
  let s = String(v).trim();
  // MySQL "YYYY-MM-DD HH:MM:SS" → ISO "YYYY-MM-DDTHH:MM:SS" (asumimos misma zona).
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s)) s = s.replace(" ", "T");
  const t = Date.parse(s);
  return Number.isNaN(t) ? NaN : t;
}
function isNewer(a, b) {
  if (!a) return false;
  if (!b) return true;
  const ta = toTime(a), tb = toTime(b);
  if (!Number.isNaN(ta) && !Number.isNaN(tb)) return ta > tb;
  return String(a) > String(b);   // fallback si algún formato no parsea
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
