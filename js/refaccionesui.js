// refaccionesui.js — Interfaz del inventario de REFACCIONES (Fase 1):
//   1) Cargar EXISTENCIAS (CSV) + MARBETES (PDF) del sistema interno.
//   2) CRUZAR por número de parte y mostrar vista previa.
//   3) Guardar el cruce en el inventario de partes (store.bulkUpsertParts).
//   4) Imprimir ETIQUETAS QR (Janel 32×64, 12/hoja).
//   5) CONTEO físico: escanear QR (o teclear nº de parte) + teclear la cantidad.
//   6) Reporte de DIFERENCIAS (conteo vs. existencia del sistema).
//
// Es un módulo autónomo que vive dentro del mismo sistema que el inventario de
// vehículos; usa su propio namespace de almacenamiento (store.*Parts).

import { store } from "./storage.js";
import {
  parseExistenciasCsv, parseMarbetesFile, cruzar,
  parsePartQr, printPartLabels,
} from "./refacciones.js";
import { Scanner } from "./scanner.js";
import { notify } from "./ui.js";
import { escapeHtml } from "./agencies.js";
import { logAction } from "./syslog.js";
import * as auth from "./auth.js";

let initialized = false;
let scanner = null;
let lastCruce = null;        // resultado del último cruce (para confirmar carga)
let existencias = [];        // existencias parseadas pendientes de cruzar
let marbetes = [];           // marbetes parseados pendientes de cruzar
let audioCtx = null;

export function initRefacciones() {
  if (initialized) return;
  initialized = true;

  // --- Carga de archivos ---
  const btnExist = document.getElementById("ref-existencias-btn");
  const fileExist = document.getElementById("ref-existencias-file");
  const btnMarb = document.getElementById("ref-marbetes-btn");
  const fileMarb = document.getElementById("ref-marbetes-file");

  if (btnExist && fileExist) {
    btnExist.addEventListener("click", () => { fileExist.value = ""; fileExist.click(); });
    fileExist.addEventListener("change", async () => {
      const f = fileExist.files && fileExist.files[0];
      if (f) await cargarExistencias(f);
    });
  }
  if (btnMarb && fileMarb) {
    btnMarb.addEventListener("click", () => { fileMarb.value = ""; fileMarb.click(); });
    fileMarb.addEventListener("change", async () => {
      const f = fileMarb.files && fileMarb.files[0];
      if (f) await cargarMarbetes(f);
    });
  }

  // --- Acciones del cruce ---
  const btnCruzar = document.getElementById("ref-cruzar");
  if (btnCruzar) btnCruzar.addEventListener("click", hacerCruce);
  const btnConfirmar = document.getElementById("ref-confirmar");
  if (btnConfirmar) btnConfirmar.addEventListener("click", confirmarCarga);
  const btnLimpiar = document.getElementById("ref-limpiar");
  if (btnLimpiar) btnLimpiar.addEventListener("click", limpiarCarga);

  // --- Etiquetas ---
  const btnEtq = document.getElementById("ref-etiquetas");
  if (btnEtq) btnEtq.addEventListener("click", imprimirEtiquetas);
  const btnEtqPrueba = document.getElementById("ref-etiquetas-prueba");
  if (btnEtqPrueba) btnEtqPrueba.addEventListener("click", () => imprimirEtiquetas(true));

  // --- Conteo ---
  const btnScan = document.getElementById("ref-scan");
  const btnScanStop = document.getElementById("ref-scan-stop");
  const btnManual = document.getElementById("ref-conteo-manual-btn");
  if (btnScan) btnScan.addEventListener("click", startScan);
  if (btnScanStop) btnScanStop.addEventListener("click", stopScan);
  if (btnManual) btnManual.addEventListener("click", registrarConteoManual);
  const inpManual = document.getElementById("ref-conteo-parte");
  if (inpManual) inpManual.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); document.getElementById("ref-conteo-cant")?.focus(); }
  });
  const inpCant = document.getElementById("ref-conteo-cant");
  if (inpCant) inpCant.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); registrarConteoManual(); }
  });

  // --- Reporte de diferencias ---
  const btnDiffPdf = document.getElementById("ref-diff-pdf");
  if (btnDiffPdf) btnDiffPdf.addEventListener("click", imprimirDiferencias);
  const btnDiffCsv = document.getElementById("ref-diff-csv");
  if (btnDiffCsv) btnDiffCsv.addEventListener("click", exportarDiferenciasCsv);
  const btnReset = document.getElementById("ref-reset-conteo");
  if (btnReset) btnReset.addEventListener("click", reiniciarConteo);

  const video = document.getElementById("ref-video");
  if (video) {
    scanner = new Scanner(video, {
      onResult: (text) => handleScan(text),
      onStatus: (msg, kind) => setScanStatus(msg, kind),
    });
  }
}

