// agencies.js — Gestión de agencias y sus ubicaciones internas (pestaña Agencias).
import { store } from "./storage.js";
import { getPosition } from "./events.js";
import { notify, confirmDialog } from "./ui.js";
import { geocode } from "./geo.js";

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
        <button class="btn btn-primary save-loc" data-id="${a.id}" style="margin-top:6px;">Guardar ubicaciones internas</button>
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
