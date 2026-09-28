// audit.js — Conteo físico / auditoría de inventario.
//
// Flujo:
//   1) El usuario elige agencia y tipo de conteo:
//        - "full": todas las unidades que figuran DENTRO de esa agencia.
//        - "random": una muestra aleatoria de N unidades (rotativo).
//   2) Escanea (o captura) cada unidad presente físicamente.
//   3) El sistema marca: PRESENTE, FALTANTE (esperada no vista) y SOBRANTE
//      (vista pero no esperada / de otra agencia / no registrada).
//   4) Se guarda el resultado con fecha y usuario.

import { store } from "./storage.js";
import { Scanner } from "./scanner.js";
import { normalizeVin } from "./vin.js";
import { escapeHtml } from "./agencies.js";
import { notify, confirmDialog } from "./ui.js";
import * as auth from "./auth.js";

let session = null;   // { agency, mode, expected:Set, seen:Map(vin->status), extras:Set }
let scanner = null;

export function initAudit() {
  // Poblar agencias
  const agSel = document.getElementById("audit-agency");
  agSel.innerHTML = store.listAgencies()
    .map(a => `<option value="${escapeHtml(a.name)}">${escapeHtml(a.name)}</option>`).join("");

  const modeSel = document.getElementById("audit-mode");
  const countField = document.getElementById("audit-count-field");
  const updateScope = () => {
    countField.style.display = modeSel.value === "random" ? "" : "none";
    const agency = agSel.value;
    const dentro = store.listVehicles().filter(v => v.status === "dentro" && v.currentAgency === agency);
    const scope = document.getElementById("audit-scope");
    if (modeSel.value === "full") {
      scope.textContent = `Se auditarán las ${dentro.length} unidades que figuran DENTRO de ${agency}.`;
    } else {
      const n = Math.min(parseInt(document.getElementById("audit-count").value, 10) || 0, dentro.length);
      scope.textContent = `Se elegirán ${n} unidades al azar de las ${dentro.length} que figuran DENTRO de ${agency}.`;
    }
  };
  agSel.onchange = updateScope;
  modeSel.onchange = updateScope;
  document.getElementById("audit-count").oninput = updateScope;
  updateScope();

  document.getElementById("audit-start").onclick = startAudit;
  document.getElementById("audit-cancel").onclick = cancelAudit;
  document.getElementById("audit-finish").onclick = finishAudit;
  document.getElementById("audit-manual-btn").onclick = () => {
    markPresent(document.getElementById("audit-manual").value);
    document.getElementById("audit-manual").value = "";
  };
  document.getElementById("audit-manual").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); document.getElementById("audit-manual-btn").click(); }
  });

  setupAuditScanner();
  renderHistory();
}

function startAudit() {
  const agency = document.getElementById("audit-agency").value;
  const mode = document.getElementById("audit-mode").value;
  const dentro = store.listVehicles().filter(v => v.status === "dentro" && v.currentAgency === agency);

  let expectedVehicles = dentro;
  if (mode === "random") {
    const n = Math.max(1, Math.min(parseInt(document.getElementById("audit-count").value, 10) || 1, dentro.length));
    expectedVehicles = shuffle([...dentro]).slice(0, n);
  }
  if (!expectedVehicles.length) {
    notify("No hay unidades dentro de esta agencia para auditar.", { type: "warn" });
    return;
  }

  session = {
    agency, mode,
    startedAt: new Date().toISOString(),
    by: auth.currentUser()?.name || "—",
    expected: new Map(expectedVehicles.map(v => [v.vin, v])),
    seen: new Map(),   // vin -> "presente" | "sobrante"
  };

  document.getElementById("audit-setup").hidden = true;
  document.getElementById("audit-run").hidden = false;
  renderRun();
}

function markPresent(raw) {
  if (!session) return;
  const vin = normalizeVin(raw);
  if (vin.length !== 17) { setStatus("VIN inválido (deben ser 17 caracteres).", "error"); return; }

  if (session.seen.has(vin)) { setStatus("Esa unidad ya fue contada.", "info"); return; }

  if (session.expected.has(vin)) {
    session.seen.set(vin, "presente");
    setStatus("✓ Presente: " + vin, "ok");
  } else {
    // No estaba en la lista esperada: sobrante (o de otra agencia / no registrada)
    session.seen.set(vin, "sobrante");
    const v = store.getVehicle(vin);
    const donde = v ? ` (figura en ${v.currentAgency || "—"})` : " (no registrada)";
    setStatus("⚠️ Sobrante: " + vin + donde, "warn");
  }
  renderRun();
}

