// audit.js — Auditoría / conteo físico como ASISTENTE DE 5 ETAPAS.
//
//   Etapa 1 · Inicio          → elegir agencia, tipo (total/rotativo) y congelar.
//   Etapa 2 · Lista           → ver/imprimir las unidades esperadas (con casillas).
//   Etapa 3 · Conteo físico   → escanear/capturar; contador en vivo + progreso.
//   Etapa 4 · Diferencias     → presentes/faltantes/sobrantes; reporte PDF/CSV.
//   Etapa 5 · Corrección      → reasignar sobrantes / marcar faltantes; cerrar.
//
// El progreso se PERSISTE en store.openAudits para poder retomar tras recargar.
// "Congelar" marca la agencia como bloqueada: app.js impide entradas/salidas
// mientras la auditoría siga abierta (salvo override de admin).

import { store } from "./storage.js";
import { Scanner } from "./scanner.js";
import { normalizeVin } from "./vin.js";
import { escapeHtml } from "./agencies.js";
import { notify, confirmDialog } from "./ui.js";
import { printReport, printCountList } from "./pdf.js";
import { readVinCloud, hasCloudOcr } from "./ocr.js";
import * as auth from "./auth.js";

let session = null;   // sesión viva en memoria (ver buildSession)
let scanner = null;
let currentStage = 1;

export function initAudit() {
  // Si hay una auditoría abierta persistida, ofrecemos retomarla.
  const open = store.listOpenAudits();

  const agSel = document.getElementById("audit-agency");
  agSel.innerHTML = store.listAgencies()
    .map(a => `<option value="${escapeHtml(a.name)}">${escapeHtml(a.name)}</option>`).join("");

  const modeSel = document.getElementById("audit-mode");
  const countField = document.getElementById("audit-count-field");
  const areaSel = document.getElementById("audit-area");
  let lastAgency = null;  // para repoblar áreas solo cuando cambie la agencia
  const updateScope = () => {
    countField.style.display = modeSel.value === "random" ? "" : "none";
    const agency = agSel.value;
    // MEJORA 2: repuebla las áreas cuando cambia la agencia (conserva opción si existe).
    if (areaSel && agency !== lastAgency) {
      populateAreaSelect(areaSel, agency);
      lastAgency = agency;
    }
    const area = areaSel ? areaSel.value : "";
    const dentro = unitsInAgency(agency, area);
    const scope = document.getElementById("audit-scope");
    const enArea = area ? ` del área ${area}` : "";
    if (modeSel.value === "full") {
      scope.textContent = `Se auditarán las ${dentro.length} unidades${enArea} de ${agency}.`;
    } else {
      const n = Math.min(parseInt(document.getElementById("audit-count").value, 10) || 0, dentro.length);
      scope.textContent = `Se elegirán ${n} unidades al azar de las ${dentro.length}${enArea} que figuran DENTRO de ${agency}.`;
    }
    showResumeNote(agency);
  };
  agSel.onchange = updateScope;
  modeSel.onchange = updateScope;
  if (areaSel) areaSel.onchange = updateScope;
  document.getElementById("audit-count").oninput = updateScope;

  // --- Botones de navegación entre etapas ---
  document.getElementById("audit-start").onclick = startAudit;
  document.getElementById("audit-back-1").onclick = () => gotoStage(1);
  document.getElementById("audit-print-list").onclick = printList;
  document.getElementById("audit-to-count").onclick = () => gotoStage(3);
  document.getElementById("audit-finish").onclick = () => { stopScanner(); computeAndRenderDiff(); gotoStage(4); };
  document.getElementById("audit-cancel").onclick = cancelAudit;
  document.getElementById("audit-report-pdf").onclick = reportPDF;
  document.getElementById("audit-report-csv").onclick = reportCSV;
  document.getElementById("audit-to-fix").onclick = () => { renderFix(); gotoStage(5); };
  document.getElementById("audit-back-4").onclick = () => gotoStage(4);
  document.getElementById("audit-close").onclick = closeAudit;

  // Conteo manual
  document.getElementById("audit-manual-btn").onclick = () => {
    markPresent(document.getElementById("audit-manual").value);
    document.getElementById("audit-manual").value = "";
  };
  document.getElementById("audit-manual").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); document.getElementById("audit-manual-btn").click(); }
  });

  setupAgenda();
  setupAuditScanner();
  renderHistory();
  updateScope();
  updateFrozenBadge();

  // Si hay auditoría(s) abiertas, retomar la primera automáticamente.
  if (open.length) {
    resumeSession(open[0]);
  } else {
    gotoStage(1);
  }
}

// --- Agenda de auditorías programadas ---
function setupAgenda() {
  const canSchedule = auth.can("audit.schedule");
  const agenda = document.getElementById("audit-agenda");
  if (agenda) agenda.hidden = false;

  const schAg = document.getElementById("sched-agency");
  if (schAg) {
    schAg.innerHTML = store.listAgencies()
      .map(a => `<option value="${escapeHtml(a.name)}">${escapeHtml(a.name)}</option>`).join("");
  }
  const schMode = document.getElementById("sched-mode");
  const schCountField = document.getElementById("sched-count-field");
  if (schMode) {
    schMode.onchange = () => { schCountField.style.display = schMode.value === "random" ? "" : "none"; };
  }
  // Fecha por defecto: hoy (en zona local).
  const schDate = document.getElementById("sched-date");
  if (schDate && !schDate.value) schDate.value = new Date().toISOString().slice(0, 10);

  const addBtn = document.getElementById("sched-add");
  if (addBtn) {
    // Solo admin/auditor pueden programar; si no, se oculta el formulario de alta.
    const form = addBtn.previousElementSibling; // .filters
    addBtn.style.display = canSchedule ? "" : "none";
    if (form && form.classList.contains("filters")) form.style.display = canSchedule ? "" : "none";
    addBtn.onclick = addScheduled;
  }
  renderScheduled();
}

