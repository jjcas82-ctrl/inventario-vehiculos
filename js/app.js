// app.js — Orquestador: navegación por pestañas, flujo de escaneo, registro de
// eventos, respaldo de datos e instalación PWA.
import { decodeVin, normalizeVin } from "./vin.js";
import { Scanner } from "./scanner.js";
import { readVinFromVideo } from "./ocr.js";
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

// Intenta extraer un VIN de 17 caracteres de un texto (el QR/código puede traer
// texto extra o el VIN incrustado en una URL/etiqueta).
function extractVin(text) {
  const norm = normalizeVin(text);
  if (norm.length === 17) return norm;
  // Busca una subcadena de 17 caracteres válidos de VIN
  const m = norm.match(/[A-HJ-NPR-Z0-9]{17}/);
  return m ? m[0] : null;
}

function handleScannedText(text) {
  const vin = extractVin(text) || normalizeVin(text);
  const dec = decodeVin(vin);
  document.getElementById("vin-input").value = dec.vin;
  showVinResult(dec);
  if (dec.vin.length === 17) {
    toast(dec.checkDigit.ok ? "VIN leído correctamente" : "VIN leído (verifica el dígito)");
  }
  return dec;
}

// ---------- Escáner ----------
function setupScanner() {
  const video = document.getElementById("scan-video");
  const startBtn = document.getElementById("scan-start");
  const stopBtn = document.getElementById("scan-stop");
  const status = document.getElementById("scan-status");

  const diag = document.getElementById("scan-diag");
  const diagLog = (line) => {
    diag.hidden = false;
    const t = new Date().toLocaleTimeString();
    diag.textContent = `[${t}] ${line}\n` + diag.textContent;
    diag.textContent = diag.textContent.split("\n").slice(0, 12).join("\n");
  };

  const setStatus = (msg, kind) => {
    status.textContent = msg;
    status.style.color = kind === "error" ? "var(--danger)"
      : (kind === "ok" ? "var(--primary)" : "var(--muted)");
    diagLog(msg);
  };

  const stopCamera = () => {
    scanner.stop();
    startBtn.hidden = false;
    stopBtn.hidden = true;
  };

  scanner = new Scanner(video, {
    onResult: (text) => {
      const vin = extractVin(text);
      if (vin) {
        // ¡VIN encontrado! Lo procesamos y detenemos la cámara.
        handleScannedText(vin);
        stopCamera();
        setStatus("✓ VIN leído: " + vin, "ok");
      } else {
        // Se leyó un código, pero no parece un VIN de 17 caracteres.
        setStatus("Código leído pero no es un VIN de 17 caracteres: “" +
          String(text).slice(0, 30) + "”. Sigue apuntando o usa la captura manual.", "error");
      }
    },
    onDetect: (raw, format) => {
      diagLog(`detectado (${format}): ${String(raw).slice(0, 40)}`);
    },
    onStatus: setStatus,
  });

  startBtn.addEventListener("click", async () => {
    try {
      await scanner.start();
      startBtn.hidden = true;
      stopBtn.hidden = false;
    } catch (e) { /* onStatus ya mostró el error */ }
  });
  stopBtn.addEventListener("click", () => {
    stopCamera();
    setStatus("Cámara detenida.", "muted");
  });

  // ---- OCR: leer el VIN de TEXTO (parabrisas, sin código de barras) ----
  const ocrBtn = document.getElementById("scan-ocr");
  ocrBtn.addEventListener("click", async () => {
    // Si la cámara no está abierta, la abrimos primero.
    if (!scanner.running) {
      try {
        await scanner.start();
        startBtn.hidden = true;
        stopBtn.hidden = false;
        setStatus("Encuadra el VIN dentro del recuadro y toca de nuevo “Leer VIN de texto”.", "ok");
        return; // dar un momento para encuadrar
      } catch (e) { return; }
    }
    ocrBtn.disabled = true;
    const original = ocrBtn.textContent;
    ocrBtn.textContent = "Leyendo…";
    try {
      setStatus("Tomando foto y leyendo el texto del VIN…", "muted");
      const { vin, raw } = await readVinFromVideo(video, {
        onProgress: (m) => setStatus(m, "muted"),
        onCandidate: (c) => diagLog("OCR leyó: " + JSON.stringify(c)),
      });
      if (vin) {
        handleScannedText(vin);
        stopCamera();
        setStatus("✓ VIN leído por texto: " + vin, "ok");
      } else {
        // No salió exacto: precargamos lo mejor leído para que el usuario lo corrija.
        const guess = (raw || "").slice(0, 17);
        setStatus("No salió exacto (17 caracteres). Se leyó: “" + (raw || "—") +
          "”. Lo puse en el campo para que lo corrijas y pulses “Leer VIN”. Reintenta con más luz/enfoque.", "error");
        if (guess) {
          document.getElementById("vin-input").value = guess;
          // Si por casualidad ya son 17 válidos, lo mostramos decodificado
          if (guess.length === 17) handleScannedText(guess);
        }
      }
    } catch (e) {
      setStatus("Error de OCR: " + (e.message || e) + ". Usa la captura manual.", "error");
    } finally {
      ocrBtn.disabled = false;
      ocrBtn.textContent = original;
    }
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