// Se llama cada vez que se abre la pestaña de refacciones.
export function renderRefacciones() {
  if (!initialized) return;
  renderCargaResumen();
  renderConteo();
  renderDiferencias();
}

export function stopRefacciones() { try { stopScan(); } catch (e) {} }

// ======================= CARGA =======================

async function cargarExistencias(file) {
  setCargaStatus("Leyendo archivo de existencias…", "info");
  try {
    const text = await readTextFile(file);
    existencias = parseExistenciasCsv(text);
    setCargaStatus(`✓ Existencias leídas: ${existencias.length} partes.`, "ok");
  } catch (e) {
    existencias = [];
    setCargaStatus("No se pudo leer el archivo de existencias: " + (e.message || e), "error");
  }
  renderCargaResumen();
}

async function cargarMarbetes(file) {
  setCargaStatus("Leyendo PDF de marbetes… (puede tardar en archivos grandes)", "info");
  try {
    marbetes = await parseMarbetesFile(file, (p, total) => {
      setCargaStatus(`Leyendo marbetes: página ${p} de ${total}…`, "info");
    });
    const reales = marbetes.filter(m => !m.enBlanco).length;
    const blanco = marbetes.filter(m => m.enBlanco).length;
    setCargaStatus(`✓ Marbetes leídos: ${reales} partes${blanco ? ` · ${blanco} marbete(s) en blanco` : ""}.`, "ok");
  } catch (e) {
    marbetes = [];
    setCargaStatus("No se pudo leer el PDF de marbetes: " + (e.message || e), "error");
  }
  renderCargaResumen();
}

function hacerCruce() {
  if (!marbetes.length && !existencias.length) {
    notify("Primero carga el archivo de existencias y/o el PDF de marbetes.", { type: "warn" });
    return;
  }
  lastCruce = cruzar(marbetes, existencias);
  renderCrucePreview(lastCruce);
  const btnConfirmar = document.getElementById("ref-confirmar");
  if (btnConfirmar) btnConfirmar.hidden = !(lastCruce.items.length || lastCruce.soloExistencia.length);
}

