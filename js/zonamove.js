// zonamove.js — Pantalla "Mover por zona": el operador escanea el QR de una ZONA
// (pegado en el área física) y luego los QR de las UNIDADES que deja en esa zona.
// Cada unidad se mueve a la zona activa con locationSource "qr-zona".
//
// Distingue dos tipos de QR:
//   - QR de zona:   "ZONA|<agencia>|<area>"  (lo genera la pestaña Agencias)
//   - QR de unidad: un VIN de 17 caracteres.

import { store } from "./storage.js";
import { Scanner } from "./scanner.js";
import { normalizeVin } from "./vin.js";
import { parseZonaQr } from "./agencies.js";
import { registerEvent } from "./events.js";
import { notify } from "./ui.js";
import { escapeHtml } from "./agencies.js";
import * as auth from "./auth.js";

let scanner = null;
let zona = null;      // { agency, area }
let movidas = 0;
let audioCtx = null;
let initialized = false;

export function initZonaMove() {
  if (initialized) return;
  initialized = true;

  document.getElementById("zona-scan").onclick = startScan;
  document.getElementById("zona-scan-stop").onclick = stopScan;
  document.getElementById("zona-reset").onclick = resetZona;
  document.getElementById("zona-manual-btn").onclick = () => {
    moverUnidad(document.getElementById("zona-manual").value);
    document.getElementById("zona-manual").value = "";
  };
  document.getElementById("zona-manual").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); document.getElementById("zona-manual-btn").click(); }
  });

  const video = document.getElementById("zona-video");
  scanner = new Scanner(video, {
    onResult: (text) => handleScan(text),
    onStatus: (msg, kind) => setStatus(msg, kind),
  });
}

async function startScan() {
  try {
    await scanner.start();
    document.getElementById("zona-scanner-wrap").hidden = false;
    document.getElementById("zona-scan").hidden = true;
    document.getElementById("zona-scan-stop").hidden = false;
  } catch (e) { /* el scanner ya avisa */ }
}
function stopScan() {
  if (scanner) scanner.stop();
  document.getElementById("zona-scanner-wrap").hidden = true;
  document.getElementById("zona-scan").hidden = false;
  document.getElementById("zona-scan-stop").hidden = true;
}
function resetZona() {
  zona = null;
  renderZona();
  setStatus("Escanea el QR de una zona para empezar.", "info");
}

// Un escaneo puede ser un QR de zona o un VIN de unidad.
function handleScan(text) {
  const z = parseZonaQr(text);
  if (z) {
    zona = z;
    renderZona();
    beep(true);
    setStatus(`Zona activa: ${z.area} (${z.agency}). Ahora escanea las unidades.`, "ok");
    return;
  }
  // Si no es zona, intentamos como VIN de unidad.
  const vin = (normalizeVin(text).match(/[A-HJ-NPR-Z0-9]{17}/) || [])[0];
  if (vin) moverUnidad(vin);
}

async function moverUnidad(raw) {
  if (!zona) {
    setStatus("Primero escanea el QR de una zona.", "error");
    beep(false);
    notify("Primero escanea el QR de la zona.", { type: "warn" });
    return;
  }
  const vin = normalizeVin(raw);
  if (vin.length !== 17) { setStatus("VIN inválido (17 caracteres).", "error"); beep(false); return; }

  const v = store.getVehicle(vin);
  if (!v) {
    setStatus(`La unidad ${vin} no está registrada. Regístrala primero (entrada).`, "error");
    beep(false);
    return;
  }

  // Registrar movimiento interno a la zona activa, con origen "qr-zona".
  const by = auth.currentUser()?.name || store.getUser() || "—";
  await registerEvent({
    vin, type: "move",
    agency: zona.agency, area: zona.area, location: zona.area,
    by, locationSource: "qr-zona",
  });

  movidas++;
  addRow(vin, v);
  renderZona();
  beep(true);
  setStatus(`✓ ${vin} movida a ${zona.area}.`, "ok");
}

function renderZona() {
  document.getElementById("zona-nombre").textContent =
    zona ? `${zona.area} · ${zona.agency}` : "— sin zona —";
  document.getElementById("zona-contador").textContent = String(movidas);
}

function addRow(vin, v) {
  const tbody = document.querySelector("#zona-table tbody");
  const tr = document.createElement("tr");
  tr.innerHTML = `<td>${new Date().toLocaleTimeString()}</td>
    <td><code>${escapeHtml(vin)}</code></td>
    <td>${escapeHtml(`${v.make || ""} ${v.model || ""}`.trim())}</td>
    <td>${escapeHtml(zona.area)}</td>`;
  tbody.insertBefore(tr, tbody.firstChild);
}

function setStatus(msg, kind) {
  const el = document.getElementById("zona-status");
  if (!el) return;
  el.textContent = msg;
  el.style.color = kind === "error" ? "var(--danger)"
    : (kind === "ok" ? "var(--primary)" : (kind === "warn" ? "#b45309" : "var(--muted)"));
}

function beep(ok) {
  try {
    if (navigator.vibrate) navigator.vibrate(ok ? 40 : [60, 40, 60]);
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = ok ? 880 : 300;
    o.connect(g); g.connect(audioCtx.destination);
    g.gain.setValueAtTime(0.08, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.18);
    o.start(); o.stop(audioCtx.currentTime + 0.18);
  } catch (e) { /* audio no disponible */ }
}

// Detener la cámara al salir de la pestaña.
export function stopZonaMove() { stopScan(); }
