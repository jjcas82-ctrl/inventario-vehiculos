// storage.js — Persistencia local (localStorage) con una pequeña capa de acceso.
// Modelo de datos:
//   vehicles: { [vin]: { vin, make, country, year, model, color, condition,
//                        plate, notes, currentAgency, currentArea, currentLocation,
//                        status, entryAt, entryBy, ... } }
//   events:   [ { id, vin, type: 'entry'|'exit'|'move', agency, area, location,
//                 condition, by, lat, lng, accuracy, at } ]
//   agencies: [ { id, name, lat, lng, areas: [{ name, subs: [string] }] } ]
//
// Las ubicaciones internas son JERÁRQUICAS: cada agencia tiene "áreas"
// (categorías) y cada área tiene sububicaciones.

const KEY = "inv_vehiculos_v1";
const USER_KEY = "inv_usuario_actual";

// Estructura jerárquica por defecto de la Agencia Aeropuerto.
const DEFAULT_AREAS = [
  { name: "Sala de Exhibición", subs: ["Ventas Chevrolet", "Ventas Buick"] },
  { name: "Servicio",           subs: ["Taller", "Preparación", "Lavado"] },
  { name: "Estacionamiento",    subs: ["Piso 1", "Piso 2", "Piso 3"] },
  { name: "Área de Entrega",    subs: [] },
];

// Estructura de la Agencia Aeroplasa Auto (ubicaciones DENTRO del sitio).
// La Bodega y los Puntos de venta son SITIOS APARTE (con su propio GPS), no áreas internas.
const AEROPLASA_AUTO_AREAS = [
  { name: "Sala de Exhibición de Ventas", subs: [] },
  { name: "Servicio",                     subs: ["Taller", "Preparación", "Lavado"] },
  { name: "Patio",                        subs: [] },
  { name: "Estacionamiento Seminuevos",   subs: [] },
  { name: "Área de Entregas",             subs: [] },
];

// Los puntos de venta son sitios remotos (con GPS propio) → áreas simples.
const PUNTO_VENTA_AREAS = [
  { name: "Exhibición", subs: [] },
  { name: "Entrega",    subs: [] },
];

// Taller de Hojalatería y Pintura (HyP): áreas propias de un taller de carrocería.
const HYP_AREAS = [
  { name: "Recepción",    subs: [] },
  { name: "Hojalatería",  subs: [] },
  { name: "Pintura",      subs: [] },
  { name: "Entrega",      subs: [] },
];

