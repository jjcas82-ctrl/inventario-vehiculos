// cdoui.js — Interfaz de carga del CDO: botón, modal, vista previa (nuevas/
// duplicadas/errores), barra de progreso y guardado masivo en "En tránsito".
// Optimizado para flotillas de 100+ unidades (paginación de la vista previa).

import { store } from "./storage.js";
import { parseCdoFile } from "./cdo.js";
import { parseFacturaXml, detectFacturaType, readTextFile } from "./factura.js";
import { notify } from "./ui.js";
import { escapeHtml } from "./agencies.js";
import { logAction } from "./syslog.js";
import * as auth from "./auth.js";

let lastParsed = null;   // { nuevas:[], duplicadas:[], errores:[] }
let onLoaded = () => {}; // callback para refrescar el inventario tras cargar

export function initCdoUpload(refreshCallback) {
  onLoaded = refreshCallback || (() => {});
  const btn = document.getElementById("cdo-upload-btn");
  const fileInput = document.getElementById("cdo-file");
  if (!btn || !fileInput) return;

  btn.addEventListener("click", () => {
    if (!auth.can("vehicle.edit")) {
      notify("Tu rol no permite cargar unidades.", { type: "warn" });
      return;
    }
    fileInput.value = "";
    fileInput.click();
  });
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files && fileInput.files[0];
    if (file) await handleFile(file);
  });

  document.getElementById("cdo-close").addEventListener("click", closeModal);
  document.getElementById("cdo-cancel").addEventListener("click", closeModal);
  document.getElementById("cdo-confirm").addEventListener("click", confirmLoad);
  document.getElementById("cdo-modal").addEventListener("click", (e) => {
    if (e.target.id === "cdo-modal") closeModal();
  });
}

function openModal() {
  const m = document.getElementById("cdo-modal");
  m.hidden = false; m.style.display = "flex";
}
function closeModal() {
  const m = document.getElementById("cdo-modal");
  m.hidden = true; m.style.display = "none";
  lastParsed = null;
}

async function handleFile(file) {
  openModal();
  const prog = document.getElementById("cdo-progress");
  const summary = document.getElementById("cdo-summary");
  const preview = document.getElementById("cdo-preview");
  const confirmBtn = document.getElementById("cdo-confirm");
  confirmBtn.hidden = true;
  summary.innerHTML = "";
  preview.innerHTML = "";
  prog.textContent = "Leyendo el PDF…";

  let result;
  const tipo = detectFacturaType(file);
  try {
    if (tipo === "xml") {
      // Factura de traspaso en XML (CFDI). Una unidad por archivo.
      prog.textContent = "Leyendo factura XML…";
      const xmlText = await readTextFile(file);
      const unidad = parseFacturaXml(xmlText);
      if (!unidad || unidad.error) {
        prog.textContent = "";
        preview.innerHTML = `<p style="color:var(--danger)">No se pudo leer la factura XML: ${escapeHtml(unidad?.error || "formato no reconocido")}.</p>`;
        return;
      }
      result = { units: [unidad], totalLines: 0, lines: [], method: "xml-factura", pageCount: 1, totals: null };
    } else {
      // PDF: puede ser el CDO de GM o una factura PDF de traspaso. El parser CDO
      // maneja ambos (si no detecta CDO, intenta sus métodos). 
      result = await parseCdoFile(file, (p, total) => {
        prog.textContent = `Leyendo página ${p} de ${total}…`;
      });
    }
  } catch (e) {
    prog.textContent = "";
    preview.innerHTML = `<p style="color:var(--danger)">No se pudo leer el archivo: ${escapeHtml(e.message || String(e))}.
      Acepta XML (factura de traspaso), o PDF del CDO. Si el problema persiste, el formato pudo cambiar.</p>`;
    return;
  }

  const paginasTxt = result.pageCount ? ` · ${result.pageCount} página(s)` : "";
  prog.textContent = `Analizadas ${result.totalLines} líneas${paginasTxt} (método: ${result.method}).`;
  if (result.method === "columnas") {
    prog.innerHTML += `<br><span style="color:#b45309">ℹ️ Este PDF viene en formato por columnas (se procesan todas las hojas). Se cargan VIN, factura, color y datos de facturación; el <b>modelo</b> se completará al dar entrada (al decodificar el VIN).</span>`;
  }

  // Clasificar: nuevas / duplicadas (ya existen) / errores (VIN inválido).
  const nuevas = [], duplicadas = [], errores = [];
  for (const u of result.units) {
    if (!u.vin || u.vin.length !== 17) { errores.push(u); continue; }
    if (store.getVehicle(u.vin)) duplicadas.push(u);
    else nuevas.push(u);
  }
  lastParsed = { nuevas, duplicadas, errores };

  // DIAGNÓSTICO: si no se detectó ninguna unidad, mostrar el texto crudo extraído
  // para poder ajustar el parser al formato real de este PDF.
  if (result.units.length === 0) {
    const raw = (result.lines || []).join("\n");
    summary.innerHTML = `<div class="stat"><b style="color:var(--danger)">0</b><span>Unidades detectadas</span></div>`;
    preview.innerHTML = `
      <p style="color:var(--danger)"><b>No se detectó ninguna unidad en el PDF.</b></p>
      <p class="hint">Esto suele pasar si el PDF está escaneado (imagen) o si el formato cambió.
      Copia el texto de abajo y compártelo para ajustar la lectura a tu archivo.</p>
      <div class="row gap wrap" style="margin:6px 0">
        <button id="cdo-copy-raw" class="btn btn-sm">📋 Copiar texto extraído</button>
        <span class="muted">${raw.length} caracteres · ${(result.lines || []).length} líneas</span>
      </div>
      <textarea id="cdo-raw" readonly style="width:100%;height:220px;font-family:ui-monospace,monospace;font-size:11px;white-space:pre;overflow:auto">${escapeHtml(raw || "(el PDF no devolvió texto: probablemente es una imagen escaneada)")}</textarea>`;
    const copyBtn = document.getElementById("cdo-copy-raw");
    if (copyBtn) copyBtn.addEventListener("click", () => {
      const ta = document.getElementById("cdo-raw");
      ta.select();
      try { navigator.clipboard.writeText(ta.value); notify("Texto copiado.", { type: "success" }); }
      catch (e) { document.execCommand("copy"); }
    });
    confirmBtn.hidden = true;
    return;
  }

  lastParsed.totals = result.totals || null;

  summary.innerHTML = `
    <div class="stat"><b>${result.units.length}</b><span>Detectadas</span></div>
    <div class="stat"><b style="color:var(--primary)">${nuevas.length}</b><span>Nuevas a cargar</span></div>
    <div class="stat"><b style="color:#b45309">${duplicadas.length}</b><span>Ya registradas</span></div>
    <div class="stat"><b style="color:var(--danger)">${errores.length}</b><span>Con error</span></div>`;

  preview.innerHTML =
    sectionTotales(result) +
    sectionNuevas(nuevas) +
    sectionDuplicadas(duplicadas) +
    sectionErrores(errores);

  // Enlaces "Ver unidad" para las duplicadas.
  preview.querySelectorAll(".cdo-see").forEach(a =>
    a.addEventListener("click", (e) => {
      e.preventDefault();
      closeModal();
      // Abre la ficha de la unidad existente (función global del inventario).
      if (window.__openVehicle) window.__openVehicle(a.dataset.vin);
    }));

  confirmBtn.hidden = nuevas.length === 0;
  confirmBtn.textContent = `✓ Cargar ${nuevas.length} unidad${nuevas.length === 1 ? "" : "es"} nueva${nuevas.length === 1 ? "" : "s"}`;
}

