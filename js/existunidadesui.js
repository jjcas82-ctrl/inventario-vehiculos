// existunidadesui.js — Interfaz de carga del reporte de EXISTENCIAS DE UNIDADES
// ("Análisis de unidades en inventario", Excel o PDF): botón, ventana con vista
// previa (nuevas / ya registradas / en la app y no en el reporte / errores) y
// guardado. Reutiliza el patrón de la carga del CDO.
//
// Lo que hace al confirmar:
//   - Unidades NUEVAS (VIN que no existe): se dan de alta como "dentro" de la
//     agencia elegida (o "en tránsito" si el sistema las marca "Transito").
//   - Unidades que YA existen: no se tocan (opcional: completar solo datos vacíos).
//   - NO importa costos ni intereses (información financiera).

import { store } from "./storage.js";
import { parseExistenciaUnidades, readExistenciaUnidadesLines } from "./existunidades.js";
import { notify } from "./ui.js";
import { escapeHtml } from "./agencies.js";
import { logAction } from "./syslog.js";
import * as auth from "./auth.js";
import { pushVehicle } from "./sync.js";

const AGENCIA_DEFECTO = "Aeroplasa Auto";

// Mapea la NOTA de ubicación del reporte del sistema a un área interna de la
// agencia (para dejar la unidad ubicada conforme al sistema). Se queda con el
// área; el texto completo de la nota igual se guarda en `ubicacionSistema`.
// Devuelve { area, location } (location = subárea o la nota si no hay mapeo).
function mapUbicacion(nota) {
  const t = String(nota || "").trim();
  if (!t) return { area: "", location: "" };
  const up = t.toUpperCase();
  // "Sala Exh" / "EXHIBICION"
  if (/\bEXH/.test(up) || /SALA/.test(up)) return { area: "Sala de Exhibición de Ventas", location: "" };
  // "Recepcion de Unidad"
  if (/RECEP/.test(up)) return { area: "Área de Entregas", location: "Recepción" };
  // "Patio ..." (incl. Patio TyT Queretaro) y notas de traslado "... TRAS ..."
  if (/\bPATIO\b/.test(up)) return { area: "Patio", location: t };
  if (/\bTRAS\b|TRANSITO|TRÁNSITO|ST QUERETARO|DEMO/.test(up)) return { area: "Patio", location: t };
  // Cualquier otra: sin área mapeada, pero conservamos la nota como ubicación.
  return { area: "", location: t };
}
const PAGE = 50;
let parsed = null;            // { units, errores, esperado, duplicadosEnArchivo, fileName }
let onLoaded = () => {};
const $ = (id) => document.getElementById(id);
const esc = (s) => escapeHtml(String(s ?? ""));

export function initExistUnidades(refreshCallback) {
  onLoaded = refreshCallback || (() => {});
  const btn = $("exu-upload-btn"), input = $("exu-file");
  if (!btn || !input) return;

  btn.addEventListener("click", () => {
    if (!auth.can("vehicle.edit")) {
      notify("Tu rol no permite cargar unidades.", { type: "warn" });
      return;
    }
    input.value = "";
    input.click();
  });
  input.addEventListener("change", async () => {
    const f = input.files && input.files[0];
    if (f) await handleFile(f);
  });
  $("exu-close").addEventListener("click", closeModal);
  $("exu-cancel").addEventListener("click", closeModal);
  $("exu-confirm").addEventListener("click", confirmLoad);
  $("exu-agency").addEventListener("change", renderPreview);
  $("exu-update-existing").addEventListener("change", renderPreview);
  $("exu-modal").addEventListener("click", (e) => { if (e.target.id === "exu-modal") closeModal(); });
}

function openModal() { const m = $("exu-modal"); m.hidden = false; m.style.display = "flex"; }
function closeModal() { const m = $("exu-modal"); m.hidden = true; m.style.display = "none"; parsed = null; }

function fillAgencies() {
  const sel = $("exu-agency");
  const names = store.listAgencies().map(a => a.name);
  sel.innerHTML = names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
  sel.value = names.includes(AGENCIA_DEFECTO) ? AGENCIA_DEFECTO : (names[0] || "");
}