function confirmarCarga() {
  if (!lastCruce) return;
  if (!auth.can || !puedeEditar()) {
    notify("Tu rol no permite cargar inventario de refacciones.", { type: "warn" });
    return;
  }
  const by = auth.currentUser()?.name || "—";

  // Unimos los items del cruce (marbetes) + las partes solo-existencia en una
  // sola lista para guardar. Se mantiene el conteo previo si ya existía (merge).
  const toSave = [];
  for (const it of lastCruce.items) {
    if (it.enBlanco) continue;              // marbetes en blanco no son partes reales
    if (!it.numParte) continue;
    toSave.push({
      numParte: it.numParte,
      descripcion: it.descripcion || "",
      ubicacion: it.ubicacion || "",
      grupo: it.grupo || "",
      marbete: it.marbete || "",
      existencia: it.existencia,
      enMarbetes: true,
      enExistencias: it.enExistencias,
      origin: "cruce",
    });
  }
  for (const it of lastCruce.soloExistencia) {
    toSave.push({
      numParte: it.numParte,
      descripcion: it.descripcion || "",
      ubicacion: it.ubicacion || "",
      grupo: it.grupo || "",
      marbete: "",
      existencia: it.existencia,
      enMarbetes: false,
      enExistencias: true,
      origin: "existencias",
    });
  }

  const res = store.bulkUpsertParts(toSave, { merge: true });
  logAction("parts.load", `Refacciones cargadas: ${res.added} nuevas · ${res.updated} actualizadas`, by);
  notify(`Inventario de refacciones cargado: ${res.added} nuevas, ${res.updated} actualizadas.`,
    { type: "success", timeout: 6000 });

  // Limpia los buffers de archivos (ya quedaron en el store), conserva la vista.
  existencias = []; marbetes = []; lastCruce = null;
  const btnConfirmar = document.getElementById("ref-confirmar");
  if (btnConfirmar) btnConfirmar.hidden = true;
  renderCargaResumen();
  renderConteo();
  renderDiferencias();
}

function limpiarCarga() {
  existencias = []; marbetes = []; lastCruce = null;
  const prev = document.getElementById("ref-cruce-preview");
  if (prev) prev.innerHTML = "";
  const btnConfirmar = document.getElementById("ref-confirmar");
  if (btnConfirmar) btnConfirmar.hidden = true;
  setCargaStatus("", "info");
  renderCargaResumen();
}

function renderCargaResumen() {
  const el = document.getElementById("ref-carga-resumen");
  if (!el) return;
  const enStore = store.listParts().length;
  el.innerHTML = `
    <div class="stat"><b>${existencias.length}</b><span>Existencias cargadas</span></div>
    <div class="stat"><b>${marbetes.filter(m => !m.enBlanco).length}</b><span>Marbetes leídos</span></div>
    <div class="stat"><b style="color:var(--primary)">${enStore}</b><span>Partes en inventario</span></div>`;
}

function renderCrucePreview(c) {
  const el = document.getElementById("ref-cruce-preview");
  if (!el) return;
  const r = c.resumen;
  const PAGE = 60;

  const filas = c.items.slice(0, PAGE).map((it, i) => {
    const estado = it.enBlanco
      ? `<span style="color:#b45309">Marbete en blanco</span>`
      : (it.enExistencias
          ? `<span style="color:#065f46">✓ Con existencia</span>`
          : `<span style="color:var(--danger)">Solo marbete</span>`);
    return `<tr>
      <td>${i + 1}</td>
      <td><code>${escapeHtml(it.numParte || "—")}</code></td>
      <td>${escapeHtml((it.descripcion || "").slice(0, 50))}</td>
      <td><code>${escapeHtml(it.ubicacion || "")}</code></td>
      <td style="text-align:right">${it.existencia == null ? "—" : escapeHtml(String(it.existencia))}</td>
      <td>${estado}</td>
    </tr>`;
  }).join("");
  const more = c.items.length > PAGE
    ? `<tr><td colspan="6" class="muted">… y ${c.items.length - PAGE} más (todas se cargarán al confirmar).</td></tr>`
    : "";

  const soloExist = c.soloExistencia.length
    ? `<p class="hint" style="color:#b45309">⚠️ ${c.soloExistencia.length} parte(s) en existencias <b>sin marbete</b> (se cargarán, pero no tendrán etiqueta ni renglón de conteo físico).</p>`
    : "";

  el.innerHTML = `
    <h3>Vista previa del cruce</h3>
    <div class="summary">
      <div class="stat"><b>${r.totalMarbetes}</b><span>Marbetes</span></div>
      <div class="stat"><b>${r.totalExistencias}</b><span>Existencias</span></div>
      <div class="stat"><b style="color:#065f46">${r.conAmbos}</b><span>Con ambos</span></div>
      <div class="stat"><b style="color:var(--danger)">${r.soloMarbete}</b><span>Solo marbete</span></div>
      <div class="stat"><b style="color:#b45309">${r.soloExistencia}</b><span>Solo existencia</span></div>
      ${r.enBlanco ? `<div class="stat"><b>${r.enBlanco}</b><span>En blanco</span></div>` : ""}
    </div>
    ${soloExist}
    <div class="table-wrap" style="max-height:340px;overflow:auto">
      <table class="table"><thead><tr>
        <th>#</th><th>No. parte</th><th>Descripción</th><th>Ubicación</th><th>Existencia</th><th>Estado</th>
      </tr></thead><tbody>${filas}${more}</tbody></table>
    </div>`;
}

