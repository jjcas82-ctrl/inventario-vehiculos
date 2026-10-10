// models.js — Modelos por marca para el campo "Modelo" de la ficha del vehículo.
//
// Dos fuentes, en este orden de preferencia, fusionadas:
//   1) Catálogo LOCAL offline (data/modelos.json) — carga DIFERIDA (lazy): solo se
//      descarga la primera vez que se necesita, nunca al arrancar la app. Pensado
//      para el mercado mexicano y para funcionar sin internet.
//   2) NHTSA en vivo (GetModelsForMake) — complementa con modelos que el catálogo
//      local no tenga, cuando hay internet.
//
// Todo degrada con gracia: si no hay internet y no hay catálogo local para esa
// marca, el campo Modelo sigue siendo texto libre (como antes). Nunca bloquea ni
// cuelga la captura.
//
// Uso:
//   import { attachModelAutocomplete } from "./models.js";
//   attachModelAutocomplete(modelInputEl, () => makeInputEl.value);

import { attachAutocomplete } from "./autocomplete.js";

const NHTSA_MODELS = "https://vpic.nhtsa.dot.gov/api/vehicles/GetModelsForMake/";
const LOCAL_JSON = "data/modelos.json";

// Caché en memoria para no repetir trabajo durante la sesión.
const _nhtsaCache = new Map();   // claveMarca -> string[]  (resultado NHTSA)
let _localCache = null;          // objeto { marcaNormalizada: string[] } o {} si no hay archivo
let _localPromise = null;        // promesa en vuelo de la carga diferida

// Normaliza una marca para usarla como clave: minúsculas, sin acentos, sin espacios extra.
function normKey(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // quita acentos
    .replace(/\s+/g, " ");
}

// Carga DIFERIDA del catálogo local. Se llama solo bajo demanda (al enfocar el
// campo Modelo). Si el archivo no existe aún, cachea {} y no vuelve a intentarlo.
function loadLocal() {
  if (_localCache !== null) return Promise.resolve(_localCache);
  if (_localPromise) return _localPromise;
  _localPromise = fetch(LOCAL_JSON, { cache: "force-cache" })
    .then((r) => (r.ok ? r.json() : {}))
    .then((obj) => {
      // Reindexamos por clave normalizada para búsquedas tolerantes a mayúsculas/acentos.
      const idx = {};
      for (const [make, models] of Object.entries(obj || {})) {
        if (make.startsWith("_")) continue; // claves de comentario/metadatos
        if (Array.isArray(models)) idx[normKey(make)] = models.map(String);
      }
      _localCache = idx;
      return _localCache;
    })
    .catch(() => {
      _localCache = {}; // sin archivo o error: tratamos como vacío, sin reintentar
      return _localCache;
    });
  return _localPromise;
}

// Consulta a NHTSA los modelos de una marca. Devuelve [] si no hay internet o falla.
async function fetchNhtsaModels(make, timeoutMs = 8000) {
  if (!navigator.onLine) return [];
  const key = normKey(make);
  if (_nhtsaCache.has(key)) return _nhtsaCache.get(key);

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const url = NHTSA_MODELS + encodeURIComponent(make) + "?format=json";
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return [];
    const json = await res.json();
    const rows = (json && json.Results) || [];
    const models = rows
      .map((r) => (r && r.Model_Name ? String(r.Model_Name).trim() : ""))
      .filter(Boolean);
    _nhtsaCache.set(key, models);
    return models;
  } catch {
    clearTimeout(t);
    return []; // AbortError (timeout) u otro: degradamos a vacío
  }
}

// API pública: devuelve la lista de modelos (local + NHTSA fusionados, ordenados y
// sin duplicados) para una marca. Nunca lanza; en el peor caso devuelve [].
export async function getModelsForMake(make) {
  const name = String(make || "").trim();
  if (!name) return [];

  const [local, remote] = await Promise.all([
    loadLocal().then((idx) => idx[normKey(name)] || []),
    fetchNhtsaModels(name),
  ]);

  // Fusión sin duplicados (comparación tolerante), preservando el nombre "más bonito"
  // (el primero que aparezca). Local va primero por ser el catálogo curado.
  const seen = new Map(); // claveModelo -> nombreMostrado
  for (const m of [...local, ...remote]) {
    const k = normKey(m);
    if (k && !seen.has(k)) seen.set(k, m);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, "es"));
}

// Engancha el autocompletar al campo Modelo.
//   getMakeValue : función que devuelve el valor ACTUAL de la marca (reacciona si cambia).
//   getExtra     : (opcional) función que devuelve modelos extra a fusionar, p. ej. los
//                  aprendidos en el catálogo local del usuario getCatalog("model").
//
// Estrategia de rendimiento: no pedimos nada hasta que el usuario interactúa con el
// campo Modelo. Al cambiar de marca, invalidamos la lista mostrada para esa marca.
export function attachModelAutocomplete(modelInput, getMakeValue, getExtra = null) {
  if (!modelInput || modelInput.__modelAcAttached) return;
  modelInput.__modelAcAttached = true;

  let currentMakeKey = null;
  let currentModels = [];
  let loadingFor = null;

  // Fusiona la lista de la marca (local+NHTSA) con los modelos extra (catálogo aprendido),
  // sin duplicados y ordenados. Los extra se muestran aunque no haya marca reconocida.
  const merged = () => {
    const extra = (typeof getExtra === "function" ? getExtra() : []) || [];
    const seen = new Map();
    for (const m of [...currentModels, ...extra.map(String)]) {
      const k = normKey(m);
      if (k && !seen.has(k)) seen.set(k, m);
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b, "es"));
  };

  const ensureLoaded = () => {
    const make = (getMakeValue() || "").trim();
    const key = normKey(make);
    if (!make) { currentMakeKey = null; currentModels = []; return; }
    if (key === currentMakeKey) return;        // ya tenemos (o estamos cargando) esta marca
    if (key === loadingFor) return;            // carga en vuelo
    loadingFor = key;
    getModelsForMake(make).then((models) => {
      // Solo aplicamos si la marca no cambió mientras cargábamos.
      if (normKey((getMakeValue() || "").trim()) === key) {
        currentMakeKey = key;
        currentModels = models;
        loadingFor = null;
        // Re-dispara el autocompletar para que muestre la lista recién cargada
        // si el input tiene foco en este momento.
        if (document.activeElement === modelInput) {
          modelInput.dispatchEvent(new Event("input", { bubbles: true }));
        }
      } else {
        loadingFor = null;
      }
    });
  };

  // Dispara la carga al enfocar el campo Modelo (momento en que de verdad se necesita).
  modelInput.addEventListener("focus", ensureLoaded);
  modelInput.addEventListener("input", ensureLoaded);

  // El autocompletar lee SIEMPRE la lista vigente para la marca actual. Si aún no
  // cargó o la marca no se reconoce, devuelve [] y el campo queda como texto libre.
  attachAutocomplete(modelInput, merged);
}
