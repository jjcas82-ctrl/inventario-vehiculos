// inventory.js — Lista de inventario y ficha editable del vehículo (modal).
import { store } from "./storage.js";
import { escapeHtml } from "./agencies.js";
import { EVENT_LABELS } from "./events.js";

let onChange = () => {};

export function initInventory(refreshCallback) {
  onChange = refreshCallback || (() => {});
  document.getElementById("inv-search").addEventListener("input", renderInventory);
  document.getElementById("modal-close").addEventListener("click", closeModal);
  document.getElementById("modal").addEventListener("click", (e) => {
    if (e.target.id === "modal") closeModal();
  });
  renderInventory();
}

export function renderInventory() {
  const q = (document.getElementById("inv-search").value || "").toLowerCase().trim();
  const tbody = document.querySelector("#inv-table tbody");
  const empty = document.getElementById("inv-empty");
  let list = store.listVehicles();

  if (q) {
    list = list.filter(v =>
      [v.vin, v.make, v.model, v.color, v.plate].filter(Boolean)
        .some(f => String(f).toLowerCase().includes(q))
    );
  }
  list.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));

  tbody.innerHTML = "";
  empty.style.display = list.length ? "none" : "block";

  for (const v of list) {
    const tr = document.createElement("tr");
    const statusTag = v.status === "fuera"
      ? '<span class="tag tag-out">Fuera</span>'
      : (v.status === "dentro" ? '<span class="tag tag-in">Dentro</span>' : '<span class="tag">—</span>');
    tr.innerHTML = `
      <td><code>${escapeHtml(v.vin)}</code></td>
      <td>${escapeHtml(v.make || "")}</td>
      <td>${escapeHtml(v.model || "")}</td>
      <td>${escapeHtml(v.year || "")}</td>
      <td>${escapeHtml(v.condition || "")}</td>
      <td>${escapeHtml(v.currentAgency || "")}</td>
      <td>${escapeHtml(v.currentLocation || "")}</td>
      <td>${statusTag}</td>
      <td><button class="btn open-veh" data-vin="${escapeHtml(v.vin)}">Ver / Editar</button></td>
    `;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll(".open-veh").forEach(btn =>
    btn.addEventListener("click", () => openVehicle(btn.dataset.vin))
  );
}

export function openVehicle(vin) {
  const v = store.getVehicle(vin);
  if (!v) return;
  const events = store.eventsForVin(vin);
  const modal = document.getElementById("modal");
  const body = document.getElementById("modal-body");
  document.getElementById("modal-title").textContent = "Ficha: " + vin;

  const field = (label, id, value, type = "text") =>
    `<div class="field"><label>${label}</label>
       <input id="f-${id}" type="${type}" value="${escapeHtml(value ?? "")}" /></div>`;

  const timeline = events.map(e => {
    const gps = (e.lat != null) ? ` · 📍 ${e.lat.toFixed(5)}, ${e.lng.toFixed(5)}` : "";
    return `<li><b>${EVENT_LABELS[e.type] || e.type}</b> — ${escapeHtml(e.location || "")}
      <span class="muted">(${escapeHtml(e.agency || "")})</span><br>
      <span class="muted">${new Date(e.at).toLocaleString()}${gps}</span></li>`;
  }).join("");

  const incomplete = !v.model || !v.color;

  body.innerHTML = `
    ${incomplete ? '<p class="hint" style="color:var(--danger)">⚠️ Ficha incompleta: faltan datos por completar.</p>' : ''}
    <div class="grid grid-2">
      <div>
        <p class="muted">Datos leídos del VIN (no editables)</p>
        <dl class="vin-result">
          <dt>Marca</dt><dd>${escapeHtml(v.make || "—")}</dd>
          <dt>Año</dt><dd>${escapeHtml(v.year || "—")}</dd>
          <dt>País</dt><dd>${escapeHtml(v.country || "—")}</dd>
        </dl>
      </div>
      <div>
        ${field("Modelo", "model", v.model)}
        ${field("Color", "color", v.color)}
        ${field("Placa / Matrícula", "plate", v.plate)}
        <div class="field"><label>Condición</label>
          <select id="f-condition">
            <option value="nuevo" ${v.condition==="nuevo"?"selected":""}>Nuevo</option>
            <option value="usado" ${v.condition==="usado"?"selected":""}>Usado</option>
          </select>
        </div>
        <div class="field"><label>Notas</label>
          <textarea id="f-notes" rows="3" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;">${escapeHtml(v.notes || "")}</textarea>
        </div>
      </div>
    </div>
    <div class="row gap"><button id="save-veh" class="btn btn-primary">Guardar cambios</button></div>
    <hr />
    <h3>Historial de movimientos</h3>
    <ul>${timeline || '<li class="muted">Sin eventos.</li>'}</ul>
  `;

  body.querySelector("#save-veh").addEventListener("click", () => {
    store.upsertVehicle({
      vin,
      model: body.querySelector("#f-model").value.trim(),
      color: body.querySelector("#f-color").value.trim(),
      plate: body.querySelector("#f-plate").value.trim(),
      condition: body.querySelector("#f-condition").value,
      notes: body.querySelector("#f-notes").value.trim(),
    });
    closeModal();
    renderInventory();
    onChange();
  });

  modal.hidden = false;
}

function closeModal() {
  document.getElementById("modal").hidden = true;
}