function addScheduled() {
  const agency = document.getElementById("sched-agency").value;
  const mode = document.getElementById("sched-mode").value;
  const count = parseInt(document.getElementById("sched-count").value, 10) || 10;
  const date = document.getElementById("sched-date").value;
  const notifyDays = Math.max(0, parseInt(document.getElementById("sched-notify").value, 10) || 0);
  const note = document.getElementById("sched-note").value.trim();
  if (!date) { notify("Elige una fecha para la auditoría.", { type: "warn" }); return; }

  store.addScheduledAudit({
    agency, mode, count: mode === "random" ? count : null,
    date, notifyDays, note,
    by: auth.currentUser()?.name || "—",
  });
  document.getElementById("sched-note").value = "";
  renderScheduled();
  notify(`Auditoría programada para ${formatDate(date)} en ${agency}.`, { type: "success" });
}

function renderScheduled() {
  const wrap = document.getElementById("audit-sched-list");
  if (!wrap) return;
  const list = store.listScheduledAudits().filter(s => !s.done);
  if (!list.length) {
    wrap.innerHTML = '<p class="muted">No hay auditorías programadas.</p>';
    return;
  }
  const canSchedule = auth.can("audit.schedule");
  wrap.innerHTML = list.map(s => {
    const dLeft = daysUntil(s.date);
    const estado = dLeft < 0 ? `<span class="tag tag-out">Vencida (${-dLeft} d)</span>`
      : dLeft === 0 ? '<span class="tag" style="background:#fef3c7;color:#92400e">¡Hoy!</span>'
      : `<span class="tag tag-in">En ${dLeft} día${dLeft === 1 ? "" : "s"}</span>`;
    return `<div class="agency">
      <div class="agency-head">
        <b>${escapeHtml(s.agency)} · ${s.mode === "full" ? "Total" : "Rotativo"}</b>
        ${estado}
      </div>
      <p class="hint">📅 ${formatDate(s.date)} · aviso ${s.notifyDays} día(s) antes · programó ${escapeHtml(s.by || "—")}${s.note ? " · " + escapeHtml(s.note) : ""}</p>
      <div class="row gap wrap">
        <button class="btn btn-sm sched-start" data-id="${s.id}">▶️ Iniciar ahora</button>
        ${canSchedule ? `<button class="btn btn-sm btn-ghost sched-del" data-id="${s.id}">Eliminar</button>` : ""}
      </div>
    </div>`;
  }).join("");

  wrap.querySelectorAll(".sched-start").forEach(btn =>
    btn.addEventListener("click", () => startFromSchedule(btn.dataset.id)));
  wrap.querySelectorAll(".sched-del").forEach(btn =>
    btn.addEventListener("click", async () => {
      const choice = await confirmDialog({
        icon: "🗓️", title: "Eliminar programación",
        message: "¿Eliminar esta auditoría programada?",
        buttons: [
          { label: "Cancelar", value: null, variant: "ghost" },
          { label: "Eliminar", value: "del", variant: "danger" },
        ],
      });
      if (choice === "del") { store.removeScheduledAudit(btn.dataset.id); renderScheduled(); }
    }));
}

// Inicia una auditoría tomando los datos de una programación (precarga etapa 1).
function startFromSchedule(id) {
  const s = store.listScheduledAudits().find(x => x.id === id);
  if (!s) return;
  document.getElementById("audit-agency").value = s.agency;
  document.getElementById("audit-mode").value = s.mode;
  document.getElementById("audit-count-field").style.display = s.mode === "random" ? "" : "none";
  if (s.mode === "random" && s.count) document.getElementById("audit-count").value = s.count;
  // Marca la programación como realizada (para que no siga avisando).
  store.updateScheduledAudit(id, { done: true });
  renderScheduled();
  gotoStage(1);
  document.getElementById("audit-agency").dispatchEvent(new Event("change"));
  notify(`Auditoría de ${s.agency} lista para iniciar. Revisa las opciones y pulsa "Iniciar auditoría".`, { type: "info", timeout: 6000 });
}

// --- Helpers de datos ---
// Unidades DENTRO de una agencia. Si se pasa `area` (MEJORA 2), filtra a las que
// estén en esa área interna (por currentArea o currentLocation).
function unitsInAgency(agency, area) {
  let list = store.listVehicles().filter(v => v.status === "dentro" && v.currentAgency === agency);
  if (area) {
    list = list.filter(v => v.currentArea === area || v.currentLocation === area);
  }
  return list;
}

// Devuelve la lista plana de nombres de áreas (incluyendo subs) de una agencia.
function areaNames(agency) {
  const ag = store.listAgencies().find(a => a.name === agency);
  if (!ag || !Array.isArray(ag.areas)) return [];
  const out = [];
  for (const area of ag.areas) {
    if (!area || !area.name) continue;
    out.push(area.name);
    for (const sub of (area.subs || [])) {
      if (sub) out.push(sub);
    }
  }
  return out;
}

// Rellena un <select> de áreas para la agencia dada, con la opción "(Toda la agencia)".
function populateAreaSelect(sel, agency) {
  const prev = sel.value;
  const names = areaNames(agency);
  sel.innerHTML = '<option value="">(Toda la agencia)</option>' +
    names.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("");
  // Conserva la selección previa si sigue existiendo entre las nuevas áreas.
  if (prev && names.includes(prev)) sel.value = prev;
}

function showResumeNote(agency) {
  const note = document.getElementById("audit-resume-note");
  const o = store.getOpenAudit(agency);
  if (o) {
    note.hidden = false;
    note.textContent = `↩️ Hay una auditoría en curso en ${agency} (abierta por ${o.by || "—"}). Al iniciar, se retomará.`;
  } else {
    note.hidden = true;
  }
}

function updateFrozenBadge() {
  const badge = document.getElementById("audit-frozen-badge");
  if (!badge) return;
  const frozen = store.listOpenAudits().some(o => o.frozen);
  badge.hidden = !frozen;
}

// --- Navegación por etapas ---
function gotoStage(n) {
  currentStage = n;
  document.querySelectorAll(".audit-stage").forEach(el => {
    el.hidden = Number(el.dataset.stage) !== n;
  });
  document.querySelectorAll("#audit-steps li").forEach(li => {
    const s = Number(li.dataset.step);
    li.classList.toggle("is-active", s === n);
    li.classList.toggle("is-done", s < n);
  });
}

