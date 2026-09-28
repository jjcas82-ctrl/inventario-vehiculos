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
import { notify, confirmDialog, promptDialog, loginDialog } from "./ui.js";
import * as auth from "./auth.js";
import { initUsers, renderUsers } from "./users.js";
import { getPosition } from "./events.js";
import { nearestAgency } from "./geo.js";
import "./audit.js";

let currentDecode = null;   // resultado del último VIN decodificado
let scanner = null;

// Compat: mantenemos toast() pero ahora usa el aviso bonito.
function toast(msg, type = "info") { notify(msg, { type }); }

// ---------- Sesión / Login por rol ----------
function refreshUserLabel() {
  const el = document.getElementById("user-name");
  const u = auth.currentUser();
  el.textContent = u ? `${u.name} · ${auth.ROLES[u.role]?.label || u.role}` : "Iniciar sesión";
}

// Aplica los permisos a la interfaz: pestañas y acciones visibles según el rol.
function applyPermissions() {
  const loggedIn = !!auth.currentUser();
  // Pestañas: mostrar solo las permitidas
  document.querySelectorAll(".tab[data-perm]").forEach(tab => {
    const ok = loggedIn && auth.can(tab.dataset.perm);
    tab.style.display = ok ? "" : "none";
  });
  // Acciones marcadas con data-perm en cualquier parte
  document.querySelectorAll("[data-perm]:not(.tab)").forEach(el => {
    el.style.display = (loggedIn && auth.can(el.dataset.perm)) ? "" : "none";
  });
  // Si la pestaña activa ya no es visible, saltar a la primera visible
  const active = document.querySelector(".tab.is-active");
  if (!active || active.style.display === "none") {
    const first = [...document.querySelectorAll(".tab")].find(t => t.style.display !== "none");
    if (first) first.click();
  }
}

// Flujo de inicio de sesión: usuario + contraseña.
async function login() {
  const creds = await loginDialog({ title: "Iniciar sesión" });
  if (!creds) return false;
  const res = await auth.login(creds.username, creds.password);
  if (!res.ok) {
    notify(res.error, { type: "error", title: "No se pudo iniciar sesión" });
    return false;
  }
  refreshUserLabel();
  applyPermissions();
  renderUsers();
  notify(`Bienvenido, ${res.user.name} (${auth.ROLES[res.user.role]?.label}).`, { type: "success" });
  return true;
}

async function setupUser() {
  await auth.ensureSeedAdmin(); // crea jcabrera/1234 si no hay usuarios con credenciales
  refreshUserLabel();
  document.getElementById("user-btn").addEventListener("click", async () => {
    if (auth.currentUser()) {
      const choice = await confirmDialog({
        icon: "👤", title: auth.currentUser().name,
        message: `Usuario: ${auth.currentUser().username}\nRol: ${auth.ROLES[auth.currentUser().role]?.label || ""}`,
        buttons: [
          { label: "Cerrar sesión", value: "logout", variant: "danger" },
          { label: "Cambiar de usuario", value: "switch", variant: "primary" },
          { label: "Cerrar", value: null, variant: "ghost" },
        ],
      });
      if (choice === "logout") { auth.logout(); refreshUserLabel(); applyPermissions(); }
      else if (choice === "switch") { auth.logout(); refreshUserLabel(); applyPermissions(); await login(); }
    } else {
      await login();
    }
  });
  applyPermissions();
  if (!auth.currentUser()) setTimeout(login, 400);
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
      if (name === "users") renderUsers();
      if (name === "audit") window.__initAudit && window.__initAudit();
    })
  );
}