// ======================= ETIQUETAS =======================

async function imprimirEtiquetas(prueba = false) {
  const lista = store.listParts().filter(p => p.numParte);
  if (!lista.length) { notify("No hay partes en el inventario. Carga existencias/marbetes primero.", { type: "warn" }); return; }
  try {
    await printPartLabels(lista, {
      prueba,
      margenSup: numVal("ref-etq-sup", 12),
      margenIzq: numVal("ref-etq-izq", 6),
      sepH: numVal("ref-etq-seph", 2),
      sepV: numVal("ref-etq-sepv", 2),
    });
  } catch (e) {
    notify(e.message || String(e), { type: "error" });
  }
}

function numVal(id, def) {
  const el = document.getElementById(id);
  if (!el) return def;
  const n = Number(el.value);
  return Number.isFinite(n) ? n : def;
}

// ======================= CONTEO FÍSICO =======================

async function startScan() {
  if (!scanner) return;
  try {
    await scanner.start();
    document.getElementById("ref-scanner-wrap").hidden = false;
    document.getElementById("ref-scan").hidden = true;
    document.getElementById("ref-scan-stop").hidden = false;
  } catch (e) { /* el scanner ya avisa */ }
}
function stopScan() {
  if (scanner) scanner.stop();
  const wrap = document.getElementById("ref-scanner-wrap");
  if (wrap) wrap.hidden = true;
  const b1 = document.getElementById("ref-scan");
  const b2 = document.getElementById("ref-scan-stop");
  if (b1) b1.hidden = false;
  if (b2) b2.hidden = true;
}

// Al escanear un QR de parte: rellena el número de parte y enfoca la cantidad.
function handleScan(text) {
  const p = parsePartQr(text);
  if (!p || !p.numParte) { setScanStatus("Código no reconocido.", "error"); beep(false); return; }
  const inp = document.getElementById("ref-conteo-parte");
  const cant = document.getElementById("ref-conteo-cant");
  if (inp) inp.value = p.numParte;
  beep(true);
  const existente = store.getPart(p.numParte);
  if (existente) {
    setScanStatus(`✓ ${p.numParte} — ${existente.descripcion || p.descripcion || ""}. Teclea la cantidad contada.`, "ok");
  } else {
    setScanStatus(`⚠️ ${p.numParte} no está en el inventario cargado. Puedes contarla igual.`, "warn");
  }
  if (cant) { cant.value = ""; cant.focus(); }
}

function registrarConteoManual() {
  const inp = document.getElementById("ref-conteo-parte");
  const cantEl = document.getElementById("ref-conteo-cant");
  const numParte = (inp?.value || "").trim();
  if (!numParte) { notify("Escanea o escribe el número de parte.", { type: "warn" }); inp?.focus(); return; }
  const cantRaw = (cantEl?.value || "").trim();
  if (cantRaw === "") { notify("Teclea la cantidad contada.", { type: "warn" }); cantEl?.focus(); return; }
  const conteo = Number(cantRaw);
  if (!Number.isFinite(conteo) || conteo < 0) { notify("La cantidad debe ser un número válido (0 o más).", { type: "warn" }); cantEl?.focus(); return; }

  const by = auth.currentUser()?.name || "—";
  let p = store.getPart(numParte);
  if (!p) {
    // Parte contada que no estaba en el inventario cargado: se da de alta.
    store.upsertPart({ numParte, descripcion: "", ubicacion: "", existencia: null, enMarbetes: false, enExistencias: false, origin: "conteo" });
  }
  p = store.setPartConteo(numParte, conteo, by);
  logAction("parts.count", `Conteo de ${numParte}: ${conteo}`, by);
  beep(true);
  setScanStatus(`✓ Contada ${numParte}: ${conteo}.`, "ok");
  if (inp) inp.value = "";
  if (cantEl) cantEl.value = "";
  if (inp) inp.focus();
  renderConteo();
  renderDiferencias();
}

