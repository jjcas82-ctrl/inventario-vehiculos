// app.js — Orquestador: navegación por pestañas, flujo de escaneo, registro de
// eventos, respaldo de datos e instalación PWA.
import { decodeVin, normalizeVin } from "./vin.js";
import { Scanner } from "./scanner.js";
import { readVinFromVideo, readVinCloud, getCloudOcrKey, setCloudOcrKey, hasCloudOcr } from "./ocr.js";
import { enrichVin } from "./vinapi.js";
import { store } from "./storage.js";
import { registerEvent } from "./events.js";
import { initAgencies, escapeHtml } from "./agencies.js";
import { initInventory, renderInventory } from "./inventory.js";
import { initMap, drawMap, refreshMapVinOptions } from "./map.js";
import { initReports, renderReports, refreshReportAgencies } from "./reports.js";
import { notify, confirmDialog, promptDialog } from "./ui.js";
import * as auth from "./auth.js";
import { initUsers, renderUsers } from "./users.js";
import { initLabels, renderLabels } from "./labels.js";
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

// Muestra u oculta la pantalla de login (bloquea la app hasta autenticarse).
function showLoginScreen(show) {
  const screen = document.getElementById("login-screen");
  if (show) {
    screen.classList.remove("hidden");
    document.body.classList.add("locked");
    const err = document.getElementById("login-error");
    err.hidden = true;
    document.getElementById("login-pass").value = "";
    setTimeout(() => document.getElementById("login-user").focus(), 80);
  } else {
    screen.classList.add("hidden");
    document.body.classList.remove("locked");
  }
}

// Procesa el formulario de la pantalla de login.
async function submitLoginScreen(e) {
  if (e) e.preventDefault();
  const err = document.getElementById("login-error");
  const btn = document.getElementById("login-submit");
  const username = document.getElementById("login-user").value.trim();
  const password = document.getElementById("login-pass").value;
  err.hidden = true;
  btn.disabled = true; btn.textContent = "Entrando…";
  const res = await auth.login(username, password);
  btn.disabled = false; btn.textContent = "Entrar";
  if (!res.ok) {
    err.textContent = res.error;
    err.hidden = false;
    return;
  }
  showLoginScreen(false);
  refreshUserLabel();
  applyPermissions();
  renderUsers();
  notify(`Bienvenido, ${res.user.name} (${auth.ROLES[res.user.role]?.label}).`, { type: "success" });
}

async function setupUser() {
  await auth.ensureSeedAdmin(); // crea jcabrera/1234 si no hay usuarios con credenciales
  refreshUserLabel();

  document.getElementById("login-form").addEventListener("submit", submitLoginScreen);

  document.getElementById("user-btn").addEventListener("click", async () => {
    if (auth.currentUser()) {
      const choice = await confirmDialog({
        icon: "👤", title: auth.currentUser().name,
        message: `Usuario: ${auth.currentUser().username}\nRol: ${auth.ROLES[auth.currentUser().role]?.label || ""}`,
        buttons: [
          { label: "Cerrar sesión", value: "logout", variant: "danger" },
          { label: "Cerrar", value: null, variant: "ghost" },
        ],
      });
      if (choice === "logout") {
        auth.logout();
        refreshUserLabel();
        applyPermissions();
        showLoginScreen(true);   // vuelve a la pantalla de login
      }
    }
  });

  applyPermissions();
  // Al arrancar: si no hay sesión activa, mostrar la pantalla de login (bloquea la app).
  if (auth.currentUser()) {
    showLoginScreen(false);
  } else {
    showLoginScreen(true);
  }
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
      if (name === "labels") renderLabels();
      if (name === "audit") window.__initAudit && window.__initAudit();
    })
  );
}