// Sitios que se precargan con sus direcciones y coordenadas reales.
const SEED_SITES = [
  {
    name: "Aeroplasa Aeropuerto",
    address: "Blvd. Puerto Aéreo 141, Col. Federal, Venustiano Carranza, 15700 Ciudad de México, CDMX",
    lat: 19.425222, lng: -99.093219, radius: 200, areas: DEFAULT_AREAS,
  },
  {
    // Aeroplasa Automotriz (Buick/GMC). Comparte SITIO físico con Aeroplasa
    // Aeropuerto (mismas coordenadas); mismas áreas. Sus refacciones solo están
    // en puntos de venta / exhibidores dentro de la agencia.
    name: "Aeroplasa Automotriz",
    address: "Blvd. Puerto Aéreo 141, Col. Federal, Venustiano Carranza, 15700 Ciudad de México, CDMX",
    lat: 19.425222, lng: -99.093219, radius: 200, areas: DEFAULT_AREAS,
  },
  {
    name: "Aeroplasa Auto",
    address: "Carretera Federal México-Tuxpan Km 190 S/N, Col. El Potro, C.P. 73176, Huauchinango, Puebla",
    lat: 20.173122, lng: -98.070828, radius: 200, areas: AEROPLASA_AUTO_AREAS,
  },
  {
    // Bodega como SITIO independiente (cambio de ubicación).
    name: "Bodega Aeroplasa Auto",
    address: "Calle Rafael Cravioto #146, Santa Cruz, C.P. 73175, Huauchinango, Puebla",
    lat: 20.169589, lng: -98.068696, radius: 150, areas: [
      { name: "Recepción", subs: [] }, { name: "Almacén", subs: [] },
    ],
  },
  {
    name: "Punto de Venta Zacatlán",
    address: "5 de Mayo LB, Cabañas del Mirador, 73310 Zacatlán, Pue.",
    lat: 19.930012, lng: -97.959983, radius: 150, areas: PUNTO_VENTA_AREAS,
  },
  {
    name: "Punto de Venta Chignahuapan",
    address: "Vicente Guerrero 31, Centro, 73300 Chignahuapan, Pue.",
    lat: 19.840180, lng: -98.031988, radius: 150, areas: PUNTO_VENTA_AREAS,
  },

  // --- Aeroplasa Aeropuerto (CDMX) ---
  {
    // Taller de Hojalatería y Pintura (HyP).
    name: "Dirección de HyP",
    address: "C. Uno 387, Cuchilla Pantitlán, Venustiano Carranza, 15610 Ciudad de México, CDMX",
    lat: 19.422836, lng: -99.067075, radius: 80, areas: HYP_AREAS,
  },
  {
    name: "Punto de Venta Calzada del Hueso",
    address: "Calz. del Hueso 689, Segunda Sección, Tlalpan, 14325 Ciudad de México, CDMX",
    lat: 19.301453, lng: -99.117438, radius: 80, areas: PUNTO_VENTA_AREAS,
  },
  {
    name: "Punto de Venta Miramontes",
    address: "Canal de Miramontes 3164, Coapa, Acoxpa, Tlalpan, 14300 Ciudad de México, CDMX",
    lat: 19.300289, lng: -99.124641, radius: 80, areas: PUNTO_VENTA_AREAS,
  },
  {
    // Bodega (solo almacenaje).
    name: "Bodega WALMART",
    address: "Calz. Ignacio Zaragoza 58, Industrial Puerto Aéreo, Venustiano Carranza, 15700 Ciudad de México, CDMX",
    lat: 19.419611, lng: -99.093835, radius: 80, areas: [
      { name: "Almacén", subs: [] },
    ],
  },
];

function cloneAreas(list) {
  return list.map(a => ({ name: a.name, subs: [...a.subs] }));
}
function defaultAreas() { return cloneAreas(DEFAULT_AREAS); }

// --- REFACCIONES: agencias de inventario ---
// Las 3 agencias reales entre las que se separa TODO el inventario de refacciones.
// El mismo nº de parte puede existir en varias con existencias distintas: NUNCA
// se mezclan. Promovida aquí (antes vivía solo en refaccionesui.js) para que el
// store sea la única fuente de verdad.
export const AGENCIAS_REF = ["Aeroplasa Auto", "Aeroplasa Aeropuerto", "Aeroplasa Automotriz"];

// Cajón especial donde queda el inventario/historial de refacciones que existía
// ANTES del rediseño por agencia (no sabíamos a qué agencia pertenecía). No se
// pierde: queda consultable y se puede reasignar a una agencia real después.
export const ARCHIVO_PREVIO = "__archivo_previo__";
export const ARCHIVO_PREVIO_LABEL = "📦 Archivo anterior (sin agencia)";

// ¿Es `agency` una agencia de refacciones válida (o el archivo previo)?
function isAgencyRef(agency) {
  return agency === ARCHIVO_PREVIO || AGENCIAS_REF.includes(agency);
}
// Normaliza la agencia recibida por los métodos de refacciones. Si no viene o no
// es válida, cae a la primera agencia real (evita escribir en claves basura).
function partsAgency(agency) {
  return isAgencyRef(agency) ? agency : AGENCIAS_REF[0];
}
// Devuelve (creándolo si hace falta) el sub-diccionario de partes de una agencia.
// Función libre (no depende de `this`) para que funcione aunque los métodos del
// store se desestructuren.
function partsBucket(db, agency) {
  const a = partsAgency(agency);
  if (!db.parts || typeof db.parts !== "object") db.parts = {};
  if (!db.parts[a] || typeof db.parts[a] !== "object") db.parts[a] = {};
  return db.parts[a];
}

