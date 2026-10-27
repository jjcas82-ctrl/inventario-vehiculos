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
import { pushParts, pushPartConteo, pushPart } from "./sync.js";

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

  // --- Exhibición / puntos de venta ---
  const btnExh = document.getElementById("ref-exh-btn");
  if (btnExh) btnExh.addEventListener("click", registrarExhibicion);
  const selExhAg = document.getElementById("ref-exh-agencia");
  if (selExhAg) selExhAg.addEventListener("change", () => { fillPuntosVenta(); });
  const inpExhCant = document.getElementById("ref-exh-cant");
  if (inpExhCant) inpExhCant.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); registrarExhibicion(); }
  });

  // --- Rondas de conteo (1 a 3) ---
  const selRondas = document.getElementById("ref-rondas-sel");
  if (selRondas) selRondas.addEventListener("change", () => {
    const rondas = Number(selRondas.value) || 1;
    const a = store.getPartsAudit() || {};
    store.setPartsAudit({ rondas, rondaActual: a.rondaActual || 1 });
    renderRondas();
  });
  const btnRondaSig = document.getElementById("ref-ronda-siguiente");
  if (btnRondaSig) btnRondaSig.addEventListener("click", avanzarRonda);
  const btnRondaFin = document.getElementById("ref-ronda-finalizar");
  if (btnRondaFin) btnRondaFin.addEventListener("click", finalizarConteos);

  // --- Reporte de diferencias ---
  const btnDiffPdf = document.getElementById("ref-diff-pdf");
  if (btnDiffPdf) btnDiffPdf.addEventListener("click", imprimirDiferencias);
  const btnDiffCsv = document.getElementById("ref-diff-csv");
  if (btnDiffCsv) btnDiffCsv.addEventListener("click", exportarDiferenciasCsv);
  const btnReset = document.getElementById("ref-reset-conteo");
  if (btnReset) btnReset.addEventListener("click", reiniciarConteo);

  // --- Resultado final con firmas ---
  const btnFinalPdf = document.getElementById("ref-final-pdf");
  if (btnFinalPdf) btnFinalPdf.addEventListener("click", imprimirResultadoFinal);
  const btnFinalCerrar = document.getElementById("ref-final-cerrar");
  if (btnFinalCerrar) btnFinalCerrar.addEventListener("click", cerrarAuditoria);

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
  renderRondas();
  renderCargaResumen();
  renderConteo();
  renderExhibicion();
  renderDiferencias();
  renderFinal();
}

// ======================= EXHIBICIÓN / PUNTOS DE VENTA =======================

// Llena el desplegable de puntos de venta con las agencias/sitios existentes.
// Sitios de EXHIBICIÓN / puntos de venta por agencia (mapeo fijo). "Exhibición"
// es dentro de la propia agencia. Las bodegas y talleres NO aparecen aquí (no se
// exhiben refacciones). Aeropuerto y Automotriz comparten sitio y puntos de venta.
const PUNTOS_POR_AGENCIA = {
  "Aeroplasa Auto":        ["Exhibición", "Punto de Venta Zacatlán", "Punto de Venta Chignahuapan"],
  "Aeroplasa Aeropuerto":  ["Exhibición", "Punto de Venta Calzada del Hueso", "Punto de Venta Miramontes"],
  "Aeroplasa Automotriz":  ["Exhibición", "Punto de Venta Calzada del Hueso", "Punto de Venta Miramontes"],
};
const AGENCIAS_REF = ["Aeroplasa Auto", "Aeroplasa Aeropuerto", "Aeroplasa Automotriz"];

// Agencia del inventario de refacciones seleccionada (para filtrar exhibición).
function agenciaExhSeleccionada() {
  const sel = document.getElementById("ref-exh-agencia");
  return (sel && sel.value) || AGENCIAS_REF[0];
}