function reiniciarConteo() {
  const partes = store.listParts().filter(p => p.conteo != null);
  if (!partes.length) { notify("No hay conteos registrados.", { type: "info" }); return; }
  if (!confirm(`¿Borrar el conteo físico de ${partes.length} parte(s)? El inventario cargado (existencias) se conserva.`)) return;
  const by = auth.currentUser()?.name || "—";
  for (const p of partes) {
    store.upsertPart({ numParte: p.numParte, conteo: null, conteoBy: null, conteoAt: null });
  }
  logAction("parts.count.reset", `Conteo reiniciado (${partes.length} partes)`, by);
  notify("Conteo físico reiniciado.", { type: "success" });
  renderConteo();
  renderDiferencias();
}

function renderConteo() {
  const el = document.getElementById("ref-conteo-resumen");
  if (!el) return;
  const all = store.listParts();
  const contadas = all.filter(p => p.conteo != null).length;
  const pendientes = all.filter(p => p.conteo == null && p.enMarbetes !== false).length;
  el.innerHTML = `
    <div class="stat"><b>${all.length}</b><span>Partes en inventario</span></div>
    <div class="stat"><b style="color:var(--primary)">${contadas}</b><span>Contadas</span></div>
    <div class="stat"><b style="color:#b45309">${pendientes}</b><span>Pendientes (con marbete)</span></div>`;

  // Tabla de las últimas contadas (orden por fecha de conteo descendente).
  const tbody = document.querySelector("#ref-conteo-table tbody");
  if (tbody) {
    const recientes = all.filter(p => p.conteo != null)
      .sort((a, b) => String(b.conteoAt || "").localeCompare(String(a.conteoAt || "")))
      .slice(0, 50);
    tbody.innerHTML = recientes.map(p => {
      const dif = diffValor(p);
      return `<tr>
        <td><code>${escapeHtml(p.numParte)}</code></td>
        <td>${escapeHtml((p.descripcion || "").slice(0, 40))}</td>
        <td style="text-align:right">${p.existencia == null ? "—" : escapeHtml(String(p.existencia))}</td>
        <td style="text-align:right"><b>${escapeHtml(String(p.conteo))}</b></td>
        <td style="text-align:right">${difBadge(dif)}</td>
      </tr>`;
    }).join("");
  }
}

// ======================= DIFERENCIAS =======================

// Diferencia = conteo físico − existencia del sistema. null si falta algún dato.
function diffValor(p) {
  if (p.conteo == null || p.existencia == null) return null;
  return p.conteo - p.existencia;
}
function difBadge(dif) {
  if (dif == null) return `<span class="muted">—</span>`;
  if (dif === 0) return `<span style="color:#065f46">0</span>`;
  const signo = dif > 0 ? "+" : "";
  const color = dif > 0 ? "#b45309" : "var(--danger)";
  return `<b style="color:${color}">${signo}${dif}</b>`;
}