async function handleFile(file) {
  openModal();
  parsed = null;
  $("exu-confirm").hidden = true;
  $("exu-summary").innerHTML = "";
  $("exu-preview").innerHTML = "";
  fillAgencies();
  const prog = $("exu-progress");
  prog.textContent = "Leyendo el archivo…";

  let lines;
  try {
    lines = await readExistenciaUnidadesLines(file, (p, t) => { prog.textContent = `Leyendo página ${p} de ${t}…`; });
  } catch (e) {
    prog.textContent = "";
    $("exu-preview").innerHTML = `<p style="color:var(--danger)">No se pudo leer el archivo: ${esc(e.message || e)}</p>`;
    return;
  }

  parsed = { ...parseExistenciaUnidades(lines), fileName: file.name, totalLines: lines.length, lines };
  prog.textContent = `«${file.name}»: ${lines.length} líneas analizadas.`;

  if (!parsed.units.length) {
    // Diagnóstico: mostrar el texto leído para poder ajustar la lectura al archivo real.
    const raw = lines.slice(0, 60).join("\n");
    $("exu-summary").innerHTML = `<div class="stat"><b style="color:var(--danger)">0</b><span>Unidades detectadas</span></div>`;
    $("exu-preview").innerHTML = `
      <p style="color:var(--danger)"><b>No se detectó ninguna unidad.</b></p>
      <p class="hint">Cada unidad debe traer su VIN de 17 caracteres. Si el archivo es un PDF escaneado (imagen) no tiene texto que leer. Estas son las primeras líneas que se leyeron:</p>
      <textarea readonly style="width:100%;height:200px;font-family:ui-monospace,monospace;font-size:11px;white-space:pre">${esc(raw || "(el archivo no devolvió texto)")}</textarea>`;
    return;
  }
  renderPreview();
}

// ---------- Vista previa ----------
function classify(agency) {
  const nuevas = [], existentes = [];
  const enReporte = new Set();
  for (const u of parsed.units) {
    enReporte.add(u.vin);
    (store.getVehicle(u.vin) ? existentes : nuevas).push(u);
  }
  // En la app como "dentro" de esta agencia, pero que el reporte no trae.
  const noEnReporte = store.listVehicles().filter(v =>
    v.status === "dentro" && v.currentAgency === agency && !enReporte.has(v.vin));
  return { nuevas, existentes, noEnReporte };
}

function table(head, rowsHtml, total) {
  const more = total > PAGE ? `<tr><td colspan="${head.length}" class="muted">… y ${total - PAGE} más (se procesan todas al confirmar).</td></tr>` : "";
  return `<div class="table-wrap" style="max-height:260px;overflow:auto"><table class="table"><thead><tr>${
    head.map(h => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rowsHtml}${more}</tbody></table></div>`;
}

