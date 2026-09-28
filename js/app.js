// app.js — Orquestador: navegación por pestañas, flujo de escaneo, registro de
// eventos, respaldo de datos e instalación PWA.
import { decodeVin } from "./vin.js";
import { Scanner } from "./scanner.js";
import { store } from "./storage.js";
import { registerEvent } from "./events.js";
import { initAgencies, escapeHtml } from "./agencies.js";
import { initInventory, renderInventory } from "./inventory.js";
import { initMap, drawMap, refreshMapVinOptions } from "./map.js";
import { initReports, renderReports, refreshReportAgencies } from "./reports.js";

let currentDecode = null;   // resultado del último VIN decodificado
let scanner = null;

// ---------- Toast ----------
function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), 2600);
}

// ---------- Navegación por pestañas ----------
function setupTabs() {
  const tabs = document.querySelectorAll(".tab");
  tabs.forEach(tab =>
    tab.addEventListener("click", () => {
      tabs.forEach(t => t.classList.remove("is-active"));
      tab.classList.add("is-active");
      document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("is-active"));
      const name = tab.dataset.tab;
      document.getElementById("tab-" + name).classList.add("is-active");
      if (name === "map") { refreshMapVinOptions(); drawMap(); }
      if (name === "reports") { refreshReportAgencies(); renderReports(); }
      if (name === "inventory") renderInventory();
    })
  );
}

// ---------- Selectores de agencia/ubicación en el formulario de evento ----------
function fillEventSelectors() {
  const agSel = document.getElementById("ev-agency");
  const locSel = document.getElementById("ev-location");
  const agencies = store.listAgencies();
  const curAg = agSel.value;
  agSel.innerHTML = agencies.map(a => `<option value="${escapeHtml(a.name)}">${escapeHtml(a.name)}</option>`).join("");
  if (curAg) agSel.value = curAg;

  const fillLocs = () => {
    const a = agencies.find(x => x.name === agSel.value) || agencies[0];
    locSel.innerHTML = (a?.locations || []).map(l => `<option value="${escapeHtml(l)}">${escapeHtml(l)}</option>`).join("");
  };
  agSel.onchange = fillLocs;
  fillLocs();
}

// ---------- Mostrar datos del VIN ----------
function showVinResult(dec) {
  currentDecode = dec;
  const box = document.getElementById("vin-result");
  const chk = dec.checkDigit.ok
    ? '<span class="chk-ok">✓ Coincide</span>'
    : '<span class="chk-bad">✗ No coincide</span>';

  box.innerHTML = `
    <dl>
      <dt>VIN</dt><dd><code>${escapeHtml(dec.vin)}</code></dd>
      <dt>Marca</dt><dd>${escapeHtml(dec.make || "—")}</dd>
      <dt>Año</dt><dd>${escapeHtml(dec.year || "—")}</dd>
      <dt>País</dt><dd>${escapeHtml(dec.country || "—")}</dd>
      <dt>Serie (VIS)</dt><dd><code>${escapeHtml(dec.vis || "—")}</code></dd>
      <dt>Dígito verificador</dt><dd>${chk}</dd>
    </dl>
    ${dec.errors.length ? `<p class="hint" style="color:var(--danger)">${dec.errors.map(escapeHtml).join("<br>")}</p>` : ""}
  `;

  // Mostrar formulario de evento sólo si el VIN tiene 17 caracteres válidos de formato
  const form = document.getElementById("event-form");
  form.hidden = dec.vin.length !== 17 || dec.errors.some(e => e.includes("caracteres no válidos") || e.includes("17"));
  fillEventSelectors();
}

function handleScannedText(text) {
  // El código puede traer el VIN "crudo"; lo decodificamos
  const dec = decodeVin(text);
  document.getElementById("vin-input").value = dec.vin;
  showVinResult(dec);
  if (dec.vin.length === 17) {
    toast(dec.checkDigit.ok ? "VIN leído correctamente" : "VIN leído (verifica el dígito)");
  }
}

