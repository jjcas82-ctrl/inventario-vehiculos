// reports.js — Reportes con filtros directamente en la app (sin depender de Excel).
import { store } from "./storage.js";
import { escapeHtml } from "./agencies.js";
import { EVENT_LABELS } from "./events.js";
import { allStages, isClosed, isSoldStage } from "./stages.js";
import { printReport } from "./pdf.js";

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
  document.getElementById("rep-print").addEventListener("click", () => {
    const sel = document.getElementById("rep-type");
    const titulo = "Reporte: " + (sel.options[sel.selectedIndex]?.text || "Inventario");
    try { printReport(titulo, lastCols, lastRows); }
    catch (e) { window.print(); }
  });
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
    cols = ["Fecha", "Tipo", "VIN", "Agencia", "Ubicación", "Entregó/Recibió", "Tipo persona", "Contacto", "Registró", "GPS"];
    rows = store.listEvents().filter(e => {
      const d = new Date(e.at);
      if (from && d < from) return false;
      if (to && d > to) return false;
      if (agency && e.agency !== agency) return false;
      const pname = e.person && e.person.name ? e.person.name : "";
      if (q && ![e.vin, e.location, e.agency, e.by, pname].filter(Boolean).some(f => String(f).toLowerCase().includes(q))) return false;
      return true;
    }).sort((a, b) => b.at.localeCompare(a.at)).map(e => [
      new Date(e.at).toLocaleString(), EVENT_LABELS[e.type] || e.type, e.vin, e.agency || "", e.location || "",
      e.person?.name || "", e.person?.type || "", e.person?.contact || "", e.by || "—",
      e.sinGps ? "⚠️ Sin GPS" : "OK",
    ]);
  }
  else if (type === "sold") {
    // Vendidas / Entregadas (solo consulta). Incluye las vendidas aún dentro y las
    // ya entregadas/cerradas que salieron.
    cols = ["VIN", "Marca", "Modelo", "Año", "Color", "Etapa", "Agencia", "Estado", "Salida", "Entregó/Recibió"];
    rows = store.listVehicles()
      .filter(v => isSoldStage(v.stage))
      .filter(v => !agency || v.currentAgency === agency)
      .filter(v => {
        if (!q) return true;
        return [v.vin, v.make, v.model, v.color].filter(Boolean).some(f => String(f).toLowerCase().includes(q));
      })
      .sort((a, b) => (b.exitAt || b.updatedAt || "").localeCompare(a.exitAt || a.updatedAt || ""))
      .map(v => {
        // Buscar el nombre de quien recibió en el último evento de salida.
        const salidas = store.eventsForVin(v.vin).filter(e => e.type === "exit");
        const ult = salidas.length ? salidas[salidas.length - 1] : null;
        const recibio = ult && ult.person && ult.person.name ? ult.person.name : "";
        return [
          v.vin, v.make || "", v.model || "", v.year || "", v.color || "",
          v.stage || "", v.currentAgency || "",
          v.status === "fuera" ? "Entregada/Salió" : "Dentro",
          v.exitAt ? new Date(v.exitAt).toLocaleString() : "",
          recibio,
        ];
      });
  }
  else if (type === "incomplete") {
    cols = ["VIN", "Marca", "Año", "Falta modelo", "Falta color", "Agencia"];
    rows = store.listVehicles().filter(matchVehicle)
      .filter(v => !v.model || !v.color)
      .map(v => [v.vin, v.make || "", v.year || "", v.model ? "" : "Sí", v.color ? "" : "Sí", v.currentAgency || ""]);
  }

  return { type, cols, rows };
}

// El resumen DEBE reflejar la selección actual (agencia/condición/etapa), no todo
// el inventario. Así, al cambiar de agencia, las cuentas cambian con el filtro.
function renderSummary(type, rows) {
  const el = document.getElementById("rep-summary");
  const agency = document.getElementById("rep-agency").value;
  const condition = document.getElementById("rep-condition").value;
  const stage = document.getElementById("rep-stage") ? document.getElementById("rep-stage").value : "";

  // Base: vehículos DENTRO que cumplen el filtro seleccionado.
  const dentro = store.listVehicles().filter(v => v.status === "dentro").filter(v => {
    if (agency && v.currentAgency !== agency) return false;
    if (condition && v.condition !== condition) return false;
    if (stage && v.stage !== stage) return false;
    return true;
  });
  const nuevos = dentro.filter(v => v.condition === "nuevo").length;
  const usados = dentro.filter(v => v.condition === "usado").length;

  const byAgency = {};
  dentro.forEach(v => { byAgency[v.currentAgency || "—"] = (byAgency[v.currentAgency || "—"] || 0) + 1; });

  // Etiqueta del alcance del resumen (qué selección se está mostrando).
  const alcance = agency ? agency : "Todas las agencias";

  el.innerHTML = `
    <div class="stat stat-wide"><b>${escapeHtml(alcance)}</b><span>Selección actual</span></div>
    <div class="stat"><b>${rows.length}</b><span>Filas en el reporte</span></div>
    <div class="stat"><b>${dentro.length}</b><span>Vehículos dentro (filtro)</span></div>
    <div class="stat"><b>${nuevos}</b><span>Nuevos</span></div>
    <div class="stat"><b>${usados}</b><span>Usados</span></div>
    ${agency ? "" : Object.entries(byAgency).map(([a, n]) =>
      `<div class="stat"><b>${n}</b><span>${escapeHtml(a)}</span></div>`).join("")}
  `;
}

// Muestra solo los filtros que aplican a cada tipo de reporte, para que no queden
// campos irrelevantes "arrastrando" valores de una selección anterior.
function applyFilterVisibility(type) {
  // Qué filtros aplican por tipo de reporte.
  const map = {
    inventory:  { agency: 1, condition: 1, stage: 1, from: 0, to: 0, days: 0, search: 1 },
    stages:     { agency: 1, condition: 1, stage: 0, from: 0, to: 0, days: 0, search: 1 },
    aging:      { agency: 1, condition: 1, stage: 1, from: 0, to: 0, days: 1, search: 1 },
    idle:       { agency: 1, condition: 1, stage: 1, from: 0, to: 0, days: 1, search: 1 },
    flow:       { agency: 1, condition: 0, stage: 0, from: 1, to: 1, days: 0, search: 1 },
    sold:       { agency: 1, condition: 0, stage: 0, from: 0, to: 0, days: 0, search: 1 },
    incomplete: { agency: 1, condition: 0, stage: 0, from: 0, to: 0, days: 0, search: 1 },
  };
  const cfg = map[type] || map.inventory;
  const fieldOf = (id) => {
    const el = document.getElementById(id);
    return el ? el.closest(".field") : null;
  };
  const toggle = (id, show) => {
    const f = fieldOf(id);
    if (!f) return;
    f.style.display = show ? "" : "none";
    // Si el filtro se oculta, limpiar su valor para que NO afecte al reporte.
    // Solo si tenía valor, para no re-disparar eventos innecesariamente.
    if (!show) { const el = document.getElementById(id); if (el && el.value) el.value = ""; }
  };
  toggle("rep-agency", cfg.agency);
  toggle("rep-condition", cfg.condition);
  toggle("rep-stage", cfg.stage);
  toggle("rep-from", cfg.from);
  toggle("rep-to", cfg.to);
  toggle("rep-days", cfg.days);
  toggle("rep-search", cfg.search);
}

function render() {
  // Ajusta qué filtros se ven según el tipo de reporte y limpia los no aplicables.
  applyFilterVisibility(document.getElementById("rep-type").value);
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
