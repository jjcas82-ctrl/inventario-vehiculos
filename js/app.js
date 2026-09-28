// app.js — Orquestador: navegación por pestañas, flujo de escaneo, registro de
// eventos, respaldo de datos e instalación PWA.
import { decodeVin, normalizeVin } from "./vin.js";
import { Scanner } from "./scanner.js";
import { readVinFromVideo } from "./ocr.js";
import { enrichVin } from "./vinapi.js";
import { store } from "./storage.js";
import { registerEvent } from "./events.js";
import { initAgencies, escapeHtml } from "./agencies.js";
import { initInventory, renderInventory } from "./inventory.js";
import { initMap, drawMap, refreshMapVinOptions } from "./map.js";
import { initReports, renderReports, refreshReportAgencies } from "./reports.js";
import { notify, confirmDialog, promptDialog } from "./ui.js";

let currentDecode = null;   // resultado del último VIN decodificado
let scanner = null;

// Compat: mantenemos toast() pero ahora usa el aviso bonito.
function toast(msg, type = "info") { notify(msg, { type }); }

// ---------- Usuario que registra ----------
function refreshUserLabel() {
  const el = document.getElementById("user-name");
  const u = store.getUser();
  el.textContent = u || "Sin usuario";
}

async function askUser({ force = false } = {}) {
  const current = store.getUser();
  if (current && !force) return current;
  const name = await promptDialog({
    icon: "👤",
    title: "¿Quién registra?",
    message: "Escribe tu nombre o iniciales. Quedará guardado en cada entrada, salida y movimiento que registres.",
    placeholder: "Ej. Juan Pérez",
    value: current || "",
  });
  if (name && name.trim()) {
    store.setUser(name.trim());
    refreshUserLabel();
    return name.trim();
  }
  return current;
}

