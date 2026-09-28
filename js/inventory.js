// inventory.js — Lista de inventario y ficha editable del vehículo (modal).
import { store } from "./storage.js";
import { escapeHtml } from "./agencies.js";
import { EVENT_LABELS } from "./events.js";
import * as auth from "./auth.js";
import { notify, confirmDialog } from "./ui.js";
import { decodeVin } from "./vin.js";

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
      <td>${escapeHtml(v.entryAt ? new Date(v.entryAt).toLocaleString() : "")}</td>
      <td>${escapeHtml(v.entryBy || v.lastBy || "")}</td>
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
    const who = e.by ? ` · 👤 ${escapeHtml(e.by)}` : "";
    const cont = e.sinGps ? ' <span class="tag" style="background:#fef3c7;color:#92400e">⚠️ sin GPS</span>' : "";
    return `<li><b>${EVENT_LABELS[e.type] || e.type}</b> — ${escapeHtml(e.location || "")}
      <span class="muted">(${escapeHtml(e.agency || "")})</span>${cont}<br>
      <span class="muted">${new Date(e.at).toLocaleString()}${who}${gps}</span></li>`;
  }).join("");

  const incomplete = !v.model || !v.color;
  const canEdit = auth.can("vehicle.edit");
  const canEditVin = auth.can("vehicle.editVin");
  const dis = canEdit ? "" : "disabled";

  // Fila del VIN: editable solo por administrador; para el resto es de solo lectura.
  const vinRow = canEditVin
    ? `<div class="field"><label>VIN (solo administrador puede cambiarlo)</label>
         <div class="row gap">
           <input id="f-vin" type="text" maxlength="17" value="${escapeHtml(v.vin)}" style="font-family:ui-monospace,monospace" />
           <button id="change-vin" class="btn btn-danger">Cambiar VIN</button>
         </div>
         <p class="hint">Cambiar el VIN afecta todo el historial de la unidad. Úsalo solo para corregir un VIN mal capturado.</p>
       </div>`
    : `<div class="field"><label>VIN</label>
         <div><code style="font-size:15px">${escapeHtml(v.vin)}</code> <span class="tag">🔒 Solo admin</span></div>
       </div>`;

  body.innerHTML = `
    ${incomplete ? '<p class="hint" style="color:var(--danger)">⚠️ Ficha incompleta: faltan datos por completar.</p>' : ''}
    ${!canEdit ? '<p class="hint">Tu rol permite ver esta ficha, pero no editarla.</p>' : ''}
    <p class="ficha-meta">
      📅 Ingreso: <b>${v.entryAt ? new Date(v.entryAt).toLocaleString() : "—"}</b>
      &nbsp;·&nbsp; 👤 Registró: <b>${escapeHtml(v.entryBy || v.lastBy || "—")}</b>
      ${v.exitAt ? `&nbsp;·&nbsp; 🚪 Salida: <b>${new Date(v.exitAt).toLocaleString()}</b> (${escapeHtml(v.exitBy || "—")})` : ""}
    </p>
    <div class="grid grid-2">
      <div>
        <p class="muted">Datos del VIN (año y país no editables)</p>
        <dl class="vin-result">
          <dt>Año</dt><dd>${escapeHtml(v.year || "—")}</dd>
          <dt>País</dt><dd>${escapeHtml(v.country || "—")}</dd>
          ${v.bodyClass ? `<dt>Carrocería</dt><dd>${escapeHtml(v.bodyClass)}</dd>` : ""}
          ${v.engine ? `<dt>Motor</dt><dd>${escapeHtml(v.engine)}</dd>` : ""}
          ${v.fuelType ? `<dt>Combustible</dt><dd>${escapeHtml(v.fuelType)}</dd>` : ""}
          ${v.transmission ? `<dt>Transmisión</dt><dd>${escapeHtml(v.transmission)}</dd>` : ""}
        </dl>
      </div>
      <div>
        ${vinRow}
        <div class="field"><label>Marca</label><input id="f-make" type="text" value="${escapeHtml(v.make || "")}" ${dis} /></div>
        <div class="field"><label>Modelo</label><input id="f-model" type="text" value="${escapeHtml(v.model || "")}" ${dis} /></div>
        <div class="field"><label>Color</label><input id="f-color" type="text" value="${escapeHtml(v.color || "")}" ${dis} /></div>
        <div class="field"><label>Placa / Matrícula</label><input id="f-plate" type="text" value="${escapeHtml(v.plate || "")}" ${dis} /></div>
        <div class="field"><label>Condición</label>
          <select id="f-condition" ${dis}>
            <option value="nuevo" ${v.condition==="nuevo"?"selected":""}>Nuevo</option>
            <option value="usado" ${v.condition==="usado"?"selected":""}>Usado</option>
          </select>
        </div>
        <div class="field"><label>Notas</label>
          <textarea id="f-notes" rows="3" ${dis} style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;">${escapeHtml(v.notes || "")}</textarea>
        </div>
      </div>
    </div>
    ${canEdit ? '<div class="row gap"><button id="save-veh" class="btn btn-primary">Guardar cambios</button></div>' : ''}
    <hr />
    <h3>Historial de movimientos</h3>
    <ul>${timeline || '<li class="muted">Sin eventos.</li>'}</ul>
  `;

  const saveBtn = body.querySelector("#save-veh");
  if (saveBtn) saveBtn.addEventListener("click", () => {
    store.upsertVehicle({
      vin,
      make: body.querySelector("#f-make").value.trim(),
      model: body.querySelector("#f-model").value.trim(),
      color: body.querySelector("#f-color").value.trim(),
      plate: body.querySelector("#f-plate").value.trim(),
      condition: body.querySelector("#f-condition").value,
      notes: body.querySelector("#f-notes").value.trim(),
    });
    closeModal();
    renderInventory();
    onChange();
    notify("Ficha guardada.", { type: "success" });
  });

  // Cambio de VIN (solo admin), con validación ISO 3779 y confirmación.
  const changeVinBtn = body.querySelector("#change-vin");
  if (changeVinBtn) changeVinBtn.addEventListener("click", async () => {
    const nuevo = (body.querySelector("#f-vin").value || "").toUpperCase().trim();
    if (nuevo === vin) { notify("El VIN es el mismo.", { type: "info" }); return; }
    const dec = decodeVin(nuevo);
    if (dec.vin.length !== 17 || dec.errors.length) {
      notify("VIN inválido (ISO 3779): " + (dec.errors[0] || "revisa el formato."), { type: "error" });
      return;
    }
    const choice = await confirmDialog({
      icon: "🔑", title: "Cambiar VIN",
      message: `Vas a cambiar el VIN:\n\n${vin}\n→ ${nuevo}\n\nSe actualizará todo el historial de la unidad. ¿Continuar?`,
      buttons: [
        { label: "Cancelar", value: null, variant: "ghost" },
        { label: "Sí, cambiar VIN", value: "ok", variant: "danger" },
      ],
    });
    if (choice !== "ok") return;
    const res = store.changeVin(vin, nuevo);
    if (!res.ok) { notify(res.error, { type: "error" }); return; }
    closeModal();
    renderInventory();
    onChange();
    notify("VIN actualizado correctamente.", { type: "success" });
  });

  modal.hidden = false;
  modal.style.display = "flex";
}

function closeModal() {
  const modal = document.getElementById("modal");
  modal.hidden = true;
  modal.style.display = "none";
}