function seed() {
  return {
    vehicles: {},
    events: [],
    agencies: SEED_SITES.map(s => ({
      id: cryptoId(), name: s.name, address: s.address,
      lat: s.lat, lng: s.lng, radius: s.radius, areas: cloneAreas(s.areas),
    })),
    users: [],   // el admin inicial (jcabrera) lo crea auth.ensureSeedAdmin()
    audits: [],
    openAudits: {},  // auditorías en curso por agencia (congelar/retomar)
    scheduledAudits: [], // agenda de auditorías programadas
    // REFACCIONES separadas POR AGENCIA:
    //   parts:             { [agency]: { [numParte]: {parte} } }
    //   partsAudit:        { [agency]: {sesión} | null }
    //   partsAuditHistory: [ { ..., agency } ]  (plano, con etiqueta de agencia)
    parts: {},
    partsAudit: {},
    partsAuditHistory: [],
  };
}

// Migra agencias antiguas (locations planas) al modelo jerárquico (areas).
function migrateAgency(a) {
  if (a.areas) return a;
  if (Array.isArray(a.locations) && a.locations.length) {
    a.areas = [{ name: "Ubicaciones", subs: [...a.locations] }];
  } else {
    a.areas = defaultAreas();
  }
  return a;
}

// Migra el inventario de REFACCIONES al modelo separado por agencia.
//  - Formato VIEJO (global): parts = { [numParte]: {} }, partsAudit = {sesión}|null,
//    partsAuditHistory = [ {} ].  Todo lo global se mueve al "archivo anterior".
//  - Formato NUEVO: parts = { [agency]: { [numParte]: {} } }, partsAudit = { [agency]: {} },
//    partsAuditHistory = [ {..., agency} ].
// La detección es defensiva: si `parts` tiene como valores objetos-parte (traen
// numParte) en vez de sub-diccionarios por agencia, es el formato viejo.
function migratePartsByAgency(db) {
  // ---- parts ----
  if (!db.parts || typeof db.parts !== "object") db.parts = {};
  const keys = Object.keys(db.parts);
  // ¿Formato viejo? Alguna clave de primer nivel NO es una agencia conocida y su
  // valor parece una PARTE (tiene numParte) en vez de un sub-diccionario.
  const looksFlat = keys.some(k => {
    if (isAgencyRef(k)) return false;
    const v = db.parts[k];
    return v && typeof v === "object" && ("numParte" in v);
  });
  if (looksFlat) {
    const prev = db.parts;
    db.parts = {};
    db.parts[ARCHIVO_PREVIO] = prev;   // todo lo global → archivo anterior
  }
  // Asegurar un sub-diccionario por cada agencia real (+ archivo previo si existe).
  for (const a of AGENCIAS_REF) {
    if (!db.parts[a] || typeof db.parts[a] !== "object") db.parts[a] = {};
  }

  // ---- partsAudit ----
  // Viejo: null u objeto de sesión plano (tiene rondas/rondaActual/by/…).
  // Nuevo: { [agency]: {sesión} }.
  if (!db.partsAudit || typeof db.partsAudit !== "object") {
    db.partsAudit = {};
  } else {
    const ak = Object.keys(db.partsAudit);
    const auditFlat = ak.length > 0 && ak.every(k => !isAgencyRef(k));
    if (auditFlat) {
      // Era una sesión plana → pasa al archivo anterior.
      const prevAudit = db.partsAudit;
      db.partsAudit = {};
      db.partsAudit[ARCHIVO_PREVIO] = prevAudit;
    }
  }

  // ---- partsAuditHistory ----
  // Se mantiene como array plano, pero cada entrada lleva `agency`. Las que no la
  // tengan (historial viejo) se marcan como ARCHIVO_PREVIO.
  if (!Array.isArray(db.partsAuditHistory)) db.partsAuditHistory = [];
  db.partsAuditHistory.forEach(h => {
    if (h && !h.agency) h.agency = ARCHIVO_PREVIO;
  });
}

export function cryptoId() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return "id-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

let _cache = null;