// Devuelve SOLO las partes con diferencia (conteo ≠ existencia) o sin dato para
// comparar (contada sin existencia, o con existencia pero sin contar).
function listaDiferencias() {
  const all = store.listParts();
  const out = [];
  for (const p of all) {
    const dif = diffValor(p);
    if (dif != null) {
      if (dif !== 0) out.push({ ...p, dif, tipo: dif > 0 ? "sobrante" : "faltante" });
    } else {
      // Falta un dato para comparar: lo reportamos como pendiente/sin-dato.
      if (p.conteo != null && p.existencia == null) out.push({ ...p, dif: null, tipo: "sin-existencia" });
      else if (p.conteo == null && p.existencia != null && p.enMarbetes !== false) out.push({ ...p, dif: null, tipo: "sin-contar" });
    }
  }
  // Orden: faltantes primero, luego sobrantes, luego sin dato; por magnitud.
  const rank = { faltante: 0, sobrante: 1, "sin-existencia": 2, "sin-contar": 3 };
  out.sort((a, b) => (rank[a.tipo] - rank[b.tipo]) || (Math.abs(b.dif || 0) - Math.abs(a.dif || 0)));
  return out;
}

function renderDiferencias() {
  const el = document.getElementById("ref-diff-resumen");
  const tbody = document.querySelector("#ref-diff-table tbody");
  if (!el && !tbody) return;
  const difs = listaDiferencias();
  const faltantes = difs.filter(d => d.tipo === "faltante").length;
  const sobrantes = difs.filter(d => d.tipo === "sobrante").length;
  const sinContar = difs.filter(d => d.tipo === "sin-contar").length;
  const sinExist = difs.filter(d => d.tipo === "sin-existencia").length;

  if (el) el.innerHTML = `
    <div class="stat"><b style="color:var(--danger)">${faltantes}</b><span>Faltantes</span></div>
    <div class="stat"><b style="color:#b45309">${sobrantes}</b><span>Sobrantes</span></div>
    <div class="stat"><b>${sinContar}</b><span>Sin contar</span></div>
    <div class="stat"><b>${sinExist}</b><span>Contadas sin existencia</span></div>`;

  if (tbody) {
    tbody.innerHTML = difs.map(d => `
      <tr>
        <td><code>${escapeHtml(d.numParte)}</code></td>
        <td>${escapeHtml((d.descripcion || "").slice(0, 45))}</td>
        <td><code>${escapeHtml(d.ubicacion || "")}</code></td>
        <td style="text-align:right">${d.existencia == null ? "—" : escapeHtml(String(d.existencia))}</td>
        <td style="text-align:right">${d.conteo == null ? "—" : escapeHtml(String(d.conteo))}</td>
        <td style="text-align:right">${difBadge(d.dif)}</td>
        <td>${tipoLabel(d.tipo)}</td>
      </tr>`).join("");
    const empty = document.getElementById("ref-diff-empty");
    if (empty) empty.style.display = difs.length ? "none" : "";
  }
}

function tipoLabel(t) {
  return {
    faltante: `<span style="color:var(--danger)">Faltante</span>`,
    sobrante: `<span style="color:#b45309">Sobrante</span>`,
    "sin-contar": `<span class="muted">Sin contar</span>`,
    "sin-existencia": `<span class="muted">Contada sin existencia</span>`,
  }[t] || t;
}