// ---------- Selectores de agencia/ubicación en el formulario de evento ----------
function fillEventSelectors() {
  const agHidden = document.getElementById("ev-agency");
  const agFixed = document.getElementById("ev-agency-fixed");
  const areaSel = document.getElementById("ev-area");
  const locSel = document.getElementById("ev-location");
  const subField = document.getElementById("ev-sub-field");
  const agencies = store.listAgencies();

  // El movimiento interno es dentro de la agencia ACTUAL de la unidad (fija).
  const vehicle = currentDecode ? store.getVehicle(currentDecode.vin) : null;
  const agencyName = vehicle?.currentAgency || (agencies[0] && agencies[0].name) || "";
  if (agHidden) agHidden.value = agencyName;
  if (agFixed) agFixed.textContent = agencyName || "—";

  const currentAgency = () => agencies.find(x => x.name === agencyName) || agencies[0];

  const fillAreas = () => {
    const a = currentAgency();
    const areas = a?.areas || [];
    areaSel.innerHTML = areas.map(ar => `<option value="${escapeHtml(ar.name)}">${escapeHtml(ar.name)}</option>`).join("");
    fillSubs();
  };

  const fillSubs = () => {
    const a = currentAgency();
    const area = (a?.areas || []).find(ar => ar.name === areaSel.value);
    const subs = area?.subs || [];
    if (subs.length) {
      subField.style.display = "";
      locSel.innerHTML = subs.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("");
    } else {
      subField.style.display = "none";
      locSel.innerHTML = `<option value="">${escapeHtml(areaSel.value || "")}</option>`;
    }
  };

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
      <dt>Marca</dt><dd>${dec.make && dec.make !== "Desconocido"
        ? escapeHtml(dec.make) + (dec.makeConfident
            ? ' <span class="muted" style="font-weight:400">(sugerida — verifica en la ficha)</span>'
            : ' <span class="chk-bad" style="font-weight:400">(aproximada — confirma la marca en la ficha)</span>')
        : '<span class="muted">Se completa manualmente</span>'}</dd>
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
  const valido = dec.vin.length === 17 && !dec.errors.some(e => e.includes("caracteres no válidos") || e.includes("17"));
  form.hidden = !valido;
  fillEventSelectors();
  if (valido) updateEventButtons(dec.vin);
}