function read() {
  if (_cache) return _cache;
  try {
    const raw = localStorage.getItem(KEY);
    _cache = raw ? JSON.parse(raw) : seed();
  } catch (e) {
    _cache = seed();
  }
  // Migración defensiva
  _cache.vehicles = _cache.vehicles || {};
  _cache.events = _cache.events || [];
  _cache.agencies = (_cache.agencies || seed().agencies).map(migrateAgency);
  if (!Array.isArray(_cache.users)) _cache.users = [];
  if (!Array.isArray(_cache.audits)) _cache.audits = [];
  if (!_cache.openAudits || typeof _cache.openAudits !== "object") _cache.openAudits = {};
  if (!Array.isArray(_cache.scheduledAudits)) _cache.scheduledAudits = [];
  migratePartsByAgency(_cache);

  // Precarga/actualización de sitios con sus direcciones y coordenadas reales.
  // Matching por nombre EXACTO (sin heurística ambigua, para no confundir
  // "Bodega Aeroplasa Auto" con "Agencia Aeroplasa Auto").
  SEED_SITES.forEach(site => {
    let a = _cache.agencies.find(x => x.name.toLowerCase() === site.name.toLowerCase());
    // Caso especial: instalaciones antiguas donde la agencia se llamaba distinto.
    // "Agencia Aeroplasa Auto" / "Aeroplasa Auto" -> ahora "Aeroplasa Auto".
    if (!a && site.name === "Aeroplasa Auto") {
      a = _cache.agencies.find(x => /^(agencia\s+)?aeroplasa auto$/i.test(x.name));
    }
    // "Agencia Aeropuerto" / "Aeroplasa Aeropuerto" -> ahora "Aeroplasa Aeropuerto".
    // Nota: NO debe capturar "Aeroplasa Auto"; por eso exige la palabra "aeropuerto".
    if (!a && site.name === "Aeroplasa Aeropuerto") {
      a = _cache.agencies.find(x => /aeropuerto/i.test(x.name));
    }
    if (!a) {
      // Sitio nuevo (ej. Bodega, puntos de venta): crearlo.
      _cache.agencies.push({
        id: cryptoId(), name: site.name, address: site.address,
        lat: site.lat, lng: site.lng, radius: site.radius, areas: cloneAreas(site.areas),
      });
    } else {
      const oldName = a.name;
      a.name = site.name;
      // Si la agencia se renombró, propagar el nuevo nombre a los vehículos y
      // eventos que apuntaban al nombre viejo (para no dejar registros huérfanos).
      if (oldName && oldName !== site.name) {
        Object.values(_cache.vehicles).forEach(v => {
          if (v.currentAgency === oldName) v.currentAgency = site.name;
        });
        _cache.events.forEach(e => { if (e.agency === oldName) e.agency = site.name; });
      }
      if (!a.address && site.address) a.address = site.address;
      if ((a.lat == null || a.lng == null) && site.lat != null) { a.lat = site.lat; a.lng = site.lng; }
      if (!a.radius) a.radius = site.radius;
      // Actualizar la estructura interna de Aeroplasa Auto a la versión vigente
      // si todavía tiene áreas antiguas ("Bodega"/"Puntos de venta" como área interna).
      if (site.name === "Aeroplasa Auto" && a.areas &&
          a.areas.some(ar => ["Bodega", "Puntos de venta", "Sala de Exhibición", "Área de Entrega"].includes(ar.name))) {
        a.areas = cloneAreas(AEROPLASA_AUTO_AREAS);
      }
    }
  });
  return _cache;
}

function write(db) {
  _cache = db;
  localStorage.setItem(KEY, JSON.stringify(db));
}

