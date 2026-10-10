// syslogview.js — Pestaña "Bitácora de auditoría" (solo admin). Muestra el registro
// de acciones del sistema con filtro por texto/acción y exportación a CSV.
import { listLog, SYSLOG_ACTIONS } from "./syslog.js";
import { escapeHtml } from "./agencies.js";

export function initSyslog() {
  const sel = document.getElementById("syslog-action");
  if (sel) sel.innerHTML = '<option value="">Todas las acciones</option>' +
    Object.entries(SYSLOG_ACTIONS).map(([k, v]) => `<option value="${k}">${escapeHtml(v)}</option>`).join("");

  const search = document.getElementById("syslog-search");
  if (search) search.addEventListener("input", renderSyslog);
  if (sel) sel.addEventListener("change", renderSyslog);
  const csv = document.getElementById("syslog-csv");
  if (csv) csv.addEventListener("click", exportCsv);

  renderSyslog();
}

export function renderSyslog() {
  const tbody = document.querySelector("#syslog-table tbody");
  const empty = document.getElementById("syslog-empty");
  const count = document.getElementById("syslog-count");
  if (!tbody) return;

  const q = document.getElementById("syslog-search")?.value || "";
  const action = document.getElementById("syslog-action")?.value || "";
  const rows = listLog({ q, action });

  if (empty) empty.style.display = rows.length ? "none" : "block";
  if (count) count.textContent = rows.length ? `${rows.length} registro${rows.length === 1 ? "" : "s"}` : "";

  tbody.innerHTML = rows.map(e => `
    <tr>
      <td>${escapeHtml(new Date(e.at).toLocaleString())}</td>
      <td>${escapeHtml(SYSLOG_ACTIONS[e.action] || e.action)}</td>
      <td>${escapeHtml(e.by || "—")}</td>
      <td>${e.vin ? `<code>${escapeHtml(e.vin)}</code>` : ""}</td>
      <td class="muted">${escapeHtml(e.detail || "")}</td>
    </tr>`).join("");
}

function exportCsv() {
  const q = document.getElementById("syslog-search")?.value || "";
  const action = document.getElementById("syslog-action")?.value || "";
  const rows = listLog({ q, action });
  const esc = (s) => { const t = String(s ?? ""); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  const header = ["Fecha y hora", "Acción", "Usuario", "VIN", "Detalle"];
  const lines = [header.map(esc).join(",")].concat(rows.map(e => [
    new Date(e.at).toLocaleString(), SYSLOG_ACTIONS[e.action] || e.action, e.by || "", e.vin || "", e.detail || "",
  ].map(esc).join(",")));
  const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "bitacora-" + new Date().toISOString().slice(0, 10) + ".csv";
  a.click();
  URL.revokeObjectURL(url);
}