// Ajusta qué botones/secciones se muestran según el ESTADO de la unidad:
//  - No registrada / fuera → solo ENTRADA (Movimiento interno oculto).
//  - Dentro → MOVIMIENTO interno y SALIDA (Entrada oculta).
function updateEventButtons(vin) {
  const v = store.getVehicle(vin);
  const status = v?.status; // "dentro" | "fuera" | undefined
  const entryBtn = document.getElementById("ev-entry");
  const exitBtn = document.getElementById("ev-exit");
  const moveCard = document.getElementById("move-card");
  const entryExitCard = document.getElementById("entry-exit-card");

  const dentro = status === "dentro";
  // Entrada: solo si NO está dentro. Salida: solo si está dentro.
  entryBtn.style.display = dentro ? "none" : "";
  exitBtn.style.display = dentro ? "" : "none";
  // El apartado de movimiento interno solo aparece si la unidad está dentro.
  if (moveCard) moveCard.style.display = dentro ? "" : "none";
  // La tarjeta de entrada/salida se muestra siempre (para entrada nueva o salida).
  if (entryExitCard) entryExitCard.style.display = "";

  // Info de estado actual
  const info = document.getElementById("ev-status-info");
  if (info) {
    if (dentro) {
      info.textContent = `🚗 Unidad DENTRO en: ${v.currentLocation || "—"} (${v.currentAgency || "—"}). Puedes moverla internamente o registrar su salida.`;
      info.style.color = "var(--primary)";
    } else if (status === "fuera") {
      info.textContent = "La unidad figura FUERA. Puedes registrar su entrada.";
      info.style.color = "var(--muted)";
    } else {
      info.textContent = "Unidad nueva (sin registro previo). Registra su entrada.";
      info.style.color = "var(--muted)";
    }
  }
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

  // NHTSA cubre bien el mercado EE.UU. y parcialmente otros. Si no trae marca ni
  // modelo, ese VIN no está en su base (p. ej. vehículos de Europa/Asia).
  if (!data.make && !data.model && !data.bodyClass) {
    if (dec.make && dec.make !== "Desconocido") {
      // La tabla local SÍ reconoció la marca → mensaje tranquilizador, no alarmante.
      note.textContent = `Marca identificada localmente: ${dec.make}. ` +
        "NHTSA no tiene detalles extra de este VIN (suele pasar con vehículos de Europa/Asia). " +
        "Puedes ajustar marca y modelo en la ficha si hace falta.";
      note.style.color = "var(--muted)";
    } else {
      note.textContent = "No se pudo identificar la marca automáticamente para este VIN " +
        "(ni en la base local ni en NHTSA). Captura la marca y el modelo manualmente en la ficha.";
      note.style.color = "var(--danger)";
    }
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

  // MARCA: NHTSA (dato oficial) tiene prioridad para seminuevos de cualquier marca.
  // Se usa su marca cuando: la local falta, es "Desconocido", o es solo aproximada
  // (coincidencia de 2 caracteres). Si la local es confiable (3 chars) y coincide,
  // se conserva. En todos los casos NHTSA se marca como VERIFICADA en línea.
  if (data.make) {
    const localAproxOFalta = !dec.make || dec.make === "Desconocido" || dec.makeConfident === false;
    if (localAproxOFalta) {
      dec.make = toTitle(data.make);
    }
    dec.makeVerifiedOnline = true;           // bandera para la vista
    dec.makeConfident = true;                 // ya hay confirmación oficial
  }

  currentDecode = dec;
  updateMakeField(dec);       // reescribe el campo "Marca" principal de la vista
  renderApiExtras(dec);       // añade los campos extra a la vista
  saveVinBasics(dec);         // actualiza los datos guardados del vehículo
}

// Normaliza "SUZUKI" / "suzuki" → "Suzuki" (NHTSA suele devolver en mayúsculas).
function toTitle(s) {
  return String(s || "").toLowerCase().replace(/\b([a-záéíóúñ])/g, (m, c) => c.toUpperCase());
}

// Reescribe el valor del campo "Marca" en la vista de datos del VIN, usando la
// marca ya fusionada (local + NHTSA). Marca con etiqueta clara el origen.
function updateMakeField(dec) {
  const box = document.getElementById("vin-result");
  if (!box) return;
  const dds = box.querySelectorAll("dl > dd");
  // El primer <dd> del primer <dl> es la Marca (según el orden de showVinResult).
  const makeDd = box.querySelector("dl dd");
  if (!makeDd) return;
  const nombre = dec.make && dec.make !== "Desconocido" ? escapeHtml(dec.make) : null;
  if (!nombre) {
    makeDd.innerHTML = '<span class="muted">Se completa manualmente</span>';
    return;
  }
  const etiqueta = dec.makeVerifiedOnline
    ? ' <span class="chk-ok" style="font-weight:400">✓ confirmada en línea (NHTSA)</span>'
    : (dec.makeConfident
        ? ' <span class="muted" style="font-weight:400">(sugerida — verifica en la ficha)</span>'
        : ' <span class="chk-bad" style="font-weight:400">(aproximada — confirma la marca en la ficha)</span>');
  makeDd.innerHTML = nombre + etiqueta;
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
    if (window.__stopLiveOcr) window.__stopLiveOcr();
    scanner.stop();
    startBtn.hidden = false;
    stopBtn.hidden = true;
    const ob = document.getElementById("scan-ocr");
    if (ob) ob.textContent = "3️⃣ Leer VIN";
    const cb = document.getElementById("scan-cloud");
    if (cb) cb.textContent = "2️⃣ Leer VIN (en la nube)";
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
      // Limpiar lectura previa para no arrastrar un VIN anterior.
      currentDecode = null;
      document.getElementById("vin-input").value = "";
      document.getElementById("vin-result").innerHTML =
        '<p class="muted">Escanea o escribe un VIN para ver sus datos.</p>';
      document.getElementById("event-form").hidden = true;
      await scanner.start();
      startBtn.hidden = true;
      stopBtn.hidden = false;
    } catch (e) { /* onStatus ya mostró el error */ }
  });
  stopBtn.addEventListener("click", () => {
    stopCamera();
    setStatus("Cámara detenida.", "muted");
  });

  // ---- OCR de TEXTO por FOTO (versión que funcionaba: abrir cámara → tomar foto) ----
  const ocrBtn = document.getElementById("scan-ocr");
  const OCR_LABEL = "3️⃣ Leer VIN";
  const OCR_SHOOT = "📸 Tomar foto y leer VIN";
  const stopLiveOcr = () => {}; // compat (ya no hay OCR en vivo)
  window.__stopLiveOcr = stopLiveOcr;

  ocrBtn.addEventListener("click", async () => {
    // 1er toque: abrir la cámara (sin detector de barras) y esperar a encuadrar.
    if (!scanner.running) {
      try {
        currentDecode = null;
        document.getElementById("vin-input").value = "";
        document.getElementById("vin-result").innerHTML =
          '<p class="muted">Escanea o escribe un VIN para ver sus datos.</p>';
        document.getElementById("event-form").hidden = true;
        await scanner.start({ detect: false });
        startBtn.hidden = true;
        stopBtn.hidden = false;
        ocrBtn.textContent = OCR_SHOOT;
        setStatus("Encuadra el VIN dentro del recuadro, bien enfocado, y toca “📸 Tomar foto y leer VIN”.", "ok");
        return;
      } catch (e) { return; }
    }
    // 2º toque: tomar la foto y leer.
    ocrBtn.disabled = true;
    ocrBtn.textContent = "Leyendo…";
    try {
      setStatus("Leyendo el texto del VIN…", "muted");
      const { vin, verified, raw, lowInk } = await readVinFromVideo(video, {
        onProgress: (m) => setStatus(m, "muted"),
        onCandidate: (c) => diagLog("OCR: " + c),
      });
      if (verified && vin) {
        handleScannedText(vin);
        stopCamera();
        ocrBtn.textContent = OCR_LABEL;
        setStatus("✓ VIN leído y verificado: " + vin, "ok");
      } else if (lowInk) {
        setStatus("No se ve texto legible. Acerca más el VIN llenando el recuadro, enfoca y evita reflejos. Toca 📸 otra vez.", "error");
      } else {
        const guess = (raw || "").slice(0, 17);
        if (guess) document.getElementById("vin-input").value = guess;
        showVinResult(decodeVin(guess));
        setStatus("⚠️ Lectura no confiable. Se leyó “" + (raw || "—") +
          "”. Revisa/corrige en la captura manual, o toma otra foto más cercana y nítida.", "error");
        notify("Revisa el VIN antes de registrar.", { type: "warn", title: "Verifica el VIN", timeout: 5000 });
      }
    } catch (e) {
      setStatus("Error de OCR: " + (e.message || e) + ". Usa la captura manual.", "error");
    } finally {
      ocrBtn.disabled = false;
      ocrBtn.textContent = scanner.running ? OCR_SHOOT : OCR_LABEL;
    }
  });


  // ---- OCR EN LA NUBE (OCR.space): abrir cámara → enviar foto a la nube ----
  const cloudBtn = document.getElementById("scan-cloud");
  const CLOUD_LABEL = "2️⃣ Leer VIN (en la nube)";
  const CLOUD_SHOOT = "☁️ Enviar a la nube";

  function refreshCloudButton() {
    if (!cloudBtn) return;
    // El botón 2 (nube) SIEMPRE está visible para que la lista 1-2-3-4 sea
    // consistente. El estilo lo da la clase .scan-method en el CSS. Si no hay
    // API key, al pulsarlo se ofrece configurarla (ver handler más abajo).
    cloudBtn.hidden = false;
  }
  refreshCloudButton();
  window.__refreshCloudButton = refreshCloudButton;

  if (cloudBtn) cloudBtn.addEventListener("click", async () => {
    // Sin API key configurada: ofrecer configurarla (lleva a la pestaña Datos).
    if (!hasCloudOcr()) {
      notify("El OCR en la nube necesita una API key gratuita de OCR.space. Configúrala en la pestaña “Agencias” → “OCR en la nube”.", { type: "warn" });
      const tab = document.querySelector('[data-tab="settings"]');
      if (tab) tab.click();
      const ki = document.getElementById("cloud-ocr-key");
      if (ki) { ki.focus(); ki.scrollIntoView({ behavior: "smooth", block: "center" }); }
      return;
    }
    // 1er toque: abrir cámara (solo cámara, sin detector de barras).
    if (!scanner.running) {
      try {
        currentDecode = null;
        document.getElementById("vin-input").value = "";
        document.getElementById("event-form").hidden = true;
        await scanner.start({ detect: false });
        startBtn.hidden = true;
        stopBtn.hidden = false;
        cloudBtn.textContent = CLOUD_SHOOT;
        setStatus("Encuadra el VIN en el recuadro y toca “☁️ Enviar a la nube”.", "ok");
        return;
      } catch (e) { return; }
    }
    // 2º toque: enviar a la nube.
    cloudBtn.disabled = true;
    cloudBtn.textContent = "Enviando…";
    try {
      const { vin, verified, raw, error } = await readVinCloud(video, {
        onProgress: (m) => setStatus(m, "muted"),
      });
      if (error) {
        setStatus("OCR en la nube: " + error + " Usa el lector local o la captura manual.", "error");
      } else if (verified && vin) {
        handleScannedText(vin);
        stopCamera();
        cloudBtn.textContent = CLOUD_LABEL;
        setStatus("✓ VIN leído en la nube: " + vin, "ok");
      } else {
        const guess = (raw || vin || "").slice(0, 17);
        if (guess) document.getElementById("vin-input").value = guess;
        showVinResult(decodeVin(guess));
        setStatus("⚠️ Lectura no confiable (nube). Se leyó “" + (raw || vin || "—") +
          "”. Revisa/corrige en la captura manual, o reintenta.", "error");
      }
    } catch (e) {
      setStatus("Error del OCR en la nube: " + (e.message || e), "error");
    } finally {
      cloudBtn.disabled = false;
      cloudBtn.textContent = scanner.running ? CLOUD_SHOOT : CLOUD_LABEL;
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

  // ---- 4) Ingreso manual: el botón lleva el foco al campo de captura ----
  const manualBtn = document.getElementById("scan-manual");
  if (manualBtn) manualBtn.addEventListener("click", () => {
    const input = document.getElementById("vin-input");
    const field = document.getElementById("manual-vin-field");
    if (field) field.scrollIntoView({ behavior: "smooth", block: "center" });
    if (input) { input.focus(); input.select(); }
    setStatus("Escribe el VIN de 17 caracteres y pulsa “Leer VIN”.", "muted");
  });

  // ---- Configuración de la API key del OCR en la nube (pestaña Datos) ----
  const keyInput = document.getElementById("cloud-ocr-key");
  const keyStatus = document.getElementById("cloud-ocr-status");
  const refreshKeyStatus = () => {
    if (!keyStatus) return;
    keyStatus.textContent = hasCloudOcr() ? "✓ OCR en la nube configurado y activo." : "No configurado (se usa el lector local).";
    keyStatus.style.color = hasCloudOcr() ? "var(--primary)" : "var(--muted)";
  };
  if (keyInput) keyInput.value = getCloudOcrKey();
  refreshKeyStatus();
  const saveKeyBtn = document.getElementById("save-cloud-ocr");
  if (saveKeyBtn) saveKeyBtn.addEventListener("click", () => {
    setCloudOcrKey(keyInput.value);
    refreshKeyStatus();
    refreshCloudButton();
    notify("Configuración de OCR en la nube guardada.", { type: "success" });
  });
  const clearKeyBtn = document.getElementById("clear-cloud-ocr");
  if (clearKeyBtn) clearKeyBtn.addEventListener("click", () => {
    setCloudOcrKey("");
    keyInput.value = "";
    refreshKeyStatus();
    refreshCloudButton();
    notify("OCR en la nube desactivado.", { type: "info" });
  });
}

// ---------- Registro de eventos ----------
function setupEventButtons() {
  const gpsStatus = document.getElementById("gps-status");
  const onGps = (msg, kind) => {
    gpsStatus.textContent = msg;
    gpsStatus.style.color = kind === "error" || kind === "warn" ? "var(--danger)" : "var(--muted)";
  };

  // Lee los datos de la persona que entrega/recibe. En entrada/salida son
  // OBLIGATORIOS (nombre y tipo); en movimiento interno son opcionales.
  const readPerson = (type) => {
    if (type === "move") {
      const name = (document.getElementById("move-person")?.value || "").trim();
      return { person: name ? { name, type: "Traslado interno", contact: "" } : null, ok: true };
    }
    const name = (document.getElementById("person-name")?.value || "").trim();
    const ptype = document.getElementById("person-type")?.value || "";
    const contact = (document.getElementById("person-contact")?.value || "").trim();
    if (!name || !ptype) {
      const quien = type === "entry" ? "entrega" : "recibe";
      notify(`Indica el nombre y el tipo de la persona que ${quien} la unidad (son obligatorios).`,
        { type: "warn", title: "Falta la persona responsable" });
      const el = !name ? document.getElementById("person-name") : document.getElementById("person-type");
      if (el) { el.focus(); el.scrollIntoView({ behavior: "smooth", block: "center" }); }
      return { person: null, ok: false };
    }
    return { person: { name, type: ptype, contact }, ok: true };
  };

  const doEvent = async (type) => {
    if (!currentDecode || currentDecode.vin.length !== 17) {
      notify("Primero escanea o captura un VIN válido.", { type: "warn" });
      return;
    }
    const vin = currentDecode.vin;
    const existing = store.getVehicle(vin);
    const condition = document.getElementById("ev-condition").value;

    // Validar/leer la persona responsable ANTES de continuar.
    const { person, ok: personOk } = readPerson(type);
    if (!personOk) return;

    const status = existing?.status; // "dentro" | "fuera" | undefined
    const curLocation = existing?.currentLocation;
    const curAgency = existing?.currentAgency;

    // SALVAGUARDA anti-retrabajo: si el VIN NO pasa el dígito de control ISO 3779
    // y es una unidad NUEVA (no registrada), pedimos confirmación explícita antes
    // de crearla, para no meter un VIN mal leído al inventario.
    if (!existing && !currentDecode.checkDigit.ok) {
      const choice = await confirmDialog({
        icon: "⚠️", title: "VIN no verificado",
        message:
          `El VIN "${vin}" no supera el dígito de control ISO 3779 ` +
          `(se esperaba "${currentDecode.checkDigit.expected}", trae "${currentDecode.checkDigit.actual}").\n\n` +
          `Esto suele indicar un error de lectura o captura. Si registras, podría quedar un VIN incorrecto en el inventario.\n\n` +
          `¿Qué deseas hacer?`,
        buttons: [
          { label: "Corregir VIN", value: null, variant: "primary" },
          { label: "Registrar de todos modos", value: "force", variant: "danger" },
        ],
      });
      if (choice !== "force") {
        notify("Revisa y corrige el VIN antes de registrar.", { type: "info" });
        document.getElementById("vin-input").focus();
        return;
      }
    }

    // ============ MOVIMIENTO INTERNO: agencia/área elegidas por el capturista ============
    if (type === "move") {
      if (status !== "dentro") {
        notify("Solo se puede mover internamente una unidad que está DENTRO. Registra primero su entrada.", { type: "warn", title: "Aviso" });
        return;
      }
      // La agencia NO cambia en un movimiento interno: se conserva la agencia actual
      // de la unidad (el cambio de agencia solo ocurre por GPS en entrada/salida).
      const agency = existing.currentAgency;
      const { area, location } = getSelectedLocation();
      return finalizeEvent(vin, "move", agency, area, location, condition, existing, null, false, person);
    }

    // Si intentan ENTRADA y la unidad YA está dentro: ofrecer movimiento interno
    // (en vez de pedir GPS y registrar otra entrada).
    if (type === "entry" && status === "dentro") {
      const ingreso = existing?.entryAt ? new Date(existing.entryAt).toLocaleString() : "—";
      const quien = existing?.entryBy || existing?.lastBy || "—";
      const choice = await confirmDialog({
        icon: "🚗", title: "La unidad ya está dentro",
        message:
          `El VIN ${vin} ya tiene una ENTRADA registrada y no ha salido.\n\n` +
          `📍 Ubicación actual: ${curLocation || "—"} (${curAgency || "—"})\n` +
          `📅 Ingreso: ${ingreso}\n👤 Registró: ${quien}\n\n` +
          `¿Deseas registrar un MOVIMIENTO interno para actualizar su ubicación?`,
        buttons: [
          { label: "Cancelar", value: null, variant: "ghost" },
          { label: "Registrar movimiento interno", value: "move", variant: "primary" },
        ],
      });
      if (choice === "move") {
        // Mostrar y resaltar el apartado de movimiento interno.
        const moveCard = document.getElementById("move-card");
        if (moveCard) {
          moveCard.style.display = "";
          moveCard.scrollIntoView({ behavior: "smooth", block: "center" });
          moveCard.classList.add("pulse");
          setTimeout(() => moveCard.classList.remove("pulse"), 1500);
        }
      } else {
        notify("No se registró nada. Verifica la unidad.", { type: "info" });
      }
      return;
    }

    // ============ ENTRADA / SALIDA: la AGENCIA se detecta por GPS ============
    onGps("Detectando ubicación por GPS…", "info");
    let pos;
    try {
      pos = await getPosition();
    } catch (e) {
      // ---- Contingencia: el GPS falló. Ofrecer reintentar o registro manual. ----
      pos = null;
      onGps("Sin GPS: " + e.message, "warn");
    }

    let agency, sinGps = false;
    const area = "";        // el área interna es para movimientos
    let location;

    if (pos) {
      // GPS OK → detectar agencia por cercanía.
      const agencies = store.listAgencies().filter(a => a.lat != null && a.lng != null);
      if (!agencies.length) {
        notify("No hay agencias con ubicación registrada. Pide al administrador que configure las coordenadas en Agencias.",
          { type: "error", title: "Sin agencias configuradas" });
        return;
      }
      const near = nearestAgency(pos.lat, pos.lng, agencies);
      if (!near || !near.withinRadius) {
        // Fuera de rango: NO se permite registrar. Solo se informa y se cancela.
        const d = near ? Math.round(near.distance) : "—";
        const cercana = near ? near.agency.name : "—";
        await confirmDialog({
          icon: "📍", title: "Fuera de agencias conocidas",
          message: `Tu ubicación no coincide con ninguna agencia registrada.\n\n` +
            `La más cercana es "${cercana}" a ${d} m (fuera del radio).\n\n` +
            `No se puede registrar aquí. Acércate a una agencia o punto de venta registrado.`,
          buttons: [
            { label: "Aceptar", value: "ok", variant: "primary" },
          ],
        });
        onGps("Registro cancelado: fuera de rango de las agencias.", "warn");
        return;
      }
      agency = near.agency.name;
      location = agency;
      onGps(`Agencia detectada: ${agency} (a ${Math.round(near.distance)} m).`, "ok");
    } else {
      // ---- GPS falló ----
      // El registro manual (contingencia) SOLO se habilita si NO hay internet.
      // Con internet, un fallo de GPS solo permite reintentar (no es contingencia real).
      if (navigator.onLine) {
        const choice = await confirmDialog({
          icon: "📡", title: "GPS no disponible",
          message: "No se pudo obtener la ubicación por GPS.\n\n" +
            "Como hay conexión a internet, activa/permite la ubicación del dispositivo y reintenta. " +
            "El registro manual solo se habilita cuando no hay servicio de internet (contingencia).",
          buttons: [
            { label: "Cancelar", value: null, variant: "ghost" },
            { label: "🔄 Reintentar GPS", value: "retry", variant: "primary" },
          ],
        });
        if (choice === "retry") return doEvent(type);
        onGps("Registro cancelado (activa la ubicación y reintenta).", "warn");
        return;
      }

      // Sin internet Y sin GPS → contingencia real: permitir agencia manual.
      const cont = await contingencyLocation(type);
      if (!cont) { onGps("Registro cancelado.", "warn"); return; }
      if (cont.retry) return doEvent(type); // reintentar todo el flujo (vuelve a pedir GPS)
      agency = cont.agency;
      location = agency;
      sinGps = true;
      onGps(`⚠️ Registro en CONTINGENCIA (sin internet ni GPS) — agencia: ${agency}.`, "warn");
    }

    if (type === "exit" && status === "fuera") {
      notify("Nota: esta unidad ya figuraba fuera. Se registró la salida igualmente.", { type: "warn", title: "Aviso" });
    } else if (type === "exit" && !existing) {
      notify("Nota: no había entrada previa de esta unidad. Se registró la salida.", { type: "warn", title: "Aviso" });
    }

    // Pasamos la posición ya capturada para no volver a pedir GPS.
    return finalizeEvent(vin, type, agency, area, location, condition, existing, pos, sinGps, person);
  };

  // Guarda datos básicos del VIN (1ª vez) y registra el evento.
  const finalizeEvent = async (vin, type, agency, area, location, condition, existing, presetPos, sinGps = false, person = null) => {
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
      notify("Tu rol no permite registrar eventos.", { type: "warn" });
      return;
    }
    const by = auth.currentUser()?.name || store.getUser() || "—";
    await registerEvent({ vin, type, agency, area, location, condition, by, presetPos, sinGps, person }, onGps);
    const labels = { entry: "Entrada", move: "Movimiento", exit: "Salida" };
    const quienFrase = person && person.name
      ? ` · ${type === "exit" ? "recibió" : (type === "entry" ? "entregó" : "movió")}: ${person.name}`
      : "";
    notify(`${labels[type]} registrada por ${by || "—"}${quienFrase}${sinGps ? " (contingencia sin GPS)" : ""}.`,
      { type: sinGps ? "warn" : "success", title: vin });
    refreshAll();
    // Actualiza los botones según el nuevo estado de la unidad.
    if (currentDecode && currentDecode.vin === vin) updateEventButtons(vin);
  };

  // Diálogo de contingencia: sin GPS, ofrece reintentar o elegir agencia manual.
  async function contingencyLocation(type) {
    const label = type === "entry" ? "entrada" : "salida";
    const agencies = store.listAgencies();
    // Construimos los botones: reintentar + una opción por agencia (máx. 5) + cancelar.
    const buttons = [{ label: "🔄 Reintentar GPS", value: "__retry", variant: "primary" }];
    agencies.slice(0, 5).forEach(a => buttons.push({ label: "📍 " + a.name, value: a.name, variant: "ghost" }));
    buttons.push({ label: "Cancelar", value: null, variant: "ghost" });

    const choice = await confirmDialog({
      icon: "⚠️", title: "Contingencia: sin internet ni GPS",
      message: `No hay servicio de internet ni se pudo obtener el GPS para registrar la ${label}.\n\n` +
        `Puedes reintentar el GPS o seleccionar la agencia manualmente. ` +
        `El registro quedará MARCADO como "sin GPS" para revisión del administrador.`,
      buttons,
    });
    if (!choice) return null;
    if (choice === "__retry") return { retry: true };
    return { agency: choice };
  }

  document.getElementById("ev-entry").addEventListener("click", () => doEvent("entry"));
  document.getElementById("ev-move").addEventListener("click", () => doEvent("move"));
  document.getElementById("ev-exit").addEventListener("click", () => doEvent("exit"));
  document.getElementById("ev-new").addEventListener("click", nuevoRegistro);
}

// Limpia la pantalla para escanear/registrar otra unidad desde cero.
function nuevoRegistro() {
  currentDecode = null;
  document.getElementById("vin-input").value = "";
  document.getElementById("vin-result").innerHTML =
    '<p class="muted">Escanea o escribe un VIN para ver sus datos.</p>';
  document.getElementById("event-form").hidden = true;
  const diag = document.getElementById("scan-diag");
  if (diag) { diag.hidden = true; diag.textContent = ""; }
  const st = document.getElementById("scan-status");
  if (st) st.textContent = "";
  const gps = document.getElementById("gps-status");
  if (gps) gps.textContent = "";
  // Limpiar los campos de persona (entrega/recibe y responsable de movimiento).
  ["person-name", "person-contact", "move-person"].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = "";
  });
  const ptype = document.getElementById("person-type"); if (ptype) ptype.value = "";
  document.getElementById("vin-input").focus();
  notify("Listo para un nuevo registro.", { type: "info", timeout: 1500 });
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

