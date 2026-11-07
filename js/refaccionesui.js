// refaccionesui.js — Interfaz del inventario de REFACCIONES (Fase 1):
//   1) Cargar EXISTENCIAS (CSV) + MARBETES (PDF) del sistema interno.
//   2) CRUZAR por número de parte y mostrar vista previa.
//   3) Guardar el cruce en el inventario de partes (store.bulkUpsertParts).
//   4) Imprimir ETIQUETAS QR (Janel 32×64, 12/hoja).
//   5) CONTEO físico: escanear QR (o teclear nº de parte) + teclear la cantidad.
//   6) Reporte de DIFERENCIAS (conteo vs. existencia del sistema).
//
// Es un módulo autónomo que vive dentro del mismo sistema que el inventario de
// vehículos; usa su propio namespace de almacenamiento (store.*Parts).

import { store, AGENCIAS_REF, ARCHIVO_PREVIO, ARCHIVO_PREVIO_LABEL } from "./storage.js";
import {
  parseExistenciasCsv, parseMarbetesFile, cruzar,
  parsePartQr, printPartLabels, diagnosticarMarbetes,
} from "./refacciones.js";
import { Scanner } from "./scanner.js";
import { notify } from "./ui.js";
import { escapeHtml } from "./agencies.js";
import { logAction } from "./syslog.js";
import * as auth from "./auth.js";
import * as api from "./api.js";
import { pushParts, pushPartConteo, pushPart, pushPartsAudit } from "./sync.js";

let initialized = false;
let scanner = null;
let lastCruce = null;        // resultado del último cruce (para confirmar carga)
let existencias = [];        // existencias parseadas pendientes de cruzar
let marbetes = [];           // marbetes parseados pendientes de cruzar
let lastMarbetesFile = null; // último PDF de marbetes cargado (para diagnóstico)
let audioCtx = null;

// ======================= AGENCIA ACTIVA (maestro) =======================
// Todo el módulo opera sobre la agencia elegida en el asistente de inicio. Se
// persiste para retomar el inventario tras recargar. El TIPO (completo/rotativo)
// vive en la sesión de auditoría de esa agencia (store.getPartsAudit(agency)).
const AGENCIA_KEY = "inv_ref_agencia_activa";
let agencyActual = (() => { try { return localStorage.getItem(AGENCIA_KEY) || ""; } catch (e) { return ""; } })();

function setAgenciaActual(a) {
  agencyActual = a || "";
  try { localStorage.setItem(AGENCIA_KEY, agencyActual); } catch (e) {}
}
// La agencia con la que se llama al store. Si aún no se eligió, cae a la 1ª real
// solo para lecturas defensivas (la UI bloquea las escrituras sin agencia).
function ag() { return agencyActual || AGENCIAS_REF[0]; }

// Tipo de inventario de la agencia activa ('completo' | 'rotativo' | "").
function tipoActual() {
  if (!agencyActual) return "";
  const a = store.getPartsAudit(agencyActual) || {};
  return a.tipo || "";
}
function esRotativo() { return tipoActual() === "rotativo"; }
function esCompleto() { return tipoActual() === "completo"; }

// ¿La agencia activa tiene un inventario EN CURSO (no cerrado)? Lo está si tiene
// una sesión con tipo elegido Y partes cargadas Y aún no se cerró (sin finishedAt).
// Devuelve un objeto con el detalle para la leyenda, o null si no hay.
function inventarioActivo() {
  if (!agencyActual) return null;
  const a = store.getPartsAudit(ag()) || {};
  if (!a.tipo) return null;
  if (a.finishedAt) return null;                 // ya se cerró → no está activo
  const partes = partesActuales();
  if (!partes.length) return null;               // sin partes cargadas → no hay inventario
  const contadas = partes.filter(p => p.conteo != null || (p.conteos && Object.keys(p.conteos).length)).length;
  return { tipo: a.tipo, total: partes.length, contadas };
}
// Solo el ADMINISTRADOR puede saltarse el candado (iniciar otro con uno activo).
function puedeSaltarCandado() { try { return auth.isAdmin(); } catch (e) { return false; } }

// Partes del inventario a trabajar en el flujo actual.
//   - ROTATIVO: SOLO las de la sesión de muestra activa (ignora cualquier parte
//     que el servidor haya vuelto a bajar de un conteo anterior).
//   - COMPLETO: todas las de la agencia.
function partesActuales() {
  const todas = store.listParts(ag());
  if (!esRotativo()) return todas;
  const sesion = (store.getPartsAudit(ag()) || {}).rotativoSesion;
  // En ROTATIVO filtramos SIEMPRE por el sello de la muestra. Antes, si no había
  // sello se devolvían TODAS las partes (fallback), por eso el reporte mostraba
  // el inventario completo (p. ej. 26) en vez de la muestra (p. ej. 5). Ahora:
  //   - con sello → solo las partes de esa muestra.
  //   - sin sello (aún no se genera la muestra) → ninguna, no todas.
  if (!sesion) return [];
  return todas.filter(p => p.rotativoSesion === sesion);
}

export function initRefacciones() {
  if (initialized) return;
  initialized = true;

  // --- Carga de archivos ---
  const btnExist = document.getElementById("ref-existencias-btn");
  const fileExist = document.getElementById("ref-existencias-file");
  const btnMarb = document.getElementById("ref-marbetes-btn");
  const fileMarb = document.getElementById("ref-marbetes-file");

  if (btnExist && fileExist) {
    btnExist.addEventListener("click", () => { fileExist.value = ""; fileExist.click(); });
    fileExist.addEventListener("change", async () => {
      const f = fileExist.files && fileExist.files[0];
      if (f) await cargarExistencias(f);
    });
  }
  if (btnMarb && fileMarb) {
    btnMarb.addEventListener("click", () => { fileMarb.value = ""; fileMarb.click(); });
    fileMarb.addEventListener("change", async () => {
      const f = fileMarb.files && fileMarb.files[0];
      if (f) { lastMarbetesFile = f; await cargarMarbetes(f); }
    });
  }
  const btnMarbDiag = document.getElementById("ref-marbetes-diag");
  if (btnMarbDiag) btnMarbDiag.addEventListener("click", diagnosticarPdfMarbetes);

  // --- Acciones del cruce ---
  const btnCruzar = document.getElementById("ref-cruzar");
  if (btnCruzar) btnCruzar.addEventListener("click", hacerCruce);
  const btnConfirmar = document.getElementById("ref-confirmar");
  if (btnConfirmar) btnConfirmar.addEventListener("click", confirmarCarga);
  const btnLimpiar = document.getElementById("ref-limpiar");
  if (btnLimpiar) btnLimpiar.addEventListener("click", limpiarCarga);

  // --- Conteo ---
  const btnScan = document.getElementById("ref-scan");
  const btnScanStop = document.getElementById("ref-scan-stop");
  const btnManual = document.getElementById("ref-conteo-manual-btn");
  if (btnScan) btnScan.addEventListener("click", startScan);
  if (btnScanStop) btnScanStop.addEventListener("click", stopScan);
  if (btnManual) btnManual.addEventListener("click", registrarConteoManual);
  // Botones +1 / -1 para ajustar la cantidad con el pulgar (celular).
  const ajustarCant = (delta) => {
    const cantEl = document.getElementById("ref-conteo-cant");
    if (!cantEl) return;
    const actual = Number(cantEl.value);
    const base = Number.isFinite(actual) ? actual : 0;
    cantEl.value = String(Math.max(0, base + delta));
    beep(true);
  };
  const btnMas = document.getElementById("ref-cant-mas");
  const btnMenos = document.getElementById("ref-cant-menos");
  if (btnMas) btnMas.addEventListener("click", () => ajustarCant(1));
  if (btnMenos) btnMenos.addEventListener("click", () => ajustarCant(-1));
  const inpManual = document.getElementById("ref-conteo-parte");
  if (inpManual) inpManual.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); document.getElementById("ref-conteo-cant")?.focus(); }
  });
  const inpCant = document.getElementById("ref-conteo-cant");
  if (inpCant) inpCant.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); registrarConteoManual(); }
  });

  // --- Exhibición / puntos de venta ---
  const btnExh = document.getElementById("ref-exh-btn");
  if (btnExh) btnExh.addEventListener("click", registrarExhibicion);
  const selExhAg = document.getElementById("ref-exh-agencia");
  if (selExhAg) selExhAg.addEventListener("change", () => { fillPuntosVenta(); });
  const inpExhCant = document.getElementById("ref-exh-cant");
  if (inpExhCant) inpExhCant.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); registrarExhibicion(); }
  });
  const inpExhObs = document.getElementById("ref-exh-obs");
  if (inpExhObs) inpExhObs.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); registrarExhibicion(); }
  });

  // --- Rondas de conteo (1 a 3) ---
  const selRondas = document.getElementById("ref-rondas-sel");
  if (selRondas) selRondas.addEventListener("change", () => {
    const rondas = Number(selRondas.value) || 1;
    const a = store.getPartsAudit(ag()) || {};
    store.setPartsAudit(ag(), { rondas, rondaActual: a.rondaActual || 1 });
    try { pushPartsAudit(ag()); } catch (e) {}
    renderRondas();
  });
  const btnRondaSig = document.getElementById("ref-ronda-siguiente");
  if (btnRondaSig) btnRondaSig.addEventListener("click", avanzarRonda);
  const btnRondaFin = document.getElementById("ref-ronda-finalizar");
  if (btnRondaFin) btnRondaFin.addEventListener("click", finalizarConteos);
  const btnHojaConteo = document.getElementById("ref-hoja-conteo");
  if (btnHojaConteo) btnHojaConteo.addEventListener("click", () => imprimirHojaConteo());

  // --- Reporte de diferencias ---
  const btnDiffPdf = document.getElementById("ref-diff-pdf");
  if (btnDiffPdf) btnDiffPdf.addEventListener("click", imprimirDiferencias);
  const btnDiffCsv = document.getElementById("ref-diff-csv");
  if (btnDiffCsv) btnDiffCsv.addEventListener("click", exportarDiferenciasCsv);
  const btnReset = document.getElementById("ref-reset-conteo");
  if (btnReset) btnReset.addEventListener("click", reiniciarConteo);
  const btnPendToggle = document.getElementById("ref-pend-toggle");
  if (btnPendToggle) btnPendToggle.addEventListener("click", () => {
    _pendColapsado = !_pendColapsado;
    renderPendientesUbicacion();
  });

  // --- Resultado final con firmas ---
  const btnFinalPdf = document.getElementById("ref-final-pdf");
  if (btnFinalPdf) btnFinalPdf.addEventListener("click", imprimirResultadoFinal);
  const btnFinalCerrar = document.getElementById("ref-final-cerrar");
  if (btnFinalCerrar) btnFinalCerrar.addEventListener("click", cerrarAuditoria);
  const btnPartAdd = document.getElementById("ref-part-add");
  if (btnPartAdd) btnPartAdd.addEventListener("click", () => { agregarFilaParticipante(); });

  // --- Respaldo y conexión ---
  const btnBackupExp = document.getElementById("ref-backup-exportar");
  if (btnBackupExp) btnBackupExp.addEventListener("click", exportarRespaldo);
  const btnBackupImpBtn = document.getElementById("ref-backup-importar-btn");
  const fileBackupImp = document.getElementById("ref-backup-importar-file");
  if (btnBackupImpBtn && fileBackupImp) {
    btnBackupImpBtn.addEventListener("click", () => { fileBackupImp.value = ""; fileBackupImp.click(); });
    fileBackupImp.addEventListener("change", async () => {
      const f = fileBackupImp.files && fileBackupImp.files[0];
      if (f) await importarRespaldo(f);
    });
  }
  const btnConnProbar = document.getElementById("ref-conn-probar");
  if (btnConnProbar) btnConnProbar.addEventListener("click", probarConexion);

  // --- Etiquetas QR para anaqueles (solo existencias, sin inventario) ---
  const soloBtn = document.getElementById("ref-solo-etq-file-btn");
  const soloFile = document.getElementById("ref-solo-etq-file");
  if (soloBtn && soloFile) {
    soloBtn.addEventListener("click", () => { soloFile.value = ""; soloFile.click(); });
    soloFile.addEventListener("change", async () => {
      const f = soloFile.files && soloFile.files[0];
      if (f) await cargarExistenciasSoloEtiquetas(f);
    });
  }
  const soloPrint = document.getElementById("ref-solo-etq-print");
  if (soloPrint) soloPrint.addEventListener("click", () => imprimirEtiquetasAnaqueles(false));
  const soloPrueba = document.getElementById("ref-solo-etq-prueba");
  if (soloPrueba) soloPrueba.addEventListener("click", () => imprimirEtiquetasAnaqueles(true));

  // --- Etiqueta suelta (refacción nueva, escrita a mano) ---
  const manualAdd = document.getElementById("ref-manual-add");
  if (manualAdd) manualAdd.addEventListener("click", agregarEtiquetaManual);
  const manualPrint = document.getElementById("ref-manual-print");
  if (manualPrint) manualPrint.addEventListener("click", () => imprimirEtiquetasManuales(false));
  const manualClear = document.getElementById("ref-manual-clear");
  if (manualClear) manualClear.addEventListener("click", vaciarEtiquetasManuales);
  // Enter en cualquiera de los campos agrega la fila.
  ["ref-manual-parte", "ref-manual-desc", "ref-manual-ubic", "ref-manual-cant"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); agregarEtiquetaManual(); } });
  });

  // --- Asistente de inicio: agencia + tipo ---
  const selWizAg = document.getElementById("ref-wizard-agencia");
  if (selWizAg) selWizAg.addEventListener("change", () => {
    const a = selWizAg.value;
    if (!a) { setAgenciaActual(""); renderRefacciones(); return; }
    setAgenciaActual(a);
    logAction("parts.agency.select", `Agencia de refacciones seleccionada: ${a}`, auth.currentUser()?.name || "—");
    renderRefacciones();
  });
  const btnTipoComp = document.getElementById("ref-tipo-completo");
  if (btnTipoComp) btnTipoComp.addEventListener("click", () => elegirTipo("completo"));
  const btnTipoRot = document.getElementById("ref-tipo-rotativo");
  if (btnTipoRot) btnTipoRot.addEventListener("click", () => elegirTipo("rotativo"));
  const btnNuevoInv = document.getElementById("ref-nuevo-inventario");
  if (btnNuevoInv) btnNuevoInv.addEventListener("click", iniciarNuevoInventario);

  // --- Rotativo: muestreo + plantilla ---
  const btnMuestrear = document.getElementById("ref-rotativo-muestrear");
  if (btnMuestrear) btnMuestrear.addEventListener("click", muestrearRotativo);
  const btnCargarManual = document.getElementById("ref-rotativo-cargar-manual");
  if (btnCargarManual) btnCargarManual.addEventListener("click", cargarRotativoManual);
  document.querySelectorAll('input[name="ref-rotativo-modo"]').forEach(r => {
    r.addEventListener("change", aplicarModoRotativo);
  });
  const btnPlantilla = document.getElementById("ref-plantilla-print");
  if (btnPlantilla) btnPlantilla.addEventListener("click", imprimirPlantillaConteo);

  // --- Histórico: cambiar de agencia a ver ---
  const selHistAg = document.getElementById("ref-hist-agencia");
  if (selHistAg) selHistAg.addEventListener("change", renderHistorialAuditorias);

  const video = document.getElementById("ref-video");
  if (video) {
    scanner = new Scanner(video, {
      onResult: (text) => handleScan(text),
      onStatus: (msg, kind) => setScanStatus(msg, kind),
    });
  }
}

// Se llama cada vez que se abre la pestaña de refacciones.
export function renderRefacciones() {
  if (!initialized) return;
  // Rehidrata el buffer de existencias desde el catálogo persistido si está
  // vacío (p. ej. tras recargar la página). Así «Generar muestra» / «Cargar
  // estas partes» siguen teniendo el inventario completo aunque se haya perdido
  // la variable en memoria.
  if (agencyActual && !existencias.length) {
    const cat = catalogoExistencias();
    if (cat.length) existencias = cat.map(e => ({ ...e }));
  }
  renderWizard();
  // El histórico se ve siempre (incluso sin agencia elegida).
  renderHistorialAuditorias();

  // El resto del inventario solo cuando ya hay agencia + tipo elegidos.
  const listo = !!agencyActual && !!tipoActual();
  const inv = document.getElementById("ref-inventario");
  if (inv) inv.hidden = !listo;
  if (!listo) return;

  aplicarVisibilidadTipo();
  renderRondas();
  renderCargaResumen();
  renderConteo();
  renderExhibicion();
  renderDiferencias();
  renderFinal();
  // Comprueba el estado de conexión al abrir la pestaña (no bloquea).
  try { probarConexion(); } catch (e) {}
}

// ======================= ASISTENTE DE INICIO (WIZARD) =======================