// --- Secciones de la vista previa (con paginación para volúmenes grandes) ---
const PAGE = 50;

function unitRow(u, i) {
  return `<tr><td>${i + 1}</td><td><code>${escapeHtml(u.vin)}</code></td>
    <td>${escapeHtml(u.make)}</td><td>${escapeHtml(u.model)}</td>
    <td>${escapeHtml(u.color)}</td><td>${escapeHtml(u.year)}</td>
    <td>${escapeHtml(u.factura)}</td><td style="text-align:right">${escapeHtml(u.total)}</td></tr>`;
}

function pagedTable(units, headExtra) {
  const shown = units.slice(0, PAGE).map(unitRow).join("");
  const more = units.length > PAGE
    ? `<tr><td colspan="8" class="muted">… y ${units.length - PAGE} más (se cargarán todas al confirmar).</td></tr>`
    : "";
  return `<div class="table-wrap" style="max-height:300px;overflow:auto">
    <table class="table"><thead><tr>
      <th>#</th><th>VIN</th><th>Marca</th><th>Modelo</th><th>Color</th><th>Año</th><th>Factura</th><th>Total</th>
    </tr></thead><tbody>${shown}${more}</tbody></table></div>`;
}

// Resumen de TOTALES del CDO + verificación de que cuadre con lo leído.
function sectionTotales(result) {
  const t = result.totals;
  if (!t) return "";
  const leido = result.units.length;
  const esperado = t.totalFacturas;
  // Verificación del conteo de unidades.
  let aviso = "";
  if (esperado != null) {
    if (leido === esperado) {
      aviso = `<p class="hint" style="color:#065f46">✓ El conteo cuadra: el CDO indica ${esperado} unidades y se leyeron ${leido}.</p>`;
    } else {
      aviso = `<p class="hint" style="color:var(--danger)">⚠️ El conteo NO cuadra: el CDO indica <b>${esperado}</b> unidades pero se leyeron <b>${leido}</b>. Revisa el documento antes de cargar.</p>`;
    }
  }
  const row = (lbl, val) => val ? `<div class="stat"><b>${escapeHtml(val)}</b><span>${lbl}</span></div>` : "";
  return `<h3>🧾 Totales del CDO</h3>
    ${aviso}
    <div class="summary">
      ${esperado != null ? `<div class="stat"><b>${esperado}</b><span>Total de facturas</span></div>` : ""}
      ${row("Precio (suma)", t.sumaPrecio)}
      ${row("ISAN (suma)", t.sumaIsan)}
      ${row("Gastos (suma)", t.sumaGastos)}
      ${row("IVA (suma)", t.sumaIva)}
      ${row("HB/Holdback (suma)", t.sumaHb)}
      ${row("Total general", t.sumaTotal)}
    </div>`;
}