// ---------- Indicador de conexión (online/offline) ----------
function setupConnectivity() {
  const badge = document.getElementById("online-badge");
  const update = () => {
    if (navigator.onLine) {
      badge.textContent = "En línea";
      badge.style.background = "rgba(255,255,255,.25)";
      badge.title = "Con conexión a internet";
    } else {
      badge.textContent = "⚠️ Sin conexión";
      badge.style.background = "#b45309";
      badge.title = "Trabajando sin internet — los registros se guardan localmente";
    }
  };
  window.addEventListener("online", () => { update(); notify("Conexión restablecida.", { type: "success" }); });
  window.addEventListener("offline", () => { update(); notify("Sin conexión: seguirás trabajando localmente (GPS y registros funcionan).", { type: "warn", timeout: 5000 }); });
  update();
}

// ---------- Service Worker ----------
function setupServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").then((reg) => {
      // Cuando se detecta una versión nueva, recargar una vez para tomarla.
      reg.addEventListener("updatefound", () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener("statechange", () => {
          if (nw.state === "installed" && navigator.serviceWorker.controller) {
            notify("Nueva versión disponible, actualizando…", { type: "info", timeout: 2000 });
            setTimeout(() => location.reload(), 800);
          }
        });
      });
    }).catch(() => {});
    // Busca actualizaciones al abrir.
    navigator.serviceWorker.getRegistration().then(r => r && r.update()).catch(() => {});
  });
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
  initLabels();
  setupScanner();
  setupEventButtons();
  setupDataButtons();
  setupInstall();
  setupConnectivity();
  setupServiceWorker();

  initAgencies(refreshAll);
  initInventory(refreshAll);
  initMap();
  initReports();
  fillEventSelectors();
}

document.addEventListener("DOMContentLoaded", main);