function computeResults() {
  const presentes = [], faltantes = [], sobrantes = [];
  for (const [vin, v] of session.expected) {
    if (session.seen.get(vin) === "presente") presentes.push(vin);
    else faltantes.push(vin);
  }
  for (const [vin, status] of session.seen) {
    if (status === "sobrante") sobrantes.push(vin);
  }
  return { presentes, faltantes, sobrantes };
}

function renderRun() {
  const { presentes, faltantes, sobrantes } = computeResults();
  const total = session.expected.size;

  document.getElementById("audit-progress").innerHTML = `
    <div class="stat"><b>${presentes.length}/${total}</b><span>Contadas</span></div>
    <div class="stat"><b>${faltantes.length}</b><span>Faltantes</span></div>
    <div class="stat"><b>${sobrantes.length}</b><span>Sobrantes</span></div>
  `;

  // Tabla: esperadas + sobrantes
  const rows = [];
  for (const [vin, v] of session.expected) {
    const st = session.seen.get(vin) === "presente"
      ? '<span class="tag tag-in">Presente</span>'
      : '<span class="tag tag-out">Faltante</span>';
    rows.push(`<tr><td><code>${escapeHtml(vin)}</code></td><td>${escapeHtml(v.make || "")}</td>
      <td>${escapeHtml(v.currentLocation || "")}</td><td>${st}</td></tr>`);
  }
  for (const [vin, status] of session.seen) {
    if (status !== "sobrante") continue;
    const v = store.getVehicle(vin);
    rows.push(`<tr><td><code>${escapeHtml(vin)}</code></td><td>${escapeHtml(v?.make || "")}</td>
      <td class="muted">${escapeHtml(v?.currentAgency || "no registrada")}</td>
      <td><span class="tag" style="background:#fef3c7;color:#92400e">Sobrante</span></td></tr>`);
  }
  document.querySelector("#audit-table tbody").innerHTML = rows.join("");
}

async function finishAudit() {
  if (!session) return;
  const { presentes, faltantes, sobrantes } = computeResults();
  const choice = await confirmDialog({
    icon: "📋", title: "Finalizar conteo",
    message: `Resultado del conteo en ${session.agency}:\n\n` +
      `• Presentes: ${presentes.length}\n• Faltantes: ${faltantes.length}\n• Sobrantes: ${sobrantes.length}\n\n¿Guardar este resultado?`,
    buttons: [
      { label: "Seguir contando", value: null, variant: "ghost" },
      { label: "Guardar resultado", value: "save", variant: "primary" },
    ],
  });
  if (choice !== "save") return;

  store.addAudit({
    agency: session.agency,
    mode: session.mode,
    by: session.by,
    startedAt: session.startedAt,
    finishedAt: new Date().toISOString(),
    totalExpected: session.expected.size,
    presentes, faltantes, sobrantes,
  });
  stopScanner();
  session = null;
  document.getElementById("audit-run").hidden = true;
  document.getElementById("audit-setup").hidden = false;
  renderHistory();
  notify("Conteo guardado.", { type: "success" });
}

function cancelAudit() {
  stopScanner();
  session = null;
  document.getElementById("audit-run").hidden = true;
  document.getElementById("audit-setup").hidden = false;
}

// ---- Escáner de auditoría (reutiliza la clase Scanner) ----
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

  startBtn.onclick = async () => {
    try {
      await scanner.start();
      wrap.hidden = false;
      startBtn.hidden = true;
      stopBtn.hidden = false;
    } catch (e) {}
  };
  stopBtn.onclick = stopScanner;
}

function stopScanner() {
  if (scanner) scanner.stop();
  const wrap = document.getElementById("audit-scanner-wrap");
  if (wrap) wrap.hidden = true;
  const startBtn = document.getElementById("audit-scan");
  const stopBtn = document.getElementById("audit-scan-stop");
  if (startBtn) startBtn.hidden = false;
  if (stopBtn) stopBtn.hidden = true;
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

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Expuesto para que app.js lo llame al abrir la pestaña.
window.__initAudit = initAudit;
