// events.js — Obtención de GPS y registro de entradas/salidas/movimientos.
import { store } from "./storage.js";

// Obtiene la posición GPS actual como promesa {lat, lng, accuracy}
export function getPosition(options = {}) {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("Este dispositivo no soporta geolocalización."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
      }),
      (err) => {
        const map = {
          1: "Permiso de ubicación denegado.",
          2: "Ubicación no disponible.",
          3: "Se agotó el tiempo para obtener la ubicación.",
        };
        reject(new Error(map[err.code] || err.message));
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0, ...options }
    );
  });
}

// Registra un evento (type: 'entry' | 'move' | 'exit'). Intenta capturar GPS,
// pero no bloquea el registro si el GPS falla.
export async function registerEvent({ vin, type, agency, area, location, condition, by }, onGps) {
  const isRemote = /puntos de venta/i.test(area || "");
  let gps = { lat: null, lng: null, accuracy: null };
  try {
    if (onGps) onGps(isRemote ? "Obteniendo ubicación GPS del punto de venta…" : "Obteniendo ubicación GPS…", "info");
    gps = await getPosition();
    if (onGps) onGps(`Ubicación capturada (±${Math.round(gps.accuracy)} m).`, "ok");
  } catch (e) {
    // En puntos de venta remotos, el GPS es especialmente importante.
    const extra = isRemote
      ? " ⚠️ En un punto de venta conviene tener GPS; el evento se guardó sin ubicación."
      : " (el evento se guarda igual).";
    if (onGps) onGps("Sin GPS: " + e.message + extra, "warn");
  }

  const rec = store.addEvent({
    vin, type, agency, area, location, condition, by,
    lat: gps.lat, lng: gps.lng, accuracy: gps.accuracy,
  });
  return rec;
}

export const EVENT_LABELS = { entry: "Entrada", move: "Movimiento", exit: "Salida" };