// ---------- Selectores de agencia/ubicación en el formulario de evento ----------
function fillEventSelectors() {
  const agSel = document.getElementById("ev-agency");
  const areaSel = document.getElementById("ev-area");
  const locSel = document.getElementById("ev-location");
  const subField = document.getElementById("ev-sub-field");
  const agencies = store.listAgencies();

  const curAg = agSel.value;
  agSel.innerHTML = agencies.map(a => `<option value="${escapeHtml(a.name)}">${escapeHtml(a.name)}</option>`).join("");
  if (curAg) agSel.value = curAg;

  const currentAgency = () => agencies.find(x => x.name === agSel.value) || agencies[0];

  // Rellena el selector de Área según la agencia.
  const fillAreas = () => {
    const a = currentAgency();
    const areas = a?.areas || [];
    areaSel.innerHTML = areas.map(ar => `<option value="${escapeHtml(ar.name)}">${escapeHtml(ar.name)}</option>`).join("");
    fillSubs();
  };

  // Rellena las sububicaciones según el área elegida. Si el área no tiene
  // sububicaciones (ej. "Área de Entrega"), oculta el 2.º selector.
  const fillSubs = () => {
    const a = currentAgency();
    const area = (a?.areas || []).find(ar => ar.name === areaSel.value);
    const subs = area?.subs || [];
    if (subs.length) {
      subField.style.display = "";
      locSel.innerHTML = subs.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("");
    } else {
      // Sin sububicaciones: la ubicación es la propia área.
      subField.style.display = "none";
      locSel.innerHTML = `<option value="">${escapeHtml(areaSel.value || "")}</option>`;
    }
  };

  agSel.onchange = fillAreas;
  areaSel.onchange = fillSubs;
  fillAreas();
}