export const store = {
  get all() { return read(); },

  // ---- Vehículos ----
  getVehicle(vin) { return read().vehicles[vin] || null; },
  listVehicles() { return Object.values(read().vehicles); },
  upsertVehicle(v) {
    const db = read();
    const now = new Date().toISOString();
    const prev = db.vehicles[v.vin];
    db.vehicles[v.vin] = {
      ...prev,
      ...v,
      createdAt: prev?.createdAt || now,
      // Conserva el updatedAt que traiga el objeto (p. ej. el del SERVIDOR al
      // sincronizar). Antes siempre se ponía `now`, lo que corrompía la fusión
      // last-write-wins (el registro local quedaba "más nuevo" que el servidor y
      // el servidor ya nunca ganaba el merge). Solo usamos `now` si no viene.
      updatedAt: v.updatedAt || now,
    };
    write(db);
    return db.vehicles[v.vin];
  },

  // Alta/actualización MASIVA en una sola escritura (para cargar flotillas del CDO).
  // `vehiclesArr`: array de objetos con al menos { vin, ... }.
  // Opciones: { skipExisting:true } omite los VIN que ya existan (no los pisa).
  // Devuelve { added:[vin], skipped:[vin] }.
  bulkUpsertVehicles(vehiclesArr, { skipExisting = true } = {}) {
    const db = read();
    const now = new Date().toISOString();
    const added = [], skipped = [];
    for (const v of (vehiclesArr || [])) {
      if (!v || !v.vin) continue;
      const prev = db.vehicles[v.vin];
      if (prev && skipExisting) { skipped.push(v.vin); continue; }
      db.vehicles[v.vin] = {
        ...prev, ...v,
        createdAt: prev?.createdAt || now,
        updatedAt: now,
      };
      added.push(v.vin);
    }
    write(db); // una sola escritura para todo el lote
    return { added, skipped };
  },

  // ---- Usuario actual (quién registra) ----
  getUser() { try { return localStorage.getItem(USER_KEY) || ""; } catch (e) { return ""; } },
  setUser(name) { try { localStorage.setItem(USER_KEY, name || ""); } catch (e) {} },

  // ---- Eventos ----
  listEvents() { return read().events; },
  addEvent(ev) {
    const db = read();
    const by = ev.by || store.getUser() || "—";
    const rec = { id: cryptoId(), at: new Date().toISOString(), by, ...ev };
    rec.by = by; // asegurar que 'by' quede aunque ev no lo trajera
    db.events.push(rec);
    // Actualiza estado del vehículo según el evento
    const v = db.vehicles[ev.vin] || { vin: ev.vin };
    const wasTransito = v.status === "transito"; // estatus ANTES de este evento
    if (ev.type === "entry" || ev.type === "move") {
      v.currentAgency = ev.agency;
      v.currentArea = ev.area || "";
      v.currentLocation = ev.location;
      v.status = "dentro";
      if (ev.type === "entry") {
        // Fecha de ingreso y usuario del ingreso actual
        v.entryAt = rec.at;
        v.entryBy = by;
        // FEATURE 3: al ARRIBAR una unidad que venía "en tránsito" (o que trae
        // fecha de facturación del CDO), persistimos los días de tránsito y la
        // fecha de arribo. Es solo una conveniencia: la ficha y los reportes
        // también lo calculan on-the-fly (fechaFactura/transitAt → entrada).
        if (wasTransito || v.fechaFactura || v.transitAt) {
          // Fecha de referencia: la facturación del CDO (YYYY-MM-DD, local) o
          // el momento en que se marcó "en tránsito".
          let ref = null;
          const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v.fechaFactura || "").trim());
          if (m) ref = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
          else if (v.transitAt) ref = new Date(v.transitAt);
          if (ref && !isNaN(ref)) {
            const dias = Math.floor((new Date(rec.at) - ref) / (1000 * 60 * 60 * 24));
            v.transitDays = Math.max(0, dias);
          }
          v.arrivedAt = rec.at;
        }
        // Etapa inicial al ingresar (si no tenía una).
        if (!v.stage) {
          v.stage = "Recepción";
          v.stageAt = rec.at;
          v.stageBy = by;
          v.stageHistory = (v.stageHistory || []).concat([{ stage: "Recepción", by, at: rec.at, from: null }]);
        }
      }
    } else if (ev.type === "exit") {
      v.status = "fuera";
      v.exitAt = rec.at;
      v.exitBy = by;
    }
    if (ev.condition) v.condition = ev.condition;
    v.lastBy = by;
    v.lastSinGps = !!ev.sinGps; // marca si el último evento fue en contingencia (sin GPS)
    db.vehicles[ev.vin] = { ...v, updatedAt: rec.at, createdAt: v.createdAt || rec.at };
    write(db);
    return rec;
  },
  eventsForVin(vin) { return read().events.filter(e => e.vin === vin).sort((a,b)=>a.at.localeCompare(b.at)); },

  // ---- Agencias (con áreas jerárquicas) ----
  listAgencies() { return read().agencies; },
  addAgency(name) {
    const db = read();
    db.agencies.push({ id: cryptoId(), name, lat: null, lng: null, areas: defaultAreas() });
    write(db);
  },
  updateAgency(id, patch) {
    const db = read();
    const a = db.agencies.find(x => x.id === id);
    if (a) { Object.assign(a, patch); write(db); }
  },
  removeAgency(id) {
    const db = read();
    db.agencies = db.agencies.filter(x => x.id !== id);
    write(db);
  },

  // Actualiza la etapa (estatus comercial) del vehículo, con bitácora quién/cuándo.
  setStage(vin, stage, by) {
    const db = read();
    const v = db.vehicles[vin];
    if (!v) return null;
    const now = new Date().toISOString();
    if (v.stage !== stage) {
      v.stageHistory = v.stageHistory || [];
      v.stageHistory.push({ stage, by: by || "—", at: now, from: v.stage || null });
      v.stage = stage;
      v.stageAt = now;
      v.stageBy = by || "—";
      v.updatedAt = now;
      write(db);
    }
    return v;
  },

  // Cambia el VIN (clave) de un vehículo y actualiza sus eventos. Solo admin en la UI.
  changeVin(oldVin, newVin) {
    const db = read();
    if (!db.vehicles[oldVin]) return { ok: false, error: "El vehículo no existe." };
    if (db.vehicles[newVin]) return { ok: false, error: "Ya existe un vehículo con el VIN nuevo." };
    const v = db.vehicles[oldVin];
    delete db.vehicles[oldVin];
    v.vin = newVin;
    v.updatedAt = new Date().toISOString();
    db.vehicles[newVin] = v;
    // Reasignar el VIN en los eventos históricos
    db.events.forEach(e => { if (e.vin === oldVin) e.vin = newVin; });
    write(db);
    return { ok: true };
  },

  // Elimina un vehículo y TODOS sus eventos del dispositivo. Devuelve {ok} o
  // {ok:false,error}. La UI debe restringir esto al administrador.
  removeVehicle(vin) {
    const db = read();
    if (!db.vehicles[vin]) return { ok: false, error: "El vehículo no existe." };
    delete db.vehicles[vin];
    db.events = (db.events || []).filter(e => e.vin !== vin);
    write(db);
    return { ok: true };
  },

  // ---- Usuarios y roles ----
  listUsers() { return read().users || []; },
  addUser(data) {
    const db = read();
    const u = { id: cryptoId(), createdAt: new Date().toISOString(), ...data };
    db.users.push(u);
    write(db);
    return u;
  },
  updateUser(id, patch) {
    const db = read();
    const u = db.users.find(x => x.id === id);
    if (u) { Object.assign(u, patch); write(db); }
    return u;
  },
  removeUser(id) {
    const db = read();
    db.users = db.users.filter(x => x.id !== id);
    write(db);
  },

  // ---- Auditorías / conteo físico ----
  listAudits() { return read().audits || []; },
  addAudit(audit) {
    const db = read();
    const rec = { id: cryptoId(), createdAt: new Date().toISOString(), ...audit };
    db.audits.push(rec);
    write(db);
    return rec;
  },
  updateAudit(id, patch) {
    const db = read();
    const a = db.audits.find(x => x.id === id);
    if (a) { Object.assign(a, patch); write(db); }
    return a;
  },

  // ---- Auditoría EN CURSO (sesión persistente + congelar inventario) ----
  // Estructura: db.openAudits = { [agency]: { agency, mode, frozen, by, startedAt,
  //   stage, expected:[vin], seen:{vin:status}, count } }
  // Persistir permite retomar el conteo si el auditor recarga o cierra la app.
  listOpenAudits() {
    const db = read();
    return Object.values(db.openAudits || {});
  },
  getOpenAudit(agency) {
    const db = read();
    return (db.openAudits || {})[agency] || null;
  },
  saveOpenAudit(agency, data) {
    const db = read();
    db.openAudits = db.openAudits || {};
    db.openAudits[agency] = { ...(db.openAudits[agency] || {}), ...data, agency };
    write(db);
    return db.openAudits[agency];
  },
  clearOpenAudit(agency) {
    const db = read();
    if (db.openAudits && db.openAudits[agency]) {
      delete db.openAudits[agency];
      write(db);
    }
  },
  // ¿Está congelado el inventario de una agencia? (auditoría abierta con frozen=true)
  isAgencyFrozen(agency) {
    const o = store.getOpenAudit(agency);
    return !!(o && o.frozen);
  },

  // ---- Auditorías PROGRAMADAS (agenda) ----
  // Estructura: { id, agency, mode, count, date (YYYY-MM-DD), notifyDays, note,
  //   by, createdAt, notified (bool), done (bool) }
  listScheduledAudits() {
    const db = read();
    return (db.scheduledAudits || []).slice().sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  },
  addScheduledAudit(data) {
    const db = read();
    db.scheduledAudits = db.scheduledAudits || [];
    const rec = { id: cryptoId(), createdAt: new Date().toISOString(), notified: false, done: false, ...data };
    db.scheduledAudits.push(rec);
    write(db);
    return rec;
  },
  updateScheduledAudit(id, patch) {
    const db = read();
    const s = (db.scheduledAudits || []).find(x => x.id === id);
    if (s) { Object.assign(s, patch); write(db); }
    return s;
  },
  removeScheduledAudit(id) {
    const db = read();
    db.scheduledAudits = (db.scheduledAudits || []).filter(x => x.id !== id);
    write(db);
  },

  // ---- Refacciones (inventario de partes) · SEPARADO POR AGENCIA ----
  // Todo el inventario de refacciones vive en db.parts[agency][numParte]. El mismo
  // numParte puede existir en varias agencias con existencias distintas y NUNCA se
  // mezcla. Todos los métodos reciben `agency` como PRIMER parámetro.
  // Cada parte: { numParte, descripcion, ubicacion, grupo, existencia (número),
  //   marbete, conteo (número|null), origin, createdAt, updatedAt }

  listParts(agency) { return Object.values(partsBucket(read(), agency)); },
  getPart(agency, numParte) { return partsBucket(read(), agency)[numParte] || null; },
  upsertPart(agency, p) {
    const db = read();
    const bucket = partsBucket(db, agency);
    const now = new Date().toISOString();
    const prev = bucket[p.numParte];
    bucket[p.numParte] = { ...prev, ...p, createdAt: prev?.createdAt || now, updatedAt: now };
    write(db);
    return bucket[p.numParte];
  },
  // Alta/actualización MASIVA en una sola escritura (cargar cientos de partes).
  bulkUpsertParts(agency, arr, { merge = true } = {}) {
    const db = read();
    const bucket = partsBucket(db, agency);
    const now = new Date().toISOString();
    let added = 0, updated = 0;
    for (const p of (arr || [])) {
      if (!p || !p.numParte) continue;
      const prev = bucket[p.numParte];
      if (prev) { bucket[p.numParte] = { ...(merge ? prev : {}), ...p, createdAt: prev.createdAt || now, updatedAt: now }; updated++; }
      else { bucket[p.numParte] = { ...p, createdAt: now, updatedAt: now }; added++; }
    }
    write(db);
    return { added, updated };
  },
  // Guarda el conteo físico de una parte en la RONDA indicada (1, 2 o 3).
  // Mantiene el histórico por ronda en p.conteos = { "1": n, "2": n, "3": n } y
  // deja p.conteo = el valor de la ronda recién capturada (vista rápida).
  setPartConteo(agency, numParte, conteo, by, ronda = 1) {
    const db = read();
    const p = partsBucket(db, agency)[numParte];
    if (!p) return null;
    const r = String(ronda || 1);
    p.conteos = p.conteos || {};
    p.conteos[r] = conteo;
    p.conteo = conteo;                 // compat: último conteo
    p.conteoRonda = Number(ronda || 1);
    p.conteoBy = by || "—";
    p.conteoAt = new Date().toISOString();
    p.updatedAt = p.conteoAt;
    write(db);
    return p;
  },
  // Registra piezas de una parte que están en EXHIBICIÓN / punto de venta (la
  // "libreta"). Se guarda por punto (p.exhibiciones = { "Punto X": n }) y el
  // total p.exhibicion. Estas piezas SUMAN al conteo físico para cuadrar contra
  // la existencia del sistema (Opción A). Si la parte no existe, se da de alta.
  setPartExhibicion(agency, numParte, punto, cantidad, by, observacion) {
    const db = read();
    const bucket = partsBucket(db, agency);
    let p = bucket[numParte];
    const now = new Date().toISOString();
    if (!p) {
      p = bucket[numParte] = { numParte, descripcion: "", ubicacion: "", existencia: null,
        enMarbetes: false, enExistencias: false, origin: "exhibicion", createdAt: now };
    }
    p.exhibiciones = p.exhibiciones || {};
    const key = punto || "Exhibición";
    const n = Number(cantidad);
    if (!Number.isFinite(n) || n <= 0) delete p.exhibiciones[key];
    else p.exhibiciones[key] = n;
    // Total en exhibición = suma de todos los puntos.
    p.exhibicion = Object.values(p.exhibiciones).reduce((s, v) => s + Number(v || 0), 0);
    // Observaciones por punto (p. ej. para "Sin ubicación": dónde se encontró).
    if (observacion !== undefined) {
      p.exhibObs = p.exhibObs || {};
      const obs = String(observacion || "").trim();
      if (obs) p.exhibObs[key] = obs;
      else if (p.exhibObs[key]) delete p.exhibObs[key];
    }
    p.exhibicionBy = by || "—";
    p.exhibicionAt = now;
    p.updatedAt = now;
    write(db);
    return p;
  },
  // Elimina del inventario de una agencia las partes cuyo numParte NO esté en
  // `keepSet` (un Set). Se usa en el flujo ROTATIVO: tras muestrear, se conserva
  // SOLO el subconjunto a auditar. Devuelve cuántas se eliminaron.
  retainParts(agency, keepSet) {
    const db = read();
    const bucket = partsBucket(db, agency);
    let removed = 0;
    for (const k of Object.keys(bucket)) {
      if (!keepSet.has(k)) { delete bucket[k]; removed++; }
    }
    write(db);
    return removed;
  },
  clearParts(agency) {
    const db = read();
    db.parts[partsAgency(agency)] = {};
    write(db);
  },

  // ---- Auditoría de REFACCIONES por agencia (sesión: tipo, nº de rondas, etc.) ----
  // partsAudit[agency] = { tipo:'completo'|'rotativo', rondas (1-3), rondaActual,
  //   cantidadRotativo, by, startedAt, finishedAt, firmas…, note }
  getPartsAudit(agency) {
    const db = read();
    return (db.partsAudit && db.partsAudit[partsAgency(agency)]) || null;
  },
  setPartsAudit(agency, patch) {
    const db = read();
    const a = partsAgency(agency);
    if (!db.partsAudit || typeof db.partsAudit !== "object") db.partsAudit = {};
    db.partsAudit[a] = { ...(db.partsAudit[a] || {}), ...patch };
    write(db);
    return db.partsAudit[a];
  },
  clearPartsAudit(agency) {
    const db = read();
    if (db.partsAudit) db.partsAudit[partsAgency(agency)] = null;
    write(db);
  },

  // ---- Histórico de inventarios de refacciones CERRADOS (plano, con agency) ----
  // Cada entrada es un snapshot al cerrar: { id, fecha, agency, by, rondas,
  //   valorInventario, valorDiferencia, faltantes, sobrantes, noComprobadas,
  //   totalPartes, firmaAdmin, firmaRefacciones, firmaPosventa, firmaAuditor,
  //   porClasificacion }
  // Si se pasa `agency`, devuelve SOLO el historial de esa agencia; si no, todo.
  listPartsAuditHistory(agency) {
    const db = read();
    let list = (db.partsAuditHistory || []).slice();
    if (agency != null) list = list.filter(h => (h.agency || ARCHIVO_PREVIO) === agency);
    return list.sort((a, b) => String(b.fecha || "").localeCompare(String(a.fecha || "")));
  },
  addPartsAuditHistory(entry) {
    const db = read();
    db.partsAuditHistory = db.partsAuditHistory || [];
    const rec = { id: cryptoId(), fecha: new Date().toISOString(), ...entry };
    if (!rec.agency) rec.agency = ARCHIVO_PREVIO;
    db.partsAuditHistory.push(rec);
    write(db);
    return rec;
  },
  // Reasigna una entrada del histórico a otra agencia (p. ej. mover algo del
  // "archivo anterior" a su agencia real una vez identificado).
  reassignPartsAuditHistory(id, newAgency) {
    const db = read();
    const h = (db.partsAuditHistory || []).find(x => x.id === id);
    if (h) { h.agency = partsAgency(newAgency); write(db); }
    return h;
  },

  // ---- Respaldo ----
  export() { return JSON.stringify(read(), null, 2); },
  import(json) {
    const data = typeof json === "string" ? JSON.parse(json) : json;
    const merged = { ...seed(), ...data };
    migratePartsByAgency(merged);  // normaliza refacciones al modelo por agencia
    write(merged);
  },
  wipe() { write(seed()); },
};

export { defaultAreas, DEFAULT_AREAS };
