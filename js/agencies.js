// agencies.js — Gestión de agencias y sus ubicaciones internas (pestaña Agencias).
import { store } from "./storage.js";
import { getPosition } from "./events.js";
import { notify, confirmDialog } from "./ui.js";

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
      ? `📍 ${a.lat.toFixed(5)}, ${a.lng.toFixed(5)}`
      : "Sin ubicación GPS";
    el.innerHTML = `
      <div class="agency-head">
        <b>${escapeHtml(a.name)}</b>
        <div class="row gap">
          <button class="btn use-loc" data-id="${a.id}">Usar mi ubicación actual</button>
          <button class="btn btn-danger del-ag" data-id="${a.id}">Eliminar</button>
        </div>
      </div>
      <p class="hint">${coords}</p>
      <div class="field">
        <label>Ubicaciones internas (estructura por áreas)</label>
        <p class="hint" style="margin-top:0">Escribe el <b>Área</b> pegada al margen y sus <b>sububicaciones</b> con sangría (2 espacios o tabulador). Un área sin sububicaciones (como "Área de Entrega") se usa tal cual.</p>
        <textarea class="loc-edit" data-id="${a.id}" rows="12"
          style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;font-size:14px;font-family:ui-monospace,monospace;">${escapeHtml(areasToText(a.areas))}</textarea>
        <button class="btn btn-primary save-loc" data-id="${a.id}" style="margin-top:6px;">Guardar ubicaciones</button>
      </div>
    `;
    wrap.appendChild(el);
  });

  wrap.querySelectorAll(".use-loc").forEach(btn =>
    btn.addEventListener("click", async () => {
      btn.disabled = true; btn.textContent = "Obteniendo…";
      try {
        const pos = await getPosition();
        store.updateAgency(btn.dataset.id, { lat: pos.lat, lng: pos.lng });
        render(); onChange();
      } catch (e) {
        notify("No se pudo obtener la ubicación: " + e.message, { type: "error" });
        btn.disabled = false; btn.textContent = "Usar mi ubicación actual";
      }
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