// Devuelve {area, location} del formulario.
// location = ubicación legible completa: "Área › Sububicación" (o solo el área).
function getSelectedLocation() {
  const area = document.getElementById("ev-area").value;
  const sub = document.getElementById("ev-location").value;
  const location = sub ? `${area} › ${sub}` : area;
  return { area, location };
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

// Captura MANUAL: valida ISO 3779 de forma explícita y guía la corrección.
function decodeManualVin(raw) {
  const vin = normalizeVin(raw);
  document.getElementById("vin-input").value = vin;

  // Validaciones puntuales para dar un mensaje de corrección claro.
  if (vin.length === 0) { notify("Escribe un VIN.", { type: "warn" }); return null; }
  if (vin.length !== 17) {
    notify(`El VIN debe tener 17 caracteres (ISO 3779). Van ${vin.length}. Revisa la captura.`, { type: "error", title: "VIN inválido" });
    showVinResult(decodeVin(vin));
    return null;
  }
  if (/[IOQ]/.test(vin)) {
    const pos = [...vin].map((c, i) => "IOQ".includes(c) ? i + 1 : null).filter(Boolean).join(", ");
    notify(`El VIN no puede contener las letras I, O ni Q (posición ${pos}). Suelen confundirse con 1 y 0.`, { type: "error", title: "VIN inválido" });
    showVinResult(decodeVin(vin));
    return null;
  }

  const dec = decodeVin(vin);
  showVinResult(dec);
  if (!dec.checkDigit.ok) {
    notify(`El dígito de control (posición 9) no coincide: el VIN trae “${dec.checkDigit.actual}” pero según ISO 3779 debería ser “${dec.checkDigit.expected}”. Verifica que no haya un error de captura.`,
      { type: "warn", title: "Revisa el VIN", timeout: 7000 });
  } else {
    notify("VIN válido (ISO 3779) ✓", { type: "success" });
    tryEnrich(dec);
  }
  return dec;
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

  // Captura manual con validación ISO 3779 explícita
  const manualDecode = () => {
    const val = document.getElementById("vin-input").value;
    const dec = decodeManualVin(val);
    return dec;
  };
  document.getElementById("vin-decode").addEventListener("click", manualDecode);
  document.getElementById("vin-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); manualDecode(); }
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
    const condition = document.getElementById("ev-condition").value;

    const status = existing?.status; // "dentro" | "fuera" | undefined
    const curLocation = existing?.currentLocation;
    const curAgency = existing?.currentAgency;

    // ============ MOVIMIENTO INTERNO: agencia/área elegidas por el capturista ============
    if (type === "move") {
      const agency = document.getElementById("ev-agency").value;
      const { area, location } = getSelectedLocation();
      if (status !== "dentro") {
        notify("Nota: la unidad no figuraba dentro. Se registró el movimiento.", { type: "warn", title: "Aviso" });
      }
      return finalizeEvent(vin, "move", agency, area, location, condition, existing);
    }

    // ============ ENTRADA / SALIDA: la AGENCIA se detecta por GPS ============
    onGps("Detectando ubicación por GPS…", "info");
    let pos;
    try {
      pos = await getPosition();
    } catch (e) {
      notify("No se pudo obtener el GPS: " + e.message + ". Activa la ubicación para registrar entradas/salidas.",
        { type: "error", title: "GPS requerido" });
      onGps("Sin GPS: " + e.message, "warn");
      return;
    }

    const agencies = store.listAgencies().filter(a => a.lat != null && a.lng != null);
    if (!agencies.length) {
      notify("No hay agencias con ubicación registrada. Pide al administrador que configure las coordenadas en la pestaña Agencias.",
        { type: "error", title: "Sin agencias configuradas" });
      return;
    }
    const near = nearestAgency(pos.lat, pos.lng, agencies);
    if (!near || !near.withinRadius) {
      const d = near ? Math.round(near.distance) : "—";
      const cercana = near ? near.agency.name : "—";
      const choice = await confirmDialog({
        icon: "📍", title: "Fuera de agencias conocidas",
        message: `Tu ubicación no coincide con ninguna agencia registrada.\n\n` +
          `La más cercana es "${cercana}" a ${d} m (fuera del radio).\n\n` +
          `¿Registrar de todos modos en "${cercana}"?`,
        buttons: [
          { label: "Cancelar", value: null, variant: "ghost" },
          { label: `Usar "${cercana}"`, value: "force", variant: "primary" },
        ],
      });
      if (choice !== "force" || !near) { onGps("Registro cancelado (fuera de rango).", "warn"); return; }
    }

    const agency = near.agency.name;
    onGps(`Agencia detectada: ${agency} (a ${Math.round(near.distance)} m).`, "ok");

    // Para entrada/salida la "ubicación" es la agencia (el área interna es para movimientos).
    const area = "";
    const location = agency;

    // Caso: intentan ENTRADA cuando la unidad ya está dentro.
    if (type === "entry" && status === "dentro") {
      const ingreso = existing?.entryAt ? new Date(existing.entryAt).toLocaleString() : "—";
      const quien = existing?.entryBy || existing?.lastBy || "—";
      const choice = await confirmDialog({
        icon: "🚗", title: "La unidad ya está dentro",
        message:
          `El VIN ${vin} ya tiene una ENTRADA registrada y no ha salido.\n\n` +
          `📍 Ubicación actual: ${curLocation || "—"} (${curAgency || "—"})\n` +
          `📅 Ingreso: ${ingreso}\n👤 Registró: ${quien}\n\n` +
          `Si la unidad realmente reingresó, confirma para registrar la nueva entrada en "${agency}".`,
        buttons: [
          { label: "Cancelar", value: null, variant: "ghost" },
          { label: "Registrar entrada", value: "entry", variant: "primary" },
        ],
      });
      if (choice !== "entry") { notify("No se registró nada. Verifica la unidad.", { type: "info" }); return; }
    }

    if (type === "exit" && status === "fuera") {
      notify("Nota: esta unidad ya figuraba fuera. Se registró la salida igualmente.", { type: "warn", title: "Aviso" });
    } else if (type === "exit" && !existing) {
      notify("Nota: no había entrada previa de esta unidad. Se registró la salida.", { type: "warn", title: "Aviso" });
    }

    // Pasamos la posición ya capturada para no volver a pedir GPS.
    return finalizeEvent(vin, type, agency, area, location, condition, existing, pos);
  };

  // Guarda datos básicos del VIN (1ª vez) y registra el evento.
  const finalizeEvent = async (vin, type, agency, area, location, condition, existing, presetPos) => {
    if (!existing) {
      store.upsertVehicle({
        vin,
        make: currentDecode.make,
        year: currentDecode.year,
        country: currentDecode.country,
      });
    }
    // Asegura que haya sesión iniciada para registrar.
    if (!auth.can("event.register")) {
      notify("Inicia sesión para registrar eventos.", { type: "warn" });
      await login();
      if (!auth.can("event.register")) return;
    }
    const by = auth.currentUser()?.name || store.getUser() || "—";
    await registerEvent({ vin, type, agency, area, location, condition, by, presetPos }, onGps);
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
  initUsers();
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