function renderPreview() {
  if (!parsed || !parsed.units.length) return;
  const agency = $("exu-agency").value;
  const { nuevas, existentes, noEnReporte } = classify(agency);
  const actualizar = $("exu-update-existing").checked;
  const enTransito = nuevas.filter(u => esTransito(u)).length;

  $("exu-summary").innerHTML = `
    <div class="stat"><b>${parsed.units.length}</b><span>En el reporte</span></div>
    <div class="stat"><b style="color:var(--primary)">${nuevas.length}</b><span>Nuevas a dar de alta</span></div>
    <div class="stat"><b style="color:#b45309">${existentes.length}</b><span>Ya registradas</span></div>
    <div class="stat"><b style="color:${noEnReporte.length ? "var(--danger)" : "inherit"}">${noEnReporte.length}</b><span>En la app y no en el reporte</span></div>
    <div class="stat"><b style="color:${parsed.errores.length ? "var(--danger)" : "inherit"}">${parsed.errores.length}</b><span>Con error de lectura</span></div>`;

  // Verificación contra el total que declara el propio reporte.
  let cuadre = "";
  if (parsed.esperado != null) {
    cuadre = parsed.units.length === parsed.esperado
      ? `<p class="hint" style="color:#065f46">✓ El conteo cuadra: el reporte indica ${parsed.esperado} unidades y se leyeron ${parsed.units.length}.</p>`
      : `<p class="hint" style="color:var(--danger)">⚠️ El conteo NO cuadra: el reporte indica <b>${parsed.esperado}</b> unidades pero se leyeron <b>${parsed.units.length}</b>. Revisa el archivo antes de cargar.</p>`;
  }
  const dupArch = parsed.duplicadosEnArchivo
    ? `<p class="hint" style="color:#b45309">ℹ️ ${parsed.duplicadosEnArchivo} VIN aparecía repetido en el archivo (se cuenta una sola vez).</p>` : "";

  const queHara = `<p class="hint">Las <b>${nuevas.length}</b> nuevas se darán de alta como <b>dentro de «${esc(agency)}»</b>${
    enTransito ? ` (${enTransito} marcada(s) «Transito» en el sistema entrarán como <b>en tránsito</b>)` : ""
  }. La ubicación que trae el sistema se guarda como nota. <b>No se importan costos ni intereses.</b> Las ya registradas no se modifican${
    actualizar ? ", salvo completar sus datos vacíos" : ""}.</p>`;

  const nuevasRows = nuevas.slice(0, PAGE).map((u, i) => `<tr><td>${i + 1}</td><td><code>${esc(u.vin)}</code></td>
    <td>${esc(u.model)}</td><td>${esc(u.year)}</td><td>${esc(u.color)}</td><td>${esc(u.invNumero)}</td>
    <td>${esc(u.ubicacionSistema)}</td></tr>`).join("");
  const secNuevas = nuevas.length
    ? `<h3>✅ Nuevas a dar de alta (${nuevas.length})</h3>` + table(["#", "VIN", "Modelo", "Año", "Color", "Inv.", "Ubicación en el sistema"], nuevasRows, nuevas.length)
    : `<h3>✅ Nuevas (0)</h3><p class="muted">Todas las unidades del reporte ya están registradas.</p>`;

  const estados = { dentro: "Dentro", fuera: "Fuera", transito: "En tránsito" };
  const exRows = existentes.slice(0, PAGE).map((u, i) => {
    const v = store.getVehicle(u.vin);
    const distinta = v.status === "dentro" && v.currentAgency && v.currentAgency !== agency;
    return `<tr><td>${i + 1}</td><td><code>${esc(u.vin)}</code></td><td>${esc(v.model || u.model)}</td>
      <td>${esc(estados[v.status] || v.status || "—")}</td>
      <td${distinta ? ' style="color:#b45309"' : ""}>${esc(v.currentAgency || "—")}${distinta ? " ⚠" : ""}</td></tr>`;
  }).join("");
  const secExist = existentes.length
    ? `<h3 style="color:#b45309">⚠️ Ya registradas (${existentes.length})</h3>
       <p class="hint">Revisa las marcadas con ⚠: están registradas en otra agencia distinta a la elegida.</p>`
       + table(["#", "VIN", "Modelo", "Estado en la app", "Agencia en la app"], exRows, existentes.length)
    : "";

  const nrRows = noEnReporte.slice(0, PAGE).map((v, i) => `<tr><td>${i + 1}</td><td><code>${esc(v.vin)}</code></td>
    <td>${esc(v.model)}</td><td>${esc(v.color)}</td><td>${esc(v.currentLocation || v.currentArea || "")}</td></tr>`).join("");
  const secNoRep = noEnReporte.length
    ? `<h3 style="color:var(--danger)">❓ En la app como «dentro de ${esc(agency)}» y NO en el reporte (${noEnReporte.length})</h3>
       <p class="hint">Pueden estar vendidas, entregadas o con la salida sin registrar. Solo se muestran; no se modifican.</p>`
       + table(["#", "VIN", "Modelo", "Color", "Ubicación"], nrRows, noEnReporte.length)
    : "";

  const errRows = parsed.errores.slice(0, PAGE).map((e, i) => `<tr><td>${i + 1}</td><td class="muted">${esc(e.raw.slice(0, 120))}</td></tr>`).join("");
  const secErr = parsed.errores.length
    ? `<h3 style="color:var(--danger)">❌ Con error de lectura (${parsed.errores.length})</h3>
       <p class="hint">Parecen unidades pero no se pudo reconocer un VIN válido de 17 caracteres.</p>`
       + table(["#", "Línea"], errRows, parsed.errores.length)
    : "";

  $("exu-preview").innerHTML = cuadre + dupArch + queHara + secNuevas + secExist + secNoRep + secErr;

  // Opción de completar existentes: solo útil si hay existentes.
  const lbl = $("exu-update-existing").closest("label");
  if (lbl) lbl.style.display = existentes.length ? "block" : "none";

  const hay = nuevas.length > 0 || (actualizar && existentes.length > 0);
  const partes = [];
  if (nuevas.length) partes.push(`Dar de alta ${nuevas.length}`);
  if (actualizar && existentes.length) partes.push(`completar ${existentes.length}`);
  $("exu-confirm").hidden = !hay;
  $("exu-confirm").textContent = "✓ " + (partes.join(" y ") || "Cargar");
}

