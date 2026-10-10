// syslog.js — Bitácora de auditoría del sistema: registra QUIÉN hizo QUÉ y CUÁNDO.
// Da trazabilidad profesional sobre acciones sensibles (editar unidad, cambiar VIN,
// dar de baja, reabrir, gestión de usuarios, borrar datos, inicio/cierre de sesión).
//
// Se guarda en localStorage (por dispositivo, como el resto). En la Fase 2 se enviará
// a la tabla `bitacora` del servidor para una bitácora central y compartida.

const KEY = "inv_bitacora_v1";
const MAX = 2000; // tope de entradas para no crecer sin límite en el dispositivo

// Catálogo de acciones (para etiquetas e íconos legibles).
export const SYSLOG_ACTIONS = {
  "login":          "🔑 Inicio de sesión",
  "logout":         "🚪 Cierre de sesión",
  "session.expire": "⏱️ Sesión expirada (inactividad)",
  "vehicle.create": "➕ Alta de unidad",
  "vehicle.edit":   "✏️ Edición de ficha",
  "vehicle.vin":    "🔑 Cambio de VIN",
  "vehicle.sold":   "🏷️ Marcada como Vendida",
  "vehicle.deliver":"📤 Entrega / baja de inventario",
  "vehicle.reopen": "🔓 Reapertura de unidad",
  "event.entry":    "🟢 Entrada registrada",
  "event.exit":     "🔴 Salida registrada",
  "event.move":     "🔀 Movimiento interno",
  "user.create":    "👤 Alta de usuario",
  "user.edit":      "👤 Edición de usuario",
  "user.delete":    "🗑️ Baja de usuario",
  "user.password":  "🔒 Cambio de contraseña",
  "data.wipe":      "💥 Borrado total de datos",
  "data.import":    "📥 Importación de respaldo",
};

let _cache = null;

function read() {
  if (_cache) return _cache;
  try {
    const raw = localStorage.getItem(KEY);
    _cache = raw ? JSON.parse(raw) : [];
  } catch (e) { _cache = []; }
  if (!Array.isArray(_cache)) _cache = [];
  return _cache;
}

function write(list) {
  _cache = list;
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) {}
}

function cryptoId() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return "log-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Registra una acción. `action` es una clave de SYSLOG_ACTIONS; `detail` texto libre;
// `by` opcional (si no se pasa, lo resuelve app.js al llamar). `vin` opcional.
export function logAction(action, detail = "", by = "", vin = "") {
  const list = read();
  list.push({
    id: cryptoId(),
    at: new Date().toISOString(),
    action,
    detail: String(detail || ""),
    by: String(by || "—"),
    vin: String(vin || ""),
  });
  // Recortar si excede el tope (conserva las más recientes).
  if (list.length > MAX) list.splice(0, list.length - MAX);
  write(list);
}

// Devuelve la bitácora (más reciente primero), con filtro opcional por texto.
export function listLog({ q = "", action = "" } = {}) {
  const ql = (q || "").toLowerCase().trim();
  return read().slice().reverse().filter(e => {
    if (action && e.action !== action) return false;
    if (ql) {
      const label = SYSLOG_ACTIONS[e.action] || e.action;
      const hay = [e.by, e.vin, e.detail, label].filter(Boolean).some(f => String(f).toLowerCase().includes(ql));
      if (!hay) return false;
    }
    return true;
  });
}

export function clearLog() { write([]); }
