// labels.js — Pestaña "Etiquetas": listar unidades, seleccionar e imprimir etiquetas QR.
import { store } from "./storage.js";
import { escapeHtml } from "./agencies.js";
import { notify } from "./ui.js";
import { printVinLabel, printVinLabels } from "./label.js";

export function initLabels() {
  const search = document.getElementById("lbl-search");
  if (search) search.addEventListener("input", renderLabels);

  const selAll = document.getElementById("lbl-selall");
  if (selAll) selAll.addEventListener("click", () => {
    const boxes = document.querySelectorAll("#lbl-table tbody .lbl-chk");
    const allChecked = [...boxes].every(b => b.checked);
    boxes.forEach(b => (b.checked = !allChecked));
    selAll.textContent = allChecked ? "Seleccionar todo" : "Quitar selección";
  });

  const printSel = document.getElementById("lbl-print-sel");
  if (printSel) printSel.addEventListener("click", async () => {
    const vins = [...document.querySelectorAll("#lbl-table tbody .lbl-chk:checked")].map(b => b.dataset.vin);
    if (!vins.length) { notify("Selecciona al menos una unidad.", { type: "warn" }); return; }
    const vehicles = vins.map(v => store.getVehicle(v)).filter(Boolean);
    try {
      await printVinLabels(vehicles);
    } catch (e) { notify(e.message || "No se pudo imprimir.", { type: "error" }); }
  });

  renderLabels();
}

export function renderLabels() {
  const tbody = document.querySelector("#lbl-table tbody");
  const empty = document.getElementById("lbl-empty");
  if (!tbody) return;
  const q = (document.getElementById("lbl-search").value || "").toLowerCase().trim();

  let list = store.listVehicles();
  if (q) {
    list = list.filter(v => [v.vin, v.make, v.model, v.color, v.plate]
      .filter(Boolean).some(f => String(f).toLowerCase().includes(q)));
  }
  list.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));

  empty.style.display = list.length ? "none" : "block";
  tbody.innerHTML = list.map(v => `
    <tr>
      <td><input type="checkbox" class="lbl-chk" data-vin="${escapeHtml(v.vin)}" /></td>
      <td><code>${escapeHtml(v.vin)}</code></td>
      <td>${escapeHtml(v.make || "")}</td>
      <td>${escapeHtml(v.model || "")}</td>
      <td>${escapeHtml(v.year || "")}</td>
      <td>${escapeHtml(v.currentLocation || "")}</td>
      <td><button class="btn lbl-one" data-vin="${escapeHtml(v.vin)}">🖨️ Imprimir</button></td>
    </tr>`).join("");

  tbody.querySelectorAll(".lbl-one").forEach(btn =>
    btn.addEventListener("click", async () => {
      const v = store.getVehicle(btn.dataset.vin);
      if (!v) return;
      try { await printVinLabel(v); }
      catch (e) { notify(e.message || "No se pudo imprimir.", { type: "error" }); }
    })
  );
}