// ---------- Guardado ----------
function esTransito(u) { return /^tr[aá]nsito$/i.test(String(u.ubicacionSistema || "").trim()); }

function buildVehicle(u, agency, now, by) {
  const v = {
    vin: u.vin, make: u.make, model: u.model, year: u.year, color: u.color,
    condition: "nuevo", origin: "Existencias",
    catalogo: u.catalogo, invNumero: u.invNumero, ordenCompra: u.orden, fechaCompra: u.fechaCompra,
    ubicacionSistema: u.ubicacionSistema,
    cargadaDesdeReporteAt: now, cargadaDesdeReporteBy: by,
  };
  if (esTransito(u)) {
    v.status = "transito"; v.transitAt = now; v.transitBy = by;
  } else {
    // Alta como "dentro", UBICADA según la nota del sistema (área interna + nota).
    const { area, location } = mapUbicacion(u.ubicacionSistema);
    v.status = "dentro"; v.currentAgency = agency;
    v.currentArea = area; v.currentLocation = location;
    v.entryAt = now; v.entryBy = by;
  }
  return v;
}

const CAMPOS_COMPLETAR = ["make", "model", "year", "color", "catalogo", "invNumero", "ordenCompra", "fechaCompra", "ubicacionSistema"];

function confirmLoad() {
  if (!parsed) return;
  if (!auth.can("vehicle.edit")) { notify("Tu rol no permite cargar unidades.", { type: "warn" }); return; }
  const agency = $("exu-agency").value;
  if (!agency) { notify("Elige la agencia.", { type: "warn" }); return; }
  const actualizar = $("exu-update-existing").checked;
  const by = auth.currentUser()?.name || "—";
  const now = new Date().toISOString();
  const { nuevas, existentes } = classify(agency);

  let added = [], skipped = [], completadas = 0;
  if (nuevas.length) {
    const res = store.bulkUpsertVehicles(nuevas.map(u => buildVehicle(u, agency, now, by)), { skipExisting: true });
    added = res.added; skipped = res.skipped;
  }

  const tocadas = [];
  if (actualizar) {
    for (const u of existentes) {
      const prev = store.getVehicle(u.vin);
      if (!prev) continue;
      const src = buildVehicle(u, agency, now, by);
      const patch = {};
      for (const k of CAMPOS_COMPLETAR) if (!prev[k] && src[k]) patch[k] = src[k];   // solo huecos
      if (Object.keys(patch).length) { store.upsertVehicle({ ...patch, vin: u.vin }); completadas++; tocadas.push(u.vin); }
    }
  }

  // Sincroniza con el servidor (o encola si no hay internet), sin bloquear la carga local.
  try { for (const vin of [...added, ...tocadas]) pushVehicle(vin); } catch (e) {}

  logAction("units.stock.load",
    `Existencias de unidades (${agency}, «${parsed.fileName}»): ${added.length} altas` +
    (completadas ? ` · ${completadas} completadas` : "") + (skipped.length ? ` · ${skipped.length} ya existían` : ""), by);
  notify(`Se dieron de alta ${added.length} unidades en ${agency}.` +
    (completadas ? ` Se completaron datos de ${completadas}.` : "") +
    (skipped.length ? ` ${skipped.length} ya existían (no se tocaron).` : ""), { type: "success", timeout: 7000 });

  closeModal();
  onLoaded();
}