// Llena el selector de AGENCIA de la sección exhibición (las 3 agencias).
function fillAgenciasExh() {
  const sel = document.getElementById("ref-exh-agencia");
  if (!sel) return;
  // Solo las agencias de refacciones que existan dadas de alta (por si acaso).
  const existentes = new Set(store.listAgencies().map(a => a.name));
  const opciones = AGENCIAS_REF.filter(a => existentes.has(a));
  const lista = opciones.length ? opciones : AGENCIAS_REF;
  const prev = sel.value;
  sel.innerHTML = lista.map(a => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join("");
  if (prev && lista.includes(prev)) sel.value = prev;
}

// Llena el desplegable de puntos de venta SOLO con los sitios de la agencia
// seleccionada (según PUNTOS_POR_AGENCIA). Sin bodegas ni talleres.
function fillPuntosVenta() {
  const sel = document.getElementById("ref-exh-punto");
  if (!sel) return;
  const agencia = agenciaExhSeleccionada();
  const sitios = PUNTOS_POR_AGENCIA[agencia] || ["Exhibición"];
  const prev = sel.value;
  sel.innerHTML = `<option value="">— Punto de venta / exhibidor —</option>` +
    sitios.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("") +
    `<option value="Otro">Otro…</option>`;
  // Conservar la selección previa solo si sigue siendo válida para esta agencia.
  if (prev && (sitios.includes(prev) || prev === "Otro")) sel.value = prev;
}

function registrarExhibicion() {
  if (!puedeContar()) { notify("Tu rol no permite registrar refacciones.", { type: "warn" }); return; }
  const parteEl = document.getElementById("ref-exh-parte");
  const puntoEl = document.getElementById("ref-exh-punto");
  const cantEl = document.getElementById("ref-exh-cant");
  const numParte = (parteEl?.value || "").trim();
  const punto = (puntoEl?.value || "").trim();
  const cantRaw = (cantEl?.value || "").trim();
  if (!numParte) { notify("Escribe el número de parte.", { type: "warn" }); parteEl?.focus(); return; }
  if (!punto) { notify("Elige el punto de venta / armario.", { type: "warn" }); puntoEl?.focus(); return; }
  const cant = Number(cantRaw);
  if (!Number.isFinite(cant) || cant < 0) { notify("La cantidad debe ser 0 o más.", { type: "warn" }); cantEl?.focus(); return; }

  const by = auth.currentUser()?.name || "—";
  const p = store.setPartExhibicion(numParte, punto, cant, by);
  logAction("parts.exhibicion", `Exhibición de ${numParte}: ${cant} en ${punto}`, by);
  try { pushPart(numParte); } catch (e) {}
  setExhStatus(`✓ ${numParte}: ${cant} en ${punto} (total en exhibición: ${p.exhibicion}).`, "ok");
  if (parteEl) parteEl.value = "";
  if (cantEl) cantEl.value = "";
  if (parteEl) parteEl.focus();
  renderExhibicion();
  renderConteo();
  renderDiferencias();
  renderFinal();
}

function renderExhibicion() {
  fillAgenciasExh();
  fillPuntosVenta();
  const el = document.getElementById("ref-exh-resumen");
  const tbody = document.querySelector("#ref-exh-table tbody");
  const all = store.listParts();
  const conExh = all.filter(p => Number(p.exhibicion || 0) > 0);
  const totalPiezas = conExh.reduce((s, p) => s + Number(p.exhibicion || 0), 0);
  if (el) el.innerHTML = `
    <div class="stat"><b>${conExh.length}</b><span>Partes en exhibición</span></div>
    <div class="stat"><b>${totalPiezas}</b><span>Piezas en exhibición (suman al conteo)</span></div>`;
  if (tbody) {
    // Una fila por (parte, punto).
    const filas = [];
    for (const p of conExh) {
      for (const [punto, n] of Object.entries(p.exhibiciones || {})) {
        filas.push(`<tr>
          <td><code>${escapeHtml(p.numParte)}</code></td>
          <td>${escapeHtml((p.descripcion || "").slice(0, 40))}</td>
          <td>${escapeHtml(punto)}</td>
          <td style="text-align:right"><b>${escapeHtml(String(n))}</b></td>
        </tr>`);
      }
    }
    tbody.innerHTML = filas.join("");
  }
}

function setExhStatus(msg, kind) { setStatusEl("ref-exh-status", msg, kind); }

// ======================= RONDAS DE CONTEO (1 a 3) =======================

// Devuelve la ronda actual (1-3) y el total de rondas configurado.
function rondaInfo() {
  const a = store.getPartsAudit() || {};
  const rondas = Math.min(3, Math.max(1, Number(a.rondas) || 1));
  const rondaActual = Math.min(rondas, Math.max(1, Number(a.rondaActual) || 1));
  return { rondas, rondaActual };
}

function renderRondas() {
  const { rondas, rondaActual } = rondaInfo();
  const sel = document.getElementById("ref-rondas-sel");
  if (sel && Number(sel.value) !== rondas) sel.value = String(rondas);
  const badge = document.getElementById("ref-ronda-actual");
  if (badge) badge.textContent = `Conteo ${rondaActual} de ${rondas}`;
  const btnSig = document.getElementById("ref-ronda-siguiente");
  if (btnSig) {
    btnSig.hidden = rondaActual >= rondas;   // en la última ronda no hay "siguiente"
    btnSig.textContent = rondaActual < rondas
      ? `Terminar conteo ${rondaActual} y pasar al ${rondaActual + 1} →` : "";
  }
  const hint = document.getElementById("ref-ronda-hint");
  if (hint) {
    hint.textContent = rondaActual === 1
      ? "1er conteo: cuenta TODAS las partes con marbete."
      : `Conteo ${rondaActual}: recuenta SOLO las partes que siguen con diferencia (resaltadas como pendientes).`;
  }
}

// ¿Una parte está "pendiente de contar" en la ronda actual?
//  - Ronda 1: pendiente si aún no tiene conteo en la ronda 1 (y tiene marbete).
//  - Ronda ≥2: pendiente solo si en la ronda anterior quedó con DIFERENCIA.
function pendienteEnRonda(p, ronda) {
  if (p.enMarbetes === false) return false;       // sin marbete no entra al conteo físico
  const conteos = p.conteos || {};
  if (ronda === 1) return conteos["1"] == null;
  // Para rondas ≥2: solo las que la ronda anterior dejó con diferencia vs
  // existencia (contando también lo que esté en exhibición → Opción A).
  const prev = conteos[String(ronda - 1)];
  if (prev == null) return false;                  // no se contó antes → no aplica
  if (p.existencia == null) return false;
  const efectivo = Number(prev) + Number(p.exhibicion || 0);
  return efectivo !== Number(p.existencia);        // seguía con diferencia → recontar
}

// Avanza a la siguiente ronda (registra la vuelta en la bitácora).
function avanzarRonda() {
  const { rondas, rondaActual } = rondaInfo();
  if (rondaActual >= rondas) { notify("Ya estás en el último conteo.", { type: "info" }); return; }
  const by = auth.currentUser()?.name || "—";
  // Resumen de la ronda que se cierra.
  const difs = listaDiferencias().filter(d => d.tipo === "faltante" || d.tipo === "sobrante").length;
  logAction("parts.count.round", `Conteo ${rondaActual} terminado · ${difs} con diferencia`, by);
  store.setPartsAudit({ rondaActual: rondaActual + 1, rondas });
  notify(`Conteo ${rondaActual} terminado. Ahora el conteo ${rondaActual + 1} recuenta solo las diferencias.`, { type: "success", timeout: 6000 });
  renderRondas();
  renderConteo();
  renderDiferencias();
}

// Finaliza los conteos AQUÍ, aunque falten rondas por hacer. El auditor decide
// cuándo ya es suficiente (p. ej. configuró 3 conteos pero con 2 le basta).
// Fija el total de rondas a la ronda actual para cerrar el proceso de conteo.
function finalizarConteos() {
  const { rondas, rondaActual } = rondaInfo();
  const faltan = rondas - rondaActual;
  const msg = faltan > 0
    ? `¿Finalizar los conteos en el conteo ${rondaActual}? Se omitirá(n) ${faltan} conteo(s) restante(s) y pasarás al resultado final.`
    : `¿Finalizar los conteos y pasar al resultado final?`;
  if (!confirm(msg)) return;
  const by = auth.currentUser()?.name || "—";
  store.setPartsAudit({ rondas: rondaActual, rondaActual });
  logAction("parts.count.finish", `Conteos finalizados en el conteo ${rondaActual} (de ${rondas} configurados)`, by);
  notify(`Conteos finalizados en el conteo ${rondaActual}. Revisa las diferencias y el resultado final.`, { type: "success", timeout: 6000 });
  renderRondas();
  renderConteo();
  renderDiferencias();
  renderFinal();
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
  if (!puedeEditar()) {
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
      precioUnit: it.precioUnit ?? null,
      clasificacion: it.clasificacion || "",
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
      precioUnit: it.precioUnit ?? null,
      clasificacion: it.clasificacion || "",
      enMarbetes: false,
      enExistencias: true,
      origin: "existencias",
    });
  }

  const res = store.bulkUpsertParts(toSave, { merge: true });
  logAction("parts.load", `Refacciones cargadas: ${res.added} nuevas · ${res.updated} actualizadas`, by);
  // SINCRONIZACIÓN: sube el lote de refacciones al servidor (o encola si no hay red).
  try { pushParts(toSave); } catch (e) {}
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

  if (!puedeContar()) { notify("Tu rol no permite registrar conteos de refacciones.", { type: "warn" }); return; }

  const by = auth.currentUser()?.name || "—";
  const { rondaActual } = rondaInfo();
  let p = store.getPart(numParte);

  // AVISO: si esta parte YA fue contada en la ronda ACTUAL, confirmar antes de
  // reemplazar el valor (opción A). En las rondas ≥2 recontar es lo esperado, así
  // que el aviso solo aplica a un re-registro dentro de la misma ronda.
  if (p) {
    const previo = (p.conteos || {})[String(rondaActual)];
    if (previo != null) {
      const ok = confirm(
        `La parte ${numParte} ya fue contada en el conteo ${rondaActual} (valor: ${previo}).\n\n` +
        `¿Reemplazar por el nuevo valor (${conteo})?`
      );
      if (!ok) {
        setScanStatus(`Sin cambios: ${numParte} conserva su conteo anterior (${previo}).`, "warn");
        if (inp) { inp.value = ""; inp.focus(); }
        if (cantEl) cantEl.value = "";
        return;
      }
    }
  } else {
    // Parte contada que no estaba en el inventario cargado: se da de alta.
    store.upsertPart({ numParte, descripcion: "", ubicacion: "", existencia: null, enMarbetes: false, enExistencias: false, origin: "conteo" });
  }
  p = store.setPartConteo(numParte, conteo, by, rondaActual);
  logAction("parts.count", `Conteo ${rondaActual} de ${numParte}: ${conteo}`, by);
  // SINCRONIZACIÓN: sube el conteo al servidor (o encola si no hay internet).
  try { pushPartConteo(numParte, conteo); } catch (e) {}
  beep(true);
  setScanStatus(`✓ Contada ${numParte}: ${conteo} (conteo ${rondaActual}).`, "ok");
  if (inp) inp.value = "";
  if (cantEl) cantEl.value = "";
  if (inp) inp.focus();
  renderConteo();
  renderDiferencias();
  renderFinal();
}