// --- Construcción / persistencia de la sesión ---
function buildSession(agency, mode, frozen, expectedVehicles, seenObj, area) {
  return {
    agency, mode, frozen,
    area: area || "",   // MEJORA 2: área auditada ("" = toda la agencia)
    startedAt: new Date().toISOString(),
    by: auth.currentUser()?.name || "—",
    expected: new Map(expectedVehicles.map(v => [v.vin, v])),
    seen: new Map(Object.entries(seenObj || {})),  // vin -> "presente" | "sobrante"
  };
}

function persist() {
  if (!session) return;
  store.saveOpenAudit(session.agency, {
    mode: session.mode,
    frozen: session.frozen,
    area: session.area || "",   // MEJORA 2: persistir área auditada
    by: session.by,
    startedAt: session.startedAt,
    expected: [...session.expected.keys()],
    seen: Object.fromEntries(session.seen),
  });
  updateFrozenBadge();
}

function startAudit() {
  const agency = document.getElementById("audit-agency").value;
  const mode = document.getElementById("audit-mode").value;
  const freeze = document.getElementById("audit-freeze").checked;
  const areaEl = document.getElementById("audit-area");
  const area = areaEl ? areaEl.value : "";   // MEJORA 2: área a auditar ("" = toda)

  // Si ya había una auditoría abierta en esta agencia, la retomamos.
  const existing = store.getOpenAudit(agency);
  if (existing) { resumeSession(existing); return; }

  const dentro = unitsInAgency(agency, area);
  let expectedVehicles = dentro;
  if (mode === "random") {
    const n = Math.max(1, Math.min(parseInt(document.getElementById("audit-count").value, 10) || 1, dentro.length));
    expectedVehicles = shuffle([...dentro]).slice(0, n);
  }
  if (!expectedVehicles.length) {
    notify(area
      ? `No hay unidades en el área ${area} de ${agency} para auditar.`
      : "No hay unidades dentro de esta agencia para auditar.", { type: "warn" });
    return;
  }

  session = buildSession(agency, mode, freeze, expectedVehicles, {}, area);
  persist();
  if (freeze) notify(`🔒 Inventario de ${agency} congelado durante el conteo.`, { type: "info", timeout: 5000 });
  renderList();
  gotoStage(2);
}

// Retoma una auditoría persistida (tras recargar o reabrir la app).
function resumeSession(open) {
  // Reconstruye la lista esperada a partir de los VIN guardados.
  const expectedVehicles = (open.expected || [])
    .map(vin => store.getVehicle(vin) || { vin, make: "", model: "", currentLocation: "" });
  session = buildSession(open.agency, open.mode, open.frozen, expectedVehicles, open.seen, open.area);
  session.startedAt = open.startedAt || session.startedAt;
  session.by = open.by || session.by;
  notify(`↩️ Auditoría retomada en ${open.agency}.`, { type: "info", timeout: 4000 });
  renderList();
  renderRun();
  gotoStage(3);
}

// --- Etapa 2: lista de unidades esperadas ---
function renderList() {
  if (!session) return;
  const rows = [...session.expected.values()].map((v, i) => `
    <tr><td>${i + 1}</td><td><code>${escapeHtml(v.vin)}</code></td>
      <td>${escapeHtml(v.make || "")}</td><td>${escapeHtml(v.model || "")}</td>
      <td>${escapeHtml(v.currentLocation || "")}</td></tr>`).join("");
  document.querySelector("#audit-list-table tbody").innerHTML = rows;
  document.getElementById("audit-list-summary").innerHTML = `
    <div class="stat"><b>${session.expected.size}</b><span>Unidades a contar</span></div>
    <div class="stat"><b>${session.mode === "full" ? "Total" : "Rotativo"}</b><span>Tipo</span></div>
    <div class="stat"><b>${session.frozen ? "Sí 🔒" : "No"}</b><span>Congelado</span></div>`;
}

function printList() {
  if (!session) return;
  const rows = [...session.expected.values()].map((v, i) =>
    [String(i + 1), v.vin, v.make || "", v.model || "", v.currentLocation || ""]);
  printCountList({
    agency: session.agency,
    mode: session.mode === "full" ? "Total" : "Rotativo",
    by: session.by,
    rows,
  });
}

// --- Etapa 3: conteo físico ---
function markPresent(raw) {
  if (!session) return;
  let vin = normalizeVin(raw);

  // Si no son 17 caracteres, puede ser un código de barras PARCIAL del fabricante
  // (muchos traen solo los últimos dígitos del VIN). Intentamos emparejar por el
  // final del VIN contra las unidades esperadas / registradas.
  if (vin.length !== 17) {
    const parcial = matchVinParcial(vin);
    if (parcial) {
      vin = parcial; // ¡encontrado! usamos el VIN completo correspondiente.
    } else {
      setStatus(`Lectura: "${normalizeVin(raw)}" (${vin.length} caract.). No es un VIN de 17 ni coincide con una unidad. Escanea el QR del sistema o captura el VIN a mano.`, "error");
      beep(false);
      return;
    }
  }
  if (session.seen.has(vin)) { setStatus("Esa unidad ya fue contada.", "info"); return; }

  if (session.expected.has(vin)) {
    session.seen.set(vin, "presente");
    setStatus("✓ Presente: " + vin, "ok");
    beep(true);
  } else {
    session.seen.set(vin, "sobrante");
    const v = store.getVehicle(vin);
    const donde = v ? ` (figura en ${v.currentAgency || "—"})` : " (no registrada)";
    setStatus("⚠️ Sobrante: " + vin + donde, "warn");
    beep(false);
  }
  persist();
  renderRun();
}

// Intenta emparejar un código PARCIAL (p. ej. los últimos dígitos del VIN que
// trae el código de barras del fabricante) con un VIN completo. Busca primero en
// las unidades ESPERADAS de la auditoría y luego en todo el inventario.
// Requiere al menos 6 caracteres para evitar falsos positivos, y que el match
// sea único (si varios VIN terminan igual, no adivina).
function matchVinParcial(fragmento) {
  const frag = normalizeVin(fragmento);
  if (frag.length < 6) return null;

  const matchEn = (vins) => {
    const hits = vins.filter(v => v.endsWith(frag) || v.includes(frag));
    return hits.length === 1 ? hits[0] : null;
  };
  // 1) Entre las esperadas de esta auditoría (lo más probable).
  const esperadas = [...session.expected.keys()];
  const m1 = matchEn(esperadas);
  if (m1) return m1;
  // 2) En todo el inventario (por si es sobrante).
  const todas = store.listVehicles().map(v => v.vin);
  return matchEn(todas);
}