function sectionNuevas(nuevas) {
  if (!nuevas.length) return "<h3>✅ Nuevas (0)</h3><p class='muted'>No hay unidades nuevas para cargar.</p>";
  return `<h3>✅ Nuevas a cargar (${nuevas.length})</h3>` + pagedTable(nuevas);
}

function sectionDuplicadas(dups) {
  if (!dups.length) return "";
  const rows = dups.slice(0, PAGE).map((u, i) => {
    const v = store.getVehicle(u.vin);
    const estado = v ? ({ dentro: "Dentro", fuera: "Fuera", transito: "En tránsito" }[v.status] || v.status || "—") : "—";
    return `<tr><td>${i + 1}</td><td><code>${escapeHtml(u.vin)}</code></td>
      <td>${escapeHtml(u.make || v?.make || "")}</td><td>${escapeHtml(u.model || v?.model || "")}</td>
      <td>${escapeHtml(estado)}</td>
      <td><a href="#" class="cdo-see" data-vin="${escapeHtml(u.vin)}">Ver unidad →</a></td></tr>`;
  }).join("");
  const more = dups.length > PAGE ? `<tr><td colspan="6" class="muted">… y ${dups.length - PAGE} más.</td></tr>` : "";
  return `<h3 style="color:#b45309">⚠️ Ya registradas (${dups.length}) — no se cargarán</h3>
    <p class="hint">Estas unidades ya existen. Valida si corresponde. No se duplicarán.</p>
    <div class="table-wrap" style="max-height:220px;overflow:auto">
      <table class="table"><thead><tr>
        <th>#</th><th>VIN</th><th>Marca</th><th>Modelo</th><th>Estado actual</th><th></th>
      </tr></thead><tbody>${rows}${more}</tbody></table></div>`;
}

function sectionErrores(errs) {
  if (!errs.length) return "";
  const rows = errs.map((u, i) =>
    `<tr><td>${i + 1}</td><td><code>${escapeHtml(u.vin || "")}</code></td>
      <td class="muted">${escapeHtml((u.raw || []).join(" | ").slice(0, 80))}</td></tr>`).join("");
  return `<h3 style="color:var(--danger)">❌ Con error de lectura (${errs.length})</h3>
    <p class="hint">No se pudo reconstruir un VIN válido de 17 caracteres. Revisa estas filas en el PDF.</p>
    <div class="table-wrap" style="max-height:180px;overflow:auto">
      <table class="table"><thead><tr><th>#</th><th>VIN leído</th><th>Texto origen</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
}

// --- Guardado masivo ---
function confirmLoad() {
  if (!lastParsed || !lastParsed.nuevas.length) return;
  const by = auth.currentUser()?.name || "—";
  const now = new Date().toISOString();

  const toSave = lastParsed.nuevas.map(u => ({
    vin: u.vin,
    make: u.make || "",
    model: u.model || "",
    powertrain: u.version || u.powertrain || "",
    color: u.color || "",
    year: u.year || "",
    status: "transito",       // ← estatus inicial: en tránsito
    condition: "nuevo",
    origin: u.origin || "CDO", // "CDO" (planta) o "Traspaso" (otra agencia)
    transitAt: now,
    transitBy: by,
    // Datos propios del TRASPASO (si vinieron de una factura XML/PDF).
    emisor: u.emisor || "",
    emisorRfc: u.emisorRfc || "",
    folioFiscal: u.folioFiscal || "",
    claveVehicular: u.claveVehicular || "",
    transmission: u.transmission || "",
    // Campos del encabezado de facturación del CDO (solo lectura en la ficha).
    ov: u.ov || "",
    cveVeh: u.cveVeh || "",
    factura: u.factura || "",
    numMov: u.numMov || "",
    aduana: u.aduana || "",
    pedimento: u.pedimento || "",
    fechaPedimento: u.fechaPedimento || "",
    modeloGm: u.modeloGm || "",
    fechaFactura: u.fechaFactura || "",
    // Importes financieros del CDO (visibles solo a auditor/capturista/admin).
    pq: u.pq || "",
    precio: u.precio || "",
    isan: u.isan || "",
    gastos: u.gastos || "",
    iva: u.iva || "",
    hb: u.hb || "",
    total: u.total || "",
  }));

  const { added, skipped } = store.bulkUpsertVehicles(toSave, { skipExisting: true });
  const origenTxt = lastParsed.nuevas[0]?.origin === "Traspaso" ? "traspaso" : "CDO";
  logAction("cdo.load", `Cargadas ${added.length} unidades en tránsito (${origenTxt})` +
    (skipped.length ? ` · ${skipped.length} omitidas por existir` : ""), by);

  notify(`Se cargaron ${added.length} unidades en tránsito.` +
    (skipped.length ? ` ${skipped.length} ya existían y se omitieron.` : ""),
    { type: "success", timeout: 6000 });

  closeModal();
  onLoaded();
}
