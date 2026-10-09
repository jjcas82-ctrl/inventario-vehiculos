// alerts.js — Alertas proactivas e indicadores del dashboard.
// Calcula qué unidades necesitan atención: estancadas (muchos días sin movimiento),
// fichas incompletas y registros en contingencia (sin GPS) por revisar.
// Los umbrales de días (amarillo/rojo) los configura el administrador.
import { store } from "./storage.js";

const KEY = "inv_umbral_dias_v1";
const DEFAULTS = { warn: 15, danger: 30 };

export function getThresholds() {
  try {
    const raw = localStorage.getItem(KEY);
    const o = raw ? JSON.parse(raw) : {};
    const warn = Number.isFinite(+o.warn) && +o.warn > 0 ? +o.warn : DEFAULTS.warn;
    const danger = Number.isFinite(+o.danger) && +o.danger > 0 ? +o.danger : DEFAULTS.danger;
    return { warn, danger: Math.max(danger, warn) };
  } catch (e) { return { ...DEFAULTS }; }
}

export function setThresholds({ warn, danger }) {
  const w = Math.max(1, parseInt(warn, 10) || DEFAULTS.warn);
  const d = Math.max(w, parseInt(danger, 10) || DEFAULTS.danger);
  try { localStorage.setItem(KEY, JSON.stringify({ warn: w, danger: d })); } catch (e) {}
  return { warn: w, danger: d };
}

const DAY = 1000 * 60 * 60 * 24;

// Días desde el último evento (movimiento/entrada/salida) de la unidad.
export function daysSinceLastMove(vin) {
  const evs = store.eventsForVin(vin);
  if (!evs.length) return null;
  const last = new Date(evs[evs.length - 1].at);
  return Math.floor((Date.now() - last.getTime()) / DAY);
}

// Nivel de antigüedad de una unidad: "ok" | "warn" | "danger" según umbrales.
export function agingLevel(vin, th = getThresholds()) {
  const d = daysSinceLastMove(vin);
  if (d == null) return { level: "ok", days: null };
  if (d >= th.danger) return { level: "danger", days: d };
  if (d >= th.warn) return { level: "warn", days: d };
  return { level: "ok", days: d };
}

// ¿La ficha está incompleta? (faltan datos clave para vender/operar).
function isIncomplete(v) {
  return !v.model || !v.color;
}

// Calcula todas las alertas actuales. Devuelve conteos y listas para el dashboard.
export function getAlerts() {
  const th = getThresholds();
  const dentro = store.listVehicles().filter(v => v.status === "dentro");

  const estancadas = [];   // >= umbral rojo
  const porVencer = [];    // entre amarillo y rojo
  dentro.forEach(v => {
    const d = daysSinceLastMove(v.vin);
    if (d == null) return;
    if (d >= th.danger) estancadas.push({ vin: v.vin, make: v.make, model: v.model, agency: v.currentAgency, location: v.currentLocation, days: d });
    else if (d >= th.warn) porVencer.push({ vin: v.vin, make: v.make, model: v.model, agency: v.currentAgency, location: v.currentLocation, days: d });
  });
  estancadas.sort((a, b) => b.days - a.days);
  porVencer.sort((a, b) => b.days - a.days);

  const incompletas = dentro.filter(isIncomplete)
    .map(v => ({ vin: v.vin, make: v.make, model: v.model, agency: v.currentAgency, falta: [!v.model ? "modelo" : null, !v.color ? "color" : null].filter(Boolean).join(", ") }));

  // Registros en contingencia (sin GPS) por revisar: unidades cuyo último evento fue sin GPS.
  const sinGps = dentro.filter(v => v.lastSinGps)
    .map(v => ({ vin: v.vin, make: v.make, model: v.model, agency: v.currentAgency }));

  const total = estancadas.length + porVencer.length + incompletas.length + sinGps.length;

  return { th, total, estancadas, porVencer, incompletas, sinGps };
}
