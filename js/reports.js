// reports.js — Reportes con filtros directamente en la app (sin depender de Excel).
import { store } from "./storage.js";
import { escapeHtml } from "./agencies.js";
import { EVENT_LABELS } from "./events.js";
import { allStages } from "./stages.js";

let lastRows = [];   // filas actuales (para copiar/exportar)
let lastCols = [];   // columnas actuales
let sortState = { col: null, dir: 1 };

export function initReports() {
  const ids = ["rep-type", "rep-agency", "rep-condition", "rep-stage", "rep-from", "rep-to", "rep-days", "rep-search"];
  ids.forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener("input", render);
    el.addEventListener("change", render);
  });
  document.getElementById("rep-print").addEventListener("click", () => window.print());
  document.getElementById("rep-copy").addEventListener("click", copyForExcel);
  document.getElementById("rep-csv").addEventListener("click", exportCsv);
  // Poblar filtro de etapa
  const stSel = document.getElementById("rep-stage");
  if (stSel) stSel.innerHTML = '<option value="">Todas</option>' +
    allStages().map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("");
  refreshReportAgencies();
  render();
}

export function refreshReportAgencies() {
  const sel = document.getElementById("rep-agency");
  const cur = sel.value;
  sel.innerHTML = '<option value="">Todas las agencias</option>' +
    store.listAgencies().map(a => `<option value="${escapeHtml(a.name)}">${escapeHtml(a.name)}</option>`).join("");
  sel.value = cur;
}

function daysBetween(a, b) {
  return Math.floor((b - a) / (1000 * 60 * 60 * 24));
}

function lastEntryDate(vin) {
  const evs = store.eventsForVin(vin).filter(e => e.type === "entry");
  return evs.length ? new Date(evs[evs.length - 1].at) : null;
}
function lastMoveDate(vin) {
  const evs = store.eventsForVin(vin);
  return evs.length ? new Date(evs[evs.length - 1].at) : null;
}

function buildData() {
  const type = document.getElementById("rep-type").value;
  const agency = document.getElementById("rep-agency").value;
  const condition = document.getElementById("rep-condition").value;
  const stage = document.getElementById("rep-stage") ? document.getElementById("rep-stage").value : "";
  const from = document.getElementById("rep-from").value ? new Date(document.getElementById("rep-from").value) : null;
  const to = document.getElementById("rep-to").value ? new Date(document.getElementById("rep-to").value + "T23:59:59") : null;
  const minDays = parseInt(document.getElementById("rep-days").value, 10) || 0;
  const q = (document.getElementById("rep-search").value || "").toLowerCase().trim();
  const now = new Date();

  const matchVehicle = (v) => {
    if (agency && v.currentAgency !== agency) return false;
    if (condition && v.condition !== condition) return false;
    if (stage && v.stage !== stage) return false;
    if (q && ![v.vin, v.make, v.model, v.color, v.plate].filter(Boolean)
      .some(f => String(f).toLowerCase().includes(q))) return false;
    return true;
  };

  let cols = [], rows = [];

  if (type === "inventory") {
    cols = ["VIN", "Marca", "Modelo", "Año modelo", "Color", "No. de motor", "Kilometraje", "Tipo",
            "Ubicación", "Etapa", "Condición", "Agencia", "Ingreso", "Registró", "Estado"];
    rows = store.listVehicles().filter(v => v.status !== "fuera").filter(matchVehicle).map(v => [
      v.vin, v.make || "", v.model || "", v.year || "", v.color || "",
      v.engineNo || "", (v.mileage != null && v.mileage !== "" ? v.mileage : ""), v.vehType || v.bodyClass || "",
      v.currentLocation || "", v.stage || "", v.condition || "", v.currentAgency || "",
      v.entryAt ? new Date(v.entryAt).toLocaleString() : "", v.entryBy || v.lastBy || "",
      v.status || "",
    ]);
  }
  else if (type === "stages") {
    // Resumen: cuántas unidades dentro hay en cada etapa.
    cols = ["Etapa", "Unidades", "Nuevos", "Usados"];
    const dentro = store.listVehicles().filter(v => v.status !== "fuera").filter(matchVehicle);
    const byStage = {};
    dentro.forEach(v => {
      const s = v.stage || "Sin etapa";
      byStage[s] = byStage[s] || { total: 0, nuevo: 0, usado: 0 };
      byStage[s].total++;
      if (v.condition === "usado") byStage[s].usado++; else byStage[s].nuevo++;
    });
    rows = Object.entries(byStage).map(([s, c]) => [s, c.total, c.nuevo, c.usado]);
  }
  else if (type === "aging") {
    cols = ["VIN", "Marca", "Modelo", "Agencia", "Ubicación", "Días en inventario"];
    rows = store.listVehicles().filter(v => v.status !== "fuera").filter(matchVehicle).map(v => {
      const entry = lastEntryDate(v.vin);
      const d = entry ? daysBetween(entry, now) : 0;
      return { d, row: [v.vin, v.make || "", v.model || "", v.currentAgency || "", v.currentLocation || "", d] };
    }).filter(x => x.d >= minDays).sort((a, b) => b.d - a.d).map(x => x.row);
  }
  else if (type === "idle") {
    cols = ["VIN", "Marca", "Modelo", "Agencia", "Ubicación", "Días sin movimiento"];
    rows = store.listVehicles().filter(v => v.status !== "fuera").filter(matchVehicle).map(v => {
      const last = lastMoveDate(v.vin);
      const d = last ? daysBetween(last, now) : 0;
      return { d, row: [v.vin, v.make || "", v.model || "", v.currentAgency || "", v.currentLocation || "", d] };
    }).filter(x => x.d >= minDays).sort((a, b) => b.d - a.d).map(x => x.row);
  }
  else if (type === "flow") {
    cols = ["Fecha", "Tipo", "VIN", "Agencia", "Ubicación", "Registró", "GPS"];
    rows = store.listEvents().filter(e => {
      const d = new Date(e.at);
      if (from && d < from) return false;
      if (to && d > to) return false;
      if (agency && e.agency !== agency) return false;
      if (q && ![e.vin, e.location, e.agency, e.by].filter(Boolean).some(f => String(f).toLowerCase().includes(q))) return false;
      return true;
    }).sort((a, b) => b.at.localeCompare(a.at)).map(e => [
      new Date(e.at).toLocaleString(), EVENT_LABELS[e.type] || e.type, e.vin, e.agency || "", e.location || "", e.by || "—",
      e.sinGps ? "⚠️ Sin GPS" : "OK",
    ]);
  }
  else if (type === "incomplete") {
    cols = ["VIN", "Marca", "Año", "Falta modelo", "Falta color", "Agencia"];
    rows = store.listVehicles().filter(matchVehicle)
      .filter(v => !v.model || !v.color)
      .map(v => [v.vin, v.make || "", v.year || "", v.model ? "" : "Sí", v.color ? "" : "Sí", v.currentAgency || ""]);
  }

  return { type, cols, rows };
}

