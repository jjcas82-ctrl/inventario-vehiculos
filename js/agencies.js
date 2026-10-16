// agencies.js — Gestión de agencias y sus ubicaciones internas (pestaña Agencias).
import { store } from "./storage.js";
import { getPosition } from "./events.js";
import { notify, confirmDialog } from "./ui.js";
import { geocode } from "./geo.js";
import { qrDataUrl } from "./qrgen.js";

// Formato del QR de zona: "ZONA|<agencia>|<area>". Lo lee la pantalla "Mover por zona".
export function zonaQrPayload(agency, area) {
  return `ZONA|${agency}|${area}`;
}
// Parsea un QR de zona. Devuelve {agency, area} o null si no es un QR de zona.
export function parseZonaQr(text) {
  const t = String(text || "").trim();
  if (!t.startsWith("ZONA|")) return null;
  const parts = t.split("|");
  if (parts.length < 3) return null;
  return { agency: parts[1], area: parts.slice(2).join("|") };
}

// Lista plana de áreas (incluyendo sububicaciones) de una agencia.
function flatAreas(agency) {
  const a = store.listAgencies().find(x => x.name === agency);
  if (!a || !a.areas) return [];
  const out = [];
  for (const ar of a.areas) {
    out.push(ar.name);
    for (const s of (ar.subs || [])) out.push(s);
  }
  return out;
}

// Abre una ventana imprimible con un QR por cada zona de la agencia.
async function printZoneQrs(agencyId) {
  const a = store.listAgencies().find(x => x.id === agencyId);
  if (!a) return;
  const zonas = flatAreas(a.name);
  if (!zonas.length) { notify("Esta agencia no tiene áreas definidas.", { type: "warn" }); return; }

  const cards = [];
  for (const zona of zonas) {
    const url = await qrDataUrl(zonaQrPayload(a.name, zona), { size: 320, margin: 2 });
    cards.push(`<figure class="zq">
      <img src="${url}" alt="QR ${escapeHtml(zona)}">
      <figcaption><b>${escapeHtml(zona)}</b><br><span>${escapeHtml(a.name)}</span></figcaption>
    </figure>`);
  }
  const win = window.open("", "_blank", "width=820,height=900");
  if (!win) { notify("El navegador bloqueó la ventana. Permite ventanas emergentes.", { type: "error" }); return; }
  win.document.write(`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
    <title>QR de zonas · ${escapeHtml(a.name)}</title>
    <style>
      *{box-sizing:border-box} @page{size:letter;margin:12mm}
      body{font-family:system-ui,sans-serif;margin:0;color:#0f172a}
      h1{font-size:18px;color:#0f204a}
      .grid{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}
      .zq{margin:0;border:1px solid #cbd5e1;border-radius:10px;padding:12px;text-align:center;page-break-inside:avoid}
      .zq img{width:260px;height:260px}
      .zq figcaption{margin-top:6px;font-size:15px} .zq figcaption span{color:#475569;font-size:12px}
      .no-print{text-align:center;margin:14px 0}
      .no-print button{padding:10px 18px;border:1px solid #0f204a;background:#0f204a;color:#fff;border-radius:8px;cursor:pointer}
      @media print{.no-print{display:none}}
    </style></head><body>
    <h1>QR de zonas · ${escapeHtml(a.name)}</h1>
    <p style="font-size:12px;color:#475569">Pega cada QR en su área. Escanéalo en "Mover por zona" para ubicar unidades.</p>
    <div class="grid">${cards.join("")}</div>
    <div class="no-print"><button onclick="window.print()">🖨️ Imprimir</button></div>
    <script>window.onload=()=>setTimeout(()=>window.print(),400)<\/script>
    </body></html>`);
  win.document.close();
}

let onChange = () => {};

export function initAgencies(refreshCallback) {
  onChange = refreshCallback || (() => {});
  document.getElementById("add-agency").addEventListener("click", () => {
    const input = document.getElementById("new-agency");
    const name = input.value.trim();
    if (!name) return;
    store.addAgency(name);
    input.value = "";
    render();
    onChange();
  });
  render();
}

