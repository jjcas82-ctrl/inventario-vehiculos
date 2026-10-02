// map.js — Mapa y trazado de movimientos con GPS, usando Leaflet (CDN).
import { store } from "./storage.js";
import { EVENT_LABELS } from "./events.js";

let map = null;
let layer = null;
let leafletLoaded = false;

// Carga Leaflet (CSS + JS) una sola vez desde CDN.
async function ensureLeaflet() {
  if (leafletLoaded && window.L) return window.L;
  if (!document.getElementById("leaflet-css")) {
    const css = document.createElement("link");
    css.id = "leaflet-css";
    css.rel = "stylesheet";
    css.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
    document.head.appendChild(css);
  }
  await new Promise((resolve, reject) => {
    if (window.L) return resolve();
    const s = document.createElement("script");
    s.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    s.onload = resolve;
    s.onerror = () => reject(new Error("No se pudo cargar el mapa (¿sin internet?)."));
    document.head.appendChild(s);
  });
  leafletLoaded = true;
  return window.L;
}

export function initMap() {
  const sel = document.getElementById("map-vin");
  sel.addEventListener("change", drawMap);
  refreshMapVinOptions();
}

export function refreshMapVinOptions() {
  const sel = document.getElementById("map-vin");
  const current = sel.value;
  const vins = [...new Set(store.listEvents().map(e => e.vin))];
  sel.innerHTML = '<option value="">— Todos los eventos recientes —</option>' +
    vins.map(v => `<option value="${v}">${v}</option>`).join("");
  sel.value = current;
}

export async function drawMap() {
  let L;
  try { L = await ensureLeaflet(); }
  catch (e) {
    document.getElementById("map").innerHTML =
      `<p class="muted" style="padding:16px">${e.message}</p>`;
    return;
  }

  if (!map) {
    map = L.map("map").setView([19.4326, -99.1332], 5); // Centro genérico (México)
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "© OpenStreetMap",
    }).addTo(map);
  }
  if (layer) { layer.remove(); layer = null; }
  layer = L.layerGroup().addTo(map);

  const vinFilter = document.getElementById("map-vin").value;
  let events = store.listEvents().filter(e => e.lat != null && e.lng != null);
  if (vinFilter) events = events.filter(e => e.vin === vinFilter);
  events.sort((a, b) => a.at.localeCompare(b.at));

  const pts = [];
  events.forEach(e => {
    const label = `${EVENT_LABELS[e.type] || e.type} · ${e.vin}<br>${e.location || ""} (${e.agency || ""})<br>${new Date(e.at).toLocaleString()}`;
    const color = e.type === "exit" ? "#dc2626" : (e.type === "entry" ? "#0f204a" : "#2563eb");
    L.circleMarker([e.lat, e.lng], { radius: 7, color, fillColor: color, fillOpacity: .8 })
      .bindPopup(label).addTo(layer);
    pts.push([e.lat, e.lng]);
  });

  // Traza la línea de recorrido si filtramos por un VIN
  if (vinFilter && pts.length > 1) {
    L.polyline(pts, { color: "#2563eb", weight: 3, opacity: .6, dashArray: "6 6" }).addTo(layer);
  }

  if (pts.length) {
    map.fitBounds(pts, { padding: [40, 40], maxZoom: 17 });
  }
  // Necesario cuando el contenedor estaba oculto (pestaña inactiva)
  setTimeout(() => map.invalidateSize(), 100);
}