function renderSummary(type, rows) {
  const el = document.getElementById("rep-summary");
  const vehicles = store.listVehicles();
  const dentro = vehicles.filter(v => v.status === "dentro");
  const nuevos = dentro.filter(v => v.condition === "nuevo").length;
  const usados = dentro.filter(v => v.condition === "usado").length;

  const byAgency = {};
  dentro.forEach(v => { byAgency[v.currentAgency || "—"] = (byAgency[v.currentAgency || "—"] || 0) + 1; });

  el.innerHTML = `
    <div class="stat"><b>${rows.length}</b><span>Filas en el reporte</span></div>
    <div class="stat"><b>${dentro.length}</b><span>Vehículos dentro</span></div>
    <div class="stat"><b>${nuevos}</b><span>Nuevos</span></div>
    <div class="stat"><b>${usados}</b><span>Usados</span></div>
    ${Object.entries(byAgency).map(([a, n]) =>
      `<div class="stat"><b>${n}</b><span>${escapeHtml(a)}</span></div>`).join("")}
  `;
}

function render() {
  const { type, cols, rows } = buildData();
  lastCols = cols; lastRows = rows;

  // Ordenamiento
  if (sortState.col != null && sortState.col < cols.length) {
    const c = sortState.col, dir = sortState.dir;
    rows.sort((a, b) => {
      const x = a[c], y = b[c];
      const nx = Number(x), ny = Number(y);
      if (!isNaN(nx) && !isNaN(ny)) return (nx - ny) * dir;
      return String(x).localeCompare(String(y)) * dir;
    });
  }

  const thead = document.querySelector("#rep-table thead");
  const tbody = document.querySelector("#rep-table tbody");
  thead.innerHTML = "<tr>" + cols.map((c, i) => {
    const arrow = sortState.col === i ? (sortState.dir === 1 ? " ▲" : " ▼") : "";
    return `<th data-col="${i}">${escapeHtml(c)}${arrow}</th>`;
  }).join("") + "</tr>";
  tbody.innerHTML = rows.map(r =>
    "<tr>" + r.map(c => `<td>${escapeHtml(c)}</td>`).join("") + "</tr>"
  ).join("");

  thead.querySelectorAll("th").forEach(th =>
    th.addEventListener("click", () => {
      const col = Number(th.dataset.col);
      if (sortState.col === col) sortState.dir *= -1;
      else { sortState.col = col; sortState.dir = 1; }
      render();
    })
  );

  renderSummary(type, rows);
}

function toTSV() {
  return [lastCols.join("\t"), ...lastRows.map(r => r.join("\t"))].join("\n");
}
function toCSV() {
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [lastCols.map(esc).join(","), ...lastRows.map(r => r.map(esc).join(","))].join("\n");
}

async function copyForExcel() {
  const btn = document.getElementById("rep-copy");
  try {
    await navigator.clipboard.writeText(toTSV());
    btn.textContent = "Copiado ✓";
  } catch (e) {
    // Fallback
    const ta = document.createElement("textarea");
    ta.value = toTSV(); document.body.appendChild(ta); ta.select();
    document.execCommand("copy"); ta.remove();
    btn.textContent = "Copiado ✓";
  }
  setTimeout(() => (btn.textContent = "Copiar para Excel"), 1500);
}

function exportCsv() {
  const blob = new Blob(["\uFEFF" + toCSV()], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "reporte-" + new Date().toISOString().slice(0, 10) + ".csv";
  a.click();
  URL.revokeObjectURL(url);
}

export { render as renderReports };
