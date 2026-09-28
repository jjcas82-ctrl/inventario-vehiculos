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

// Estructura de la Agencia Aeroplasa Auto.
const AEROPLASA_AUTO_AREAS = [
  { name: "Sala de Exhibición",        subs: [] },
  { name: "Servicio",                  subs: ["Taller", "Preparación", "Lavado"] },
  { name: "Patio",                     subs: [] },
  { name: "Estacionamiento Seminuevos", subs: [] },
  { name: "Área de Entrega",           subs: [] },
];

function cloneAreas(list) {
  return list.map(a => ({ name: a.name, subs: [...a.subs] }));
}
function defaultAreas() { return cloneAreas(DEFAULT_AREAS); }

function seed() {
  return {
    vehicles: {},
    events: [],
    agencies: [
      { id: cryptoId(), name: "Agencia Aeropuerto",     lat: null, lng: null, areas: cloneAreas(DEFAULT_AREAS) },
      { id: cryptoId(), name: "Agencia Aeroplasa Auto", lat: null, lng: null, areas: cloneAreas(AEROPLASA_AUTO_AREAS) },
    ],
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

  // Alta de la Agencia Aeroplasa Auto para instalaciones previas (sin perder datos).
  if (!_cache.agencies.some(a => /aeroplasa auto/i.test(a.name))) {
    _cache.agencies.push({
      id: cryptoId(), name: "Agencia Aeroplasa Auto",
      lat: null, lng: null, areas: cloneAreas(AEROPLASA_AUTO_AREAS),
    });
  }
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
      updatedAt: now,
    };
    write(db);
    return db.vehicles[v.vin];
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
    if (ev.type === "entry" || ev.type === "move") {
      v.currentAgency = ev.agency;
      v.currentArea = ev.area || "";
      v.currentLocation = ev.location;
      v.status = "dentro";
      if (ev.type === "entry") {
        // Fecha de ingreso y usuario del ingreso actual
        v.entryAt = rec.at;
        v.entryBy = by;
      }
    } else if (ev.type === "exit") {
      v.status = "fuera";
      v.exitAt = rec.at;
      v.exitBy = by;
    }
    if (ev.condition) v.condition = ev.condition;
    v.lastBy = by;
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

  // ---- Respaldo ----
  export() { return JSON.stringify(read(), null, 2); },
  import(json) {
    const data = typeof json === "string" ? JSON.parse(json) : json;
    write({ ...seed(), ...data });
  },
  wipe() { write(seed()); },
};

export { defaultAreas, DEFAULT_AREAS };