function computeResults() {
  const presentes = [], faltantes = [], sobrantes = [];
  for (const [vin] of session.expected) {
    if (session.seen.get(vin) === "presente") presentes.push(vin);
    else faltantes.push(vin);
  }
  for (const [vin, status] of session.seen) {
    if (status === "sobrante") sobrantes.push(vin);
  }
  return { presentes, faltantes, sobrantes };
}

function renderRun() {
  if (!session) return;
  const { presentes, faltantes, sobrantes } = computeResults();
  const total = session.expected.size;
  const pct = total ? Math.round((presentes.length / total) * 100) : 0;

  document.getElementById("audit-progress").innerHTML = `
    <div class="stat"><b>${presentes.length}/${total}</b><span>Contadas</span></div>
    <div class="stat"><b style="color:var(--danger)">${faltantes.length}</b><span>Faltantes</span></div>
    <div class="stat"><b style="color:#b45309">${sobrantes.length}</b><span>Sobrantes</span></div>
    <div class="stat"><b>${pct}%</b><span>Avance</span></div>`;
  const fill = document.getElementById("audit-progress-fill");
  if (fill) fill.style.width = pct + "%";

  const rows = [];
  for (const [vin, v] of session.expected) {
    const presente = session.seen.get(vin) === "presente";
    const st = presente
      ? '<span class="tag tag-in">Presente</span>'
      : '<span class="tag tag-out">Faltante</span>';
    // MEJORA 1: botón para corregir la ubicación de la unidad (esperada/presente).
    const fixBtn = `<button class="btn btn-sm audit-fix-loc" data-vin="${escapeHtml(vin)}">📍 Corregir ubicación</button>`;
    // Ubicación actual (puede haber cambiado por una corrección previa).
    const cur = store.getVehicle(vin) || v;
    rows.push(`<tr><td><code>${escapeHtml(vin)}</code></td><td>${escapeHtml(cur.make || v.make || "")}</td>
      <td>${escapeHtml(cur.currentLocation || cur.currentArea || v.currentLocation || "")}</td>
      <td>${st}<div style="margin-top:4px">${fixBtn}</div></td></tr>`);
  }
  for (const [vin, status] of session.seen) {
    if (status !== "sobrante") continue;
    const v = store.getVehicle(vin);
    rows.push(`<tr><td><code>${escapeHtml(vin)}</code></td><td>${escapeHtml(v?.make || "")}</td>
      <td class="muted">${escapeHtml(v?.currentAgency || "no registrada")}</td>
      <td><span class="tag" style="background:#fef3c7;color:#92400e">Sobrante</span></td></tr>`);
  }
  const tbody = document.querySelector("#audit-table tbody");
  tbody.innerHTML = rows.join("");
  // Conectar botones de corrección (MEJORA 1).
  tbody.querySelectorAll(".audit-fix-loc").forEach(btn =>
    btn.addEventListener("click", () => corregirUbicacion(btn.dataset.vin)));
}

// --- MEJORA 1: corrección de ubicación de una unidad (reutilizable) ---
// Abre un diálogo propio (overlay con clases .modal) que permite:
//   (a) cambiar el ÁREA INTERNA dentro de la misma agencia,
//   (b) marcar que la unidad "está en otra agencia" (reasignar currentAgency),
//   (c) registrar la SALIDA de la unidad (status "fuera").
// Al confirmar, registra el evento correspondiente y re-renderiza las tablas.
async function corregirUbicacion(vin) {
  if (!session) return;
  const v = store.getVehicle(vin);
  if (!v) { notify("La unidad no está registrada.", { type: "warn" }); return; }

  const areas = areaNames(session.agency);
  // Otras agencias (para la opción "está en otra agencia").
  const otrasAgencias = store.listAgencies()
    .map(a => a.name).filter(n => n !== session.agency);

  const choice = await locationFixDialog({
    vin,
    label: `${v.make || ""} ${v.model || ""}`.trim(),
    agency: session.agency,
    areaActual: v.currentArea || v.currentLocation || "",
    areas,
    otrasAgencias,
  });
  if (!choice) return;  // cancelado

  if (choice.accion === "area") {
    // (a) Mover a otra área interna de la MISMA agencia.
    const nuevaArea = choice.area;
    store.addEvent({
      vin, type: "move", agency: session.agency,
      area: nuevaArea, location: nuevaArea,
      by: session.by, locationSource: "manual", nota: "Corregido en auditoría",
    });
    notify(`📍 ${vin} movida a ${nuevaArea} en ${session.agency}.`, { type: "success" });
  } else if (choice.accion === "otra") {
    // (b) Está en otra agencia: reasignar currentAgency.
    store.upsertVehicle({ vin, currentAgency: choice.agencia, status: "dentro" });
    store.addEvent({
      vin, type: "move", agency: choice.agencia, area: "", location: choice.agencia,
      by: session.by, locationSource: "manual", nota: "Reubicada en otra agencia (auditoría)",
    });
    notify(`${vin} reasignada a ${choice.agencia}.`, { type: "info" });
  } else if (choice.accion === "salida") {
    // (c) Registrar salida (fuera).
    store.addEvent({
      vin, type: "exit", agency: session.agency,
      by: session.by, locationSource: "manual", nota: "Salida registrada en auditoría",
    });
    notify(`${vin} marcada como SALIDA (fuera).`, { type: "info" });
  }

  // Si la unidad estaba contada como presente, conservamos ese estado.
  // (session.seen no se toca; solo cambia la ubicación/estatus del vehículo.)
  persist();
  // Re-render inmediato de la etapa activa.
  if (currentStage === 5) renderFix();
  else renderRun();
}

