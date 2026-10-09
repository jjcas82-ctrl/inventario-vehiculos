// catalog.js — Catálogos editables para estandarizar la captura y mantener la base
// LIMPIA y SIN ERRORES. El que recibe la unidad elige/autocompleta de estas listas.
// El administrador puede agregar/quitar valores. Si se escribe un valor nuevo, se
// agrega al catálogo para la próxima vez (autoaprendizaje opcional).
//
// Se guardan en localStorage (por dispositivo, como el resto). En la Fase 2 se
// sincronizarán desde el servidor central.

const KEY = "inv_catalogos_v1";

// Catálogos y sus valores por defecto. Las claves se usan en la ficha del vehículo.
const DEFAULTS = {
  color: ["Blanco", "Negro", "Gris", "Plata", "Rojo", "Azul", "Café", "Beige", "Verde", "Amarillo", "Naranja", "Vino", "Dorado"],
  vehType: ["Sedán", "Hatchback", "SUV", "Crossover", "Pickup", "Van", "Minivan", "Coupé", "Convertible", "Camión"],
  // Versión / tren motriz (tipo de motorización)
  powertrain: ["Gasolina", "Diésel", "Híbrido", "Híbrido enchufable (PHEV)", "Eléctrico (EV)", "GLP", "Flex"],
  transmission: ["Manual", "Automática", "CVT", "Automática secuencial", "DCT (doble embrague)"],
};

// Etiquetas legibles para la UI del panel de administración.
export const CATALOG_LABELS = {
  color: "Colores",
  vehType: "Tipos de vehículo (carrocería)",
  powertrain: "Versión / tren motriz",
  transmission: "Transmisión",
};

let _cache = null;

function read() {
  if (_cache) return _cache;
  try {
    const raw = localStorage.getItem(KEY);
    _cache = raw ? JSON.parse(raw) : {};
  } catch (e) { _cache = {}; }
  // Sembrar los catálogos faltantes con sus valores por defecto.
  for (const k of Object.keys(DEFAULTS)) {
    if (!Array.isArray(_cache[k]) || !_cache[k].length) _cache[k] = [...DEFAULTS[k]];
  }
  return _cache;
}

function write(data) {
  _cache = data;
  try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) {}
}

// Devuelve la lista de valores de un catálogo (ordenada alfabéticamente).
export function getCatalog(name) {
  const db = read();
  return (db[name] || []).slice().sort((a, b) => a.localeCompare(b, "es"));
}

// Devuelve todos los nombres de catálogo.
export function catalogNames() { return Object.keys(DEFAULTS); }

// Agrega un valor a un catálogo (si no existe, sin distinción de mayúsculas).
// Devuelve true si lo agregó.
export function addToCatalog(name, value) {
  const v = String(value || "").trim();
  if (!v) return false;
  const db = read();
  db[name] = db[name] || [];
  const existe = db[name].some(x => x.toLowerCase() === v.toLowerCase());
  if (existe) return false;
  db[name].push(v);
  write(db);
  return true;
}

// Quita un valor de un catálogo.
export function removeFromCatalog(name, value) {
  const db = read();
  db[name] = (db[name] || []).filter(x => x.toLowerCase() !== String(value).toLowerCase());
  write(db);
}

// Restaura un catálogo a sus valores por defecto.
export function resetCatalog(name) {
  const db = read();
  db[name] = [...(DEFAULTS[name] || [])];
  write(db);
}

// Si el usuario escribió un valor que no está en el catálogo, lo agrega
// (autoaprendizaje), para que la próxima vez salga en el autocompletado.
export function learnValue(name, value) {
  return addToCatalog(name, value);
}