function render() {
  const wrap = document.getElementById("agency-list");
  const agencies = store.listAgencies();
  wrap.innerHTML = "";

  agencies.forEach(a => {
    const el = document.createElement("div");
    el.className = "agency";
    const coords = (a.lat != null && a.lng != null)
      ? `📍 ${a.lat.toFixed(6)}, ${a.lng.toFixed(6)}`
      : "⚠️ Sin ubicación GPS (obligatoria para detectar entradas/salidas)";
    const radius = a.radius || 200;
    el.innerHTML = `
      <div class="agency-head">
        <b>${escapeHtml(a.name)}</b>
        <button class="btn btn-danger del-ag" data-id="${a.id}">Eliminar</button>
      </div>
      <p class="hint">${coords}</p>
      ${a.address ? `<p class="hint">🏢 ${escapeHtml(a.address)}</p>` : ""}

      <div class="loc-card">
        <b>Ubicación / dirección de esta agencia</b>
        <p class="hint" style="margin-top:2px">Se usa para detectar automáticamente la agencia en entradas y salidas por GPS.</p>

        <div class="row gap wrap" style="margin:8px 0">
          <button class="btn use-loc" data-id="${a.id}">📍 Usar mi ubicación actual</button>
        </div>

        <div class="field">
          <label>Buscar por dirección (requiere internet)</label>
          <div class="row gap">
            <input class="addr-input" data-id="${a.id}" type="text" placeholder="Calle, número, ciudad, estado" />
            <button class="btn geocode-btn" data-id="${a.id}">Buscar</button>
          </div>
        </div>

        <div class="row gap wrap">
          <div class="field" style="flex:1;min-width:120px">
            <label>Latitud</label>
            <input class="lat-input" data-id="${a.id}" type="number" step="any" value="${a.lat ?? ""}" />
          </div>
          <div class="field" style="flex:1;min-width:120px">
            <label>Longitud</label>
            <input class="lng-input" data-id="${a.id}" type="number" step="any" value="${a.lng ?? ""}" />
          </div>
          <div class="field" style="flex:1;min-width:120px">
            <label>Radio de detección (m)</label>
            <input class="radius-input" data-id="${a.id}" type="number" min="10" value="${radius}" />
          </div>
        </div>
        <button class="btn btn-primary save-coords" data-id="${a.id}">Guardar ubicación</button>
      </div>

      <div class="field" style="margin-top:12px">
        <label>Ubicaciones internas (estructura por áreas)</label>
        <p class="hint" style="margin-top:0">Escribe el <b>Área</b> pegada al margen y sus <b>sububicaciones</b> con sangría (2 espacios o tabulador). Un área sin sububicaciones se usa tal cual.</p>
        <textarea class="loc-edit" data-id="${a.id}" rows="10"
          style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;font-size:14px;font-family:ui-monospace,monospace;">${escapeHtml(areasToText(a.areas))}</textarea>
        <div class="row gap wrap" style="margin-top:6px">
          <button class="btn btn-primary save-loc" data-id="${a.id}">Guardar ubicaciones internas</button>
          <button class="btn print-zone-qr" data-id="${a.id}">🏷️ Imprimir QR de zonas</button>
        </div>
        <p class="hint">Pega el QR de cada zona en su área física. En la pantalla "Mover por zona", el operador escanea el QR de la zona y luego las unidades para ubicarlas ahí.</p>
      </div>
    `;
    wrap.appendChild(el);
  });

  // Usar ubicación actual (GPS del dispositivo)
  wrap.querySelectorAll(".use-loc").forEach(btn =>
    btn.addEventListener("click", async () => {
      btn.disabled = true; btn.textContent = "Obteniendo…";
      try {
        const pos = await getPosition();
        store.updateAgency(btn.dataset.id, { lat: pos.lat, lng: pos.lng });
        notify(`Ubicación fijada (±${Math.round(pos.accuracy)} m).`, { type: "success" });
        render(); onChange();
      } catch (e) {
        notify("No se pudo obtener la ubicación: " + e.message, { type: "error" });
        btn.disabled = false; btn.textContent = "📍 Usar mi ubicación actual";
      }
    })
  );

  // Buscar por dirección (geocodificación)
  wrap.querySelectorAll(".geocode-btn").forEach(btn =>
    btn.addEventListener("click", async () => {
      const input = wrap.querySelector(`.addr-input[data-id="${btn.dataset.id}"]`);
      const addr = input.value.trim();
      if (!addr) { notify("Escribe una dirección.", { type: "warn" }); return; }
      btn.disabled = true; btn.textContent = "Buscando…";
      const r = await geocode(addr);
      btn.disabled = false; btn.textContent = "Buscar";
      if (r.error) { notify(r.error, { type: "error" }); return; }
      // Rellena los campos lat/lng para que el admin confirme y guarde
      wrap.querySelector(`.lat-input[data-id="${btn.dataset.id}"]`).value = r.lat.toFixed(6);
      wrap.querySelector(`.lng-input[data-id="${btn.dataset.id}"]`).value = r.lng.toFixed(6);
      notify("Dirección encontrada: " + (r.display || "").slice(0, 60) + "… Revisa y pulsa Guardar ubicación.", { type: "success", timeout: 6000 });
    })
  );

  // Guardar coordenadas + radio (manual o tras geocodificar/ubicación actual)
  wrap.querySelectorAll(".save-coords").forEach(btn =>
    btn.addEventListener("click", () => {
      const lat = parseFloat(wrap.querySelector(`.lat-input[data-id="${btn.dataset.id}"]`).value);
      const lng = parseFloat(wrap.querySelector(`.lng-input[data-id="${btn.dataset.id}"]`).value);
      const radius = parseInt(wrap.querySelector(`.radius-input[data-id="${btn.dataset.id}"]`).value, 10) || 200;
      if (isNaN(lat) || isNaN(lng)) { notify("Latitud/longitud no válidas.", { type: "error" }); return; }
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) { notify("Coordenadas fuera de rango.", { type: "error" }); return; }
      store.updateAgency(btn.dataset.id, { lat, lng, radius });
      notify("Ubicación guardada.", { type: "success" });
      render(); onChange();
    })
  );
  wrap.querySelectorAll(".del-ag").forEach(btn =>
    btn.addEventListener("click", async () => {
      const choice = await confirmDialog({
        icon: "🏢",
        title: "Eliminar agencia",
        message: "¿Seguro que quieres eliminar esta agencia? Sus ubicaciones ya no estarán disponibles para nuevos registros.",
        buttons: [
          { label: "Cancelar", value: "cancel", variant: "ghost" },
          { label: "Eliminar", value: "del", variant: "danger" },
        ],
      });
      if (choice === "del") { store.removeAgency(btn.dataset.id); render(); onChange(); }
    })
  );
  wrap.querySelectorAll(".save-loc").forEach(btn =>
    btn.addEventListener("click", () => {
      const ta = wrap.querySelector(`textarea.loc-edit[data-id="${btn.dataset.id}"]`);
      const areas = textToAreas(ta.value);
      store.updateAgency(btn.dataset.id, { areas });
      render(); onChange();
      notify("Ubicaciones guardadas.", { type: "success" });
    })
  );
  wrap.querySelectorAll(".print-zone-qr").forEach(btn =>
    btn.addEventListener("click", () => printZoneQrs(btn.dataset.id)));
}

// Convierte la estructura de áreas a texto editable (áreas al margen, subs con sangría).
function areasToText(areas) {
  return (areas || []).map(ar => {
    const head = ar.name;
    const subs = (ar.subs || []).map(s => "  " + s).join("\n");
    return subs ? head + "\n" + subs : head;
  }).join("\n");
}

// Convierte el texto editado de vuelta a la estructura de áreas.
// Regla: línea sin sangría = Área; línea con sangría (espacios/tab) = sububicación.
function textToAreas(text) {
  const lines = String(text || "").split("\n");
  const areas = [];
  let current = null;
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const indented = /^[\s\t]/.test(raw);
    const name = raw.trim();
    if (!indented) {
      current = { name, subs: [] };
      areas.push(current);
    } else if (current) {
      current.subs.push(name);
    } else {
      // sub sin área previa: la tratamos como área
      current = { name, subs: [] };
      areas.push(current);
    }
  }
  return areas;
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export { render as renderAgencies };
