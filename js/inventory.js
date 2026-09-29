// inventory.js — Lista de inventario y ficha editable del vehículo (modal).
import { store } from "./storage.js";
import { escapeHtml } from "./agencies.js";
import { EVENT_LABELS } from "./events.js";
import * as auth from "./auth.js";
import { notify, confirmDialog } from "./ui.js";
import { decodeVin } from "./vin.js";
import { stagesFor } from "./stages.js";
import { makeVinQrDataUrl, printVinLabel } from "./label.js";

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
      [v.vin, v.make, v.model, v.color, v.plate, v.engineNo, v.vehType].filter(Boolean)
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
      <td>${escapeHtml(v.color || "")}</td>
      <td>${escapeHtml(v.engineNo || "")}</td>
      <td>${escapeHtml(v.mileage != null && v.mileage !== "" ? Number(v.mileage).toLocaleString() + " km" : "")}</td>
      <td>${escapeHtml(v.vehType || v.bodyClass || "")}</td>
      <td>${escapeHtml(v.currentLocation || "")}</td>
      <td>${v.stage ? `<span class="tag" style="background:#dbeafe;color:#1e40af">${escapeHtml(v.stage)}</span>` : ""}</td>
      <td>${escapeHtml(v.condition || "")}</td>
      <td>${escapeHtml(v.currentAgency || "")}</td>
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
        <div class="field"><label>No. de motor</label><input id="f-engineNo" type="text" value="${escapeHtml(v.engineNo || "")}" ${dis} /></div>
        <div class="field"><label>Kilometraje</label><input id="f-mileage" type="number" min="0" value="${escapeHtml(v.mileage ?? "")}" ${dis} /></div>
        <div class="field"><label>Tipo (carrocería)</label><input id="f-vehType" type="text" value="${escapeHtml(v.vehType || v.bodyClass || "")}" placeholder="Sedán, SUV, Pickup…" ${dis} /></div>
        <div class="field"><label>Placa / Matrícula</label><input id="f-plate" type="text" value="${escapeHtml(v.plate || "")}" ${dis} /></div>
        <div class="field"><label>Condición</label>
          <select id="f-condition" ${dis}>
            <option value="nuevo" ${v.condition==="nuevo"?"selected":""}>Nuevo</option>
            <option value="usado" ${v.condition==="usado"?"selected":""}>Usado</option>
          </select>
        </div>
        <div class="field"><label>Etapa (estatus comercial)</label>
          <select id="f-stage" ${dis}>
            ${stagesFor(v.condition).map(s => `<option value="${escapeHtml(s)}" ${v.stage===s?"selected":""}>${escapeHtml(s)}</option>`).join("")}
          </select>
          ${v.stageAt ? `<p class="hint">Última actualización: ${new Date(v.stageAt).toLocaleString()} · 👤 ${escapeHtml(v.stageBy || "—")}</p>` : ""}
        </div>
        <div class="field"><label>Notas</label>
          <textarea id="f-notes" rows="3" ${dis} style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;">${escapeHtml(v.notes || "")}</textarea>
        </div>
      </div>
    </div>
    ${canEdit ? '<div class="row gap"><button id="save-veh" class="btn btn-primary">Guardar cambios</button></div>' : ''}
    <hr />
    <div class="row between wrap">
      <h3 style="margin:0">Etiqueta QR de la unidad</h3>
      <button id="print-label" class="btn btn-primary">🖨️ Imprimir etiqueta</button>
    </div>
    <p class="hint">Pega esta etiqueta en la unidad (parabrisas/tablero). Escaneando este QR el registro de entradas, salidas y movimientos es instantáneo y exacto.</p>
    <div id="qr-box" style="text-align:center;margin:8px 0"><span class="muted">Generando QR…</span></div>
    <hr />
    <h3>Historial de movimientos</h3>
    <ul>${timeline || '<li class="muted">Sin eventos.</li>'}</ul>
    ${(v.stageHistory && v.stageHistory.length) ? `
      <h3>Historial de etapas</h3>
      <ul>${v.stageHistory.slice().reverse().map(h =>
        `<li><b>${escapeHtml(h.stage)}</b>${h.from ? ` <span class="muted">(desde ${escapeHtml(h.from)})</span>` : ""}<br>
         <span class="muted">${new Date(h.at).toLocaleString()} · 👤 ${escapeHtml(h.by || "—")}</span></li>`).join("")}</ul>` : ""}
  `;

  // Al cambiar la condición, actualizar las opciones de etapa (nuevo/usado difieren).
  const condSel = body.querySelector("#f-condition");
  const stageSel = body.querySelector("#f-stage");
  if (condSel && stageSel) condSel.addEventListener("change", () => {
    const actual = stageSel.value;
    const opciones = stagesFor(condSel.value);
    stageSel.innerHTML = opciones.map(s => `<option value="${escapeHtml(s)}" ${actual===s?"selected":""}>${escapeHtml(s)}</option>`).join("");
  });

  const saveBtn = body.querySelector("#save-veh");
  if (saveBtn) saveBtn.addEventListener("click", () => {
    const mileageRaw = body.querySelector("#f-mileage").value.trim();
    store.upsertVehicle({
      vin,
      make: body.querySelector("#f-make").value.trim(),
      model: body.querySelector("#f-model").value.trim(),
      color: body.querySelector("#f-color").value.trim(),
      engineNo: body.querySelector("#f-engineNo").value.trim(),
      mileage: mileageRaw === "" ? "" : Number(mileageRaw),
      vehType: body.querySelector("#f-vehType").value.trim(),
      plate: body.querySelector("#f-plate").value.trim(),
      condition: body.querySelector("#f-condition").value,
      notes: body.querySelector("#f-notes").value.trim(),
    });
    // La etapa se guarda aparte para llevar bitácora de quién/cuándo la cambió.
    const nuevaEtapa = body.querySelector("#f-stage").value;
    const quien = auth.currentUser()?.name || "—";
    store.setStage(vin, nuevaEtapa, quien);
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

  // Genera el QR del VIN dentro de la ficha (para verlo/escanearlo).
  const qrBox = body.querySelector("#qr-box");
  if (qrBox) {
    makeVinQrDataUrl(vin, 200)
      .then(url => { qrBox.innerHTML = `<img src="${url}" alt="QR ${escapeHtml(vin)}" style="width:200px;height:200px" />`; })
      .catch(() => { qrBox.innerHTML = '<span class="muted">No se pudo generar el QR (¿sin internet?).</span>'; });
  }
  const printBtn = body.querySelector("#print-label");
  if (printBtn) printBtn.addEventListener("click", async () => {
    try { await printVinLabel(store.getVehicle(vin)); }
    catch (e) { notify(e.message || "No se pudo imprimir la etiqueta.", { type: "error" }); }
  });

  modal.hidden = false;
  modal.style.display = "flex";
}

function closeModal() {
  const modal = document.getElementById("modal");
  modal.hidden = true;
  modal.style.display = "none";
}