// ---------- Escáner ----------
function setupScanner() {
  const video = document.getElementById("scan-video");
  const startBtn = document.getElementById("scan-start");
  const stopBtn = document.getElementById("scan-stop");
  const status = document.getElementById("scan-status");

  scanner = new Scanner(video, {
    onResult: (text) => { handleScannedText(text); },
    onStatus: (msg, kind) => {
      status.textContent = msg;
      status.style.color = kind === "error" ? "var(--danger)" : (kind === "ok" ? "var(--primary)" : "var(--muted)");
    },
  });

  startBtn.addEventListener("click", async () => {
    try {
      await scanner.start();
      startBtn.hidden = true;
      stopBtn.hidden = false;
    } catch (e) { /* onStatus ya mostró el error */ }
  });
  stopBtn.addEventListener("click", () => {
    scanner.stop();
    startBtn.hidden = false;
    stopBtn.hidden = true;
    status.textContent = "Cámara detenida.";
    status.style.color = "var(--muted)";
  });

  // Captura manual
  document.getElementById("vin-decode").addEventListener("click", () => {
    const val = document.getElementById("vin-input").value;
    handleScannedText(val);
  });
  document.getElementById("vin-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); handleScannedText(e.target.value); }
  });
}

// ---------- Registro de eventos ----------
function setupEventButtons() {
  const gpsStatus = document.getElementById("gps-status");
  const onGps = (msg, kind) => {
    gpsStatus.textContent = msg;
    gpsStatus.style.color = kind === "error" || kind === "warn" ? "var(--danger)" : "var(--muted)";
  };

  const doEvent = async (type) => {
    if (!currentDecode || currentDecode.vin.length !== 17) {
      toast("Primero escanea o captura un VIN válido");
      return;
    }
    const vin = currentDecode.vin;
    // Guardar datos básicos del VIN la primera vez
    if (!store.getVehicle(vin)) {
      store.upsertVehicle({
        vin,
        make: currentDecode.make,
        year: currentDecode.year,
        country: currentDecode.country,
      });
    }
    const agency = document.getElementById("ev-agency").value;
    const location = document.getElementById("ev-location").value;
    const condition = document.getElementById("ev-condition").value;

    await registerEvent({ vin, type, agency, location, condition }, onGps);
    const labels = { entry: "Entrada", move: "Movimiento", exit: "Salida" };
    toast(`${labels[type]} registrada: ${vin}`);
    refreshAll();
  };

  document.getElementById("ev-entry").addEventListener("click", () => doEvent("entry"));
  document.getElementById("ev-move").addEventListener("click", () => doEvent("move"));
  document.getElementById("ev-exit").addEventListener("click", () => doEvent("exit"));
}

// ---------- Respaldo de datos ----------
function setupDataButtons() {
  document.getElementById("export-data").addEventListener("click", () => {
    const blob = new Blob([store.export()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "respaldo-inventario-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    URL.revokeObjectURL(url);
  });

  const fileInput = document.getElementById("import-file");
  document.getElementById("import-data").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (!file) return;
    try {
      store.import(await file.text());
      toast("Respaldo importado");
      refreshAll();
    } catch (e) { alert("Archivo no válido: " + e.message); }
    fileInput.value = "";
  });

  document.getElementById("wipe-data").addEventListener("click", () => {
    if (confirm("¿Borrar TODOS los datos de este dispositivo? Esta acción no se puede deshacer.")) {
      store.wipe();
      toast("Datos borrados");
      location.reload();
    }
  });
}

// ---------- Instalación PWA ----------
function setupInstall() {
  let deferred = null;
  const btn = document.getElementById("install-btn");
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e;
    btn.hidden = false;
  });
  btn.addEventListener("click", async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice;
    deferred = null;
    btn.hidden = true;
  });
  window.addEventListener("appinstalled", () => (btn.hidden = true));
}

// ---------- Service Worker ----------
function setupServiceWorker() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    });
  }
}

// ---------- Refrescos globales ----------
function refreshAll() {
  renderInventory();
  refreshMapVinOptions();
  if (document.getElementById("tab-map").classList.contains("is-active")) drawMap();
  if (document.getElementById("tab-reports").classList.contains("is-active")) renderReports();
  fillEventSelectors();
}

// ---------- Arranque ----------
function main() {
  setupTabs();
  setupScanner();
  setupEventButtons();
  setupDataButtons();
  setupInstall();
  setupServiceWorker();

  initAgencies(refreshAll);
  initInventory(refreshAll);
  initMap();
  initReports();
  fillEventSelectors();
}

document.addEventListener("DOMContentLoaded", main);