// Construye un overlay con <select> de áreas + opciones y resuelve con la elección.
// Devuelve: { accion:"area", area } | { accion:"otra", agencia } | { accion:"salida" } | null.
function locationFixDialog({ vin, label, agency, areaActual, areas, otrasAgencias }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal";
    overlay.style.zIndex = "60";

    const areaOpts = areas.length
      ? areas.map(a => `<option value="${escapeHtml(a)}"${a === areaActual ? " selected" : ""}>${escapeHtml(a)}</option>`).join("")
      : '<option value="">(Esta agencia no tiene áreas definidas)</option>';

    const otrasOpts = otrasAgencias.length
      ? otrasAgencias.map(a => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join("")
      : "";

    overlay.innerHTML = `
      <div class="modal-card" style="max-width:460px">
        <div class="row between">
          <h2 style="margin:0">📍 Corregir ubicación</h2>
        </div>
        <p class="hint"><code>${escapeHtml(vin)}</code>${label ? " · " + escapeHtml(label) : ""} ·
          figura en <b>${escapeHtml(agency)}</b>${areaActual ? " / " + escapeHtml(areaActual) : ""}</p>

        <div class="field" style="margin-top:8px">
          <label>¿Qué deseas hacer?</label>
          <select id="loc-fix-accion">
            <option value="area">Cambiar el área interna (misma agencia)</option>
            <option value="otra"${otrasOpts ? "" : " disabled"}>Está en otra agencia</option>
            <option value="salida">Registrar salida (fuera)</option>
          </select>
        </div>

        <div class="field" id="loc-fix-area-field" style="margin-top:8px">
          <label for="loc-fix-area">Área interna de ${escapeHtml(agency)}</label>
          <select id="loc-fix-area"${areas.length ? "" : " disabled"}>${areaOpts}</select>
        </div>

        <div class="field" id="loc-fix-otra-field" style="margin-top:8px;display:none">
          <label for="loc-fix-otra">Agencia donde está realmente</label>
          <select id="loc-fix-otra">${otrasOpts}</select>
        </div>

        <div class="row gap wrap" style="margin-top:14px;justify-content:flex-end">
          <button id="loc-fix-cancel" class="btn btn-ghost">Cancelar</button>
          <button id="loc-fix-save" class="btn btn-primary">Guardar</button>
        </div>
      </div>`;

    document.body.appendChild(overlay);

    const accionSel = overlay.querySelector("#loc-fix-accion");
    const areaField = overlay.querySelector("#loc-fix-area-field");
    const otraField = overlay.querySelector("#loc-fix-otra-field");
    const syncFields = () => {
      const a = accionSel.value;
      areaField.style.display = a === "area" ? "" : "none";
      otraField.style.display = a === "otra" ? "" : "none";
    };
    accionSel.addEventListener("change", syncFields);
    syncFields();

    const close = (result) => { overlay.remove(); resolve(result); };
    overlay.querySelector("#loc-fix-cancel").addEventListener("click", () => close(null));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(null); });
    overlay.querySelector("#loc-fix-save").addEventListener("click", () => {
      const accion = accionSel.value;
      if (accion === "area") {
        const area = overlay.querySelector("#loc-fix-area").value;
        if (!area) { notify("Selecciona un área válida.", { type: "warn" }); return; }
        close({ accion: "area", area });
      } else if (accion === "otra") {
        const agencia = overlay.querySelector("#loc-fix-otra").value;
        if (!agencia) { notify("Selecciona la agencia destino.", { type: "warn" }); return; }
        close({ accion: "otra", agencia });
      } else {
        close({ accion: "salida" });
      }
    });
  });
}

// --- MEJORA 3: métricas y resumen ejecutivo ---
// Calcula las métricas de la sesión actual: exactitud (%), faltantes, sobrantes,
// duración (ms) y comparación con la auditoría ANTERIOR de la misma agencia.
function computeMetrics() {
  const { presentes, faltantes, sobrantes } = computeResults();
  const total = session.expected.size;
  const exactitud = total ? (presentes.length / total) * 100 : 0;
  const duracionMs = Math.max(0, Date.now() - new Date(session.startedAt).getTime());

  // Auditoría anterior de la MISMA agencia (la última por finishedAt).
  const previas = store.listAudits()
    .filter(a => a.agency === session.agency && (a.finishedAt || a.createdAt))
    .sort((a, b) => (a.finishedAt || a.createdAt).localeCompare(b.finishedAt || b.createdAt));
  const anterior = previas.length ? previas[previas.length - 1] : null;

  let exactitudAnterior = null;
  if (anterior) {
    if (typeof anterior.exactitud === "number") {
      exactitudAnterior = anterior.exactitud;
    } else if (anterior.totalExpected) {
      // Compatibilidad: calcular desde los conteos guardados.
      const pres = Array.isArray(anterior.presentes) ? anterior.presentes.length : 0;
      exactitudAnterior = (pres / anterior.totalExpected) * 100;
    }
  }

  return {
    total,
    presentes: presentes.length,
    faltantes: faltantes.length,
    sobrantes: sobrantes.length,
    exactitud,
    duracionMs,
    anterior,
    exactitudAnterior,
  };
}