function setupUser() {
  refreshUserLabel();
  document.getElementById("user-btn").addEventListener("click", () => askUser({ force: true }));
  // Si no hay usuario, lo pedimos al inicio (no bloqueante, una sola vez).
  if (!store.getUser()) setTimeout(() => askUser(), 400);
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

  // Resalta cada sección del VIN con color, como en el diagrama del VIN.
  const v = dec.vin;
  const seg = (a, b, cls) => `<span class="vinseg ${cls}">${escapeHtml(v.slice(a, b))}</span>`;
  const vinColored = v.length === 17
    ? seg(0,3,"s-wmi") + seg(3,8,"s-vds") + seg(8,9,"s-chk") + seg(9,10,"s-year") + seg(10,11,"s-plant") + seg(11,17,"s-serial")
    : `<code>${escapeHtml(v)}</code>`;

  const rows = (dec.breakdown || []).map(b => `
    <tr>
      <td class="vinpos">${escapeHtml(b.pos)}</td>
      <td><code>${escapeHtml(b.value)}</code></td>
      <td>${escapeHtml(b.label)}</td>
      <td class="muted">${escapeHtml(b.detail || "")}</td>
    </tr>`).join("");

  box.innerHTML = `
    <div class="vin-colored">${vinColored}</div>
    <dl>
      <dt>Marca</dt><dd>${dec.make && dec.make !== "Desconocido" ? escapeHtml(dec.make) : '<span class="muted">Se completa manualmente</span>'}</dd>
      <dt>Año del modelo</dt><dd>${escapeHtml(dec.year || "—")}</dd>
      <dt>País de origen</dt><dd>${escapeHtml(dec.country || "—")}</dd>
      <dt>Planta (pos. 11)</dt><dd><code>${escapeHtml(dec.plant || "—")}</code></dd>
      <dt>N.º de serie (12-17)</dt><dd><code>${escapeHtml(dec.serial || "—")}</code></dd>
      <dt>Dígito de control</dt><dd>${chk}${dec.checkDigit.expected && !dec.checkDigit.ok ? ` <span class="muted">(esperado ${escapeHtml(dec.checkDigit.expected)})</span>` : ""}</dd>
    </dl>
    ${dec.breakdown && dec.breakdown.length ? `
      <details class="vin-details">
        <summary>Ver desglose completo del VIN</summary>
        <table class="table vin-breakdown">
          <thead><tr><th>Pos.</th><th>Valor</th><th>Significado</th><th>Detalle</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </details>` : ""}
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
    notify(dec.checkDigit.ok ? "VIN leído correctamente." : "VIN leído. Revisa el dígito de control.",
      { type: dec.checkDigit.ok ? "success" : "warn" });
    // Enriquecer con la API de NHTSA en segundo plano (si hay internet).
    tryEnrich(dec);
  }
  return dec;
}

// Consulta online los datos que el VIN sí codifica (modelo, carrocería, motor…).
async function tryEnrich(dec) {
  const box = document.getElementById("vin-result");
  const note = document.createElement("p");
  note.className = "hint";
  note.textContent = "Consultando datos oficiales del VIN (en línea)…";
  box.appendChild(note);

  const { online, data, error } = await enrichVin(dec.vin, { year: dec.year });
  // Puede que el usuario ya haya escaneado otro VIN mientras tanto.
  if (!currentDecode || currentDecode.vin !== dec.vin) return;

  if (!online) { note.textContent = "Sin conexión: se muestran los datos calculados del VIN (marca, país, año, planta)."; return; }
  if (!data || error) { note.textContent = "No se obtuvieron datos oficiales adicionales" + (error ? " (" + error + ")" : "") + "."; return; }

  // NHTSA solo cubre vehículos del mercado EE.UU. Si no trae marca ni modelo,
  // significa que ese VIN no está en su base (p. ej. vehículos hechos en China/Asia).
  if (!data.make && !data.model && !data.bodyClass) {
    note.textContent = "Este VIN no está en la base oficial de NHTSA (cubre vehículos del mercado EE.UU.). " +
      "Se muestran los datos calculados del VIN; completa el modelo manualmente en la ficha.";
    note.style.color = "var(--muted)";
    return;
  }

  // Fusionamos: la API tiene prioridad para marca/modelo/carrocería/motor.
  dec.apiMake = data.make;
  dec.model = data.model;
  dec.bodyClass = data.bodyClass;
  dec.vehicleType = data.vehicleType;
  dec.fuelType = data.fuelType;
  dec.engine = [data.displacementL ? data.displacementL + " L" : null,
                data.engineCyl ? data.engineCyl + " cil." : null,
                data.engineHP ? data.engineHP + " HP" : null].filter(Boolean).join(" · ");
  dec.transmission = data.transmission;
  dec.driveType = data.driveType;
  dec.plantCity = [data.plantCity, data.plantCountry].filter(Boolean).join(", ");
  dec.series = data.series;
  dec.trim = data.trim;
  if (data.make && (!dec.make || dec.make === "Desconocido")) dec.make = data.make;

  currentDecode = dec;
  renderApiExtras(dec);       // añade los campos extra a la vista
  saveVinBasics(dec);         // actualiza los datos guardados del vehículo
}

// Guarda/actualiza en el almacén los datos básicos derivados del VIN + API.
function saveVinBasics(dec) {
  const patch = { vin: dec.vin };
  if (dec.make) patch.make = dec.make;
  if (dec.year) patch.year = dec.year;
  if (dec.country) patch.country = dec.country;
  if (dec.model) patch.model = dec.model;
  if (dec.bodyClass) patch.bodyClass = dec.bodyClass;
  if (dec.fuelType) patch.fuelType = dec.fuelType;
  if (dec.engine) patch.engine = dec.engine;
  if (dec.transmission) patch.transmission = dec.transmission;
  store.upsertVehicle(patch);
  renderInventory();
}

// Muestra los datos oficiales extra debajo del desglose.
function renderApiExtras(dec) {
  const box = document.getElementById("vin-result");
  let extra = box.querySelector("#vin-api-extra");
  if (!extra) {
    extra = document.createElement("dl");
    extra.id = "vin-api-extra";
    extra.style.marginTop = "10px";
    box.appendChild(extra);
  }
  const row = (label, val) => val ? `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(val)}</dd>` : "";
  extra.innerHTML =
    `<dt style="grid-column:1/-1;color:var(--primary);font-weight:600;">Datos oficiales (NHTSA)</dt>` +
    row("Modelo", dec.model) +
    row("Carrocería", dec.bodyClass) +
    row("Tipo", dec.vehicleType) +
    row("Motor", dec.engine) +
    row("Combustible", dec.fuelType) +
    row("Transmisión", dec.transmission) +
    row("Tracción", dec.driveType) +
    row("Versión", dec.trim || dec.series) +
    row("Planta", dec.plantCity);
  // Quita cualquier nota de "consultando…"
  box.querySelectorAll("p.hint").forEach(p => {
    if (/Consultando datos oficiales/.test(p.textContent)) p.remove();
  });
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
    const ob = document.getElementById("scan-ocr");
    if (ob) ob.textContent = "🔤 Leer VIN de texto (foto)";
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
  const OCR_LABEL = "🔤 Leer VIN de texto (foto)";
  const OCR_SHOOT = "📸 Tomar foto y leer VIN";

  ocrBtn.addEventListener("click", async () => {
    // Si la cámara no está abierta, la abrimos primero y NO tomamos foto todavía.
    if (!scanner.running) {
      try {
        await scanner.start();
        startBtn.hidden = true;
        stopBtn.hidden = false;
        ocrBtn.textContent = OCR_SHOOT;
        setStatus("Encuadra el VIN de texto dentro del recuadro, bien enfocado, y toca “📸 Tomar foto y leer VIN”.", "ok");
        return; // dar tiempo a encuadrar
      } catch (e) { return; }
    }
    ocrBtn.disabled = true;
    ocrBtn.textContent = "Leyendo…";
    try {
      setStatus("Tomando foto y leyendo el texto del VIN…", "muted");
      const { vin, raw, lowInk } = await readVinFromVideo(video, {
        onProgress: (m) => setStatus(m, "muted"),
        onCandidate: (c) => diagLog("OCR leyó: " + JSON.stringify(c)),
      });
      if (vin) {
        handleScannedText(vin);
        stopCamera();
        setStatus("✓ VIN leído por texto: " + vin, "ok");
      } else if (lowInk) {
        setStatus("No se ve texto en el recuadro. Apunta directamente al VIN (como la fila de letras/números) y que ocupe el ancho del recuadro, bien enfocado. Luego toca 📸 otra vez.", "error");
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
      // Si la cámara sigue abierta, deja el botón en modo "tomar foto"; si no, en modo inicial.
      ocrBtn.textContent = scanner.running ? OCR_SHOOT : OCR_LABEL;
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
      notify("Primero escanea o captura un VIN válido.", { type: "warn" });
      return;
    }
    const vin = currentDecode.vin;
    const existing = store.getVehicle(vin);
    const agency = document.getElementById("ev-agency").value;
    const location = document.getElementById("ev-location").value;
    const condition = document.getElementById("ev-condition").value;

    const status = existing?.status; // "dentro" | "fuera" | undefined
    const curLocation = existing?.currentLocation;
    const curAgency = existing?.currentAgency;

    // === CASO IMPORTANTE: intentan "Entrada" cuando la unidad YA está dentro. ===
    // Es el error que más confunde, así que aquí SÍ mostramos un diálogo claro,
    // pero con la acción correcta a un toque (registrar movimiento).
    if (type === "entry" && status === "dentro") {
      const ingreso = existing?.entryAt ? new Date(existing.entryAt).toLocaleString() : "—";
      const quien = existing?.entryBy || existing?.lastBy || "—";
      const choice = await confirmDialog({
        icon: "🚗",
        title: "La unidad ya está dentro",
        message:
          `El VIN ${vin} ya tiene una ENTRADA registrada y no ha salido.\n\n` +
          `📍 Ubicación actual: ${curLocation || "—"} (${curAgency || "—"})\n` +
          `📅 Ingreso: ${ingreso}\n` +
          `👤 Registró: ${quien}\n\n` +
          `¿Deseas registrar un MOVIMIENTO interno a "${location}"?`,
        buttons: [
          { label: "Cancelar", value: "cancel", variant: "ghost" },
          { label: `Mover a ${location}`, value: "move", variant: "primary" },
        ],
      });
      if (choice !== "move") { notify("No se registró nada. Verifica la unidad.", { type: "info" }); return; }
      return finalizeEvent(vin, "move", agency, location, condition, existing);
    }

    // === Casos menores: NO bloqueamos con diálogo. Registramos y avisamos suave. ===
    // (Evita la sensación de "muchos mensajes de error".)
    if (type === "exit" && status === "fuera") {
      notify("Nota: esta unidad ya figuraba fuera. Se registró la salida igualmente.", { type: "warn", title: "Aviso" });
    } else if (type === "exit" && !existing) {
      notify("Nota: no había entrada previa de esta unidad. Se registró la salida.", { type: "warn", title: "Aviso" });
    } else if (type === "move" && status !== "dentro") {
      notify("Nota: la unidad no figuraba dentro. Se registró el movimiento.", { type: "warn", title: "Aviso" });
    }

    return finalizeEvent(vin, type, agency, location, condition, existing);
  };

  // Guarda datos básicos del VIN (1ª vez) y registra el evento.
  const finalizeEvent = async (vin, type, agency, location, condition, existing) => {
    if (!existing) {
      store.upsertVehicle({
        vin,
        make: currentDecode.make,
        year: currentDecode.year,
        country: currentDecode.country,
      });
    }
    // Asegura que haya un usuario asociado al registro.
    let by = store.getUser();
    if (!by) by = await askUser();
    await registerEvent({ vin, type, agency, location, condition, by }, onGps);
    const labels = { entry: "Entrada", move: "Movimiento", exit: "Salida" };
    notify(`${labels[type]} registrada por ${by || "—"}.`, { type: "success", title: vin });
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
      notify("Respaldo importado correctamente.", { type: "success" });
      refreshAll();
    } catch (e) { notify("Archivo no válido: " + e.message, { type: "error" }); }
    fileInput.value = "";
  });

  document.getElementById("wipe-data").addEventListener("click", async () => {
    const choice = await confirmDialog({
      icon: "🗑️",
      title: "Borrar todos los datos",
      message: "Se eliminarán TODOS los vehículos, eventos y agencias de este dispositivo. Esta acción no se puede deshacer.\n\nSugerencia: exporta un respaldo antes.",
      buttons: [
        { label: "Cancelar", value: "cancel", variant: "ghost" },
        { label: "Sí, borrar todo", value: "wipe", variant: "danger" },
      ],
    });
    if (choice === "wipe") {
      store.wipe();
      notify("Datos borrados.", { type: "success" });
      setTimeout(() => location.reload(), 600);
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
  setupUser();
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
