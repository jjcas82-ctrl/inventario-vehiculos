// storage.js — Persistencia local (localStorage) con una pequeña capa de acceso.
// Modelo de datos:
//   vehicles: { [vin]: { vin, make, country, year, model, color, condition,
//                        plate, notes, currentAgency, currentLocation, status,
//                        createdAt, updatedAt } }
//   events:   [ { id, vin, type: 'entry'|'exit'|'move', agency, location,
//                 condition, lat, lng, accuracy, at } ]
//   agencies: [ { id, name, lat, lng, locations: [string] } ]

const KEY = "inv_vehiculos_v1";

const DEFAULT_LOCATIONS = [
  "Piso 1", "Piso 2", "Piso 3",
  "Área de servicio", "Taller", "Lavado", "Accesorios",
  "Sala de exhibición - Chevrolet", "Sala de exhibición - Buick",
];

function seed() {
  return {
    vehicles: {},
    events: [],
    agencies: [
      { id: cryptoId(), name: "Aeroplasa Aeropuerto", lat: null, lng: null, locations: [...DEFAULT_LOCATIONS] },
    ],
  };
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
  _cache.agencies = _cache.agencies || seed().agencies;
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

  // ---- Eventos ----
  listEvents() { return read().events; },
  addEvent(ev) {
    const db = read();
    const rec = { id: cryptoId(), at: new Date().toISOString(), ...ev };
    db.events.push(rec);
    // Actualiza estado del vehículo según el evento
    const v = db.vehicles[ev.vin] || { vin: ev.vin };
    if (ev.type === "entry" || ev.type === "move") {
      v.currentAgency = ev.agency;
      v.currentLocation = ev.location;
      v.status = "dentro";
    } else if (ev.type === "exit") {
      v.status = "fuera";
    }
    if (ev.condition) v.condition = ev.condition;
    db.vehicles[ev.vin] = { ...v, updatedAt: rec.at, createdAt: v.createdAt || rec.at };
    write(db);
    return rec;
  },
  eventsForVin(vin) { return read().events.filter(e => e.vin === vin).sort((a,b)=>a.at.localeCompare(b.at)); },

  // ---- Agencias ----
  listAgencies() { return read().agencies; },
  addAgency(name) {
    const db = read();
    db.agencies.push({ id: cryptoId(), name, lat: null, lng: null, locations: [...DEFAULT_LOCATIONS] });
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

export { DEFAULT_LOCATIONS };