function imprimirDiferencias() {
  const difs = listaDiferencias();
  if (!difs.length) { notify("No hay diferencias que reportar. ¡El conteo cuadra!", { type: "success" }); return; }
  const by = auth.currentUser()?.name || "—";
  const fecha = new Date().toLocaleString();
  const filas = difs.map(d => `
    <tr>
      <td>${esc(d.numParte)}</td>
      <td>${esc(d.descripcion || "")}</td>
      <td>${esc(d.ubicacion || "")}</td>
      <td style="text-align:right">${d.existencia == null ? "—" : esc(String(d.existencia))}</td>
      <td style="text-align:right">${d.conteo == null ? "—" : esc(String(d.conteo))}</td>
      <td style="text-align:right">${d.dif == null ? "—" : (d.dif > 0 ? "+" : "") + d.dif}</td>
      <td>${esc(tipoTexto(d.tipo))}</td>
    </tr>`).join("");

  const win = window.open("", "_blank", "width=900,height=1000");
  if (!win) { notify("El navegador bloqueó la ventana. Permite ventanas emergentes.", { type: "warn" }); return; }
  win.document.write(`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
    <title>Reporte de diferencias — Refacciones</title>
    <style>
      *{box-sizing:border-box} body{font-family:system-ui,Arial,sans-serif;margin:24px;color:#111}
      h1{font-size:18px;margin:0 0 4px} .meta{color:#555;font-size:12px;margin-bottom:12px}
      table{width:100%;border-collapse:collapse;font-size:12px}
      th,td{border:1px solid #ccc;padding:5px 7px;text-align:left}
      th{background:#0f204a;color:#fff}
      tr:nth-child(even){background:#f6f8fc}
      .barra{margin-bottom:12px}
      .barra button{padding:8px 16px;font-size:14px;border:0;border-radius:6px;background:#0f204a;color:#fff;cursor:pointer}
      @media print{.barra{display:none}}
    </style></head><body>
    <div class="barra"><button onclick="window.print()">🖨️ Imprimir / Guardar PDF</button></div>
    <h1>Reporte de diferencias — Inventario de refacciones</h1>
    <div class="meta">Generado: ${esc(fecha)} · Por: ${esc(by)} · ${difs.length} parte(s) con diferencia</div>
    <table><thead><tr>
      <th>No. parte</th><th>Descripción</th><th>Ubicación</th><th>Existencia</th><th>Conteo</th><th>Dif.</th><th>Tipo</th>
    </tr></thead><tbody>${filas}</tbody></table>
    </body></html>`);
  win.document.close();
  logAction("parts.diff.report", `Reporte de diferencias impreso (${difs.length} partes)`, by);
}

function tipoTexto(t) {
  return { faltante: "Faltante", sobrante: "Sobrante", "sin-contar": "Sin contar", "sin-existencia": "Contada sin existencia" }[t] || t;
}

function exportarDiferenciasCsv() {
  const difs = listaDiferencias();
  if (!difs.length) { notify("No hay diferencias que exportar.", { type: "info" }); return; }
  const head = ["No.Parte", "Descripcion", "Ubicacion", "Existencia", "Conteo", "Diferencia", "Tipo"];
  const rows = difs.map(d => [
    d.numParte, d.descripcion || "", d.ubicacion || "",
    d.existencia == null ? "" : d.existencia,
    d.conteo == null ? "" : d.conteo,
    d.dif == null ? "" : d.dif,
    tipoTexto(d.tipo),
  ]);
  const csv = [head, ...rows].map(r => r.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `diferencias-refacciones-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  notify(`CSV de diferencias exportado (${difs.length} partes).`, { type: "success" });
}

// ======================= HELPERS =======================

function puedeEditar() {
  // Reutiliza el permiso de edición de vehículos (mismo perfil operativo).
  try { return auth.can("vehicle.edit") || auth.can("inventory.view"); }
  catch (e) { return true; }
}

function readTextFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(new Error("No se pudo leer el archivo."));
    r.readAsText(file, "utf-8");
  });
}

function setCargaStatus(msg, kind) { setStatusEl("ref-carga-status", msg, kind); }
function setScanStatus(msg, kind) { setStatusEl("ref-scan-status", msg, kind); }
function setStatusEl(id, msg, kind) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.style.color = kind === "error" ? "var(--danger)"
    : (kind === "ok" ? "var(--primary)" : (kind === "warn" ? "#b45309" : "var(--muted)"));
}

function beep(ok) {
  try {
    if (navigator.vibrate) navigator.vibrate(ok ? 40 : [60, 40, 60]);
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = ok ? 880 : 300;
    o.connect(g); g.connect(audioCtx.destination);
    g.gain.setValueAtTime(0.08, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.18);
    o.start(); o.stop(audioCtx.currentTime + 0.18);
  } catch (e) { /* audio no disponible */ }
}

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function esc(s) { return escapeHtml(String(s ?? "")); }