function reiniciarConteo() {
  const partes = store.listParts().filter(p => p.conteo != null || (p.conteos && Object.keys(p.conteos).length));
  if (!partes.length) { notify("No hay conteos registrados.", { type: "info" }); return; }
  if (!confirm(`¿Borrar TODOS los conteos (todas las rondas) de ${partes.length} parte(s)? El inventario cargado (existencias) se conserva.`)) return;
  const by = auth.currentUser()?.name || "—";
  for (const p of partes) {
    store.upsertPart({ numParte: p.numParte, conteo: null, conteos: {}, conteoRonda: null, conteoBy: null, conteoAt: null });
  }
  // Reiniciar la ronda a 1 (conserva el nº de rondas configurado).
  const a = store.getPartsAudit() || {};
  store.setPartsAudit({ rondas: a.rondas || 1, rondaActual: 1 });
  logAction("parts.count.reset", `Conteo reiniciado (${partes.length} partes)`, by);
  notify("Conteo físico reiniciado (vuelve al conteo 1).", { type: "success" });
  renderRondas();
  renderConteo();
  renderDiferencias();
}

function renderConteo() {
  const el = document.getElementById("ref-conteo-resumen");
  if (!el) return;
  const all = store.listParts();
  const { rondaActual } = rondaInfo();
  // Contadas EN ESTA RONDA y pendientes de contar EN ESTA RONDA.
  const contadas = all.filter(p => (p.conteos || {})[String(rondaActual)] != null).length;
  const pendientes = all.filter(p => pendienteEnRonda(p, rondaActual)).length;
  el.innerHTML = `
    <div class="stat"><b>${all.length}</b><span>Partes en inventario</span></div>
    <div class="stat"><b style="color:var(--primary)">${contadas}</b><span>Contadas (conteo ${rondaActual})</span></div>
    <div class="stat"><b style="color:#b45309">${pendientes}</b><span>Pendientes (conteo ${rondaActual})</span></div>`;

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

// Diferencia = (conteo físico + exhibición) − existencia del sistema.
// Opción A: las piezas en exhibición/puntos de venta SUMAN al conteo para que
// el total cuadre contra la existencia. null si falta algún dato.
function diffValor(p) {
  if (p.conteo == null || p.existencia == null) return null;
  const exhib = Number(p.exhibicion || 0);
  return (Number(p.conteo) + exhib) - Number(p.existencia);
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

// ======================= RESULTADO FINAL CON FIRMAS =======================

// Formatea un monto en pesos.
function money(n) {
  return "$ " + (Number(n) || 0).toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Calcula el resumen económico del inventario de refacciones.
//   valorInventario: suma de existencia × precioUnit de todas las partes.
//   valorDiferencia: suma de |diferencia| × precioUnit de las partes con diferencia.
function resumenFinal() {
  const all = store.listParts();
  let valorInventario = 0, partesConPrecio = 0;
  for (const p of all) {
    if (p.precioUnit != null && p.existencia != null) {
      valorInventario += Number(p.precioUnit) * Number(p.existencia);
      partesConPrecio++;
    }
  }
  const difs = listaDiferencias();
  const conDif = difs.filter(d => d.tipo === "faltante" || d.tipo === "sobrante");
  let valorDiferencia = 0;
  for (const d of conDif) {
    const p = store.getPart(d.numParte);
    const precio = p && p.precioUnit != null ? Number(p.precioUnit) : 0;
    valorDiferencia += Math.abs(Number(d.dif) || 0) * precio;
  }
  const noComprobadas = difs.filter(d => d.tipo === "sin-contar").length;
  return {
    totalPartes: all.length, partesConPrecio,
    valorInventario, valorDiferencia,
    faltantes: conDif.filter(d => d.tipo === "faltante").length,
    sobrantes: conDif.filter(d => d.tipo === "sobrante").length,
    noComprobadas, difs, conDif,
  };
}

function renderFinal() {
  const el = document.getElementById("ref-final-resumen");
  if (!el) return;
  const r = resumenFinal();
  el.innerHTML = `
    <div class="stat stat-wide"><b>${money(r.valorInventario)}</b><span>Valor total del inventario</span></div>
    <div class="stat"><b style="color:var(--danger)">${money(r.valorDiferencia)}</b><span>Monto de la diferencia</span></div>
    <div class="stat"><b style="color:var(--danger)">${r.faltantes}</b><span>Faltantes</span></div>
    <div class="stat"><b style="color:#b45309">${r.sobrantes}</b><span>Sobrantes</span></div>
    <div class="stat"><b>${r.noComprobadas}</b><span>No comprobadas</span></div>`;
}

// Imprime la hoja de resultado final con el resumen, las partes con diferencia y
// el área de firmas (Gte. Administrativo, Gte. de Refacciones, Auditor).
function imprimirResultadoFinal() {
  const r = resumenFinal();
  const by = auth.currentUser()?.name || "—";
  const fecha = new Date().toLocaleString();
  const { rondas, rondaActual } = rondaInfo();
  const fAdmin = (document.getElementById("ref-firma-admin")?.value || "").trim();
  const fRefa = (document.getElementById("ref-firma-refacciones")?.value || "").trim();
  const fPosventa = (document.getElementById("ref-firma-posventa")?.value || "").trim();
  const fAud = (document.getElementById("ref-firma-auditor")?.value || "").trim();

  const filas = r.difs.map(d => {
    const p = store.getPart(d.numParte);
    const precio = p && p.precioUnit != null ? Number(p.precioUnit) : null;
    const impacto = (d.dif != null && precio != null) ? Math.abs(d.dif) * precio : null;
    return `<tr>
      <td>${esc(d.numParte)}</td>
      <td>${esc(d.descripcion || "")}</td>
      <td>${esc(d.ubicacion || "")}</td>
      <td style="text-align:right">${d.existencia == null ? "—" : esc(String(d.existencia))}</td>
      <td style="text-align:right">${d.conteo == null ? "—" : esc(String(d.conteo))}</td>
      <td style="text-align:right">${d.dif == null ? "—" : (d.dif > 0 ? "+" : "") + d.dif}</td>
      <td style="text-align:right">${precio == null ? "—" : money(precio)}</td>
      <td style="text-align:right">${impacto == null ? "—" : money(impacto)}</td>
      <td>${esc(tipoTexto(d.tipo))}</td>
    </tr>`;
  }).join("");

  const win = window.open("", "_blank", "width=1000,height=1100");
  if (!win) { notify("El navegador bloqueó la ventana. Permite ventanas emergentes.", { type: "warn" }); return; }
  win.document.write(`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
    <title>Resultado de auditoría — Refacciones</title>
    <style>
      *{box-sizing:border-box} body{font-family:system-ui,Arial,sans-serif;margin:24px;color:#111}
      h1{font-size:18px;margin:0 0 2px} h2{font-size:14px;margin:18px 0 6px}
      .meta{color:#555;font-size:12px;margin-bottom:10px}
      .resumen{display:flex;flex-wrap:wrap;gap:10px;margin:10px 0}
      .box{border:1px solid #ccc;border-radius:8px;padding:8px 12px;min-width:150px}
      .box b{display:block;font-size:16px} .box span{font-size:11px;color:#555}
      table{width:100%;border-collapse:collapse;font-size:11px;margin-top:4px}
      th,td{border:1px solid #ccc;padding:4px 6px;text-align:left}
      th{background:#0f204a;color:#fff} tr:nth-child(even){background:#f6f8fc}
      .firmas{display:flex;justify-content:space-between;gap:16px;margin-top:48px;flex-wrap:wrap}
      .firma{flex:1;text-align:center} .firma .linea{border-top:1px solid #000;margin-top:40px;padding-top:4px;font-size:12px}
      .firma .cargo{font-size:11px;color:#555}
      .barra{margin-bottom:12px} .barra button{padding:8px 16px;font-size:14px;border:0;border-radius:6px;background:#0f204a;color:#fff;cursor:pointer}
      @media print{.barra{display:none}}
    </style></head><body>
    <div class="barra"><button onclick="window.print()">🖨️ Imprimir / Guardar PDF</button></div>
    <h1>Resultado de auditoría — Inventario de refacciones</h1>
    <div class="meta">Generado: ${esc(fecha)} · Responsable: ${esc(by)} · Conteos realizados: ${rondaActual} de ${rondas}</div>
    <div class="resumen">
      <div class="box"><b>${money(r.valorInventario)}</b><span>Valor total del inventario</span></div>
      <div class="box"><b>${money(r.valorDiferencia)}</b><span>Monto total de la diferencia</span></div>
      <div class="box"><b>${r.faltantes}</b><span>Faltantes</span></div>
      <div class="box"><b>${r.sobrantes}</b><span>Sobrantes</span></div>
      <div class="box"><b>${r.noComprobadas}</b><span>No comprobadas</span></div>
      <div class="box"><b>${r.difs.length}</b><span>Partes en el reporte</span></div>
    </div>
    <h2>Partes con diferencia / no comprobadas</h2>
    ${r.difs.length ? `<table><thead><tr>
      <th>No. parte</th><th>Descripción</th><th>Ubicación</th><th>Exist.</th><th>Conteo</th><th>Dif.</th>
      <th>Precio U.</th><th>Impacto $</th><th>Tipo</th>
    </tr></thead><tbody>${filas}</tbody></table>` : "<p>Sin diferencias. El inventario cuadra. 🎉</p>"}
    <div class="firmas">
      <div class="firma"><div class="linea">${esc(fAdmin || "&nbsp;")}</div><div class="cargo">Gte. Administrativo</div></div>
      <div class="firma"><div class="linea">${esc(fRefa || "&nbsp;")}</div><div class="cargo">Gte. de Refacciones</div></div>
      <div class="firma"><div class="linea">${esc(fPosventa || "&nbsp;")}</div><div class="cargo">Gte. de Posventa</div></div>
      <div class="firma"><div class="linea">${esc(fAud || "&nbsp;")}</div><div class="cargo">Auditor (nombre y firma)</div></div>
    </div>
    </body></html>`);
  win.document.close();
  logAction("parts.audit.result", `Resultado impreso · dif ${money(r.valorDiferencia)} · ${r.conDif.length} partes`, by);
}

// Cierra la auditoría: guarda firmantes y resumen en la bitácora y marca fin.
function cerrarAuditoria() {
  const r = resumenFinal();
  const by = auth.currentUser()?.name || "—";
  const fAdmin = (document.getElementById("ref-firma-admin")?.value || "").trim();
  const fRefa = (document.getElementById("ref-firma-refacciones")?.value || "").trim();
  const fPosventa = (document.getElementById("ref-firma-posventa")?.value || "").trim();
  const fAud = (document.getElementById("ref-firma-auditor")?.value || "").trim();
  if (!confirm("¿Cerrar la auditoría de refacciones y guardarla en la bitácora?")) return;

  store.setPartsAudit({
    finishedAt: new Date().toISOString(),
    firmaAdmin: fAdmin, firmaRefacciones: fRefa, firmaPosventa: fPosventa, firmaAuditor: fAud,
    valorInventario: r.valorInventario, valorDiferencia: r.valorDiferencia,
    faltantes: r.faltantes, sobrantes: r.sobrantes, noComprobadas: r.noComprobadas,
  });
  logAction("parts.audit.close",
    `Auditoría cerrada · inventario ${money(r.valorInventario)} · diferencia ${money(r.valorDiferencia)} · ` +
    `${r.faltantes} faltantes, ${r.sobrantes} sobrantes · firmas: ${[fAdmin, fRefa, fPosventa, fAud].filter(Boolean).length}/4`, by);
  notify("Auditoría de refacciones cerrada y registrada en la bitácora.", { type: "success", timeout: 6000 });
}

// ======================= HELPERS =======================

function puedeEditar() {
  // Cargar/editar el catálogo de refacciones requiere refacciones.edit.
  try { return auth.can("refacciones.edit"); }
  catch (e) { return false; }
}
// Registrar conteo físico: lo puede hacer quien edita refacciones O el auditor
// (contar es la tarea central de la auditoría de refacciones).
function puedeContar() {
  try { return auth.can("refacciones.edit") || auth.can("audit.run"); }
  catch (e) { return false; }
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
