// dashboard.js — Pantalla de inicio: indicadores clave + alertas proactivas.
import { store } from "./storage.js";
import { escapeHtml } from "./agencies.js";
import { getAlerts } from "./alerts.js";
import { openVehicle } from "./inventory.js";

let goToTab = () => {};

export function initDashboard(navigate) {
  goToTab = navigate || (() => {});
  renderDashboard();
}

export function renderDashboard() {
  renderStats();
  renderAlerts();
}

function renderStats() {
  const el = document.getElementById("dash-stats");
  if (!el) return;
  const vehicles = store.listVehicles();
  const dentro = vehicles.filter(v => v.status === "dentro");
  const fuera = vehicles.filter(v => v.status === "fuera");
  const nuevos = dentro.filter(v => v.condition === "nuevo").length;
  const usados = dentro.filter(v => v.condition === "usado").length;

  // Ingresos de hoy
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const ingresosHoy = store.listEvents().filter(e => e.type === "entry" && new Date(e.at) >= hoy).length;
  const salidasHoy = store.listEvents().filter(e => e.type === "exit" && new Date(e.at) >= hoy).length;

  // Por agencia (solo dentro)
  const byAgency = {};
  dentro.forEach(v => { byAgency[v.currentAgency || "—"] = (byAgency[v.currentAgency || "—"] || 0) + 1; });

  const stat = (b, s, extra = "") => `<div class="stat ${extra}"><b>${b}</b><span>${escapeHtml(s)}</span></div>`;

  el.innerHTML =
    stat(dentro.length, "Unidades dentro", "stat-wide") +
    stat(nuevos, "Nuevos") +
    stat(usados, "Seminuevos / usados") +
    stat(fuera.length, "Fuera (salidas)") +
    stat(ingresosHoy, "Ingresos hoy") +
    stat(salidasHoy, "Salidas hoy") +
    Object.entries(byAgency).sort((a, b) => b[1] - a[1])
      .map(([a, n]) => stat(n, a)).join("");

  const upd = document.getElementById("dash-updated");
  if (upd) upd.textContent = "Actualizado: " + new Date().toLocaleString();
}

function renderAlerts() {
  const cont = document.getElementById("dash-alerts");
  if (!cont) return;
  const a = getAlerts();

  const countEl = document.getElementById("dash-alert-count");
  if (countEl) countEl.textContent = a.total ? `${a.total} pendiente${a.total === 1 ? "" : "s"}` : "Sin pendientes 🎉";

  if (!a.total) {
    cont.innerHTML = '<p class="muted">No hay alertas. Todo el inventario está al día. 🎉</p>';
    return;
  }

  const vinChip = (x) =>
    `<button class="btn alert-vin" data-vin="${escapeHtml(x.vin)}" title="Abrir ficha">
       <code>${escapeHtml(x.vin)}</code>${x.make || x.model ? " · " + escapeHtml([x.make, x.model].filter(Boolean).join(" ")) : ""}
       ${x.days != null ? `<span class="tag" style="margin-left:6px">${x.days} días</span>` : ""}
       ${x.falta ? `<span class="tag" style="margin-left:6px;background:#fee2e2;color:#991b1b">falta ${escapeHtml(x.falta)}</span>` : ""}
       ${x.agency ? `<span class="muted" style="margin-left:6px">${escapeHtml(x.agency)}</span>` : ""}
     </button>`;

  const block = (titulo, icon, lista, clase) => {
    if (!lista.length) return "";
    return `
      <div class="alert-block ${clase}">
        <b>${icon} ${escapeHtml(titulo)} (${lista.length})</b>
        <div class="alert-list">${lista.map(vinChip).join("")}</div>
      </div>`;
  };

  cont.innerHTML =
    block(`Unidades estancadas (≥ ${a.th.danger} días sin movimiento)`, "🔴", a.estancadas, "alert-danger") +
    block(`Por vencer (≥ ${a.th.warn} días)`, "🟡", a.porVencer, "alert-warn") +
    block("Fichas incompletas", "📝", a.incompletas, "alert-info") +
    block("Registros sin GPS (revisar)", "📍", a.sinGps, "alert-info");

  cont.querySelectorAll(".alert-vin").forEach(btn =>
    btn.addEventListener("click", () => {
      goToTab("inventory");
      openVehicle(btn.dataset.vin);
    })
  );
}
