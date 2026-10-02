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

// Sitios que se precargan con sus direcciones y coordenadas reales.
const SEED_SITES = [
  {
    name: "Agencia Aeropuerto",
    address: "Blvd. Puerto Aéreo 141, Col. Federal, Venustiano Carranza, 15700 Ciudad de México, CDMX",
    lat: 19.425222, lng: -99.093219, radius: 200, areas: DEFAULT_AREAS,
  },
  {
    name: "Agencia Aeroplasa Auto",
    address: "Carretera Federal México-Tuxpan Km 190 S/N, Col. El Potro, C.P. 73176, Huauchinango, Puebla",
    lat: 20.173122, lng: -98.070828, radius: 200, areas: AEROPLASA_AUTO_AREAS,
  },
  {
    // Bodega como SITIO independiente (cambio de ubicación). Falta su dirección/GPS:
    // el administrador la fija en la pestaña Agencias (dirección o "Usar mi ubicación actual").
    name: "Bodega Aeroplasa Auto",
    address: "", lat: null, lng: null, radius: 150, areas: [
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
];

function cloneAreas(list) {
  return list.map(a => ({ name: a.name, subs: [...a.subs] }));
}
function defaultAreas() { return cloneAreas(DEFAULT_AREAS); }

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
  if (!Array.isArray(_cache.users)) _cache.users = [];
  if (!Array.isArray(_cache.audits)) _cache.audits = [];

  // Precarga/actualización de sitios con sus direcciones y coordenadas reales.
  // Matching por nombre EXACTO (sin heurística ambigua, para no confundir
  // "Bodega Aeroplasa Auto" con "Agencia Aeroplasa Auto").
  SEED_SITES.forEach(site => {
    let a = _cache.agencies.find(x => x.name.toLowerCase() === site.name.toLowerCase());
    // Caso especial: instalaciones antiguas donde la agencia se llamaba distinto.
    if (!a && site.name === "Agencia Aeroplasa Auto") {
      a = _cache.agencies.find(x => /^agencia aeroplasa auto$/i.test(x.name) || /^aeroplasa auto$/i.test(x.name));
    }
    if (!a && site.name === "Agencia Aeropuerto") {
      a = _cache.agencies.find(x => /aeropuerto/i.test(x.name));
    }
    if (!a) {
      // Sitio nuevo (ej. Bodega, puntos de venta): crearlo.
      _cache.agencies.push({
        id: cryptoId(), name: site.name, address: site.address,
        lat: site.lat, lng: site.lng, radius: site.radius, areas: cloneAreas(site.areas),
      });
    } else {
      a.name = site.name;
      if (!a.address && site.address) a.address = site.address;
      if ((a.lat == null || a.lng == null) && site.lat != null) { a.lat = site.lat; a.lng = site.lng; }
      if (!a.radius) a.radius = site.radius;
      // Actualizar la estructura interna de Aeroplasa Auto a la versión vigente
      // si todavía tiene áreas antiguas ("Bodega"/"Puntos de venta" como área interna).
      if (site.name === "Agencia Aeroplasa Auto" && a.areas &&
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

  // ---- Respaldo ----
  export() { return JSON.stringify(read(), null, 2); },
  import(json) {
    const data = typeof json === "string" ? JSON.parse(json) : json;
    write({ ...seed(), ...data });
  },
  wipe() { write(seed()); },
};

export { defaultAreas, DEFAULT_AREAS };