// Formatea una duración (ms) como "Xm Ys" o "Xh Ym".
function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s}s`;
}

function renderExecSummary() {
  const el = document.getElementById("audit-exec-summary");
  if (!el || !session) return;
  const mx = computeMetrics();

  // Comparativa de exactitud vs. auditoría anterior.
  let comparativa;
  if (mx.exactitudAnterior == null) {
    comparativa = '<span class="tag">Primera auditoría de esta agencia</span>';
  } else {
    const diff = mx.exactitud - mx.exactitudAnterior;
    const sign = diff >= 0 ? "▲ +" : "▼ ";
    const color = diff >= 0 ? "var(--primary)" : "var(--danger)";
    comparativa = `<span class="tag" style="color:${color}">${sign}${diff.toFixed(1)}% vs anterior</span>`;
  }

  const areaTxt = session.area ? ` · área ${escapeHtml(session.area)}` : "";
  el.innerHTML = `
    <h3 style="margin-bottom:6px">📊 Resumen ejecutivo</h3>
    <p class="hint" style="margin-top:0">${escapeHtml(session.agency)}${areaTxt}</p>
    <div class="summary">
      <div class="stat stat-wide"><b>${mx.exactitud.toFixed(1)}%</b><span>Exactitud (${mx.presentes}/${mx.total})</span></div>
      <div class="stat"><b style="color:var(--danger)">${mx.faltantes}</b><span>Faltantes</span></div>
      <div class="stat"><b style="color:#b45309">${mx.sobrantes}</b><span>Sobrantes</span></div>
      <div class="stat"><b>${formatDuration(mx.duracionMs)}</b><span>Tiempo de conteo</span></div>
      <div class="stat"><b>${comparativa}</b><span>Comparativa</span></div>
    </div>`;
}

// --- Etapa 4: diferencias ---
function computeAndRenderDiff() {
  if (!session) return;
  const { presentes, faltantes, sobrantes } = computeResults();

  renderExecSummary();   // MEJORA 3: resumen ejecutivo arriba del detalle

  document.getElementById("audit-diff-summary").innerHTML = `
    <div class="stat"><b style="color:var(--primary)">${presentes.length}</b><span>Presentes</span></div>
    <div class="stat"><b style="color:var(--danger)">${faltantes.length}</b><span>Faltantes</span></div>
    <div class="stat"><b style="color:#b45309">${sobrantes.length}</b><span>Sobrantes</span></div>`;

  const listBlock = (title, vins, extra) => {
    if (!vins.length) return `<h3>${title} (0)</h3><p class="muted">Ninguna.</p>`;
    const items = vins.map(vin => {
      const v = store.getVehicle(vin);
      return `<li><code>${escapeHtml(vin)}</code> · ${escapeHtml(v?.make || "")} ${escapeHtml(v?.model || "")}${extra ? extra(v) : ""}</li>`;
    }).join("");
    return `<h3>${title} (${vins.length})</h3><ul class="audit-difflist">${items}</ul>`;
  };

  document.getElementById("audit-diff-lists").innerHTML =
    listBlock("❌ Faltantes (esperadas, no vistas)", faltantes) +
    listBlock("⚠️ Sobrantes (vistas, no esperadas)", sobrantes,
      v => v ? ` <span class="muted">— figura en ${escapeHtml(v.currentAgency || "—")}</span>` : ' <span class="muted">— no registrada</span>');
}

function diffRowsForExport() {
  const { presentes, faltantes, sobrantes } = computeResults();
  const rows = [];
  presentes.forEach(vin => rows.push([vin, vehLabel(vin), "Presente", ""]));
  faltantes.forEach(vin => rows.push([vin, vehLabel(vin), "Faltante", ""]));
  sobrantes.forEach(vin => {
    const v = store.getVehicle(vin);
    rows.push([vin, vehLabel(vin), "Sobrante", v ? "figura en " + (v.currentAgency || "—") : "no registrada"]);
  });
  return rows;
}
function vehLabel(vin) {
  const v = store.getVehicle(vin);
  return v ? `${v.make || ""} ${v.model || ""}`.trim() : "";
}

function reportPDF() {
  if (!session) return;
  const title = `Reporte de auditoría · ${session.agency} · ${session.mode === "full" ? "Total" : "Rotativo"}`;
  printReport(title, ["VIN", "Unidad", "Resultado", "Observación"], diffRowsForExport());
}

function reportCSV() {
  if (!session) return;
  const header = ["VIN", "Unidad", "Resultado", "Observacion"];
  const lines = [header, ...diffRowsForExport()]
    .map(r => r.map(csvCell).join(",")).join("\r\n");
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  downloadText(`auditoria-${slug(session.agency)}-${stamp}.csv`, "\ufeff" + lines, "text/csv;charset=utf-8");
  notify("CSV exportado.", { type: "success" });
}

// --- Etapa 5: corrección de ubicaciones ---
function renderFix() {
  if (!session) return;
  const { presentes, faltantes, sobrantes } = computeResults();

  // MEJORA 1: acceso para corregir la ubicación interna de las unidades PRESENTES.
  const presBlock = presentes.length ? `
    <h3>✅ Presentes — corregir ubicación interna</h3>
    <ul class="audit-difflist">${presentes.map(vin => {
      const v = store.getVehicle(vin);
      const loc = v ? (v.currentLocation || v.currentArea || "") : "";
      return `<li>
        <code>${escapeHtml(vin)}</code> · ${escapeHtml(vehLabel(vin) || "")}
        ${loc ? `<span class="muted">— ${escapeHtml(loc)}</span>` : ""}
        <button class="btn btn-sm audit-fix-loc" data-vin="${escapeHtml(vin)}">📍 Corregir ubicación</button>
      </li>`;
    }).join("")}</ul>` : "<h3>✅ Presentes (0)</h3><p class='muted'>Ninguna.</p>";

  const sobBlock = sobrantes.length ? `
    <h3>⚠️ Sobrantes — reasignar a ${escapeHtml(session.agency)}</h3>
    <ul class="audit-difflist">${sobrantes.map(vin => {
      const v = store.getVehicle(vin);
      const reg = !!v;
      return `<li>
        <code>${escapeHtml(vin)}</code> · ${escapeHtml(vehLabel(vin) || "no registrada")}
        ${reg ? `<span class="muted">— figura en ${escapeHtml(v.currentAgency || "—")}</span>` : '<span class="muted">— no registrada</span>'}
        ${reg ? `<button class="btn btn-sm fix-reassign" data-vin="${escapeHtml(vin)}">Reasignar aquí</button>` : ""}
      </li>`;
    }).join("")}</ul>` : "<h3>⚠️ Sobrantes (0)</h3><p class='muted'>Ninguno.</p>";

  const falBlock = faltantes.length ? `
    <h3>❌ Faltantes — marcar para investigación</h3>
    <ul class="audit-difflist">${faltantes.map(vin => `
      <li><code>${escapeHtml(vin)}</code> · ${escapeHtml(vehLabel(vin))}
        <button class="btn btn-sm fix-flag" data-vin="${escapeHtml(vin)}">Marcar investigación</button>
      </li>`).join("")}</ul>` : "<h3>❌ Faltantes (0)</h3><p class='muted'>Ninguno.</p>";

  const wrap = document.getElementById("audit-fix-lists");
  wrap.innerHTML = presBlock + sobBlock + falBlock;

  // MEJORA 1: botones de corrección de ubicación de presentes.
  wrap.querySelectorAll(".audit-fix-loc").forEach(btn =>
    btn.addEventListener("click", () => corregirUbicacion(btn.dataset.vin)));

  wrap.querySelectorAll(".fix-reassign").forEach(btn =>
    btn.addEventListener("click", () => {
      const vin = btn.dataset.vin;
      const v = store.getVehicle(vin);
      if (!v) return;
      store.upsertVehicle({ vin, currentAgency: session.agency, status: "dentro" });
      store.addEvent({ vin, type: "move", agency: session.agency, area: "", location: session.agency,
        by: session.by });
      btn.outerHTML = '<span class="tag tag-in">Reasignada ✓</span>';
      notify(`${vin} reasignada a ${session.agency}.`, { type: "success" });
    })
  );
  wrap.querySelectorAll(".fix-flag").forEach(btn =>
    btn.addEventListener("click", () => {
      const vin = btn.dataset.vin;
      store.upsertVehicle({ vin, auditFlag: `Faltante en auditoría ${session.agency} · ${new Date().toLocaleString()}` });
      btn.outerHTML = '<span class="tag tag-out">Marcada 🔎</span>';
      notify(`${vin} marcada para investigación.`, { type: "info" });
    })
  );
}

async function closeAudit() {
  if (!session) return;
  const { presentes, faltantes, sobrantes } = computeResults();
  const choice = await confirmDialog({
    icon: "📋", title: "Cerrar auditoría",
    message: `Resultado en ${session.agency}:\n\n` +
      `• Presentes: ${presentes.length}\n• Faltantes: ${faltantes.length}\n• Sobrantes: ${sobrantes.length}\n\n` +
      (session.frozen ? "Se descongelará el inventario.\n\n" : "") + "¿Guardar y cerrar?",
    buttons: [
      { label: "Seguir en corrección", value: null, variant: "ghost" },
      { label: "Guardar y cerrar", value: "save", variant: "primary" },
    ],
  });
  if (choice !== "save") return;

  // MEJORA 3: guardar métricas en el registro de la auditoría.
  const total = session.expected.size;
  const exactitud = total ? (presentes.length / total) * 100 : 0;
  const duracionMs = Math.max(0, Date.now() - new Date(session.startedAt).getTime());

  store.addAudit({
    agency: session.agency, mode: session.mode, by: session.by,
    startedAt: session.startedAt, finishedAt: new Date().toISOString(),
    frozen: session.frozen,
    totalExpected: total,
    presentes, faltantes, sobrantes,
    exactitud,                      // número (% exactitud)
    duracionMs,                     // número (duración del conteo en ms)
    area: session.area || "",       // área auditada ("" = toda la agencia)
  });
  store.clearOpenAudit(session.agency); // descongela
  stopScanner();
  session = null;
  updateFrozenBadge();
  renderHistory();
  gotoStage(1);
  document.getElementById("audit-freeze").checked = false;
  notify("Auditoría guardada y cerrada.", { type: "success" });
}

async function cancelAudit() {
  const choice = await confirmDialog({
    icon: "✖️", title: "Cancelar auditoría",
    message: "¿Cancelar la auditoría en curso? Se perderá el conteo y se descongelará el inventario.",
    buttons: [
      { label: "Seguir contando", value: null, variant: "ghost" },
      { label: "Cancelar auditoría", value: "cancel", variant: "danger" },
    ],
  });
  if (choice !== "cancel") return;
  stopScanner();
  if (session) store.clearOpenAudit(session.agency);
  session = null;
  updateFrozenBadge();
  gotoStage(1);
}

// --- Sonido / vibración de confirmación ---
let _audioCtx = null;
function beep(ok) {
  try {
    if (navigator.vibrate) navigator.vibrate(ok ? 40 : [60, 40, 60]);
    _audioCtx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = _audioCtx.createOscillator();
    const g = _audioCtx.createGain();
    o.frequency.value = ok ? 880 : 300;
    o.connect(g); g.connect(_audioCtx.destination);
    g.gain.setValueAtTime(0.08, _audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, _audioCtx.currentTime + 0.18);
    o.start(); o.stop(_audioCtx.currentTime + 0.18);
  } catch (e) { /* audio no disponible: ignorar */ }
}

// --- Escáner (reutiliza la clase Scanner) ---
function setupAuditScanner() {
  const video = document.getElementById("audit-video");
  const wrap = document.getElementById("audit-scanner-wrap");
  const startBtn = document.getElementById("audit-scan");
  const stopBtn = document.getElementById("audit-scan-stop");

  scanner = new Scanner(video, {
    onResult: (text) => {
      const m = normalizeVin(text).match(/[A-HJ-NPR-Z0-9]{17}/);
      if (m) markPresent(m[0]);
    },
    onStatus: (msg, kind) => setStatus(msg, kind),
  });

  const ocrBtn = document.getElementById("audit-ocr");
  const ocrHint = document.getElementById("audit-ocr-hint");

  startBtn.onclick = async () => {
    try {
      await scanner.start();
      wrap.hidden = false; startBtn.hidden = true; stopBtn.hidden = false;
      // Mostrar el botón de OCR de nube solo si hay API key configurada.
      if (ocrBtn) ocrBtn.hidden = !hasCloudOcr();
      if (ocrHint) ocrHint.hidden = !hasCloudOcr();
      if (!hasCloudOcr() && ocrHint) {
        ocrHint.hidden = false;
        ocrHint.textContent = "Sugerencia: configura la API key de OCR en la nube (pestaña Escanear) para poder leer el VIN de texto aquí también.";
      }
    } catch (e) {}
  };
  stopBtn.onclick = stopScanner;

  // Lectura del VIN de TEXTO con OCR en la nube (cuando el QR/código no se puede leer).
  if (ocrBtn) ocrBtn.onclick = async () => {
    const video = document.getElementById("audit-video");
    if (!video || !video.videoWidth) { setStatus("Primero abre la cámara.", "warn"); return; }
    ocrBtn.disabled = true;
    const prev = ocrBtn.textContent;
    ocrBtn.textContent = "Leyendo…";
    try {
      const r = await readVinCloud(video, { onProgress: (m) => setStatus(m, "info") });
      if (r && r.vin) {
        setStatus(`VIN leído (nube): ${r.vin}${r.verified ? " ✓" : ""}`, "ok");
        markPresent(r.vin);
      } else {
        setStatus("No se pudo leer el VIN de texto: " + (r?.error || "sin resultado") + ". Intenta de nuevo o captúralo a mano.", "error");
      }
    } catch (e) {
      setStatus("Error al leer en la nube: " + (e.message || e), "error");
    } finally {
      ocrBtn.disabled = false; ocrBtn.textContent = prev;
    }
  };
}

function stopScanner() {
  if (scanner) scanner.stop();
  const wrap = document.getElementById("audit-scanner-wrap");
  if (wrap) wrap.hidden = true;
  const startBtn = document.getElementById("audit-scan");
  const stopBtn = document.getElementById("audit-scan-stop");
  if (startBtn) startBtn.hidden = false;
  if (stopBtn) stopBtn.hidden = true;
  const ocrBtn = document.getElementById("audit-ocr");
  const ocrHint = document.getElementById("audit-ocr-hint");
  if (ocrBtn) ocrBtn.hidden = true;
  if (ocrHint) ocrHint.hidden = true;
}

function setStatus(msg, kind) {
  const el = document.getElementById("audit-status");
  if (!el) return;
  el.textContent = msg;
  el.style.color = kind === "error" ? "var(--danger)"
    : (kind === "ok" ? "var(--primary)" : (kind === "warn" ? "#b45309" : "var(--muted)"));
}

function renderHistory() {
  const wrap = document.getElementById("audit-history");
  if (!wrap) return;
  const audits = [...store.listAudits()].reverse();
  if (!audits.length) { wrap.innerHTML = '<p class="muted">Aún no hay auditorías registradas.</p>'; return; }
  wrap.innerHTML = audits.map(a => `
    <div class="agency">
      <div class="agency-head">
        <b>${escapeHtml(a.agency)} · ${a.mode === "full" ? "Total" : "Rotativo"}</b>
        <span class="muted">${new Date(a.finishedAt || a.createdAt).toLocaleString()}</span>
      </div>
      <p class="hint">
        Por ${escapeHtml(a.by || "—")} ·
        Presentes: <b>${a.presentes.length}</b> ·
        Faltantes: <b style="color:var(--danger)">${a.faltantes.length}</b> ·
        Sobrantes: <b style="color:#b45309">${a.sobrantes.length}</b>
        (de ${a.totalExpected} esperadas)
      </p>
      ${a.faltantes.length ? `<p class="hint">Faltantes: ${a.faltantes.map(escapeHtml).join(", ")}</p>` : ""}
      ${a.sobrantes.length ? `<p class="hint">Sobrantes: ${a.sobrantes.map(escapeHtml).join(", ")}</p>` : ""}
    </div>`).join("");
}

// --- Utilidades ---
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
// Días (enteros) desde HOY hasta la fecha YYYY-MM-DD (negativo si ya pasó).
function daysUntil(dateStr) {
  if (!dateStr) return 0;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const [y, m, d] = dateStr.split("-").map(Number);
  const target = new Date(y, (m || 1) - 1, d || 1); target.setHours(0, 0, 0, 0);
  return Math.round((target - today) / 86400000);
}
function formatDate(dateStr) {
  if (!dateStr) return "—";
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1).toLocaleDateString("es-MX",
    { weekday: "short", day: "2-digit", month: "short", year: "numeric" });
}
function csvCell(s) {
  const str = String(s ?? "");
  return /[",\r\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
}
function slug(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime || "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 500);
}

// --- Avisos de auditorías próximas (nivel A: in-app; nivel B: navegador) ---
// Se llama al iniciar sesión. Muestra un aviso por cada auditoría programada que
// esté dentro de su ventana de aviso (date - notifyDays <= hoy) o ya vencida.
// La notificación del navegador solo se envía si el usuario concede permiso.
export function checkAuditReminders() {
  const pendientes = store.listScheduledAudits().filter(s => {
    if (s.done) return false;
    const dLeft = daysUntil(s.date);
    return dLeft <= (s.notifyDays ?? 3); // dentro de la ventana de aviso o vencida
  });
  if (!pendientes.length) return;

  // Aviso in-app (siempre).
  pendientes.forEach(s => {
    const dLeft = daysUntil(s.date);
    const cuando = dLeft < 0 ? `vencida hace ${-dLeft} día(s)`
      : dLeft === 0 ? "programada para HOY" : `en ${dLeft} día(s)`;
    notify(`🔔 Auditoría ${cuando}: ${s.agency} (${formatDate(s.date)}).`,
      { type: dLeft <= 0 ? "warn" : "info", title: "Auditoría programada", timeout: 9000 });
  });

  // Aviso del navegador (nivel B), si hay permiso o se puede pedir.
  maybeBrowserNotify(pendientes);
}

function maybeBrowserNotify(pendientes) {
  if (!("Notification" in window)) return;
  const send = () => {
    pendientes.forEach(s => {
      const dLeft = daysUntil(s.date);
      const cuando = dLeft < 0 ? "vencida" : dLeft === 0 ? "hoy" : `en ${dLeft} día(s)`;
      try {
        new Notification("Auditoría programada", {
          body: `${s.agency} · ${s.mode === "full" ? "Total" : "Rotativo"} · ${cuando} (${formatDate(s.date)})`,
          icon: "icons/icon-192.png",
        });
      } catch (e) { /* algunos navegadores exigen SW para notificar: ignorar */ }
    });
  };
  if (Notification.permission === "granted") send();
  else if (Notification.permission !== "denied") {
    Notification.requestPermission().then(p => { if (p === "granted") send(); });
  }
}

// Expuesto para que app.js lo llame al abrir la pestaña.
window.__initAudit = initAudit;