// Pinta el selector de agencia, el paso de tipo y los avisos del asistente.
function renderWizard() {
  const selAg = document.getElementById("ref-wizard-agencia");
  if (selAg) {
    // Solo las agencias de refacciones que existan dadas de alta como sitio.
    const existentes = new Set(store.listAgencies().map(a => a.name));
    const lista = AGENCIAS_REF.filter(a => existentes.has(a));
    const opciones = (lista.length ? lista : AGENCIAS_REF);
    selAg.innerHTML = `<option value="">— Selecciona la agencia —</option>` +
      opciones.map(a => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join("");
    selAg.value = agencyActual || "";
  }
  const badge = document.getElementById("ref-wizard-agencia-actual");
  if (badge) {
    badge.hidden = !agencyActual;
    badge.textContent = agencyActual ? `Agencia activa: ${agencyActual}` : "";
  }

  // Paso 2 (tipo) solo visible tras elegir agencia.
  const tipoBox = document.getElementById("ref-wizard-tipo-box");
  if (tipoBox) tipoBox.hidden = !agencyActual;
  const tipo = tipoActual();
  const btnC = document.getElementById("ref-tipo-completo");
  const btnR = document.getElementById("ref-tipo-rotativo");
  if (btnC) btnC.classList.toggle("btn-primary", tipo === "completo");
  if (btnR) btnR.classList.toggle("btn-primary", tipo === "rotativo");
  const tipoActualEl = document.getElementById("ref-wizard-tipo-actual");
  if (tipoActualEl) {
    tipoActualEl.textContent = tipo === "completo"
      ? "Inventario COMPLETO: se cargan existencias + marbetes, se cruzan y se cuentan todas las partes (hasta 3 conteos)."
      : tipo === "rotativo"
        ? "Inventario ROTATIVO: cargas existencias, eliges cuántas partes auditar al azar y haces un solo conteo."
        : "";
  }

  // CANDADO: si la agencia tiene un inventario EN CURSO, se bloquea iniciar otro
  // (cambiar de tipo / muestrear / cargar) para no borrar el trabajo por error.
  // Solo el ADMINISTRADOR puede saltarlo (vía "Iniciar nuevo inventario").
  const activo = inventarioActivo();
  const bloqueado = !!activo && !puedeSaltarCandado();
  // Deshabilita los botones de tipo mientras haya inventario activo (no-admin).
  if (btnC) btnC.disabled = bloqueado;
  if (btnR) btnR.disabled = bloqueado;

  const aviso = document.getElementById("ref-wizard-aviso");
  if (aviso) {
    if (activo) {
      const tipoTxt = activo.tipo === "rotativo" ? "rotativo" : "completo";
      aviso.innerHTML = `🔒 <b>${escapeHtml(ag())}</b>: inventario <b>${tipoTxt}</b> EN CURSO ` +
        `(${activo.total} parte(s), ${activo.contadas} contada(s)). ` +
        (bloqueado
          ? `Para continuarlo, baja a «Conteo físico». No puedes iniciar otro: pide a un administrador que use «Iniciar nuevo inventario» si hay que empezar de cero.`
          : `Para empezar de cero usa «Iniciar nuevo inventario» (abajo); si no, continúa en «Conteo físico».`);
      aviso.style.color = bloqueado ? "var(--danger)" : "#b45309";
    } else {
      aviso.style.color = "#b45309";
      aviso.textContent = !agencyActual
        ? "Selecciona una agencia para comenzar."
        : (!tipo ? "Elige el tipo de inventario para habilitar la carga y el conteo." : "");
    }
  }

  // Botón "Iniciar nuevo inventario": visible solo si la agencia activa ya tiene
  // partes cargadas. Si hay inventario activo, SOLO el administrador lo ve (es el
  // escape del candado); para los demás queda oculto.
  const nuevoBox = document.getElementById("ref-nuevo-inv-box");
  if (nuevoBox) {
    const hayDatos = agencyActual && store.listParts(ag()).length > 0;
    nuevoBox.hidden = !hayDatos || (!!activo && !puedeSaltarCandado());
  }
}

// Elige el tipo de inventario para la agencia activa. Si ya había un tipo
// distinto con datos cargados, avisa (cambiar de tipo no borra, pero el flujo
// cambia). En rotativo fijamos 1 conteo; en completo, por defecto 3.
// Candado compartido: devuelve true si se DEBE bloquear la acción de iniciar otro
// inventario (hay uno activo y el usuario no es admin). Avisa al usuario.
function candadoBloquea(accion) {
  const activo = inventarioActivo();
  if (activo && !puedeSaltarCandado()) {
    notify(`🔒 ${ag()} ya tiene un inventario ${activo.tipo} en curso (${activo.contadas}/${activo.total} contadas). ` +
      `No puedes ${accion} sin cerrarlo. Solo un administrador puede iniciar uno nuevo.`, { type: "warn", timeout: 7000 });
    return true;
  }
  return false;
}

function elegirTipo(tipo) {
  if (!agencyActual) { notify("Primero selecciona la agencia.", { type: "warn" }); return; }
  if (!puedeEditar() && !puedeContar()) {
    notify("Tu rol no permite iniciar inventarios de refacciones.", { type: "warn" });
    return;
  }
  // Cambiar de tipo con un inventario activo lo reinicia de hecho → candado.
  const prevTipo = tipoActual();
  if (tipo !== prevTipo && candadoBloquea("cambiar el tipo de inventario")) return;
  const prev = store.getPartsAudit(agencyActual) || {};
  if (prev.tipo && prev.tipo !== tipo) {
    const hayDatos = store.listParts(agencyActual).length > 0;
    const msg = hayDatos
      ? `Esta agencia ya tiene un inventario ${prev.tipo.toUpperCase()} en curso con datos cargados.\n\n` +
        `¿Cambiar a ${tipo.toUpperCase()}? Los datos cargados se conservan, pero el flujo cambia.`
      : `¿Cambiar el tipo de inventario a ${tipo.toUpperCase()}?`;
    if (!confirm(msg)) return;
  }
  const patch = { tipo };
  if (tipo === "rotativo") { patch.rondas = 1; patch.rondaActual = 1; }
  else if (!prev.rondas) { patch.rondas = 3; patch.rondaActual = prev.rondaActual || 1; }
  store.setPartsAudit(agencyActual, patch);
  try { pushPartsAudit(agencyActual); } catch (e) {}
  logAction("parts.type.select", `Tipo de inventario (${agencyActual}): ${tipo}`, auth.currentUser()?.name || "—");
  renderRefacciones();
}

// Inicia un inventario NUEVO para la agencia activa: vacía sus partes, conteos y
// la sesión en curso (tipo/rondas/firmas), para empezar de cero. NO toca el
// histórico de inventarios cerrados ni el archivo anterior. Acción sensible.
function iniciarNuevoInventario() {
  if (!agencyActual) { notify("Primero selecciona la agencia.", { type: "warn" }); return; }
  if (!puedeEditar()) {
    notify("Solo quien puede EDITAR refacciones (admin/refacciones) puede iniciar un nuevo inventario.", { type: "warn" });
    return;
  }
  const n = store.listParts(ag()).length;
  const resp = (prompt(
    `Vas a VACIAR el inventario de trabajo de "${ag()}" (${n} parte(s) y sus conteos) para empezar de cero.\n` +
    `El HISTÓRICO de inventarios cerrados NO se borra.\n\nEscribe NUEVO para confirmar:`, "") || "").trim().toUpperCase();
  if (resp !== "NUEVO") { if (resp !== "") notify("Cancelado: no se escribió NUEVO.", { type: "info" }); return; }

  store.clearParts(ag());
  store.clearPartsAudit(ag());
  existencias = []; marbetes = []; lastCruce = null; lastMarbetesFile = null;
  // Limpia TODOS los campos del formulario (antes solo se borraban los datos
  // internos, pero el modo azar/manual, la lista de números de parte, la
  // cantidad y la vista previa del cruce se quedaban con lo del inventario
  // anterior). Así el usuario arranca el nuevo inventario con la pantalla limpia.
  limpiarFormularioRefacciones();
  // Propaga el vaciado al servidor: borra el inventario de la agencia y limpia la
  // sesión, para que los demás equipos no sigan viendo el inventario anterior.
  try { api.deleteParts(ag()); } catch (e) {}
  try { pushPartsAudit(ag()); } catch (e) {}
  logAction("parts.new", `Nuevo inventario iniciado (vaciado) en ${ag()}`, auth.currentUser()?.name || "—");
  notify(`Inventario de ${ag()} vaciado. Elige el tipo y vuelve a cargar.`, { type: "success", timeout: 6000 });
  renderRefacciones();
}

// Deja en blanco los campos del asistente/muestreo de refacciones. Se usa al
// iniciar un inventario nuevo para que no queden valores del anterior.
function limpiarFormularioRefacciones() {
  const byId = (id) => document.getElementById(id);
  // Muestreo rotativo: lista manual de números de parte y cantidad al azar.
  const lista = byId("ref-rotativo-lista"); if (lista) lista.value = "";
  const cant = byId("ref-rotativo-cant");   if (cant) cant.value = "";
  // Volver el modo a "Al azar" (valor por defecto) y marcar "evitar ya auditadas".
  document.querySelectorAll('input[name="ref-rotativo-modo"]').forEach(r => {
    r.checked = (r.value === "azar");
  });
  const evitar = byId("ref-rotativo-evitar"); if (evitar) evitar.checked = true;
  // Número de conteos (completo): volver al valor por defecto.
  const rondas = byId("ref-rondas-sel"); if (rondas) rondas.value = "3";
  // Líneas de estado y vista previa del cruce.
  const prev = byId("ref-cruce-preview"); if (prev) prev.innerHTML = "";
  setRotativoStatus("", "info");
  setCargaStatus("", "info");
  const btnConfirmar = byId("ref-confirmar"); if (btnConfirmar) btnConfirmar.hidden = true;
}

// Muestra/oculta las secciones específicas de cada tipo (clases
// .ref-only-completo / .ref-only-rotativo) según el tipo activo.
function aplicarVisibilidadTipo() {
  const rot = esRotativo();
  document.querySelectorAll(".ref-only-rotativo").forEach(el => { el.hidden = !rot; });
  document.querySelectorAll(".ref-only-completo").forEach(el => { el.hidden = rot; });
  if (rot) aplicarModoRotativo();  // ajusta sub-paneles azar/manual
}

// ======================= EXHIBICIÓN / PUNTOS DE VENTA =======================

// Llena el desplegable de puntos de venta con las agencias/sitios existentes.
// Sitios de EXHIBICIÓN / puntos de venta por agencia (mapeo fijo). "Exhibición"
// es dentro de la propia agencia. Las bodegas y talleres NO aparecen aquí (no se
// exhiben refacciones). Aeropuerto y Automotriz comparten sitio y puntos de venta.
const PUNTOS_POR_AGENCIA = {
  "Aeroplasa Auto":        ["Exhibición", "Punto de Venta Zacatlán", "Punto de Venta Chignahuapan"],
  "Aeroplasa Aeropuerto":  ["Exhibición", "Punto de Venta Calzada del Hueso", "Punto de Venta Miramontes"],
  "Aeroplasa Automotriz":  ["Exhibición", "Punto de Venta Calzada del Hueso", "Punto de Venta Miramontes"],
};
// NOTA: AGENCIAS_REF se importa de storage.js (fuente única de verdad).

// Refleja la agencia ACTIVA (del asistente) en el selector de la sección
// exhibición y lo deja como indicador (no es un selector independiente: la
// agencia maestra manda). Devuelve la agencia activa.
function fillAgenciasExh() {
  const sel = document.getElementById("ref-exh-agencia");
  if (sel) {
    sel.innerHTML = AGENCIAS_REF.map(a => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join("");
    if (agencyActual) sel.value = agencyActual;
    sel.disabled = true;  // la agencia se elige en el asistente, no aquí
  }
  return agencyActual || AGENCIAS_REF[0];
}

// Llena el desplegable de puntos de venta SOLO con los sitios de la agencia
// ACTIVA (según PUNTOS_POR_AGENCIA). Sin bodegas ni talleres.
function fillPuntosVenta() {
  const sel = document.getElementById("ref-exh-punto");
  if (!sel) return;
  const agencia = agencyActual || AGENCIAS_REF[0];
  const sitios = PUNTOS_POR_AGENCIA[agencia] || ["Exhibición"];
  const prev = sel.value;
  // Opciones fijas extra: "Sin ubicación" (refacciones fuera de su lugar) y "Otro".
  sel.innerHTML = `<option value="">— Punto de venta / ubicación —</option>` +
    sitios.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("") +
    `<option value="Sin ubicación">Sin ubicación (fuera de lugar)</option>` +
    `<option value="Otro">Otro…</option>`;
  // Conservar la selección previa solo si sigue siendo válida para esta agencia.
  if (prev && (sitios.includes(prev) || prev === "Otro" || prev === "Sin ubicación")) sel.value = prev;
}

function registrarExhibicion() {
  if (!puedeContar()) { notify("Tu rol no permite registrar refacciones.", { type: "warn" }); return; }
  const parteEl = document.getElementById("ref-exh-parte");
  const puntoEl = document.getElementById("ref-exh-punto");
  const cantEl = document.getElementById("ref-exh-cant");
  const numParte = (parteEl?.value || "").trim();
  const punto = (puntoEl?.value || "").trim();
  const cantRaw = (cantEl?.value || "").trim();
  if (!numParte) { notify("Escribe el número de parte.", { type: "warn" }); parteEl?.focus(); return; }
  if (!punto) { notify("Elige el punto de venta / armario.", { type: "warn" }); puntoEl?.focus(); return; }
  const cant = Number(cantRaw);
  if (!Number.isFinite(cant) || cant < 0) { notify("La cantidad debe ser 0 o más.", { type: "warn" }); cantEl?.focus(); return; }

  // AVISO: comprobar que el número de parte EXISTE en el inventario cargado. En
  // rotativo, además, que pertenezca a la MUESTRA auditada. Antes, exhibición
  // daba de alta cualquier número sin avisar, así que un error de tecleo entraba
  // silenciosamente y descuadraba el conteo.
  const existente = store.getPart(ag(), numParte);
  const sello = (store.getPartsAudit(ag()) || {}).rotativoSesion;
  const enInventario = !!existente && (!esRotativo() || (sello && existente.rotativoSesion === sello));
  if (!enInventario) {
    const motivo = !existente
      ? `El número de parte ${numParte} NO está en el inventario cargado de ${ag()}.`
      : `El número de parte ${numParte} está en el inventario, pero NO forma parte de la muestra de este inventario rotativo.`;
    if (!confirm(`${motivo}\n\n¿Agregarlo de todos modos a exhibición? (puede descuadrar el conteo si fue un error de captura)`)) {
      setExhStatus(`Cancelado: ${numParte} no se agregó.`, "warn");
      parteEl?.focus();
      return;
    }
  }

  const obsEl = document.getElementById("ref-exh-obs");
  const observacion = (obsEl?.value || "").trim();
  const by = auth.currentUser()?.name || "—";
  const p = store.setPartExhibicion(ag(), numParte, punto, cant, by, observacion);
  const etiqueta = punto === "Sin ubicación" ? "sin ubicación (fuera de lugar)" : punto;
  logAction("parts.exhibicion", `Exhibición/ubicación de ${numParte} (${ag()}): ${cant} en ${etiqueta}${observacion ? ` · obs: ${observacion}` : ""}`, by);
  try { pushPart(ag(), numParte); } catch (e) {}
  setExhStatus(`✓ ${numParte}: ${cant} en ${etiqueta} (total: ${p.exhibicion}).`, "ok");
  if (parteEl) parteEl.value = "";
  if (cantEl) cantEl.value = "";
  if (obsEl) obsEl.value = "";
  if (parteEl) parteEl.focus();
  renderExhibicion();
  renderConteo();
  renderDiferencias();
  renderFinal();
}

function renderExhibicion() {
  fillAgenciasExh();
  fillPuntosVenta();
  const el = document.getElementById("ref-exh-resumen");
  const tbody = document.querySelector("#ref-exh-table tbody");
  const all = store.listParts(ag());
  const conExh = all.filter(p => Number(p.exhibicion || 0) > 0);
  const totalPiezas = conExh.reduce((s, p) => s + Number(p.exhibicion || 0), 0);
  if (el) el.innerHTML = `
    <div class="stat"><b>${conExh.length}</b><span>Partes en exhibición</span></div>
    <div class="stat"><b>${totalPiezas}</b><span>Piezas en exhibición (suman al conteo)</span></div>`;
  if (tbody) {
    // Una fila por (parte, punto). Resalta "Sin ubicación" (fuera de lugar).
    // Cada fila lleva un botón ✕ para quitarla (p. ej. si se capturó por error).
    const filas = [];
    for (const p of conExh) {
      // Si la parte tiene TOTAL de exhibición pero el detalle por punto está vacío
      // (dato envenenado que pudo bajar del servidor con exhibiciones=null), lo
      // mostramos igualmente como una fila "Exhibición" para que el usuario lo vea
      // y pueda quitarlo. Sin esto, el resumen contaba la parte pero la tabla
      // salía vacía.
      let detalle = p.exhibiciones && Object.keys(p.exhibiciones).length
        ? p.exhibiciones
        : { "Exhibición": Number(p.exhibicion || 0) };
      for (const [punto, n] of Object.entries(detalle)) {
        const obs = (p.exhibObs && p.exhibObs[punto]) || "";
        const sinUbic = punto === "Sin ubicación";
        filas.push(`<tr${sinUbic ? ' style="background:#fffbeb"' : ""}>
          <td><code>${escapeHtml(p.numParte)}</code></td>
          <td>${escapeHtml((p.descripcion || "").slice(0, 40))}</td>
          <td>${sinUbic ? "⚠️ " : ""}${escapeHtml(punto)}</td>
          <td style="text-align:right"><b>${escapeHtml(String(n))}</b></td>
          <td>${escapeHtml(obs)}</td>
          <td style="text-align:center"><button class="btn btn-ghost ref-exh-del" type="button" title="Quitar esta exhibición" data-parte="${escapeHtml(p.numParte)}" data-punto="${escapeHtml(punto)}" style="padding:2px 8px;color:var(--danger)">✕</button></td>
        </tr>`);
      }
    }
    tbody.innerHTML = filas.join("");
    // Enganchar los botones de quitar.
    tbody.querySelectorAll(".ref-exh-del").forEach(btn => {
      btn.addEventListener("click", () => quitarExhibicion(btn.dataset.parte, btn.dataset.punto));
    });
  }
}

// Quita una exhibición (parte + punto): pone su cantidad a 0, lo que en el store
// elimina ese punto de p.exhibiciones y recalcula el total. Se usa para corregir
// una captura equivocada.
function quitarExhibicion(numParte, punto) {
  if (!numParte || !punto) return;
  if (!puedeContar()) { notify("Tu rol no permite editar exhibición.", { type: "warn" }); return; }
  if (!confirm(`¿Quitar la exhibición de ${numParte} en «${punto}»?`)) return;
  const by = auth.currentUser()?.name || "—";
  store.setPartExhibicion(ag(), numParte, punto, 0, by);   // 0 → elimina el punto
  logAction("parts.exhibicion.del", `Exhibición quitada: ${numParte} en ${punto} (${ag()})`, by);
  try { pushPart(ag(), numParte); } catch (e) {}
  setExhStatus(`Quitada la exhibición de ${numParte} en ${punto}.`, "ok");
  renderExhibicion();
  renderConteo();
  renderDiferencias();
  renderFinal();
}

function setExhStatus(msg, kind) { setStatusEl("ref-exh-status", msg, kind); }

// ======================= RONDAS DE CONTEO (1 a 3) =======================

// Devuelve la ronda actual (1-3) y el total de rondas configurado.
function rondaInfo() {
  const a = store.getPartsAudit(ag()) || {};
  const rondas = Math.min(3, Math.max(1, Number(a.rondas) || 1));
  const rondaActual = Math.min(rondas, Math.max(1, Number(a.rondaActual) || 1));
  return { rondas, rondaActual };
}

function renderRondas() {
  const { rondas, rondaActual } = rondaInfo();
  const rot = esRotativo();
  // En rotativo el nº de conteos es fijo (1): se oculta el selector de rondas.
  const rondasBox = document.getElementById("ref-rondas-box");
  if (rondasBox) {
    const ctl = rondasBox.querySelector(".row");
    if (ctl) {
      // Oculta el selector y botones de rondas en rotativo; deja el badge.
      rondasBox.querySelectorAll("#ref-rondas-sel, #ref-ronda-siguiente, #ref-ronda-finalizar, label")
        .forEach(el => { el.style.display = rot ? "none" : ""; });
    }
  }
  const sel = document.getElementById("ref-rondas-sel");
  if (sel && Number(sel.value) !== rondas) sel.value = String(rondas);
  const badge = document.getElementById("ref-ronda-actual");
  if (badge) badge.textContent = rot ? "Conteo único (rotativo)" : `Conteo ${rondaActual} de ${rondas}`;
  const btnSig = document.getElementById("ref-ronda-siguiente");
  if (btnSig) {
    btnSig.hidden = rondaActual >= rondas;   // en la última ronda no hay "siguiente"
    btnSig.textContent = rondaActual < rondas
      ? `Terminar conteo ${rondaActual} y pasar al ${rondaActual + 1} →` : "";
  }
  const hint = document.getElementById("ref-ronda-hint");
  if (hint) {
    hint.textContent = rondaActual === 1
      ? "1er conteo: cuenta TODAS las partes con marbete."
      : `Conteo ${rondaActual}: recuenta SOLO las partes que siguen con diferencia (resaltadas como pendientes).`;
  }
}

// ¿Una parte está "pendiente de contar" en la ronda actual?
//  - Ronda 1: pendiente si aún no tiene conteo en la ronda 1 (y tiene marbete).
//  - Ronda ≥2: pendiente solo si en la ronda anterior quedó con DIFERENCIA.
function pendienteEnRonda(p, ronda) {
  // En COMPLETO, solo entran al conteo las partes con marbete. En ROTATIVO todas
  // las partes de la muestra entran (vienen de existencias, sin marbete).
  if (!esRotativo() && p.enMarbetes === false) return false;
  const conteos = p.conteos || {};
  if (ronda === 1) return conteos["1"] == null;
  // Para rondas ≥2: solo las que la ronda anterior dejó con diferencia vs
  // existencia (contando también lo que esté en exhibición → Opción A).
  const prev = conteos[String(ronda - 1)];
  if (prev == null) return false;                  // no se contó antes → no aplica
  if (p.existencia == null) return false;
  const efectivo = Number(prev) + Number(p.exhibicion || 0);
  return efectivo !== Number(p.existencia);        // seguía con diferencia → recontar
}

// Avanza a la siguiente ronda (registra la vuelta en la bitácora).
function avanzarRonda() {
  const { rondas, rondaActual } = rondaInfo();
  if (rondaActual >= rondas) { notify("Ya estás en el último conteo.", { type: "info" }); return; }
  const by = auth.currentUser()?.name || "—";
  // Resumen de la ronda que se cierra.
  const difs = listaDiferencias().filter(d => d.tipo === "faltante" || d.tipo === "sobrante").length;
  logAction("parts.count.round", `Conteo ${rondaActual} terminado · ${difs} con diferencia`, by);
  store.setPartsAudit(ag(), { rondaActual: rondaActual + 1, rondas });
  try { pushPartsAudit(ag()); } catch (e) {}
  notify(`Conteo ${rondaActual} terminado. Ahora el conteo ${rondaActual + 1} recuenta solo las diferencias.`, { type: "success", timeout: 6000 });
  renderRondas();
  renderConteo();
  renderDiferencias();
}

// Finaliza los conteos AQUÍ, aunque falten rondas por hacer. El auditor decide
// cuándo ya es suficiente (p. ej. configuró 3 conteos pero con 2 le basta).
// Fija el total de rondas a la ronda actual para cerrar el proceso de conteo.
function finalizarConteos() {
  const { rondas, rondaActual } = rondaInfo();
  const faltan = rondas - rondaActual;
  const msg = faltan > 0
    ? `¿Finalizar los conteos en el conteo ${rondaActual}? Se omitirá(n) ${faltan} conteo(s) restante(s) y pasarás al resultado final.`
    : `¿Finalizar los conteos y pasar al resultado final?`;
  if (!confirm(msg)) return;
  const by = auth.currentUser()?.name || "—";
  store.setPartsAudit(ag(), { rondas: rondaActual, rondaActual });
  try { pushPartsAudit(ag()); } catch (e) {}
  logAction("parts.count.finish", `Conteos finalizados en el conteo ${rondaActual} (de ${rondas} configurados)`, by);
  notify(`Conteos finalizados en el conteo ${rondaActual}. Revisa las diferencias y el resultado final.`, { type: "success", timeout: 6000 });
  renderRondas();
  renderConteo();
  renderDiferencias();
  renderFinal();
}

// Imprime la HOJA DEL CONTEO para capturar en el sistema de la agencia. Muestra
// nº de parte, MARBETE, descripción, ubicación y la CANTIDAD CONTADA (valores
// reales, no en blanco). En el conteo 1 incluye TODAS las partes contadas en esa
// ronda; en el conteo 2/3 solo las que SIGUEN con diferencia (son las que hay que
// recapturar). Pensada para el flujo COMPLETO.
function imprimirHojaConteo() {
  const { rondas, rondaActual } = rondaInfo();
  const all = partesActuales();

  // Conteo de referencia a imprimir: lo capturado en la ronda actual (o la última
  // con datos). Para ronda 1 = todas las contadas; para ronda ≥2 = solo las que
  // quedaron con diferencia tras esa ronda.
  let lista;
  if (rondaActual <= 1) {
    lista = all.filter(p => (p.conteos || {})["1"] != null || p.conteo != null);
  } else {
    // Partes con diferencia considerando el conteo de la ronda actual (+exhibición).
    lista = all.filter(p => {
      const c = (p.conteos || {})[String(rondaActual)];
      if (c == null || p.existencia == null) return false;
      return (Number(c) + Number(p.exhibicion || 0)) !== Number(p.existencia);
    });
  }
  if (!lista.length) {
    notify(`No hay partes contadas en el conteo ${rondaActual} para imprimir.`, { type: "warn" });
    return;
  }
  // Ordenar por ubicación para capturar en orden.
  lista.sort((a, b) => String(a.ubicacion || "~").localeCompare(String(b.ubicacion || "~"), "es"));

  const by = auth.currentUser()?.name || "—";
  const fecha = new Date().toLocaleString("es-MX");
  const filas = lista.map((p, i) => {
    const c = (p.conteos || {})[String(rondaActual)];
    const cantidad = c != null ? c : (p.conteo != null ? p.conteo : "");
    const total = cantidad === "" ? "" : Number(cantidad) + Number(p.exhibicion || 0);
    return `<tr>
      <td>${i + 1}</td>
      <td>${esc(p.numParte)}</td>
      <td>${esc(p.marbete || "")}</td>
      <td>${esc((p.descripcion || "").slice(0, 50))}</td>
      <td>${esc(p.ubicacion || "")}</td>
      <td style="text-align:right">${esc(String(cantidad))}</td>
      <td style="text-align:right">${esc(String(total))}</td>
    </tr>`;
  }).join("");

  const titulo = rondaActual <= 1
    ? "Hoja del 1er conteo (para captura en el sistema)"
    : `Hoja del conteo ${rondaActual} — solo diferencias (para captura)`;

  const win = window.open("", "_blank", "width=900,height=1000");
  if (!win) { notify("El navegador bloqueó la ventana. Permite ventanas emergentes.", { type: "warn" }); return; }
  win.document.write(`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
    <title>${esc(titulo)}</title>
    <style>
      *{box-sizing:border-box} body{font-family:system-ui,Arial,sans-serif;margin:24px;color:#111}
      h1{font-size:17px;margin:0 0 4px} .meta{color:#555;font-size:12px;margin-bottom:12px}
      table{width:100%;border-collapse:collapse;font-size:12px}
      th,td{border:1px solid #ccc;padding:5px 7px;text-align:left}
      th{background:#0f204a;color:#fff}
      tr:nth-child(even){background:#f6f8fc}
      .barra{margin-bottom:12px}
      .barra button{padding:8px 16px;font-size:14px;border:0;border-radius:6px;background:#0f204a;color:#fff;cursor:pointer}
      @media print{.barra{display:none}}
    </style></head><body>
    <div class="barra"><button onclick="window.print()">🖨️ Imprimir / Guardar PDF</button></div>
    <h1>${esc(titulo)} — ${esc(ag())}</h1>
    <div class="meta">Generada: ${esc(fecha)} · Por: ${esc(by)} · Conteo ${rondaActual} de ${rondas} · ${lista.length} parte(s)</div>
    <table><thead><tr>
      <th>#</th><th>No. parte</th><th>Marbete</th><th>Descripción</th><th>Ubicación</th>
      <th>Contado</th><th>Contado + exhib.</th>
    </tr></thead><tbody>${filas}</tbody></table>
    </body></html>`);
  win.document.close();
  logAction("parts.count.sheet", `Hoja de conteo ${rondaActual} impresa (${ag()}, ${lista.length} partes)`, by);
}

export function stopRefacciones() { try { stopScan(); } catch (e) {} }

// ======================= CARGA =======================

async function cargarExistencias(file) {
  setCargaStatus("Leyendo archivo de existencias…", "info");
  try {
    const text = await readTextFile(file);
    existencias = parseExistenciasCsv(text);
    // Persistimos el CATÁLOGO completo de existencias en la sesión de la agencia.
    // Antes, las existencias solo vivían en memoria (buffer `existencias`); si el
    // usuario recargaba la página antes de muestrear, se perdían y el "inventario
    // completo" del rotativo salía con muy pocas partes. Ahora queda guardado y
    // se rehidrata al entrar, de modo que el valor total siempre es correcto.
    guardarCatalogoExistencias(existencias);
    setCargaStatus(`✓ Existencias leídas: ${existencias.length} partes.`, "ok");
  } catch (e) {
    existencias = [];
    setCargaStatus("No se pudo leer el archivo de existencias: " + (e.message || e), "error");
  }
  renderCargaResumen();
}

// Guarda un catálogo ligero (solo lo necesario para re-muestrear y para el valor
// total del inventario) en la sesión de la agencia activa. Se sincroniza con el
// servidor como parte de partsAudit, así otro equipo también lo tiene.
function guardarCatalogoExistencias(lista) {
  if (!agencyActual) return;
  const catalogo = (lista || [])
    .filter(e => e && e.numParte)
    .map(e => ({
      numParte: e.numParte,
      descripcion: e.descripcion || "",
      ubicacion: e.ubicacion || "",
      grupo: e.grupo || "",
      existencia: e.existencia,
      precioUnit: e.precioUnit ?? null,
      clasificacion: e.clasificacion || "",
    }));
  store.setPartsAudit(ag(), { catalogo });
  try { pushPartsAudit(ag()); } catch (e) {}
}

// Devuelve el catálogo de existencias persistido de la agencia activa (o []).
function catalogoExistencias() {
  const a = store.getPartsAudit(ag()) || {};
  return Array.isArray(a.catalogo) ? a.catalogo : [];
}

async function cargarMarbetes(file) {
  setCargaStatus("Leyendo PDF de marbetes… (puede tardar en archivos grandes)", "info");
  try {
    marbetes = await parseMarbetesFile(file, (p, total) => {
      setCargaStatus(`Leyendo marbetes: página ${p} de ${total}…`, "info");
    });
    const reales = marbetes.filter(m => !m.enBlanco).length;
    const blanco = marbetes.filter(m => m.enBlanco).length;
    setCargaStatus(`✓ Marbetes leídos: ${reales} partes${blanco ? ` · ${blanco} marbete(s) en blanco` : ""}.`, "ok");
  } catch (e) {
    marbetes = [];
    setCargaStatus("No se pudo leer el PDF de marbetes: " + (e.message || e), "error");
  }
  renderCargaResumen();
}

// Herramienta de diagnóstico: muestra en una ventana el texto CRUDO que el
// sistema extrae del PDF de marbetes y cuántos renglones reconoce. Sirve para
// ver el formato real cuando "Marbetes leídos" sale en 0.
async function diagnosticarPdfMarbetes() {
  if (!lastMarbetesFile) {
    notify("Primero sube el PDF de marbetes y luego pulsa «Ver texto del PDF».", { type: "warn" });
    return;
  }
  setCargaStatus("Analizando el PDF de marbetes…", "info");
  let diag;
  try {
    diag = await diagnosticarMarbetes(lastMarbetesFile, null, 60);
  } catch (e) {
    setCargaStatus("No se pudo analizar el PDF: " + (e.message || e), "error");
    return;
  }
  setCargaStatus("", "info");
  const win = window.open("", "_blank", "width=820,height=900");
  if (!win) { notify("El navegador bloqueó la ventana. Permite ventanas emergentes.", { type: "warn" }); return; }
  const filasCrudas = diag.muestra.map((l, i) =>
    `<tr><td style="color:#888">${i + 1}</td><td><code>${esc(l)}</code></td></tr>`).join("");
  const filasParse = diag.muestraParseada.map(p =>
    `<tr><td><code>${esc(p.numParte || "(vacío)")}</code></td><td>${esc((p.descripcion || "").slice(0, 40))}</td><td><code>${esc(p.ubicacion || "")}</code></td><td><code>${esc(p.marbete || "")}</code></td></tr>`).join("");
  win.document.write(`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
    <title>Diagnóstico del PDF de marbetes</title>
    <style>
      body{font-family:system-ui,Arial,sans-serif;margin:20px;color:#111;font-size:13px}
      h1{font-size:17px} h2{font-size:14px;margin-top:18px}
      table{width:100%;border-collapse:collapse;margin-top:6px}
      td,th{border:1px solid #ddd;padding:3px 6px;text-align:left;vertical-align:top}
      th{background:#0f204a;color:#fff}
      code{font-family:ui-monospace,Consolas,monospace;font-size:12px}
      .res{display:flex;gap:14px;flex-wrap:wrap;margin:10px 0}
      .b{border:1px solid #ccc;border-radius:8px;padding:8px 12px;min-width:130px}
      .b b{display:block;font-size:18px} .b span{font-size:11px;color:#555}
      .warn{color:#b45309}
    </style></head><body>
    <h1>Diagnóstico del PDF de marbetes</h1>
    <div class="res">
      <div class="b"><b>${diag.totalLineas}</b><span>Líneas extraídas</span></div>
      <div class="b"><b>${diag.lineasConMarbete}</b><span>Líneas con marbete</span></div>
      <div class="b"><b>${diag.marbetesParseados}</b><span>Marbetes con nº de parte</span></div>
      <div class="b"><b class="${diag.sinNumParte ? "warn" : ""}">${diag.sinNumParte}</b><span>Con marbete pero sin nº de parte</span></div>
    </div>
    ${diag.lineasConMarbete === 0 ? `<p class="warn"><b>⚠️ No se detectó ningún marbete.</b> Revisa el texto crudo de abajo: puede que el marbete tenga un formato distinto a <code>dddddd-d</code>, o que el PDF no traiga texto seleccionable (sea una imagen escaneada).</p>` : ""}
    <h2>Cómo se interpretó (primeras ${diag.muestraParseada.length})</h2>
    <table><thead><tr><th>Nº parte</th><th>Descripción</th><th>Ubicación</th><th>Marbete</th></tr></thead><tbody>${filasParse || `<tr><td colspan="4">—</td></tr>`}</tbody></table>
    <h2>Texto crudo extraído (primeras ${diag.muestra.length} líneas)</h2>
    <table><thead><tr><th>#</th><th>Línea</th></tr></thead><tbody>${filasCrudas}</tbody></table>
    </body></html>`);
  win.document.close();
}

function hacerCruce() {
  if (!marbetes.length && !existencias.length) {
    notify("Primero carga el archivo de existencias y/o el PDF de marbetes.", { type: "warn" });
    return;
  }
  lastCruce = cruzar(marbetes, existencias);
  renderCrucePreview(lastCruce);
  const btnConfirmar = document.getElementById("ref-confirmar");
  if (btnConfirmar) btnConfirmar.hidden = !(lastCruce.items.length || lastCruce.soloExistencia.length);
}

// ======================= FLUJO ROTATIVO =======================

// Conjunto de números de parte YA auditados en inventarios rotativos cerrados
// anteriores de la agencia activa, con la fecha del más reciente por parte.
// Devuelve Map<numParte, fechaISO>.
function partesAuditadasAntes(agency) {
  const map = new Map();
  for (const h of store.listPartsAuditHistory(agency)) {
    if (!Array.isArray(h.partesAuditadas)) continue;
    for (const np of h.partesAuditadas) {
      const prev = map.get(np);
      if (!prev || String(h.fecha || "") > prev) map.set(np, h.fecha || "");
    }
  }
  return map;
}

// Muestra/oculta los sub-paneles del rotativo según el modo elegido (azar/manual).
function aplicarModoRotativo() {
  const modo = (document.querySelector('input[name="ref-rotativo-modo"]:checked') || {}).value || "azar";
  const azar = document.getElementById("ref-rotativo-azar");
  const manual = document.getElementById("ref-rotativo-manual");
  if (azar) azar.hidden = modo !== "azar";
  if (manual) manual.hidden = modo !== "manual";
}

// Muestreo al azar (Fisher–Yates parcial) de `n` elementos de un array.
function muestraAlAzar(arr, n) {
  const a = arr.slice();
  const m = Math.min(n, a.length);
  for (let i = 0; i < m; i++) {
    const j = i + Math.floor(Math.random() * (a.length - i));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, m);
}

// Rotativo: con las existencias ya cargadas (buffer `existencias`), el auditor
// elige CUÁNTOS números de parte auditar. Se eligen al azar entre las partes con
// existencia (>0) y se cargan SOLO esas al inventario de la agencia (se descarta
// lo demás con retainParts). Luego se imprime la plantilla de conteo.
function muestrearRotativo() {
  if (!agencyActual) { notify("Primero selecciona la agencia.", { type: "warn" }); return; }
  if (!esRotativo()) { notify("Este paso es solo para inventario rotativo.", { type: "warn" }); return; }
  if (!puedeEditar()) { notify("Tu rol no permite cargar inventario de refacciones.", { type: "warn" }); return; }
  if (candadoBloquea("generar una muestra nueva")) return;
  if (!existencias.length) {
    setRotativoStatus("Primero carga el archivo de existencias (CSV).", "error");
    notify("Carga el archivo de existencias antes de muestrear.", { type: "warn" });
    return;
  }
  const cantEl = document.getElementById("ref-rotativo-cant");
  const n = Number((cantEl?.value || "").trim());
  // Candidatos: partes con número y existencia > 0 (las que tiene sentido auditar).
  let candidatos = existencias.filter(e => e.numParte && Number(e.existencia) > 0);
  if (!candidatos.length) {
    setRotativoStatus("No hay partes con existencia (>0) para muestrear en el archivo cargado.", "error");
    return;
  }
  if (!Number.isFinite(n) || n < 1) {
    setRotativoStatus("Indica cuántos números de parte vas a auditar (1 o más).", "error");
    cantEl?.focus();
    return;
  }

  // Evitar repetir partes ya auditadas en rotativos anteriores (si está marcado).
  const evitar = document.getElementById("ref-rotativo-evitar")?.checked;
  let excluidas = 0;
  if (evitar) {
    const yaAuditadas = partesAuditadasAntes(ag());
    if (yaAuditadas.size) {
      const frescas = candidatos.filter(e => !yaAuditadas.has(e.numParte));
      excluidas = candidatos.length - frescas.length;
      // Si al excluir no alcanzan para lo pedido, avisamos y usamos las que haya;
      // si queda vacío, caemos a permitir repetidas para no bloquear.
      if (frescas.length >= Math.min(n, 1)) candidatos = frescas;
      else if (frescas.length) candidatos = frescas;
      // (si frescas está vacío, se conserva `candidatos` completo)
    }
  }

  const total = candidatos.length;
  const pedir = Math.min(n, total);
  if (n > total && !confirm(`Pediste ${n} pero solo hay ${total} partes disponibles${excluidas ? ` (se excluyeron ${excluidas} ya auditadas antes)` : ""}. ¿Auditar las ${total}?`)) return;

  const muestra = muestraAlAzar(candidatos, pedir);
  const by = auth.currentUser()?.name || "—";
  // Sello de SESIÓN de la muestra: el flujo rotativo (conteo, diferencias,
  // resultado) opera SOLO sobre las partes con este sello, pero el inventario
  // COMPLETO (todas las existencias) se conserva para calcular su valor total.
  const sesion = "rot-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const enMuestra = new Set(muestra.map(e => e.numParte));

  // Guardamos TODO el inventario cargado (las 666), NO solo la muestra. Las
  // partes elegidas llevan el sello `rotativoSesion`; las demás quedan con sello
  // vacío. Así el "inventario completo" sigue existiendo (para su valor total) y
  // el rotativo audita solo las selladas. Antes se borraba todo lo no muestreado
  // (clearParts), por eso el valor del inventario completo salía con ~22 partes.
  const toSave = existencias
    .filter(e => e.numParte)
    .map(e => {
      const sel = enMuestra.has(e.numParte);
      return {
        numParte: e.numParte,
        descripcion: e.descripcion || "",
        ubicacion: e.ubicacion || "",
        grupo: e.grupo || "",
        marbete: "",
        existencia: e.existencia,
        precioUnit: e.precioUnit ?? null,
        clasificacion: e.clasificacion || "",
        enMarbetes: false,
        enExistencias: true,
        origin: sel ? "rotativo" : "existencias",
        rotativoSesion: sel ? sesion : "",
        // Las partes de la muestra arrancan su conteo en cero; las demás no se
        // cuentan (no son parte de la auditoría rotativa).
        conteo: null, conteos: {}, conteoRonda: null, conteoBy: null, conteoAt: null,
        exhibicion: null, exhibiciones: {},
      };
    });

  // Reemplazamos el inventario de la agencia por el recién cargado (merge:false
  // refresca precios/existencia/ubicación del archivo nuevo), conservando TODAS
  // las partes y marcando la muestra.
  store.clearParts(ag());
  store.bulkUpsertParts(ag(), toSave, { merge: false });
  store.setPartsAudit(ag(), { tipo: "rotativo", rondas: 1, rondaActual: 1, cantidadRotativo: pedir, rotativoSesion: sesion });
  logAction("parts.rotativo.sample", `Muestreo rotativo (${ag()}): ${pedir} de ${total} partes al azar${excluidas ? ` (${excluidas} ya auditadas excluidas)` : ""} · inventario completo ${toSave.length} partes`, by);
  try { pushParts(ag(), toSave); pushPartsAudit(ag()); } catch (e) {}
  const nota = excluidas ? ` Se excluyeron ${excluidas} ya auditadas antes.` : "";
  setRotativoStatus(`Muestra creada: ${pedir} número(s) de parte al azar de ${total}.${nota} Imprime la plantilla de conteo.`, "ok");
  notify(`Muestra rotativa creada: ${pedir} partes.`, { type: "success", timeout: 6000 });
  // Limpia buffers de carga (ya quedó en el store).
  existencias = []; marbetes = []; lastCruce = null;
  renderRefacciones();
}

// Rotativo MANUAL: el auditor pega/escribe los números de parte a auditar. Se
// cruzan con las existencias cargadas para traer descripción/ubicación/existencia.
// Si algún número ya se auditó en un rotativo anterior, se avisa (con fecha) pero
// se permite continuar.
function cargarRotativoManual() {
  if (!agencyActual) { notify("Primero selecciona la agencia.", { type: "warn" }); return; }
  if (!esRotativo()) { notify("Este paso es solo para inventario rotativo.", { type: "warn" }); return; }
  if (!puedeEditar()) { notify("Tu rol no permite cargar inventario de refacciones.", { type: "warn" }); return; }
  if (candadoBloquea("cargar otra muestra")) return;
  if (!existencias.length) {
    setRotativoStatus("Primero carga el archivo de existencias (CSV) para traer descripción y existencia.", "error");
    notify("Carga el archivo de existencias antes de agregar las partes.", { type: "warn" });
    return;
  }
  const txt = (document.getElementById("ref-rotativo-lista")?.value || "").trim();
  if (!txt) { setRotativoStatus("Escribe o pega al menos un número de parte.", "error"); return; }
  // Separar por saltos de línea, comas o punto y coma; limpiar y deduplicar.
  const pedidos = [...new Set(txt.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean))];
  if (!pedidos.length) { setRotativoStatus("No se reconoció ningún número de parte.", "error"); return; }

  // Índice de existencias por numParte (normalizado laxo para tolerar formato).
  const normKey = (s) => String(s || "").toUpperCase().replace(/[\s\-.]/g, "");
  const exIdx = new Map();
  for (const e of existencias) if (e.numParte) exIdx.set(normKey(e.numParte), e);

  const by = auth.currentUser()?.name || "—";
  const yaAuditadas = partesAuditadasAntes(ag());
  // Sello de sesión (igual que el muestreo al azar) para poder continuar el
  // rotativo manual en otro dispositivo.
  const sesion = "rot-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  // Números de parte elegidos (normalizados) que SÍ están en existencias.
  const elegidos = new Set();
  const noEncontradas = [];
  const repetidas = [];
  for (const np of pedidos) {
    const e = exIdx.get(normKey(np));
    if (!e) { noEncontradas.push(np); continue; }
    if (yaAuditadas.has(e.numParte)) {
      const f = yaAuditadas.get(e.numParte);
      repetidas.push(`${e.numParte}${f ? ` (${new Date(f).toLocaleDateString("es-MX")})` : ""}`);
    }
    elegidos.add(e.numParte);
  }
  if (!elegidos.size) {
    setRotativoStatus(`Ninguno de los ${pedidos.length} número(s) está en las existencias cargadas.`, "error");
    return;
  }
  // Aviso de repetidas (permite continuar).
  if (repetidas.length) {
    const lista = repetidas.slice(0, 10).join(", ") + (repetidas.length > 10 ? `, …(+${repetidas.length - 10})` : "");
    if (!confirm(`Aviso: ${repetidas.length} número(s) de parte ya se auditaron en inventarios anteriores:\n\n${lista}\n\n¿Continuar de todos modos?`)) return;
  }

  // Guardamos TODO el inventario cargado y marcamos con el sello SOLO las partes
  // elegidas. Igual que en el muestreo al azar: el inventario completo se
  // conserva (para su valor total) y el rotativo audita solo las selladas.
  const toSave = existencias
    .filter(e => e.numParte)
    .map(e => {
      const sel = elegidos.has(e.numParte);
      return {
        numParte: e.numParte, descripcion: e.descripcion || "", ubicacion: e.ubicacion || "",
        grupo: e.grupo || "", marbete: "", existencia: e.existencia,
        precioUnit: e.precioUnit ?? null, clasificacion: e.clasificacion || "",
        enMarbetes: false, enExistencias: true,
        origin: sel ? "rotativo-manual" : "existencias",
        rotativoSesion: sel ? sesion : "",
        conteo: null, conteos: {}, conteoRonda: null, conteoBy: null, conteoAt: null,
        exhibicion: null, exhibiciones: {},
      };
    });

  store.clearParts(ag());
  store.bulkUpsertParts(ag(), toSave, { merge: false });
  store.setPartsAudit(ag(), { tipo: "rotativo", rondas: 1, rondaActual: 1, cantidadRotativo: elegidos.size, modoMuestreo: "manual", rotativoSesion: sesion });
  logAction("parts.rotativo.manual", `Rotativo manual (${ag()}): ${elegidos.size} partes${repetidas.length ? ` · ${repetidas.length} repetidas` : ""}${noEncontradas.length ? ` · ${noEncontradas.length} no encontradas` : ""} · inventario completo ${toSave.length} partes`, by);
  try { pushParts(ag(), toSave); pushPartsAudit(ag()); } catch (e) {}
  let msg = `Cargadas ${elegidos.size} parte(s) a auditar.`;
  if (noEncontradas.length) msg += ` ${noEncontradas.length} no estaban en existencias (omitidas).`;
  if (repetidas.length) msg += ` ${repetidas.length} ya auditadas antes.`;
  setRotativoStatus(msg + " Imprime la plantilla de conteo.", "ok");
  notify(`Rotativo manual: ${toSave.length} partes cargadas.`, { type: "success", timeout: 6000 });
  existencias = []; marbetes = []; lastCruce = null;
  renderRefacciones();
}

function setRotativoStatus(msg, kind) { setStatusEl("ref-rotativo-status", msg, kind); }

// Imprime la PLANTILLA DE CONTEO del rotativo: lista de las partes muestreadas,
// ordenada por ubicación, con una columna en blanco para anotar a mano la
// cantidad contada. La existencia del sistema NO se muestra (para no sesgar el
// conteo físico).
function imprimirPlantillaConteo() {
  const lista = partesActuales()
    .filter(p => p.numParte)
    .sort((a, b) => String(a.ubicacion || "~").localeCompare(String(b.ubicacion || "~"), "es"));
  if (!lista.length) { notify("No hay partes muestreadas. Primero genera la muestra rotativa.", { type: "warn" }); return; }
  const by = auth.currentUser()?.name || "—";
  const fecha = new Date().toLocaleString("es-MX");
  const filas = lista.map((p, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${esc(p.numParte)}</td>
      <td>${esc((p.descripcion || "").slice(0, 55))}</td>
      <td>${esc(p.ubicacion || "")}</td>
      <td class="anota">&nbsp;</td>
    </tr>`).join("");

  const win = window.open("", "_blank", "width=900,height=1000");
  if (!win) { notify("El navegador bloqueó la ventana. Permite ventanas emergentes.", { type: "warn" }); return; }
  win.document.write(`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
    <title>Plantilla de conteo — Rotativo</title>
    <style>
      *{box-sizing:border-box} body{font-family:system-ui,Arial,sans-serif;margin:24px;color:#111}
      h1{font-size:18px;margin:0 0 4px} .meta{color:#555;font-size:12px;margin-bottom:12px}
      table{width:100%;border-collapse:collapse;font-size:12px}
      th,td{border:1px solid #ccc;padding:5px 7px;text-align:left}
      th{background:#0f204a;color:#fff}
      tr:nth-child(even){background:#f6f8fc}
      .anota{width:90px;background:#fff}
      .barra{margin-bottom:12px}
      .barra button{padding:8px 16px;font-size:14px;border:0;border-radius:6px;background:#0f204a;color:#fff;cursor:pointer}
      @media print{.barra{display:none}}
    </style></head><body>
    <div class="barra"><button onclick="window.print()">🖨️ Imprimir / Guardar PDF</button></div>
    <h1>Plantilla de conteo (rotativo) — ${esc(ag())}</h1>
    <div class="meta">Generada: ${esc(fecha)} · Por: ${esc(by)} · ${lista.length} número(s) de parte a auditar</div>
    <table><thead><tr>
      <th>#</th><th>No. parte</th><th>Descripción</th><th>Ubicación</th><th>Conteo físico</th>
    </tr></thead><tbody>${filas}</tbody></table>
    </body></html>`);
  win.document.close();
  logAction("parts.rotativo.plantilla", `Plantilla de conteo impresa (${ag()}, ${lista.length} partes)`, by);
}

function confirmarCarga() {
  if (!lastCruce) return;
  if (!agencyActual) { notify("Primero selecciona la agencia en el asistente.", { type: "warn" }); return; }
  if (!puedeEditar()) {
    notify("Tu rol no permite cargar inventario de refacciones.", { type: "warn" });
    return;
  }
  if (candadoBloquea("cargar otro inventario")) return;
  const by = auth.currentUser()?.name || "—";

  // Unimos los items del cruce (marbetes) + las partes solo-existencia en una
  // sola lista para guardar. Se mantiene el conteo previo si ya existía (merge).
  const toSave = [];
  for (const it of lastCruce.items) {
    if (it.enBlanco) continue;              // marbetes en blanco no son partes reales
    if (!it.numParte) continue;
    toSave.push({
      numParte: it.numParte,
      descripcion: it.descripcion || "",
      ubicacion: it.ubicacion || "",
      ubicRecuperada: !!it.ubicRecuperada,
      grupo: it.grupo || "",
      marbete: it.marbete || "",
      existencia: it.existencia,
      precioUnit: it.precioUnit ?? null,
      clasificacion: it.clasificacion || "",
      enMarbetes: true,
      enExistencias: it.enExistencias,
      origin: "cruce",
    });
  }
  for (const it of lastCruce.soloExistencia) {
    toSave.push({
      numParte: it.numParte,
      descripcion: it.descripcion || "",
      ubicacion: it.ubicacion || "",
      ubicRecuperada: !!it.ubicRecuperada,
      grupo: it.grupo || "",
      marbete: "",
      existencia: it.existencia,
      precioUnit: it.precioUnit ?? null,
      clasificacion: it.clasificacion || "",
      enMarbetes: false,
      enExistencias: true,
      origin: "existencias",
    });
  }

  const res = store.bulkUpsertParts(ag(), toSave, { merge: true });
  logAction("parts.load", `Refacciones cargadas (${ag()}): ${res.added} nuevas · ${res.updated} actualizadas`, by);
  // SINCRONIZACIÓN: sube el lote de refacciones al servidor (o encola si no hay red).
  try { pushParts(ag(), toSave); } catch (e) {}
  notify(`Inventario de refacciones cargado: ${res.added} nuevas, ${res.updated} actualizadas.`,
    { type: "success", timeout: 6000 });

  // Limpia los buffers de archivos (ya quedaron en el store), conserva la vista.
  existencias = []; marbetes = []; lastCruce = null;
  const btnConfirmar = document.getElementById("ref-confirmar");
  if (btnConfirmar) btnConfirmar.hidden = true;
  renderCargaResumen();
  renderConteo();
  renderDiferencias();
}

function limpiarCarga() {
  existencias = []; marbetes = []; lastCruce = null;
  const prev = document.getElementById("ref-cruce-preview");
  if (prev) prev.innerHTML = "";
  const btnConfirmar = document.getElementById("ref-confirmar");
  if (btnConfirmar) btnConfirmar.hidden = true;
  setCargaStatus("", "info");
  renderCargaResumen();
}

function renderCargaResumen() {
  const el = document.getElementById("ref-carga-resumen");
  if (!el) return;
  const enStore = store.listParts(ag()).length;
  el.innerHTML = `
    <div class="stat"><b>${existencias.length}</b><span>Existencias cargadas</span></div>
    <div class="stat"><b>${marbetes.filter(m => !m.enBlanco).length}</b><span>Marbetes leídos</span></div>
    <div class="stat"><b style="color:var(--primary)">${enStore}</b><span>Partes en inventario</span></div>`;
}

function renderCrucePreview(c) {
  const el = document.getElementById("ref-cruce-preview");
  if (!el) return;
  const r = c.resumen;
  const PAGE = 60;

  const filas = c.items.slice(0, PAGE).map((it, i) => {
    const estado = it.enBlanco
      ? `<span style="color:#b45309">Marbete en blanco</span>`
      : (it.enExistencias
          ? `<span style="color:#065f46">✓ Con existencia</span>`
          : `<span style="color:var(--danger)">Solo marbete</span>`);
    const ubicCell = it.ubicRecuperada
      ? `<code title="Ubicación con posible error de exportación (Excel); verifícala en el sistema" style="color:#b45309">${escapeHtml(it.ubicacion || "")} ⚠</code>`
      : `<code>${escapeHtml(it.ubicacion || "")}</code>`;
    return `<tr>
      <td>${i + 1}</td>
      <td><code>${escapeHtml(it.numParte || "—")}</code></td>
      <td><code>${escapeHtml(it.marbete || "")}</code></td>
      <td>${escapeHtml((it.descripcion || "").slice(0, 50))}</td>
      <td>${ubicCell}</td>
      <td style="text-align:right">${it.existencia == null ? "—" : escapeHtml(String(it.existencia))}</td>
      <td>${estado}</td>
    </tr>`;
  }).join("");
  const more = c.items.length > PAGE
    ? `<tr><td colspan="7" class="muted">… y ${c.items.length - PAGE} más (todas se cargarán al confirmar).</td></tr>`
    : "";

  const soloExist = c.soloExistencia.length
    ? `<p class="hint" style="color:#b45309">⚠️ ${c.soloExistencia.length} parte(s) en existencias <b>sin marbete</b> (se cargarán, pero no tendrán etiqueta ni renglón de conteo físico).</p>`
    : "";

  // Aviso de ubicaciones reconstruidas (errores de Excel al exportar).
  const nRecup = [...c.items, ...c.soloExistencia].filter(it => it.ubicRecuperada).length;
  const avisoUbic = nRecup
    ? `<p class="hint" style="color:#b45309">⚠️ ${nRecup} ubicación(es) vienen con un posible <b>error de exportación</b> (notación científica, p. ej. 2.04E+303). Se dejan <b>tal cual</b> del archivo y se marcan con ⚠ para que las <b>verifiques en el sistema</b>. (En inventario completo, el marbete corrige la ubicación automáticamente cuando la trae.)</p>`
    : "";

  el.innerHTML = `
    <h3>Vista previa del cruce</h3>
    <div class="summary">
      <div class="stat"><b>${r.totalMarbetes}</b><span>Marbetes</span></div>
      <div class="stat"><b>${r.totalExistencias}</b><span>Existencias</span></div>
      <div class="stat"><b style="color:#065f46">${r.conAmbos}</b><span>Con ambos</span></div>
      <div class="stat"><b style="color:var(--danger)">${r.soloMarbete}</b><span>Solo marbete</span></div>
      <div class="stat"><b style="color:#b45309">${r.soloExistencia}</b><span>Solo existencia</span></div>
      ${r.enBlanco ? `<div class="stat"><b>${r.enBlanco}</b><span>En blanco</span></div>` : ""}
    </div>
    ${soloExist}
    ${avisoUbic}
    <div class="table-wrap" style="max-height:340px;overflow:auto">
      <table class="table"><thead><tr>
        <th>#</th><th>No. parte</th><th>Marbete</th><th>Descripción</th><th>Ubicación</th><th>Existencia</th><th>Estado</th>
      </tr></thead><tbody>${filas}${more}</tbody></table>
    </div>`;
}

// ======================= ETIQUETAS PARA ANAQUELES =======================
// Imprime etiquetas QR directamente desde el archivo de existencias, SIN iniciar
// un inventario ni guardar nada en el store. Buffer propio (no toca `existencias`
// del flujo de inventario).
let etqAnaqueles = [];

async function cargarExistenciasSoloEtiquetas(file) {
  setStatusEl("ref-solo-etq-status", "Leyendo archivo de existencias…", "info");
  try {
    const text = await readTextFile(file);
    etqAnaqueles = parseExistenciasCsv(text);
    const n = etqAnaqueles.length;
    setStatusEl("ref-solo-etq-status",
      n ? `✓ ${n} partes leídas de «${file.name}». Ajusta los márgenes si hace falta e imprime.`
        : "El archivo no contiene partes reconocibles.", n ? "ok" : "error");
    const hay = n > 0;
    const b1 = document.getElementById("ref-solo-etq-print");
    const b2 = document.getElementById("ref-solo-etq-prueba");
    if (b1) b1.disabled = !hay;
    if (b2) b2.disabled = !hay;
  } catch (e) {
    etqAnaqueles = [];
    setStatusEl("ref-solo-etq-status", "No se pudo leer el archivo: " + (e.message || e), "error");
  }
}

async function imprimirEtiquetasAnaqueles(prueba = false) {
  if (!etqAnaqueles.length) { notify("Primero sube el archivo de existencias.", { type: "warn" }); return; }
  const soloConExist = document.getElementById("ref-solo-etq-conexist")?.checked;
  // Filtra, quita duplicados exactos (misma parte + misma ubicación) y ordena por
  // ubicación para pegar las etiquetas recorriendo el almacén en orden.
  const vistos = new Set();
  const lista = [];
  for (const e of etqAnaqueles) {
    if (!e.numParte) continue;
    if (soloConExist && !(Number(e.existencia) > 0)) continue;
    const k = `${e.numParte}|${e.ubicacion || ""}`;
    if (vistos.has(k)) continue;
    vistos.add(k);
    lista.push(e);
  }
  if (!lista.length) { notify("No hay partes que cumplan el filtro para imprimir.", { type: "warn" }); return; }
  lista.sort((a, b) => String(a.ubicacion || "~").localeCompare(String(b.ubicacion || "~"), "es"));
  try {
    await printPartLabels(lista, {
      prueba,
      mostrarUbic: true,
      margenSup: numVal("ref-solo-etq-sup", 12),
      margenIzq: numVal("ref-solo-etq-izq", 6),
      sepH: numVal("ref-solo-etq-seph", 2),
      sepV: numVal("ref-solo-etq-sepv", 2),
    });
    if (!prueba) logAction("parts.labels.shelf", `Etiquetas para anaqueles impresas (${lista.length} partes)`, auth.currentUser()?.name || "—");
  } catch (e) {
    notify(e.message || String(e), { type: "error" });
  }
}

// ---- Etiquetas SUELTAS escritas a mano (refacciones nuevas sin archivo) ----
let etqManuales = [];   // [{ numParte, descripcion, ubicacion }]

function renderEtiquetasManuales() {
  const wrap = document.getElementById("ref-manual-wrap");
  const tbody = document.querySelector("#ref-manual-table tbody");
  const btnPrint = document.getElementById("ref-manual-print");
  const btnClear = document.getElementById("ref-manual-clear");
  if (wrap) wrap.hidden = etqManuales.length === 0;
  if (tbody) {
    tbody.innerHTML = etqManuales.map((p, i) => `<tr>
      <td><code>${escapeHtml(p.numParte)}</code></td>
      <td>${escapeHtml(p.descripcion || "")}</td>
      <td><code>${escapeHtml(p.ubicacion || "")}</code></td>
      <td style="text-align:right"><b>${p.cantidad || 1}</b></td>
      <td style="text-align:right"><button class="btn btn-ghost ref-manual-del" data-i="${i}" style="padding:2px 8px">✕</button></td>
    </tr>`).join("");
    tbody.querySelectorAll(".ref-manual-del").forEach(b =>
      b.addEventListener("click", () => { etqManuales.splice(Number(b.dataset.i), 1); renderEtiquetasManuales(); }));
  }
  // Total de etiquetas = suma de cantidades (cada refacción puede repetirse).
  const totalEtq = etqManuales.reduce((s, p) => s + (Number(p.cantidad) || 1), 0);
  if (btnPrint) {
    btnPrint.disabled = etqManuales.length === 0;
    btnPrint.textContent = totalEtq ? `🖨️ Imprimir ${totalEtq} etiqueta(s)` : "🖨️ Imprimir etiqueta(s)";
  }
  if (btnClear) btnClear.disabled = etqManuales.length === 0;
}

function agregarEtiquetaManual() {
  const pEl = document.getElementById("ref-manual-parte");
  const dEl = document.getElementById("ref-manual-desc");
  const uEl = document.getElementById("ref-manual-ubic");
  const cEl = document.getElementById("ref-manual-cant");
  const numParte = (pEl?.value || "").trim();
  const descripcion = (dEl?.value || "").trim();
  const ubicacion = (uEl?.value || "").trim();
  let cantidad = Math.floor(Number(cEl?.value));
  if (!Number.isFinite(cantidad) || cantidad < 1) cantidad = 1;
  if (!numParte) { setStatusEl("ref-manual-status", "Escribe al menos el número de parte.", "error"); pEl?.focus(); return; }
  // Si el número de parte ya está, SUMA la cantidad en vez de duplicar la fila.
  const existente = etqManuales.find(x => x.numParte.toUpperCase() === numParte.toUpperCase());
  if (existente) {
    existente.cantidad = (Number(existente.cantidad) || 1) + cantidad;
    if (descripcion) existente.descripcion = descripcion;
    if (ubicacion) existente.ubicacion = ubicacion;
    setStatusEl("ref-manual-status", `${numParte} ya estaba; ahora son ${existente.cantidad} etiqueta(s).`, "ok");
  } else {
    etqManuales.push({ numParte, descripcion, ubicacion, cantidad });
    setStatusEl("ref-manual-status", `✓ Agregada ${numParte} (${cantidad} etiqueta(s)). Sigue agregando o imprime.`, "ok");
  }
  if (pEl) pEl.value = ""; if (dEl) dEl.value = ""; if (uEl) uEl.value = ""; if (cEl) cEl.value = "1";
  if (pEl) pEl.focus();
  renderEtiquetasManuales();
}

function vaciarEtiquetasManuales() {
  etqManuales = [];
  setStatusEl("ref-manual-status", "", "info");
  renderEtiquetasManuales();
}

async function imprimirEtiquetasManuales() {
  if (!etqManuales.length) { notify("Agrega al menos una refacción a la lista.", { type: "warn" }); return; }
  // Expande cada refacción en N copias según su cantidad.
  const lista = [];
  for (const p of etqManuales) {
    const n = Math.max(1, Math.floor(Number(p.cantidad) || 1));
    for (let i = 0; i < n; i++) lista.push({ numParte: p.numParte, descripcion: p.descripcion, ubicacion: p.ubicacion });
  }
  try {
    await printPartLabels(lista, {
      mostrarUbic: true,
      margenSup: numVal("ref-solo-etq-sup", 12),
      margenIzq: numVal("ref-solo-etq-izq", 6),
      sepH: numVal("ref-solo-etq-seph", 2),
      sepV: numVal("ref-solo-etq-sepv", 2),
    });
    logAction("parts.labels.manual", `Etiqueta(s) suelta(s) impresa(s): ${lista.length} de ${etqManuales.length} refacción(es)`, auth.currentUser()?.name || "—");
  } catch (e) {
    notify(e.message || String(e), { type: "error" });
  }
}

function numVal(id, def) {
  const el = document.getElementById(id);
  if (!el) return def;
  const n = Number(el.value);
  return Number.isFinite(n) ? n : def;
}

// ======================= CONTEO FÍSICO =======================

async function startScan() {
  if (!scanner) return;
  desbloquearAudio();   // el clic en «Escanear QR» desbloquea el beep en móvil
  try {
    await scanner.start();
    scanner.resume();   // arranca escuchando (por si quedó en pausa de una sesión previa)
    document.getElementById("ref-scanner-wrap").hidden = false;
    document.getElementById("ref-scan").hidden = true;
    document.getElementById("ref-scan-stop").hidden = false;
  } catch (e) { /* el scanner ya avisa */ }
}
function stopScan() {
  if (scanner) scanner.stop();
  const wrap = document.getElementById("ref-scanner-wrap");
  if (wrap) wrap.hidden = true;
  const b1 = document.getElementById("ref-scan");
  const b2 = document.getElementById("ref-scan-stop");
  if (b1) b1.hidden = false;
  if (b2) b2.hidden = true;
}

// Al escanear un QR de parte: PAUSA el escáner (para que no siga leyendo y pise
// la captura), rellena el número de parte y enfoca la cantidad. El escáner se
// reanuda al registrar (o al cancelar). Esto hace el escaneo tipo "pistola":
// escanear → teclear cantidad → Registrar → siguiente, sin pisarse.
function handleScan(text) {
  // Si ya hay una parte escaneada esperando su cantidad, ignora nuevas lecturas
  // (el escáner ya debería estar en pausa; esto es un seguro extra).
  const inp = document.getElementById("ref-conteo-parte");
  const cant = document.getElementById("ref-conteo-cant");
  const p = parsePartQr(text);
  if (!p || !p.numParte) { setScanStatus("Código no reconocido.", "error"); beep("error"); return; }

  if (scanner) scanner.pause();   // congela lecturas hasta registrar/cancelar
  if (inp) inp.value = p.numParte;
  const existente = store.getPart(ag(), p.numParte);
  // En rotativo, "cuenta" solo si la parte es de la MUESTRA (lleva el sello).
  const sello = (store.getPartsAudit(ag()) || {}).rotativoSesion;
  const enMuestra = !esRotativo() || (existente && sello && existente.rotativoSesion === sello);
  if (existente && enMuestra) {
    beep("ok");  // ÉXITO: la parte está en el inventario (y en la muestra si rotativo)
    setScanStatus(`✓ ${p.numParte} — ${existente.descripcion || p.descripcion || ""}. Teclea la cantidad y pulsa Registrar (o Enter).`, "ok");
  } else if (existente && esRotativo()) {
    beep("warn");  // existe en el inventario pero NO es de la muestra rotativa
    setScanStatus(`⚠️ ${p.numParte} no está en la muestra de este rotativo. No se contará.`, "warn");
  } else {
    beep("warn");  // AVISO: la parte NO está en el inventario
    setScanStatus(`⚠️ ${p.numParte} no está en el inventario. Teclea la cantidad y Registrar para contarla igual.`, "warn");
  }
  if (cant) { cant.value = ""; cant.focus(); }
}

// Reanuda el escáner para leer la SIGUIENTE parte (tras registrar o cancelar).
function reanudarScan() {
  if (scanner && scanner.running) scanner.resume();
}

function registrarConteoManual() {
  const inp = document.getElementById("ref-conteo-parte");
  const cantEl = document.getElementById("ref-conteo-cant");
  const numParte = (inp?.value || "").trim();
  if (!numParte) { beep("error"); notify("Escanea o escribe el número de parte.", { type: "warn" }); inp?.focus(); return; }
  const cantRaw = (cantEl?.value || "").trim();
  if (cantRaw === "") { beep("error"); notify("Teclea la cantidad contada.", { type: "warn" }); cantEl?.focus(); return; }
  const conteo = Number(cantRaw);
  if (!Number.isFinite(conteo) || conteo < 0) { beep("error"); notify("La cantidad debe ser un número válido (0 o más).", { type: "warn" }); cantEl?.focus(); return; }

  if (!puedeContar()) { notify("Tu rol no permite registrar conteos de refacciones.", { type: "warn" }); return; }

  const by = auth.currentUser()?.name || "—";
  const { rondaActual } = rondaInfo();
  let p = store.getPart(ag(), numParte);

  // En ROTATIVO el inventario del store contiene TODAS las partes (p. ej. 666),
  // pero solo se auditan las de la MUESTRA (las que llevan el sello activo). Si
  // la parte existe pero NO es de la muestra, no se cuenta (evita inflar el
  // conteo del rotativo con partes del inventario completo).
  if (esRotativo()) {
    const sello = (store.getPartsAudit(ag()) || {}).rotativoSesion;
    if (!p || !sello || p.rotativoSesion !== sello) {
      beep("warn");
      setScanStatus(`⚠️ ${numParte} no está en la muestra de este inventario rotativo. No se registra.`, "warn");
      if (inp) inp.value = "";
      if (cantEl) cantEl.value = "";
      reanudarScan();
      if (!(scanner && scanner.running) && inp) inp.focus();
      return;
    }
  }

  // AVISO: si esta parte YA fue contada en la ronda ACTUAL, confirmar antes de
  // reemplazar el valor (opción A). En las rondas ≥2 recontar es lo esperado, así
  // que el aviso solo aplica a un re-registro dentro de la misma ronda.
  if (p) {
    const previo = (p.conteos || {})[String(rondaActual)];
    if (previo != null) {
      const ok = confirm(
        `La parte ${numParte} ya fue contada en el conteo ${rondaActual} (valor: ${previo}).\n\n` +
        `¿Reemplazar por el nuevo valor (${conteo})?`
      );
      if (!ok) {
        setScanStatus(`Sin cambios: ${numParte} conserva su conteo anterior (${previo}).`, "warn");
        if (inp) { inp.value = ""; }
        if (cantEl) cantEl.value = "";
        reanudarScan();                 // vuelve a escanear la siguiente
        if (scanner && scanner.running) {} else if (inp) inp.focus();
        return;
      }
    }
  } else {
    // En ROTATIVO solo se cuentan las partes muestreadas: no se dan de alta nuevas.
    if (esRotativo()) {
      beep("warn");
      setScanStatus(`⚠️ ${numParte} no está en la muestra de este inventario rotativo. No se registra.`, "warn");
      if (inp) { inp.value = ""; }
      if (cantEl) cantEl.value = "";
      reanudarScan();                   // vuelve a escanear la siguiente
      if (!(scanner && scanner.running) && inp) inp.focus();
      return;
    }
    // Completo: una parte contada que no estaba en el inventario cargado se da de alta.
    store.upsertPart(ag(), { numParte, descripcion: "", ubicacion: "", existencia: null, enMarbetes: false, enExistencias: false, origin: "conteo" });
  }
  p = store.setPartConteo(ag(), numParte, conteo, by, rondaActual);
  logAction("parts.count", `Conteo ${rondaActual} de ${numParte} (${ag()}): ${conteo}`, by);
  // SINCRONIZACIÓN: sube el conteo al servidor (o encola si no hay internet).
  try { pushPartConteo(ag(), numParte, conteo); } catch (e) {}
  beep(true);
  if (inp) inp.value = "";
  if (cantEl) cantEl.value = "";
  // ESCANEO CONTINUO tipo "pistola": si la cámara está activa, se REANUDA para
  // leer la siguiente parte (durante el conteo estuvo en pausa para no pisarse).
  if (scanner && scanner.running) {
    reanudarScan();
    setScanStatus(`✓ Contada ${numParte}: ${conteo}. Escanea la SIGUIENTE parte…`, "ok");
  } else {
    setScanStatus(`✓ Contada ${numParte}: ${conteo} (conteo ${rondaActual}).`, "ok");
    if (inp) inp.focus();
  }
  renderConteo();
  renderDiferencias();
  renderFinal();
}

function reiniciarConteo() {
  // Acción sensible: requiere permiso de edición (no solo contar) para evitar
  // que un operador borre los conteos por error.
  if (!puedeEditar()) {
    notify("Solo quien puede EDITAR refacciones (admin/refacciones) puede reiniciar el conteo.", { type: "warn" });
    return;
  }
  const partes = store.listParts(ag()).filter(p => p.conteo != null || (p.conteos && Object.keys(p.conteos).length));
  if (!partes.length) { notify("No hay conteos registrados.", { type: "info" }); return; }
  // Confirmación reforzada: escribir la palabra para evitar ejecuciones por error.
  const resp = (prompt(`Vas a BORRAR todos los conteos (todas las rondas) de ${partes.length} parte(s) en "${ag()}".\nEl inventario cargado (existencias) se conserva.\n\nEscribe BORRAR para confirmar:`, "") || "").trim().toUpperCase();
  if (resp !== "BORRAR") { if (resp !== "") notify("Cancelado: no se escribió BORRAR.", { type: "info" }); return; }
  const by = auth.currentUser()?.name || "—";
  for (const p of partes) {
    store.upsertPart(ag(), { numParte: p.numParte, conteo: null, conteos: {}, conteoRonda: null, conteoBy: null, conteoAt: null });
  }
  // Reiniciar la ronda a 1 (conserva el nº de rondas configurado).
  const a = store.getPartsAudit(ag()) || {};
  store.setPartsAudit(ag(), { rondas: a.rondas || 1, rondaActual: 1 });
  try { pushPartsAudit(ag()); } catch (e) {}
  logAction("parts.count.reset", `Conteo reiniciado (${partes.length} partes)`, by);
  notify("Conteo físico reiniciado (vuelve al conteo 1).", { type: "success" });
  renderRondas();
  renderConteo();
  renderDiferencias();
}

function renderConteo() {
  const el = document.getElementById("ref-conteo-resumen");
  if (!el) return;
  const all = partesActuales();
  const { rondaActual } = rondaInfo();
  // Contadas EN ESTA RONDA y pendientes de contar EN ESTA RONDA.
  const contadas = all.filter(p => (p.conteos || {})[String(rondaActual)] != null).length;
  const pendientes = all.filter(p => pendienteEnRonda(p, rondaActual)).length;
  el.innerHTML = `
    <div class="stat"><b>${all.length}</b><span>Partes en inventario</span></div>
    <div class="stat"><b style="color:var(--primary)">${contadas}</b><span>Contadas (conteo ${rondaActual})</span></div>
    <div class="stat"><b style="color:#b45309">${pendientes}</b><span>Pendientes (conteo ${rondaActual})</span></div>`;

  // Barra de progreso en vivo: contadas / (contadas + pendientes) de ESTA ronda.
  const wrap = document.getElementById("ref-progress-wrap");
  const totalRonda = contadas + pendientes;
  if (wrap) {
    if (totalRonda > 0) {
      const pct = Math.round((contadas / totalRonda) * 100);
      wrap.hidden = false;
      const fill = document.getElementById("ref-progress-fill");
      const label = document.getElementById("ref-progress-label");
      const pctEl = document.getElementById("ref-progress-pct");
      if (fill) { fill.style.width = pct + "%"; fill.style.background = pct >= 100 ? "#059669" : "var(--primary)"; }
      if (label) label.textContent = `Conteo ${rondaActual}: ${contadas} de ${totalRonda} · faltan ${pendientes}`;
      if (pctEl) { pctEl.textContent = pct + "%"; pctEl.style.color = pct >= 100 ? "#059669" : "var(--primary)"; }
    } else {
      wrap.hidden = true;  // aún no hay inventario cargado para esta ronda
    }
  }

  // Tabla de las últimas contadas (orden por fecha de conteo descendente).
  const tbody = document.querySelector("#ref-conteo-table tbody");
  if (tbody) {
    const recientes = all.filter(p => p.conteo != null)
      .sort((a, b) => String(b.conteoAt || "").localeCompare(String(a.conteoAt || "")))
      .slice(0, 50);
    tbody.innerHTML = recientes.map(p => {
      const dif = diffValor(p);
      return `<tr>
        <td><code>${escapeHtml(p.numParte)}</code></td>
        <td><code>${escapeHtml(p.marbete || "")}</code></td>
        <td>${escapeHtml((p.descripcion || "").slice(0, 40))}</td>
        <td style="text-align:right">${p.existencia == null ? "—" : escapeHtml(String(p.existencia))}</td>
        <td style="text-align:right"><b>${escapeHtml(String(p.conteo))}</b></td>
        <td style="text-align:right">${difBadge(dif)}</td>
      </tr>`;
    }).join("");
  }

  renderPendientesUbicacion();
}

// Lista las partes PENDIENTES de contar en la ronda actual, AGRUPADAS por
// ubicación (rack), ordenadas alfabéticamente, para recorrer el almacén en orden.
let _pendColapsado = false;
function renderPendientesUbicacion() {
  const cont = document.getElementById("ref-pendientes-ubic");
  if (!cont) return;
  if (_pendColapsado) { cont.innerHTML = ""; return; }

  const { rondaActual } = rondaInfo();
  const pend = partesActuales().filter(p => pendienteEnRonda(p, rondaActual));
  if (!pend.length) {
    cont.innerHTML = `<p class="muted" style="margin:4px 0">✓ No hay partes pendientes en el conteo ${rondaActual}.</p>`;
    return;
  }

  // Agrupar por ubicación (las sin ubicación van al final en "Sin ubicación").
  const grupos = new Map();
  for (const p of pend) {
    const u = (p.ubicacion || "").trim() || "— Sin ubicación —";
    if (!grupos.has(u)) grupos.set(u, []);
    grupos.get(u).push(p);
  }
  const claves = [...grupos.keys()].sort((a, b) => {
    if (a.startsWith("—")) return 1;      // "Sin ubicación" al final
    if (b.startsWith("—")) return -1;
    return a.localeCompare(b, "es");
  });

  cont.innerHTML = claves.map(u => {
    const items = grupos.get(u);
    const filas = items.map(p => `<li><code>${escapeHtml(p.numParte)}</code> — ${escapeHtml((p.descripcion || "").slice(0, 45))}</li>`).join("");
    return `<details class="loc-card" style="margin:6px 0" open>
      <summary style="cursor:pointer;font-weight:700">${escapeHtml(u)} <span class="muted" style="font-weight:400">(${items.length})</span></summary>
      <ul style="margin:6px 0 0 18px;font-size:13px">${filas}</ul>
    </details>`;
  }).join("");
}

// ======================= DIFERENCIAS =======================

// Diferencia = (conteo físico + exhibición) − existencia del sistema.
// Opción A: las piezas en exhibición/puntos de venta SUMAN al conteo para que
// el total cuadre contra la existencia. null si falta algún dato.
function diffValor(p) {
  if (p.conteo == null || p.existencia == null) return null;
  const exhib = Number(p.exhibicion || 0);
  return (Number(p.conteo) + exhib) - Number(p.existencia);
}
function difBadge(dif) {
  if (dif == null) return `<span class="muted">—</span>`;
  if (dif === 0) return `<span style="color:#065f46">0</span>`;
  const signo = dif > 0 ? "+" : "";
  const color = dif > 0 ? "#b45309" : "var(--danger)";
  return `<b style="color:${color}">${signo}${dif}</b>`;
}

// Devuelve SOLO las partes con diferencia (conteo ≠ existencia) o sin dato para
// comparar (contada sin existencia, o con existencia pero sin contar).
function listaDiferencias() {
  const all = partesActuales();
  const out = [];
  for (const p of all) {
    const dif = diffValor(p);
    // Impacto económico de la diferencia: |dif| × precio unitario (si hay precio).
    const precio = p.precioUnit != null ? Number(p.precioUnit) : null;
    const impacto = (dif != null && dif !== 0 && precio != null) ? Math.abs(dif) * precio : null;
    if (dif != null) {
      if (dif !== 0) out.push({ ...p, dif, impacto, tipo: dif > 0 ? "sobrante" : "faltante" });
    } else {
      // Falta un dato para comparar: lo reportamos como pendiente/sin-dato.
      if (p.conteo != null && p.existencia == null) out.push({ ...p, dif: null, impacto: null, tipo: "sin-existencia" });
      else if (p.conteo == null && p.existencia != null && p.enMarbetes !== false) out.push({ ...p, dif: null, impacto: null, tipo: "sin-contar" });
    }
  }
  // Orden: faltantes primero, luego sobrantes, luego sin dato; dentro de cada
  // grupo por IMPACTO $ descendente (y por magnitud de unidades como desempate).
  const rank = { faltante: 0, sobrante: 1, "sin-existencia": 2, "sin-contar": 3 };
  out.sort((a, b) =>
    (rank[a.tipo] - rank[b.tipo]) ||
    ((b.impacto || 0) - (a.impacto || 0)) ||
    (Math.abs(b.dif || 0) - Math.abs(a.dif || 0)));
  return out;
}

// Lista TODAS las piezas registradas en EXHIBICIÓN / puntos de venta, una fila
// por (parte, punto), con su observación. Estas piezas SUMAN al conteo físico
// (Opción A), por eso deben quedar como EVIDENCIA en los reportes: así quien
// revise entiende de dónde salió una cantidad contada mayor a la que está en el
// anaquel. Solo incluye partes del inventario actual (partesActuales()).
function listaExhibiciones() {
  const out = [];
  for (const p of partesActuales()) {
    const detalle = (p.exhibiciones && Object.keys(p.exhibiciones).length)
      ? p.exhibiciones
      : (Number(p.exhibicion || 0) > 0 ? { "Exhibición": Number(p.exhibicion) } : null);
    if (!detalle) continue;
    for (const [punto, n] of Object.entries(detalle)) {
      if (Number(n) <= 0) continue;
      out.push({
        numParte: p.numParte,
        descripcion: p.descripcion || "",
        ubicacion: p.ubicacion || "",
        punto,
        cantidad: Number(n),
        observacion: (p.exhibObs && p.exhibObs[punto]) || "",
      });
    }
  }
  // Orden: por número de parte para que sea fácil de localizar.
  out.sort((a, b) => String(a.numParte).localeCompare(String(b.numParte), "es"));
  return out;
}

// Piezas en exhibición de UNA parte (para la columna "En exhib." de las tablas).
function exhibDeParte(numParte) {
  const p = store.getPart(ag(), numParte);
  return p ? Number(p.exhibicion || 0) : 0;
}

// Umbral de "diferencia grande" en $: configurable, default $500. Las partes con
// impacto económico >= umbral se resaltan para priorizar la recontada.
const UMBRAL_DIF_GRANDE = 500;
function esDifGrande(d) { return d && d.impacto != null && d.impacto >= UMBRAL_DIF_GRANDE; }

function renderDiferencias() {
  const el = document.getElementById("ref-diff-resumen");
  const tbody = document.querySelector("#ref-diff-table tbody");
  if (!el && !tbody) return;
  const difs = listaDiferencias();
  const faltantes = difs.filter(d => d.tipo === "faltante").length;
  const sobrantes = difs.filter(d => d.tipo === "sobrante").length;
  const sinContar = difs.filter(d => d.tipo === "sin-contar").length;
  const sinExist = difs.filter(d => d.tipo === "sin-existencia").length;
  const grandes = difs.filter(esDifGrande);
  const impactoGrande = grandes.reduce((s, d) => s + (d.impacto || 0), 0);

  if (el) el.innerHTML = `
    <div class="stat"><b style="color:var(--danger)">${faltantes}</b><span>Faltantes</span></div>
    <div class="stat"><b style="color:#b45309">${sobrantes}</b><span>Sobrantes</span></div>
    <div class="stat"><b>${sinContar}</b><span>Sin contar</span></div>
    <div class="stat"><b>${sinExist}</b><span>Contadas sin existencia</span></div>
    ${grandes.length ? `<div class="stat" style="background:#fef2f2;border-color:#fecaca"><b style="color:var(--danger)">${grandes.length} · ${money(impactoGrande)}</b><span>⚠️ Diferencias grandes (≥ ${money(UMBRAL_DIF_GRANDE)})</span></div>` : ""}`;

  if (tbody) {
    tbody.innerHTML = difs.map(d => {
      const grande = esDifGrande(d);
      const impactoCell = d.impacto == null ? "—" : money(d.impacto);
      const exh = Number(d.exhibicion || 0);
      return `
      <tr${grande ? ` style="background:#fef2f2"` : ""}>
        <td>${grande ? "⚠️ " : ""}<code>${escapeHtml(d.numParte)}</code></td>
        <td>${escapeHtml((d.descripcion || "").slice(0, 45))}</td>
        <td><code>${escapeHtml(d.ubicacion || "")}</code></td>
        <td style="text-align:right">${d.existencia == null ? "—" : escapeHtml(String(d.existencia))}</td>
        <td style="text-align:right">${d.conteo == null ? "—" : escapeHtml(String(d.conteo))}</td>
        <td style="text-align:right">${exh > 0 ? `<span title="Incluidas en el conteo" style="color:var(--primary)">${exh}</span>` : "—"}</td>
        <td style="text-align:right">${difBadge(d.dif)}</td>
        <td style="text-align:right${grande ? ";color:var(--danger);font-weight:700" : ""}">${impactoCell}</td>
        <td>${tipoLabel(d.tipo)}</td>
      </tr>`;
    }).join("");
    const empty = document.getElementById("ref-diff-empty");
    if (empty) empty.style.display = difs.length ? "none" : "";
  }
}

function tipoLabel(t) {
  return {
    faltante: `<span style="color:var(--danger)">Ajuste negativo (faltan)</span>`,
    sobrante: `<span style="color:#b45309">Ajuste positivo (sobran)</span>`,
    "sin-contar": `<span class="muted">Sin contar</span>`,
    "sin-existencia": `<span class="muted">Contada sin existencia</span>`,
  }[t] || t;
}

function imprimirDiferencias() {
  const difs = listaDiferencias();
  if (!difs.length) { notify("No hay diferencias que reportar. El conteo cuadra.", { type: "success" }); return; }
  const by = auth.currentUser()?.name || "—";
  const fecha = new Date().toLocaleString();
  const filas = difs.map(d => {
    const exh = Number(d.exhibicion || 0);
    return `
    <tr>
      <td>${esc(d.numParte)}</td>
      <td>${esc(d.descripcion || "")}</td>
      <td>${esc(d.ubicacion || "")}</td>
      <td style="text-align:right">${d.existencia == null ? "—" : esc(String(d.existencia))}</td>
      <td style="text-align:right">${d.conteo == null ? "—" : esc(String(d.conteo))}</td>
      <td style="text-align:right">${exh > 0 ? esc(String(exh)) : "—"}</td>
      <td style="text-align:right">${d.dif == null ? "—" : (d.dif > 0 ? "+" : "") + d.dif}</td>
      <td>${esc(tipoTexto(d.tipo))}</td>
    </tr>`;
  }).join("");

  // Sección de EVIDENCIA de exhibición: de dónde salieron las piezas que suman
  // al conteo (puntos de venta / fuera de ubicación), con su observación.
  const exhibiciones = listaExhibiciones();
  const seccionExhib = exhibiciones.length ? `
    <h2 style="font-size:14px;margin:18px 0 6px">Piezas en exhibición / puntos de venta (sumadas al conteo) — ${exhibiciones.length}</h2>
    <p class="meta" style="margin:0 0 6px">Estas piezas NO estaban en el anaquel pero SÍ existen físicamente; se suman al conteo para que cuadre contra la existencia. Se listan como evidencia del ajuste.</p>
    <table><thead><tr>
      <th>No. parte</th><th>Descripción</th><th>Punto / ubicación</th><th>Cantidad</th><th>Observación</th>
    </tr></thead><tbody>${
      exhibiciones.map(e => `<tr>
        <td>${esc(e.numParte)}</td>
        <td>${esc(e.descripcion)}</td>
        <td>${esc(e.punto)}</td>
        <td style="text-align:right">${esc(String(e.cantidad))}</td>
        <td>${esc(e.observacion)}</td>
      </tr>`).join("")
    }</tbody></table>` : "";

  const win = window.open("", "_blank", "width=900,height=1000");
  if (!win) { notify("El navegador bloqueó la ventana. Permite ventanas emergentes.", { type: "warn" }); return; }
  win.document.write(`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
    <title>Reporte de diferencias — Refacciones</title>
    <style>
      *{box-sizing:border-box} body{font-family:system-ui,Arial,sans-serif;margin:24px;color:#111}
      h1{font-size:18px;margin:0 0 4px} h2{color:#0f204a} .meta{color:#555;font-size:12px;margin-bottom:12px}
      table{width:100%;border-collapse:collapse;font-size:12px}
      th,td{border:1px solid #ccc;padding:5px 7px;text-align:left}
      th{background:#0f204a;color:#fff}
      tr:nth-child(even){background:#f6f8fc}
      .barra{margin-bottom:12px}
      .barra button{padding:8px 16px;font-size:14px;border:0;border-radius:6px;background:#0f204a;color:#fff;cursor:pointer}
      @media print{.barra{display:none}}
    </style></head><body>
    <div class="barra"><button onclick="window.print()">🖨️ Imprimir / Guardar PDF</button></div>
    <h1>Reporte de diferencias — Inventario de refacciones</h1>
    <div class="meta">Generado: ${esc(fecha)} · Por: ${esc(by)} · ${difs.length} parte(s) con diferencia</div>
    <table><thead><tr>
      <th>No. parte</th><th>Descripción</th><th>Ubicación</th><th>Existencia</th><th>Conteo</th><th>En exhib.</th><th>Dif.</th><th>Tipo</th>
    </tr></thead><tbody>${filas}</tbody></table>
    ${seccionExhib}
    </body></html>`);
  win.document.close();
  logAction("parts.diff.report", `Reporte de diferencias impreso (${difs.length} partes${exhibiciones.length ? `, ${exhibiciones.length} en exhibición` : ""})`, by);
}

function tipoTexto(t) {
  return { faltante: "Ajuste negativo (faltan)", sobrante: "Ajuste positivo (sobran)", "sin-contar": "Sin contar", "sin-existencia": "Contada sin existencia" }[t] || t;
}

function exportarDiferenciasCsv() {
  const difs = listaDiferencias();
  if (!difs.length) { notify("No hay diferencias que exportar.", { type: "info" }); return; }
  const head = ["No.Parte", "Descripcion", "Ubicacion", "Existencia", "Conteo", "EnExhibicion", "Diferencia", "Tipo"];
  const rows = difs.map(d => [
    d.numParte, d.descripcion || "", d.ubicacion || "",
    d.existencia == null ? "" : d.existencia,
    d.conteo == null ? "" : d.conteo,
    Number(d.exhibicion || 0) || "",
    d.dif == null ? "" : d.dif,
    tipoTexto(d.tipo),
  ]);
  const csv = [head, ...rows].map(r => r.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `diferencias-refacciones-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  notify(`CSV de diferencias exportado (${difs.length} partes).`, { type: "success" });
}

// ======================= RESULTADO FINAL CON FIRMAS =======================

// ======================= RESPALDO Y CONEXIÓN =======================

// Exporta el inventario de refacciones (partes + sesión de auditoría) a un
// archivo JSON descargable. Respaldo de seguridad por si falla el servidor.
function exportarRespaldo() {
  if (!agencyActual) { notify("Primero selecciona la agencia.", { type: "warn" }); return; }
  const parts = store.listParts(ag());
  if (!parts.length) { notify("No hay inventario de refacciones que respaldar en esta agencia.", { type: "warn" }); return; }
  const data = {
    tipo: "respaldo-refacciones",
    version: 2,                       // v2: respaldo POR AGENCIA
    agency: ag(),
    generadoEn: new Date().toISOString(),
    generadoPor: auth.currentUser()?.name || "—",
    parts,
    partsAudit: store.getPartsAudit(ag()),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const fecha = new Date().toISOString().slice(0, 10);
  const slug = ag().toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const a = document.createElement("a");
  a.href = url; a.download = `respaldo-refacciones-${slug}-${fecha}.json`;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 500);
  logAction("parts.backup.export", `Respaldo exportado (${ag()}): ${parts.length} partes`, data.generadoPor);
  setBackupStatus(`✓ Respaldo exportado: ${parts.length} partes de ${ag()}.`, "ok");
}

// Importa un respaldo JSON y restaura las partes (merge) y, opcionalmente, la
// sesión de auditoría. Pide confirmación. Requiere permiso de edición.
async function importarRespaldo(file) {
  if (!puedeEditar()) { notify("Tu rol no permite importar inventario de refacciones.", { type: "warn" }); return; }
  let data;
  try {
    data = JSON.parse(await readTextFile(file));
  } catch (e) {
    setBackupStatus("El archivo no es un respaldo válido (JSON ilegible).", "error");
    return;
  }
  if (!data || data.tipo !== "respaldo-refacciones" || !Array.isArray(data.parts)) {
    setBackupStatus("El archivo no es un respaldo de refacciones válido.", "error");
    return;
  }
  // La agencia destino: la del respaldo (v2) o, si es v1 sin agencia, la activa.
  // Si no hay agencia activa y el respaldo no la trae, no sabemos dónde ponerlo.
  const destino = data.agency && AGENCIAS_REF.includes(data.agency) ? data.agency : agencyActual;
  if (!destino) {
    setBackupStatus("Este respaldo no indica agencia. Selecciona primero la agencia a la que quieres importarlo.", "error");
    return;
  }
  const avisoAgencia = (data.agency && data.agency !== destino)
    ? `\n\n⚠️ El respaldo es de "${data.agency}" pero se importará a "${destino}".`
    : (!data.agency ? `\n\n(Respaldo antiguo sin agencia: se importará a "${destino}".)` : "");
  if (!confirm(`¿Importar el respaldo con ${data.parts.length} parte(s) a la agencia "${destino}"?\n` +
      `Se combinarán con el inventario actual de esa agencia.${avisoAgencia}`)) return;

  const res = store.bulkUpsertParts(destino, data.parts, { merge: true });
  if (data.partsAudit && typeof data.partsAudit === "object") {
    store.setPartsAudit(destino, data.partsAudit);
  }
  const by = auth.currentUser()?.name || "—";
  logAction("parts.backup.import", `Respaldo importado a ${destino}: ${res.added} nuevas, ${res.updated} actualizadas`, by);
  // Sube lo importado al servidor (o encola si no hay red).
  try { pushParts(destino, data.parts); } catch (e) {}
  setBackupStatus(`✓ Respaldo importado a ${destino}: ${res.added} nuevas, ${res.updated} actualizadas.`, "ok");
  notify("Respaldo de refacciones importado.", { type: "success", timeout: 6000 });
  renderRefacciones();
}

function setBackupStatus(msg, kind) { setStatusEl("ref-backup-status", msg, kind); }

// Opciones del selector de agencia del histórico: las 3 reales + "archivo
// anterior" solo si tiene entradas. Devuelve [{value,label}].
function opcionesHistAgencia() {
  const opts = AGENCIAS_REF.map(a => ({ value: a, label: a }));
  if (store.listPartsAuditHistory(ARCHIVO_PREVIO).length) {
    opts.push({ value: ARCHIVO_PREVIO, label: ARCHIVO_PREVIO_LABEL });
  }
  return opts;
}

// Llena y gobierna el selector de agencia del histórico. Por defecto sigue a la
// agencia activa; si no hay, la primera opción disponible.
function fillHistAgenciaSel() {
  const sel = document.getElementById("ref-hist-agencia");
  if (!sel) return (agencyActual || AGENCIAS_REF[0]);
  const opts = opcionesHistAgencia();
  const prev = sel.value;
  sel.innerHTML = opts.map(o => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join("");
  // Prioridad: selección previa válida → agencia activa → primera opción.
  const valido = (v) => opts.some(o => o.value === v);
  sel.value = valido(prev) ? prev : (valido(agencyActual) ? agencyActual : opts[0].value);
  return sel.value;
}

// Histórico de inventarios de refacciones cerrados de UNA agencia: tabla con
// fecha, valor, diferencia y firmantes. En el "archivo anterior" muestra un
// botón para reasignar cada cierre a su agencia real.
function renderHistorialAuditorias() {
  const cont = document.getElementById("ref-historial");
  if (!cont) return;
  const agSel = fillHistAgenciaSel();
  const esArchivo = agSel === ARCHIVO_PREVIO;
  const hist = store.listPartsAuditHistory(agSel);
  if (!hist.length) {
    cont.innerHTML = `<p class="muted">Sin inventarios cerrados en ${escapeHtml(esArchivo ? "el archivo anterior" : agSel)}. Cuando cierres una auditoría de esta agencia, aparecerá aquí.</p>`;
    return;
  }
  const filas = hist.map(h => {
    const fecha = h.fecha ? new Date(h.fecha).toLocaleString("es-MX") : "—";
    // Participantes del cierre nuevo; compat con cierres viejos (firmas fijas).
    const firmas = Array.isArray(h.participantes)
      ? h.participantes.length
      : [h.firmaAdmin, h.firmaRefacciones, h.firmaPosventa, h.firmaAuditor].filter(Boolean).length;
    const accion = esArchivo
      ? `<td><button class="btn btn-ghost ref-reasignar" data-id="${escapeHtml(h.id)}" style="padding:2px 8px;font-size:12px">Reasignar…</button></td>`
      : "";
    return `<tr>
      <td>${escapeHtml(fecha)}</td>
      <td style="text-align:right">${h.totalPartes ?? "—"}</td>
      <td style="text-align:right">${money(h.valorInventario || 0)}</td>
      <td style="text-align:right;color:var(--danger)">${money(h.valorDiferencia || 0)}</td>
      <td style="text-align:right">${h.faltantes ?? 0}/${h.sobrantes ?? 0}</td>
      <td style="text-align:right">${firmas}</td>
      <td>${escapeHtml(h.by || "—")}</td>
      ${accion}
    </tr>`;
  }).join("");
  cont.innerHTML = `
    <div class="table-wrap" style="max-height:320px;overflow:auto">
      <table class="table">
        <thead><tr>
          <th>Fecha de cierre</th><th style="text-align:right">Partes</th>
          <th style="text-align:right">Valor inventario</th>
          <th style="text-align:right">Diferencia $</th>
          <th style="text-align:right">Falt./Sobr.</th>
          <th style="text-align:right">Firmantes</th><th>Responsable</th>
          ${esArchivo ? "<th></th>" : ""}
        </tr></thead>
        <tbody>${filas}</tbody>
      </table>
    </div>`;

  // Enganchar los botones de reasignación (solo en el archivo anterior).
  if (esArchivo) {
    cont.querySelectorAll(".ref-reasignar").forEach(btn => {
      btn.addEventListener("click", () => reasignarHistorial(btn.getAttribute("data-id")));
    });
  }
}

// Reasigna una entrada del histórico del "archivo anterior" a una agencia real.
function reasignarHistorial(id) {
  if (!puedeEditar()) { notify("Tu rol no permite reasignar inventarios.", { type: "warn" }); return; }
  const opciones = AGENCIAS_REF.map((a, i) => `${i + 1}) ${a}`).join("\n");
  const resp = (prompt(`¿A qué agencia pertenece este inventario?\n\n${opciones}\n\nEscribe 1, 2 o 3:`, "") || "").trim();
  const idx = Number(resp) - 1;
  if (!(idx >= 0 && idx < AGENCIAS_REF.length)) {
    if (resp !== "") notify("Opción no válida. No se reasignó.", { type: "warn" });
    return;
  }
  const destino = AGENCIAS_REF[idx];
  store.reassignPartsAuditHistory(id, destino);
  logAction("parts.history.reassign", `Cierre de inventario reasignado al archivo → ${destino}`, auth.currentUser()?.name || "—");
  notify(`Inventario reasignado a ${destino}.`, { type: "success" });
  renderHistorialAuditorias();
}

// Diagnóstico de conexión: dice claramente si está conectado al SERVIDOR o en
// MODO LOCAL, y por qué. Ayuda a resolver el "cargué en una PC y no aparece en
// otra" antes de empezar el inventario.
async function probarConexion() {
  const estado = document.getElementById("ref-conn-estado");
  const detalle = document.getElementById("ref-conn-detalle");
  const set = (txt, color, det) => {
    if (estado) { estado.textContent = txt; estado.style.color = color; estado.style.fontWeight = "700"; }
    if (detalle) detalle.textContent = det || "";
  };
  set("Comprobando…", "var(--muted)", "");

  if (!navigator.onLine) {
    set("⚠️ Sin internet (modo local)", "#b45309",
      "Este dispositivo no tiene conexión. Los registros se guardan localmente y se subirán al reconectar.");
    return;
  }
  if (!api.hasToken()) {
    set("⚠️ Modo local (sin sesión de servidor)", "#b45309",
      "Iniciaste sesión en modo local o de emergencia. Lo que cargues/cuentes NO se sube al servidor ni se ve en otros equipos. Cierra sesión y entra con tu usuario del servidor para sincronizar.");
    return;
  }
  // Hay token: comprobamos que el servidor responda y que la sesión siga válida.
  try {
    const ok = await api.ping();
    if (!ok) {
      set("⚠️ Servidor no responde (modo local)", "#b45309",
        "Hay internet pero el servidor no contesta. Se trabajará localmente y se sincronizará cuando vuelva.");
      return;
    }
    await api.me();  // valida el token contra el servidor
    set("✅ Conectado al servidor", "#059669",
      `Sesión válida. Los cambios se sincronizan con el servidor (${api.apiBase()}).`);
  } catch (e) {
    if (e && e.status === 401) {
      set("⚠️ Sesión expirada (modo local)", "#b45309",
        "El servidor respondió pero tu sesión caducó. Cierra sesión y vuelve a entrar para sincronizar.");
    } else {
      set("⚠️ Servidor no disponible (modo local)", "#b45309",
        "No se pudo confirmar la conexión con el servidor. Se trabajará localmente.");
    }
  }
}

// Formatea un monto en pesos.
function money(n) {
  return "$ " + (Number(n) || 0).toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Devuelve la palabra en singular o plural según la cantidad (1 → singular).
function plural(n, sing, plur) { return Number(n) === 1 ? sing : plur; }

// Etiquetas de clasificación de rotación (del archivo de existencias).
const CLASIF_LABEL = {
  R: "Rápido", L: "Lento", E: "Estancado", P: "Próximo obsoleto",
  O: "Obsoleto", I: "Inactivo",
};
const CLASIF_ORDEN = ["R", "L", "E", "P", "O", "I"];

// Agrupa el inventario por CLASIFICACIÓN (L/O/R/E/P/I): cuántas partes, valor del
// inventario y monto de diferencia por cada clasificación. Útil para contabilidad
// (p. ej. cuánto valor hay en obsoletos, cuánta merma en rápidos).
function resumenPorClasificacion() {
  const all = partesActuales();
  const difs = listaDiferencias();
  // Mapa numParte → impacto $ de su diferencia (faltante/sobrante).
  const impactoPorParte = new Map();
  for (const d of difs) {
    if ((d.tipo === "faltante" || d.tipo === "sobrante") && d.impacto != null) {
      impactoPorParte.set(d.numParte, d.impacto);
    }
  }
  const grupos = new Map();  // clave clasif → acumulados
  const getG = (k) => {
    if (!grupos.has(k)) grupos.set(k, { clasif: k, partes: 0, valor: 0, difMonto: 0, difPartes: 0 });
    return grupos.get(k);
  };
  for (const p of all) {
    const k = (p.clasificacion || "").trim().toUpperCase() || "—";
    const g = getG(k);
    g.partes++;
    if (p.precioUnit != null && p.existencia != null) g.valor += Number(p.precioUnit) * Number(p.existencia);
    const imp = impactoPorParte.get(p.numParte);
    if (imp != null) { g.difMonto += imp; g.difPartes++; }
  }
  // Ordenar según CLASIF_ORDEN; lo desconocido ("—" u otras) al final.
  const claves = [...grupos.keys()].sort((a, b) => {
    const ia = CLASIF_ORDEN.indexOf(a), ib = CLASIF_ORDEN.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return claves.map(k => grupos.get(k));
}

// Nombre legible de una clasificación (p. ej. "R" → "Rápido (R)").
function clasifNombre(k) {
  if (k === "—" || !k) return "Sin clasificación";
  return CLASIF_LABEL[k] ? `${CLASIF_LABEL[k]} (${k})` : k;
}

// Calcula el resumen económico del inventario de refacciones.
//   valorInventario: suma de existencia × precioUnit de todas las partes.
//   valorDiferencia: suma de |diferencia| × precioUnit de las partes con diferencia.
function resumenFinal() {
  // Partes AUDITADAS (en rotativo = la muestra; en completo = todas).
  const all = partesActuales();
  // Valor del SUBCONJUNTO auditado.
  let valorInventario = 0, partesConPrecio = 0;
  for (const p of all) {
    if (p.precioUnit != null && p.existencia != null) {
      valorInventario += Number(p.precioUnit) * Number(p.existencia);
      partesConPrecio++;
    }
  }
  // Valor del INVENTARIO COMPLETO de la agencia. Preferimos el CATÁLOGO completo
  // de existencias persistido (p. ej. 666 partes), que es el inventario real
  // cargado; si no existe (inventarios antiguos), caemos a lo que haya en el
  // store. Esto corrige el caso en que el rotativo solo dejaba unas pocas partes
  // y el "valor del inventario completo" salía con 3 partes.
  const catalogo = catalogoExistencias();
  const enStore = store.listParts(ag());
  // Usamos la fuente con MÁS partes: el catálogo (inventario completo cargado) o
  // lo que haya en el store. Así el valor total es el real aunque el rotativo
  // haya dejado solo la muestra en el store, y también en inventarios completos
  // antiguos (sin catálogo) donde el store sí tiene todo.
  const todasAgencia = catalogo.length >= enStore.length ? catalogo : enStore;
  let valorInventarioTotal = 0, partesTotalConPrecio = 0;
  for (const p of todasAgencia) {
    if (p.precioUnit != null && p.existencia != null) {
      valorInventarioTotal += Number(p.precioUnit) * Number(p.existencia);
      partesTotalConPrecio++;
    }
  }

  const difs = listaDiferencias();
  const conDif = difs.filter(d => d.tipo === "faltante" || d.tipo === "sobrante");
  let valorDiferencia = 0;
  for (const d of conDif) {
    const precio = d.precioUnit != null ? Number(d.precioUnit) : 0;
    valorDiferencia += Math.abs(Number(d.dif) || 0) * precio;
  }
  const noComprobadas = difs.filter(d => d.tipo === "sin-contar").length;

  // AJUSTES (lo que hay que capturar en el sistema):
  //   - Ajuste NEGATIVO: existencia > contado  (faltan piezas físicas). dif < 0.
  //   - Ajuste POSITIVO: contado > existencia  (sobran piezas físicas). dif > 0.
  const posit = conDif.filter(d => Number(d.dif) > 0);
  const negat = conDif.filter(d => Number(d.dif) < 0);
  const uds = (arr) => arr.reduce((s, d) => s + Math.abs(Number(d.dif) || 0), 0);
  const ajustePositivo = { partes: posit.length, unidades: uds(posit) };
  const ajusteNegativo = { partes: negat.length, unidades: uds(negat) };

  return {
    totalPartes: all.length, partesConPrecio,
    valorInventario,                                  // valor del subconjunto auditado
    valorInventarioTotal, partesTotal: todasAgencia.length, partesTotalConPrecio,
    esRotativo: esRotativo(),
    valorDiferencia,
    faltantes: negat.length,   // faltante = ajuste negativo
    sobrantes: posit.length,   // sobrante = ajuste positivo
    ajustePositivo, ajusteNegativo,
    noComprobadas, difs, conDif,
  };
}

function renderFinal() {
  const el = document.getElementById("ref-final-resumen");
  if (!el) return;
  const r = resumenFinal();
  // Aviso si FALTAN precios: el valor del inventario quedaría incompleto/en $0.
  // Suele pasar cuando se cargó el archivo de TEXTO PLANO (sin precio) en vez del
  // CSV que trae la columna "Precio U.".
  const sinPrecio = r.totalPartes - r.partesConPrecio;
  let aviso = "";
  if (r.totalPartes > 0 && r.partesConPrecio === 0) {
    aviso = `<div class="stat stat-wide" style="background:#fef2f2;border-color:#fecaca">
      <b style="color:var(--danger)">⚠️ Sin precios cargados</b>
      <span>El valor del inventario sale en $0. Carga el <b>CSV de existencias con la columna "Precio U."</b> para calcular los montos.</span></div>`;
  } else if (sinPrecio > 0) {
    aviso = `<div class="stat stat-wide" style="background:#fffbeb;border-color:#fde68a">
      <b style="color:#b45309">Valor parcial</b>
      <span>${sinPrecio} de ${r.totalPartes} partes <b>sin precio</b>: el valor mostrado solo cubre ${r.partesConPrecio} partes.</span></div>`;
  }
  // En ROTATIVO mostramos DOS valores: el del inventario completo cargado y el
  // del subconjunto auditado. En completo, uno solo (son lo mismo).
  const valorTotalCell = r.esRotativo
    ? `<div class="stat stat-wide"><b>${money(r.valorInventarioTotal)}</b><span>Valor del inventario COMPLETO cargado (${r.partesTotal} partes)</span></div>
       <div class="stat stat-wide"><b style="color:var(--primary)">${money(r.valorInventario)}</b><span>Valor del subconjunto AUDITADO / rotativo (${r.totalPartes} partes)</span></div>`
    : `<div class="stat stat-wide"><b>${money(r.valorInventario)}</b><span>Valor total del inventario${r.partesConPrecio < r.totalPartes ? " (parcial)" : ""}</span></div>`;
  el.innerHTML = `
    ${aviso}
    ${valorTotalCell}
    <div class="stat"><b style="color:var(--danger)">${money(r.valorDiferencia)}</b><span>Monto de la diferencia</span></div>
    <div class="stat"><b style="color:#b45309">${r.ajustePositivo.partes} ${plural(r.ajustePositivo.partes, "parte", "partes")} · +${r.ajustePositivo.unidades} ${plural(r.ajustePositivo.unidades, "pieza", "piezas")}</b><span>Ajuste positivo (sobran): piezas contadas de más</span></div>
    <div class="stat"><b style="color:var(--danger)">${r.ajusteNegativo.partes} ${plural(r.ajusteNegativo.partes, "parte", "partes")} · −${r.ajusteNegativo.unidades} ${plural(r.ajusteNegativo.unidades, "pieza", "piezas")}</b><span>Ajuste negativo (faltan): piezas que faltan</span></div>
    <div class="stat"><b>${r.noComprobadas}</b><span>No comprobadas</span></div>`;

  renderClasificacion();
  // Solo inicializa participantes la primera vez (si el contenedor está vacío),
  // para no borrar lo que el usuario está capturando en cada repintado.
  const pc = document.getElementById("ref-participantes");
  if (pc && !pc.children.length) renderParticipantes();
}

// Tabla de valor y diferencias por CLASIFICACIÓN (L/O/R/E/P/I) para contabilidad.
function renderClasificacion() {
  const cont = document.getElementById("ref-final-clasif");
  if (!cont) return;
  const grupos = resumenPorClasificacion();
  if (!grupos.length) { cont.innerHTML = ""; return; }
  const filas = grupos.map(g => `
    <tr>
      <td>${escapeHtml(clasifNombre(g.clasif))}</td>
      <td style="text-align:right">${g.partes}</td>
      <td style="text-align:right">${money(g.valor)}</td>
      <td style="text-align:right">${g.difPartes}</td>
      <td style="text-align:right${g.difMonto > 0 ? ";color:var(--danger)" : ""}">${money(g.difMonto)}</td>
    </tr>`).join("");
  cont.innerHTML = `
    <h3 style="margin:0 0 6px">Resumen por clasificación</h3>
    <div class="table-wrap">
      <table class="table">
        <thead><tr>
          <th>Clasificación</th><th style="text-align:right">Partes</th>
          <th style="text-align:right">Valor inventario</th>
          <th style="text-align:right">Partes c/dif.</th>
          <th style="text-align:right">Monto diferencia</th>
        </tr></thead>
        <tbody>${filas}</tbody>
      </table>
    </div>`;
}

// Imprime la hoja de resultado final con el resumen, las partes con diferencia y
// el área de firmas (una por cada participante capturado: nombre y cargo).
function imprimirResultadoFinal() {
  const r = resumenFinal();
  const by = auth.currentUser()?.name || "—";
  const fecha = new Date().toLocaleString();
  const { rondas, rondaActual } = rondaInfo();
  const participantes = leerParticipantes();

  // Construye las filas de un conjunto de diferencias (para cada sección).
  const filasDe = (arr) => arr.map(d => {
    const p = store.getPart(ag(), d.numParte);
    const precio = p && p.precioUnit != null ? Number(p.precioUnit) : null;
    const impacto = (d.dif != null && precio != null) ? Math.abs(d.dif) * precio : null;
    return `<tr>
      <td>${esc(d.numParte)}</td>
      <td>${esc(d.descripcion || "")}</td>
      <td>${esc(d.ubicacion || "")}</td>
      <td style="text-align:right">${d.existencia == null ? "—" : esc(String(d.existencia))}</td>
      <td style="text-align:right">${d.conteo == null ? "—" : esc(String(d.conteo))}</td>
      <td style="text-align:right">${d.dif == null ? "—" : (d.dif > 0 ? "+" : "") + d.dif}</td>
      <td style="text-align:right">${precio == null ? "—" : money(precio)}</td>
      <td style="text-align:right">${impacto == null ? "—" : money(impacto)}</td>
    </tr>`;
  }).join("");

  // Separar: ajuste POSITIVO (dif>0, sobran) y NEGATIVO (dif<0, faltan). Las "sin
  // contar / contadas sin existencia" van en una tercera sección informativa.
  const posit = r.conDif.filter(d => Number(d.dif) > 0);
  const negat = r.conDif.filter(d => Number(d.dif) < 0);
  const otras = r.difs.filter(d => d.tipo === "sin-contar" || d.tipo === "sin-existencia");

  const cabTabla = `<thead><tr>
      <th>No. parte</th><th>Descripción</th><th>Ubicación</th><th>Exist.</th><th>Conteo</th><th>Dif.</th>
      <th>Precio U.</th><th>Impacto $</th>
    </tr></thead>`;
  const seccion = (titulo, arr, color) => arr.length
    ? `<h2 style="color:${color}">${titulo} — ${arr.length} parte(s)</h2>
       <table>${cabTabla}<tbody>${filasDe(arr)}</tbody></table>`
    : "";
  const seccionOtras = otras.length
    ? `<h2>Otras (no comprobadas / sin existencia) — ${otras.length}</h2>
       <table>${cabTabla}<tbody>${filasDe(otras)}</tbody></table>`
    : "";

  // EVIDENCIA COMPLETA de exhibición / puntos de venta: TODAS las piezas que se
  // sumaron al conteo desde exhibición (no solo las "Sin ubicación"), con su
  // observación. Así el reporte explica de dónde salió cada cantidad contada que
  // no estaba en el anaquel.
  const exhibiciones = listaExhibiciones();
  const seccionExhib = exhibiciones.length ? `
    <h2 style="color:#0f204a">Piezas en exhibición / puntos de venta — ${exhibiciones.length} (evidencia)</h2>
    <p class="nota">Estas piezas se SUMARON al conteo (existen físicamente aunque no en el anaquel). Se listan con su observación como respaldo del ajuste.</p>
    <table><thead><tr>
      <th>No. parte</th><th>Descripción</th><th>Punto / ubicación</th><th>Cantidad</th><th>Observación</th>
    </tr></thead><tbody>${
      exhibiciones.map(e => `<tr${e.punto === "Sin ubicación" ? ' style="background:#fffbeb"' : ""}>
        <td>${esc(e.numParte)}</td>
        <td>${esc(e.descripcion)}</td>
        <td>${e.punto === "Sin ubicación" ? "⚠️ " : ""}${esc(e.punto)}</td>
        <td style="text-align:right">${esc(String(e.cantidad))}</td>
        <td>${esc(e.observacion)}</td>
      </tr>`).join("")
    }</tbody></table>` : "";

  // Área de firmas: una por participante (nombre + cargo). Si no hay ninguno,
  // deja una línea genérica para firmar a mano.
  const firmas = participantes.length ? participantes : [{ nombre: "", cargo: "" }];
  const firmasHtml = `<div class="firmas">` + firmas.map(p => `
      <div class="firma">
        <div class="linea">${esc(p.nombre || "")}</div>
        <div class="cargo">${esc(p.cargo || "Nombre y firma")}</div>
      </div>`).join("") + `</div>`;

  const win = window.open("", "_blank", "width=1000,height=1100");
  if (!win) { notify("El navegador bloqueó la ventana. Permite ventanas emergentes.", { type: "warn" }); return; }
  win.document.write(`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
    <title>Resultado de auditoría — Refacciones</title>
    <style>
      *{box-sizing:border-box} body{font-family:system-ui,Arial,sans-serif;margin:24px;color:#111}
      h1{font-size:18px;margin:0 0 2px} h2{font-size:14px;margin:18px 0 6px}
      .meta{color:#555;font-size:12px;margin-bottom:10px}
      .resumen{display:flex;flex-wrap:wrap;gap:10px;margin:10px 0}
      .box{border:1px solid #ccc;border-radius:8px;padding:8px 12px;min-width:150px}
      .box b{display:block;font-size:16px} .box span{font-size:11px;color:#555}
      table{width:100%;border-collapse:collapse;font-size:11px;margin-top:4px}
      th,td{border:1px solid #ccc;padding:4px 6px;text-align:left}
      th{background:#0f204a;color:#fff} tr:nth-child(even){background:#f6f8fc}
      .firmas{display:flex;justify-content:space-between;gap:16px;margin-top:48px;flex-wrap:wrap}
      .firma{flex:1;text-align:center} .firma .linea{border-top:1px solid #000;margin-top:40px;padding-top:4px;font-size:12px}
      .firma .cargo{font-size:11px;color:#555}
      .nota{font-size:11px;color:#555;margin:2px 0 6px}
      .barra{margin-bottom:12px} .barra button{padding:8px 16px;font-size:14px;border:0;border-radius:6px;background:#0f204a;color:#fff;cursor:pointer}
      @media print{.barra{display:none}}
    </style></head><body>
    <div class="barra"><button onclick="window.print()">🖨️ Imprimir / Guardar PDF</button></div>
    <h1>Resultado de auditoría — Inventario de refacciones</h1>
    <div class="meta">Generado: ${esc(fecha)} · Responsable: ${esc(by)} · Conteos realizados: ${rondaActual} de ${rondas}</div>
    <div class="resumen">
      ${r.esRotativo
        ? `<div class="box"><b>${money(r.valorInventarioTotal)}</b><span>Valor inventario COMPLETO (${r.partesTotal} partes)</span></div>
           <div class="box"><b>${money(r.valorInventario)}</b><span>Valor subconjunto AUDITADO (${r.totalPartes} partes)</span></div>`
        : `<div class="box"><b>${money(r.valorInventario)}</b><span>Valor total del inventario</span></div>`}
      <div class="box"><b>${money(r.valorDiferencia)}</b><span>Monto total de la diferencia</span></div>
      <div class="box"><b>${r.ajustePositivo.partes} ${plural(r.ajustePositivo.partes, "parte", "partes")} · +${r.ajustePositivo.unidades} ${plural(r.ajustePositivo.unidades, "pieza", "piezas")}</b><span>Ajuste positivo (sobran piezas)</span></div>
      <div class="box"><b>${r.ajusteNegativo.partes} ${plural(r.ajusteNegativo.partes, "parte", "partes")} · −${r.ajusteNegativo.unidades} ${plural(r.ajusteNegativo.unidades, "pieza", "piezas")}</b><span>Ajuste negativo (faltan piezas)</span></div>
      <div class="box"><b>${r.noComprobadas}</b><span>No comprobadas</span></div>
      <div class="box"><b>${r.difs.length}</b><span>Partes en el reporte</span></div>
    </div>
    ${(posit.length || negat.length || otras.length)
      ? `${seccion("Ajuste POSITIVO (sobran piezas: contado &gt; existencia)", posit, "#b45309")}
         ${seccion("Ajuste NEGATIVO (faltan piezas: existencia &gt; contado)", negat, "#b91c1c")}
         ${seccionOtras}`
      : "<p>Sin diferencias. El inventario cuadra.</p>"}
    ${seccionExhib}
    ${firmasHtml}
    </body></html>`);
  win.document.close();
  logAction("parts.audit.result", `Resultado impreso · dif ${money(r.valorDiferencia)} · ${r.conDif.length} partes · ${participantes.length} firmantes`, by);
}

// ======================= PARTICIPANTES / FIRMANTES =======================

// Agrega una fila de participante (nombre + cargo) a la UI. Si se pasan valores,
// precarga la fila (para restaurar los guardados en la sesión).
function agregarFilaParticipante(nombre = "", cargo = "") {
  const cont = document.getElementById("ref-participantes");
  if (!cont) return;
  const row = document.createElement("div");
  row.className = "row gap wrap ref-part-row";
  row.style.margin = "6px 0";
  row.innerHTML = `
    <input type="text" class="ref-part-nombre" placeholder="Nombre completo" style="flex:2;min-width:160px" value="${escapeHtml(nombre)}" />
    <input type="text" class="ref-part-cargo" placeholder="Cargo / puesto" style="flex:1;min-width:130px" value="${escapeHtml(cargo)}" />
    <button class="btn btn-ghost ref-part-del" type="button" title="Quitar" style="min-width:40px">✕</button>`;
  row.querySelector(".ref-part-del").addEventListener("click", () => { row.remove(); });
  cont.appendChild(row);
}

// Lee los participantes capturados en la UI: [{nombre, cargo}] (sin filas vacías).
function leerParticipantes() {
  const cont = document.getElementById("ref-participantes");
  if (!cont) return [];
  const out = [];
  cont.querySelectorAll(".ref-part-row").forEach(row => {
    const nombre = (row.querySelector(".ref-part-nombre")?.value || "").trim();
    const cargo = (row.querySelector(".ref-part-cargo")?.value || "").trim();
    if (nombre || cargo) out.push({ nombre, cargo });
  });
  return out;
}

// Repinta la sección de participantes a partir de la sesión guardada de la
// agencia activa (o deja una fila vacía para empezar).
function renderParticipantes() {
  const cont = document.getElementById("ref-participantes");
  if (!cont) return;
  const a = store.getPartsAudit(ag()) || {};
  const guardados = Array.isArray(a.participantes) ? a.participantes : [];
  cont.innerHTML = "";
  if (guardados.length) guardados.forEach(p => agregarFilaParticipante(p.nombre, p.cargo));
  else agregarFilaParticipante();  // una fila vacía inicial
}

// Cierra la auditoría: guarda participantes y resumen en la bitácora y marca fin.
function cerrarAuditoria() {
  const r = resumenFinal();
  const by = auth.currentUser()?.name || "—";
  if (!confirm("¿Cerrar la auditoría de refacciones y guardarla en la bitácora?")) return;

  const { rondas, rondaActual } = rondaInfo();
  const tipo = tipoActual();
  const participantes = leerParticipantes();   // [{nombre, cargo}]
  // Lista de números de parte auditados en este inventario (para que un ROTATIVO
  // futuro pueda evitar repetirlos).
  const partesAuditadas = partesActuales().map(p => p.numParte).filter(Boolean);
  store.setPartsAudit(ag(), {
    finishedAt: new Date().toISOString(),
    participantes,
    valorInventario: r.valorInventario, valorDiferencia: r.valorDiferencia,
    faltantes: r.faltantes, sobrantes: r.sobrantes, noComprobadas: r.noComprobadas,
  });
  // Propaga el CIERRE a los demás equipos (el finishedAt viaja en la sesión).
  try { pushPartsAudit(ag()); } catch (e) {}
  // Guarda un SNAPSHOT en el histórico (para comparar con futuras auditorías),
  // ETIQUETADO con la agencia activa (clave del rediseño por agencia).
  store.addPartsAuditHistory({
    agency: ag(), tipo,
    by, rondas, rondasHechas: rondaActual,
    totalPartes: r.totalPartes,
    valorInventario: r.valorInventario, valorDiferencia: r.valorDiferencia,
    faltantes: r.faltantes, sobrantes: r.sobrantes, noComprobadas: r.noComprobadas,
    ajustePositivo: r.ajustePositivo, ajusteNegativo: r.ajusteNegativo,
    participantes,
    partesAuditadas,
    porClasificacion: resumenPorClasificacion(),
  });
  logAction("parts.audit.close",
    `Auditoría cerrada (${ag()}, ${tipo}) · inventario ${money(r.valorInventario)} · diferencia ${money(r.valorDiferencia)} · ` +
    `${r.faltantes} faltantes, ${r.sobrantes} sobrantes · participantes: ${participantes.length}`, by);
  notify(`Auditoría de refacciones de ${ag()} cerrada y registrada en la bitácora.`, { type: "success", timeout: 6000 });
  renderHistorialAuditorias();
}

// ======================= HELPERS =======================

function puedeEditar() {
  // Cargar/editar el catálogo de refacciones requiere refacciones.edit.
  try { return auth.can("refacciones.edit"); }
  catch (e) { return false; }
}
// Registrar conteo físico: lo puede hacer quien edita refacciones O el auditor
// (contar es la tarea central de la auditoría de refacciones).
function puedeContar() {
  try { return auth.can("refacciones.count"); }
  catch (e) { return false; }
}

function readTextFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(new Error("No se pudo leer el archivo."));
    r.readAsText(file, "utf-8");
  });
}

function setCargaStatus(msg, kind) { setStatusEl("ref-carga-status", msg, kind); }
function setScanStatus(msg, kind) { setStatusEl("ref-scan-status", msg, kind); }
function setStatusEl(id, msg, kind) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.style.color = kind === "error" ? "var(--danger)"
    : (kind === "ok" ? "var(--primary)" : (kind === "warn" ? "#b45309" : "var(--muted)"));
}

// Retroalimentación por sonido + vibración, diferenciada por tipo para que el
// contador NO tenga que mirar la pantalla:
//   "ok"    → pitido agudo corto + vibración breve (escaneo/registro correcto)
//   "warn"  → pitido medio doble + vibración doble (parte no está en inventario)
//   "error" → pitido grave triple + vibración larga triple (dato inválido)
// Compatibilidad: beep(true)=ok, beep(false)=error.
function beep(tipo) {
  if (tipo === true) tipo = "ok";
  else if (tipo === false) tipo = "error";
  const cfg = {
    ok:    { vib: 40,            tonos: [{ f: 880, d: 0.16 }] },
    warn:  { vib: [50, 40, 50],  tonos: [{ f: 600, d: 0.12 }, { f: 600, d: 0.12, gap: 0.14 }] },
    error: { vib: [70, 50, 70, 50, 70], tonos: [{ f: 260, d: 0.14 }, { f: 260, d: 0.14, gap: 0.16 }, { f: 260, d: 0.14, gap: 0.32 }] },
  }[tipo] || { vib: 40, tonos: [{ f: 880, d: 0.16 }] };
  try {
    if (navigator.vibrate) navigator.vibrate(cfg.vib);
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    // En móvil el AudioContext nace "suspendido" y NO suena hasta reanudarlo tras
    // una interacción del usuario. El escaneo no cuenta como interacción directa,
    // así que el beep quedaba mudo. Lo reanudamos aquí (y también al abrir la
    // cámara, ver desbloquearAudio) para que suene en cada lectura.
    if (audioCtx.state === "suspended") { try { audioCtx.resume(); } catch (e) {} }
    for (const t of cfg.tonos) {
      const start = audioCtx.currentTime + (t.gap || 0);
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = "square";                 // onda cuadrada: más audible en el almacén
      o.frequency.value = t.f;
      o.connect(g); g.connect(audioCtx.destination);
      g.gain.setValueAtTime(0.18, start); // volumen más alto que antes (0.08)
      g.gain.exponentialRampToValueAtTime(0.0001, start + t.d);
      o.start(start); o.stop(start + t.d);
    }
  } catch (e) { /* audio no disponible */ }
}

// "Desbloquea" el audio en móvil: crea/reanuda el AudioContext dentro de un gesto
// del usuario (al pulsar «Escanear QR»). Sin esto, el primer beep del escaneo no
// suena en Chrome Android. Se llama desde startScan().
function desbloquearAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch (e) { /* audio no disponible */ }
}

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function esc(s) { return escapeHtml(String(s ?? "")); }
