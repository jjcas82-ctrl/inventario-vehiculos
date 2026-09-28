// geo.js — Utilidades de geolocalización: distancia y geocodificación de direcciones.

// Distancia entre dos coordenadas en metros (fórmula de Haversine).
export function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000; // radio de la Tierra en metros
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Convierte una dirección de texto en coordenadas usando Nominatim (OpenStreetMap).
// Requiere internet. Devuelve { lat, lng, display } o { error }.
export async function geocode(address, { timeoutMs = 8000 } = {}) {
  if (!navigator.onLine) return { error: "Sin conexión a internet para buscar la dirección." };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" +
      encodeURIComponent(address);
    const res = await fetch(url, { signal: ctrl.signal, headers: { "Accept": "application/json" } });
    clearTimeout(t);
    if (!res.ok) return { error: "No se pudo consultar la dirección (HTTP " + res.status + ")." };
    const arr = await res.json();
    if (!arr || !arr.length) return { error: "No se encontró la dirección. Prueba con más detalle o usa coordenadas." };
    return { lat: parseFloat(arr[0].lat), lng: parseFloat(arr[0].lon), display: arr[0].display_name };
  } catch (e) {
    clearTimeout(t);
    return { error: e.name === "AbortError" ? "Tiempo de espera agotado." : (e.message || String(e)) };
  }
}

// Devuelve la agencia/punto de venta más cercano a unas coordenadas.
// agencies: [{ name, lat, lng, radius }]. Usa radius (m) por agencia o el radio por defecto.
export function nearestAgency(lat, lng, agencies, defaultRadius = 200) {
  let best = null;
  for (const a of agencies) {
    if (a.lat == null || a.lng == null) continue;
    const d = distanceMeters(lat, lng, a.lat, a.lng);
    const radius = a.radius || defaultRadius;
    if (!best || d < best.distance) best = { agency: a, distance: d, withinRadius: d <= radius };
  }
  return best; // { agency, distance, withinRadius } o null
}
