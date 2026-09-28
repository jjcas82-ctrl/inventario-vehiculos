// agencies.js — Gestión de agencias y sus ubicaciones internas (pestaña Agencias).
import { store } from "./storage.js";
import { getPosition } from "./events.js";

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
        <label>Ubicaciones internas (una por línea)</label>
        <textarea class="loc-edit" data-id="${a.id}" rows="4"
          style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;font-size:14px;">${a.locations.join("\n")}</textarea>
        <button class="btn save-loc" data-id="${a.id}" style="margin-top:6px;">Guardar ubicaciones</button>
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
        alert("No se pudo obtener la ubicación: " + e.message);
        btn.disabled = false; btn.textContent = "Usar mi ubicación actual";
      }
    })
  );
  wrap.querySelectorAll(".del-ag").forEach(btn =>
    btn.addEventListener("click", () => {
      if (confirm("¿Eliminar esta agencia?")) { store.removeAgency(btn.dataset.id); render(); onChange(); }
    })
  );
  wrap.querySelectorAll(".save-loc").forEach(btn =>
    btn.addEventListener("click", () => {
      const ta = wrap.querySelector(`textarea.loc-edit[data-id="${btn.dataset.id}"]`);
      const locations = ta.value.split("\n").map(s => s.trim()).filter(Boolean);
      store.updateAgency(btn.dataset.id, { locations });
      render(); onChange();
      btn.textContent = "Guardado ✓";
      setTimeout(() => (btn.textContent = "Guardar ubicaciones"), 1500);
    })
  );
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export { render as renderAgencies };
