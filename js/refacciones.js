// refacciones.js — Lógica del inventario de REFACCIONES:
//   1) Parseo del archivo de EXISTENCIAS (CSV/Excel exportado como CSV o texto).
//   2) Parseo del listado de MARBETES (PDF del sistema interno).
//   3) CRUCE por número de parte (une marbete + existencia).
//
// El cruce es la base para generar etiquetas QR y, luego, el reporte de
// diferencias (conteo físico vs. existencia del sistema).

import { extractPdfLines } from "./cdo.js"; // reutiliza el lector de PDF ya existente

// --- Parseo de EXISTENCIAS ---
// Acepta DOS formatos y los detecta automáticamente:
//   A) CSV (separado por , o ;) con o sin encabezado.
//   B) TEXTO POR COLUMNAS (ancho fijo) del sistema interno, cuyas líneas se ven:
//        19434095   ACEITE SINTICO,5W30 DEXOSGEN3   863 102D0102R   29/09/2026
//      → parte | descripción | cantidad + ubicación (pegadas) | fecha
//      La cantidad es el número que precede a la ubicación; la ubicación es un
//      código alfanumérico; la fecha (dd/mm/aaaa) es opcional al final.
export function parseExistenciasCsv(text) {
  if (!text) return [];
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  // Detectar el formato: si hay comas/; en varias líneas → CSV; si no → texto por columnas.
  const sample = text.split(/\r?\n/).filter(l => l.trim()).slice(0, 20);
  const comma = sample.filter(l => l.includes(",")).length;
  const semi = sample.filter(l => l.includes(";")).length;
  const esCsv = (comma + semi) >= Math.max(3, sample.length * 0.6);

  return esCsv ? parseExistenciasDelimited(text) : parseExistenciasFixed(text);
}

// Formato B: TEXTO POR COLUMNAS (el del sistema interno de refacciones).
// Estrategia robusta por regex, línea por línea:
//   - Nº de parte: primer "token" (alfanumérico) de la línea.
//   - Fecha: dd/mm/aaaa al final (si existe) → se usa como ancla derecha.
//   - Antes de la fecha viene: "<cantidad> <ubicación>" (cantidad = dígitos,
//     ubicación = código alfanumérico que puede empezar con dígito y acabar en letra).
//   - Descripción: lo que queda entre el nº de parte y la cantidad.
function parseExistenciasFixed(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  // Nº de parte: 5+ caracteres alfanuméricos (12605566, MMFR1LS, PF48M, BIRLOS, H431260C, 9594500).
  const PARTE_RE = /^\s*([0-9A-Z][0-9A-Z\-]{3,})\s+(.*)$/i;
  // "cantidad ubicación [fecha]" al final del resto: cantidad (1-6 díg) + espacio +
  // ubicación (letras/dígitos, 5-12) + opcional fecha dd/mm/aaaa.
  const COLA_RE = /\s(\d{1,6})\s+([0-9A-Z]{4,14})(?:\s+(\d{2}\/\d{2}\/\d{4}))?\s*$/i;

  for (const raw of lines) {
    const line = String(raw || "").replace(/\t/g, " ").replace(/\s+$/,"");
    if (!line.trim()) continue;
    const mp = line.match(PARTE_RE);
    if (!mp) continue;
    const numParte = mp[1].trim();
    // Descartar líneas de cabecera/separadores accidentales.
    if (/^(no\.?\s*de?\s*parte|grupo|descripcion|pagina|listado|firma)/i.test(numParte)) continue;

    let resto = mp[2];
    // Precio (defensivo) PRIMERO: si el renglón trae un importe con decimales
    // (p. ej. "1,234.56" o "99.00") al final, lo tomamos como precio unitario y
    // lo recortamos antes de buscar "cantidad ubicación [fecha]". El formato
    // texto plano normalmente NO trae precio (entonces precioUnit queda null y
    // el valor se calcula solo si se carga el CSV con la columna Precio U.).
    let precioUnit = null;
    const mp2 = resto.match(/\s(\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2})\s*$/);
    if (mp2) {
      const val = Number(mp2[1].replace(/,/g, ""));
      if (Number.isFinite(val)) { precioUnit = val; resto = resto.slice(0, mp2.index); }
    }
    const mc = resto.match(COLA_RE);
    let existencia = null, ubicacion = "";
    if (mc) {
      existencia = Number(mc[1]);
      ubicacion = mc[2].trim();
      resto = resto.slice(0, mc.index); // la descripción es lo que queda antes
    }
    const descripcion = resto.replace(/\s+/g, " ").trim();
    // Debe tener al menos descripción o cantidad para contar como renglón válido.
    if (!descripcion && existencia == null) continue;
    out.push({ numParte, descripcion, existencia: existencia == null ? 0 : existencia, ubicacion, precioUnit });
  }
  return out;
}

// Formato A: CSV delimitado (, o ;) con o sin encabezado.
// Columnas del reporte real de refacciones (por posición, sin encabezado):
//   0 No.Parte | 1 Descripción | 2 Existencia | 3 Ubicación | 4 Clasificación
//   5 Precio U. (costo unitario) | 6 Precio Público (= valor total) | 7 Fecha
// Clasificación: L=Lento, O=Obsoleto, R=Rápido, E=Estancado, P=Próximo obsoleto, I=Inactivo.
function parseExistenciasDelimited(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const first = rows[0].map(c => c.toLowerCase());
  const hasHeader = first.some(c => /parte|descrip|exist|cantidad|ubicac|precio|clasif/.test(c));
  const dataRows = hasHeader ? rows.slice(1) : rows;

  // Mapeo de columnas. Por defecto, posición (el reporte real NO trae encabezado).
  let idx = { parte: 0, desc: 1, cant: 2, ubic: 3, clasif: 4, precioU: 5, valorTotal: 6, fecha: 7 };
  if (hasHeader) {
    const find = (re, def) => { const i = first.findIndex(c => re.test(c)); return i >= 0 ? i : def; };
    idx = {
      parte:      find(/parte|no\.?\s*de?\s*parte|n[úu]mero/, 0),
      desc:       find(/descrip/, 1),
      cant:       find(/exist|cantidad|cant\b|stock/, 2),
      ubic:       find(/ubicac|localiz|rack/, 3),
      clasif:     find(/clasif|estatus|rotaci/, 4),
      precioU:    find(/precio\s*u|costo|unit/, 5),
      valorTotal: find(/p[úu]blico|valor|importe|total/, 6),
      fecha:      find(/fecha/, 7),
    };
  }

  const num = (v) => {
    const s = String(v ?? "").replace(/"/g, "").replace(/,/g, "").trim();
    if (s === "") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };

  const out = [];
  for (const r of dataRows) {
    const numParte = (r[idx.parte] ?? "").toString().replace(/"/g, "").trim();
    if (!numParte) continue;
    // Ignorar las líneas de totales del pie ("Total Valor del Inventario...").
    if (/^total\b/i.test(numParte)) continue;

    const descripcion = (r[idx.desc] ?? "").toString().replace(/"/g, "").trim();
    const existencia = num(r[idx.cant]) ?? 0;
    const ubicRaw = (r[idx.ubic] ?? "").toString().replace(/"/g, "").trim();
    const { ubicacion, recuperada } = repararUbicacion(ubicRaw);
    const clasificacion = (r[idx.clasif] ?? "").toString().replace(/"/g, "").trim().toUpperCase();
    const precioUnit = num(r[idx.precioU]);
    const valorTotal = num(r[idx.valorTotal]);
    const fecha = (r[idx.fecha] ?? "").toString().replace(/"/g, "").trim();

    out.push({ numParte, descripcion, existencia, ubicacion, ubicRecuperada: recuperada, clasificacion, precioUnit, valorTotal, fecha });
  }
  return out;
}

// Detecta ubicaciones que Excel corrompió a NOTACIÓN CIENTÍFICA al exportar
// (p. ej. "2.04E+303"). NO intenta reconstruir el valor (no es fiable: el código
// real puede ser distinto, confirmado contra el sistema). Se DEJA TAL CUAL y solo
// se marca como "dañada" para avisar al usuario que la verifique. En el inventario
// COMPLETO, el cruce la corrige con la ubicación del MARBETE (dato real).
// Devuelve { ubicacion (sin cambios), danada }.
function esUbicacionCientifica(s) {
  return /^\d\.\d+E\+?\d+$/i.test(String(s || "").trim());
}
function repararUbicacion(s) {
  const t = String(s || "").trim();
  return { ubicacion: t, recuperada: esUbicacionCientifica(t) };
}

// --- Parseo de MARBETES (PDF) ---
// Cada renglón del PDF: Grupo  No.deParte  Descripción  Ubicación  Marbete  [Conteo]
// Ej: "GM 19282628 FILTRO DE AIRE 2.4 01A0101 000001-8"
// El marbete tiene forma dddddd-d (6 dígitos, guion, dígito verificador).
// Marbete: 6 dígitos + guion + 1 dígito verificador (dddddd-d). TOLERANTE a
// espacios alrededor del guion (el agrupador de PDF a veces deja "000001 - 8").
const MARBETE_RE = /(\d{6})\s*-\s*(\d)\b/;
// Fallback si el PDF no trae el guion: una corrida de EXACTAMENTE 7 dígitos
// aislada (p. ej. "0000018"). Se usa solo si no hubo match con guion.
const MARBETE_FALLBACK_RE = /\b(\d{7})\b/;
// Ubicación: código tipo 01A0101, 03I01101 (8), ALT0119, ENTREGAS, Z999Z.
const UBIC_RE = /\b([0-9]{2}[A-Z][0-9]{4,5}|ALT[0-9]{3,4}|ENTREGAS|Z999Z)\b/;

// Busca el marbete en una línea. Devuelve { marbete, index, length } o null.
// Normaliza "000001 - 8" → "000001-8".
function matchMarbete(line) {
  const m = line.match(MARBETE_RE);
  if (m) return { marbete: `${m[1]}-${m[2]}`, index: m.index, length: m[0].length };
  const f = line.match(MARBETE_FALLBACK_RE);
  if (f) {
    const d = f[1];
    return { marbete: `${d.slice(0, 6)}-${d.slice(6)}`, index: f.index, length: f[0].length };
  }
  return null;
}

export async function parseMarbetesFile(file, onProgress) {
  const lines = await extractPdfLines(file, onProgress);
  return parseMarbetesLines(lines);
}

// Separado para poder probar/diagnosticar con líneas ya extraídas.
export function parseMarbetesLines(lines) {
  const out = [];

  for (const raw of lines) {
    const line = String(raw || "").trim();
    if (!line) continue;

    // "MARBETE EN BLANCO" se detecta primero (no trae nº de parte ni descripción normal).
    if (/MARBETE\s+EN\s+BLANCO/i.test(line)) {
      const mb = matchMarbete(line);
      out.push({ grupo: "", numParte: "", descripcion: "MARBETE EN BLANCO",
                 ubicacion: (line.match(UBIC_RE) || [, ""])[1], marbete: mb ? mb.marbete : "", enBlanco: true });
      continue;
    }

    const mm = matchMarbete(line);
    if (!mm) continue;                       // sin marbete → no es renglón de parte
    const marbete = mm.marbete;

    // Grupo: primera palabra si es corta en mayúsculas (GM, etc.).
    const tokens = line.split(/\s+/);
    let grupo = "";
    if (/^[A-Z]{2,4}$/.test(tokens[0])) grupo = tokens[0];

    // Ubicación.
    const um = line.match(UBIC_RE);
    const ubicacion = um ? um[1] : "";

    // Número de parte: primer token (tras el grupo) que NO sea la ubicación ni
    // forme parte del marbete. Más robusto que tomar solo tokens[startIdx]: si el
    // primer candidato resulta ser la ubicación o un trozo del marbete, avanza al
    // siguiente. Acepta numéricos (19282628) y alfanuméricos (MMFR1LS, H431260C).
    let numParte = "";
    const startIdx = grupo ? 1 : 0;
    for (let i = startIdx; i < tokens.length; i++) {
      const t = tokens[i];
      if (!t) continue;
      if (UBIC_RE.test(t)) continue;                    // es la ubicación
      if (/^\d{1,6}-?\d?$/.test(t) && /\d-\d/.test(t)) continue; // trozo de marbete
      if (/^\d{6}$/.test(t) || /^\d$/.test(t)) continue; // mitades del marbete partido
      // Debe parecer un número de parte: al menos 3 chars alfanuméricos.
      if (/^[0-9A-Za-z][0-9A-Za-z\-./]{2,}$/.test(t)) { numParte = t; break; }
    }

    // Descripción: lo que queda entre el número de parte y la ubicación.
    let descripcion = "";
    if (numParte) {
      const afterParte = line.slice(line.indexOf(numParte) + numParte.length);
      const cutUbic = um ? afterParte.indexOf(um[1]) : -1;
      descripcion = (cutUbic >= 0 ? afterParte.slice(0, cutUbic) : afterParte)
        .replace(MARBETE_RE, "").replace(/\s+/g, " ").trim();
    }

    out.push({ grupo, numParte, descripcion, ubicacion, marbete });
  }
  return out;
}

// DIAGNÓSTICO: extrae las primeras `max` líneas crudas del PDF (tal como las ve
// el parser) + un resumen de cuántas contienen marbete/numParte. Sirve para ver
// el formato real del PDF del usuario cuando el cruce da 0.
export async function diagnosticarMarbetes(file, onProgress, max = 40) {
  const lines = await extractPdfLines(file, onProgress);
  const parsed = parseMarbetesLines(lines);
  const conMarbete = lines.filter(l => matchMarbete(String(l || ""))).length;
  return {
    totalLineas: lines.length,
    lineasConMarbete: conMarbete,
    marbetesParseados: parsed.filter(p => !p.enBlanco && p.numParte).length,
    sinNumParte: parsed.filter(p => !p.enBlanco && !p.numParte).length,
    muestra: lines.slice(0, max),
    muestraParseada: parsed.slice(0, Math.min(max, 15)),
  };
}

// --- CRUCE por número de parte ---
// Devuelve { items, soloMarbete, soloExistencia, resumen }.
//   items: unidades con marbete Y existencia (lo normal), o lo que haya.
// Cada item: { numParte, descripcion, ubicacion, grupo, marbete, existencia, enExistencias, enMarbetes }
export function cruzar(marbetes, existencias) {
  // Índice EXACTO (clave primaria) y TOLERANTE (fallback). El tolerante solo se
  // llena si no genera ambigüedad: si dos existencias distintas colapsan a la
  // misma clave tolerante, esa clave se marca como ambigua y NO se usa (para no
  // cruzar partes equivocadas).
  const exByParte = new Map();      // norm(numParte) -> existencia
  const exByLoose = new Map();      // normLoose(numParte) -> existencia | AMBIGUO
  const AMBIGUO = Symbol("ambiguo");
  for (const e of existencias) {
    if (!e.numParte) continue;
    exByParte.set(norm(e.numParte), e);
    const lk = normLoose(e.numParte);
    if (exByLoose.has(lk)) exByLoose.set(lk, AMBIGUO);
    else exByLoose.set(lk, e);
  }

  // Resuelve una existencia para un número de parte: exacto primero, luego
  // tolerante (si no es ambiguo). Devuelve { ex, usoLoose } o { ex:null }.
  const resolverEx = (numParte) => {
    const exacto = exByParte.get(norm(numParte));
    if (exacto) return { ex: exacto, usoLoose: false };
    const loose = exByLoose.get(normLoose(numParte));
    if (loose && loose !== AMBIGUO) return { ex: loose, usoLoose: true };
    return { ex: null, usoLoose: false };
  };

  const items = [];
  const vistos = new Set();         // claves (norm) de existencias ya cruzadas

  // 1) Recorremos los MARBETES (definen el orden del conteo físico).
  for (const m of marbetes) {
    if (m.enBlanco) { items.push({ ...m, existencia: null, enExistencias: false, enMarbetes: true }); continue; }
    const { ex } = resolverEx(m.numParte);
    if (ex) vistos.add(norm(ex.numParte));
    // UBICACIÓN: en el inventario COMPLETO el marbete trae la ubicación REAL. Si
    // la de existencias está dañada (notación científica de Excel) y el marbete
    // tiene una válida, gana la del MARBETE. Reglas:
    //   - marbete con ubicación válida          → usar la del marbete (correcta).
    //   - sin marbete → usar la de existencias (aunque esté dañada) y marcarla.
    const ubicMarb = (m.ubicacion || "").trim();
    const ubicEx = ex ? (ex.ubicacion || "").trim() : "";
    const exDanada = ex ? !!ex.ubicRecuperada : false;
    let ubicFinal, danadaFinal;
    if (ubicMarb && !esUbicacionCientifica(ubicMarb)) {
      ubicFinal = ubicMarb; danadaFinal = false;          // el marbete corrige
    } else {
      ubicFinal = ubicMarb || ubicEx;                      // lo que haya
      danadaFinal = esUbicacionCientifica(ubicFinal) || (!ubicMarb && exDanada);
    }
    items.push({
      grupo: m.grupo || "",
      numParte: m.numParte,
      descripcion: m.descripcion || (ex ? ex.descripcion : ""),
      ubicacion: ubicFinal,
      ubicRecuperada: danadaFinal,
      marbete: m.marbete,
      existencia: ex ? ex.existencia : null,
      // Datos económicos/clasificación del archivo de existencias (si cruzó).
      precioUnit: ex ? (ex.precioUnit ?? null) : null,
      clasificacion: ex ? (ex.clasificacion || "") : "",
      enExistencias: !!ex,
      enMarbetes: true,
    });
  }

  // 2) Partes que están en EXISTENCIAS pero NO tienen marbete.
  const soloExistencia = [];
  for (const e of existencias) {
    if (!e.numParte) continue;
    if (vistos.has(norm(e.numParte))) continue;
    soloExistencia.push({
      grupo: "", numParte: e.numParte, descripcion: e.descripcion,
      ubicacion: e.ubicacion, ubicRecuperada: !!e.ubicRecuperada, marbete: "", existencia: e.existencia,
      precioUnit: e.precioUnit ?? null, clasificacion: e.clasificacion || "",
      enExistencias: true, enMarbetes: false,
    });
  }

  const soloMarbete = items.filter(i => i.enMarbetes && !i.enExistencias && !i.enBlanco);

  const resumen = {
    totalMarbetes: marbetes.filter(m => !m.enBlanco).length,
    totalExistencias: existencias.filter(e => e.numParte).length,
    conAmbos: items.filter(i => i.enExistencias && i.enMarbetes).length,
    soloMarbete: soloMarbete.length,
    soloExistencia: soloExistencia.length,
    enBlanco: marbetes.filter(m => m.enBlanco).length,
  };

  return { items, soloExistencia, soloMarbete, resumen };
}

// Payload del QR de una parte: numParte | descripcion | ubicacion.
export function partQrPayload(p) {
  return `PARTE|${p.numParte}|${p.descripcion || ""}|${p.ubicacion || ""}`;
}
// Parsea un QR de parte escaneado. Devuelve {numParte, descripcion, ubicacion} o null.
export function parsePartQr(text) {
  const t = String(text || "").trim();
  if (t.startsWith("PARTE|")) {
    const [, numParte, descripcion, ubicacion] = t.split("|");
    return { numParte: (numParte || "").trim(), descripcion: descripcion || "", ubicacion: ubicacion || "" };
  }
  // Si no tiene el prefijo, puede ser un QR/código que trae solo el número de parte.
  if (t) return { numParte: t, descripcion: "", ubicacion: "" };
  return null;
}

// --- Generación de ETIQUETAS QR (3 columnas × 8 filas = 24 por hoja carta) ---
// Abre una ventana imprimible. Cada etiqueta: QR (con numParte|desc|ubic) a la
// izquierda + número de parte y descripción a la derecha. La hoja adhesiva es
// completa (sin troquel), por eso se mantienen los controles de margen/separación
// para calibrar la impresión con la hoja física.
import { qrDataUrl } from "./qrgen.js";

export async function printPartLabels(parts, opts = {}) {
  const list = (parts || []).filter(p => p.numParte);
  if (!list.length) throw new Error("No hay partes con número para generar etiquetas.");

  // Medidas por defecto (ajustables). 3 columnas × 8 filas = 24 por hoja carta.
  const cfg = {
    etiqAncho: opts.etiqAncho ?? 64,   // mm (ancho de cada etiqueta)
    cols: opts.cols ?? 3,
    filas: opts.filas ?? 8,            // 8 filas → 24 etiquetas por hoja carta
    margenSup: opts.margenSup ?? 12,   // mm desde arriba a la 1ª fila
    margenIzq: opts.margenIzq ?? 6,    // mm desde la izquierda a la 1ª columna
    margenInf: opts.margenInf ?? 6,    // mm libres abajo (la mayoría de impresoras no imprime en el borde)
    sepH: opts.sepH ?? 2,              // mm separación horizontal entre etiquetas
    sepV: opts.sepV ?? 2,              // mm separación vertical entre etiquetas
    prueba: !!opts.prueba,             // modo "hoja de prueba" (dibuja bordes)
  };
  // ALTO de cada etiqueta: se calcula para que las filas QUEPAN en la hoja carta
  // (279 mm) con los márgenes y separaciones indicados, sin pasar de 32 mm. Con los
  // valores por defecto (12 arriba, 6 abajo, 2 de separación) 8 filas salen de
  // ~30.9 mm. Si se pasa etiqAlto explícito, se respeta.
  const PAGE_H = 279;   // mm, hoja carta
  cfg.etiqAlto = opts.etiqAlto ?? Math.min(32,
    Math.floor(((PAGE_H - cfg.margenSup - cfg.margenInf - (cfg.filas - 1) * cfg.sepV) / cfg.filas) * 10) / 10);

  // Pre-generar los QR (dataURL) de todas las partes.
  const qrs = [];
  for (const p of list) qrs.push(await qrDataUrl(partQrPayload(p), { size: 160, margin: 1 }));

  const porHoja = cfg.cols * cfg.filas;
  const celda = (p, qr) => `
    <div class="etq">
      <img class="qr" src="${qr}" alt="QR">
      <div class="txt">
        <div class="np">${esc(p.numParte)}</div>
        <div class="ds">${esc((p.descripcion || "").slice(0, 40))}</div>
        ${opts.mostrarUbic && p.ubicacion ? `<div class="ub">${esc(p.ubicacion)}</div>` : ""}
      </div>
    </div>`;

  // Construir hojas.
  let hojas = "";
  for (let i = 0; i < list.length; i += porHoja) {
    const bloque = list.slice(i, i + porHoja);
    const celdas = bloque.map((p, k) => celda(p, qrs[i + k])).join("");
    hojas += `<div class="hoja">${celdas}</div>`;
  }

  const win = window.open("", "_blank", "width=820,height=1000");
  if (!win) throw new Error("El navegador bloqueó la ventana. Permite ventanas emergentes.");
  win.document.write(`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
    <title>Etiquetas de refacciones</title>
    <style>
      *{box-sizing:border-box;margin:0;padding:0}
      @page{size:letter;margin:0}
      body{font-family:system-ui,Arial,sans-serif}
      .hoja{width:216mm;height:279mm;padding:${cfg.margenSup}mm 0 0 ${cfg.margenIzq}mm;page-break-after:always;}
      .etq{display:inline-flex;align-items:center;gap:2mm;
        width:${cfg.etiqAncho}mm;height:${cfg.etiqAlto}mm;
        margin:0 ${cfg.sepH}mm ${cfg.sepV}mm 0;padding:1mm;overflow:hidden;vertical-align:top;
        ${cfg.prueba ? "border:0.2mm dashed #999;" : ""}}
      .etq .qr{width:${cfg.etiqAlto - 4}mm;height:${cfg.etiqAlto - 4}mm;flex:0 0 auto}
      .etq .txt{flex:1;min-width:0}
      .etq .np{font-size:9pt;font-weight:700;line-height:1.1;word-break:break-all}
      .etq .ds{font-size:7pt;line-height:1.05;margin-top:0.5mm}
      .etq .ub{font-size:10pt;font-weight:700;line-height:1.1;margin-top:0.8mm}
      .barra{padding:8px;background:#0f204a;color:#fff;text-align:center}
      .barra button{padding:8px 16px;font-size:14px;border:0;border-radius:6px;cursor:pointer}
      @media print{.barra{display:none}}
    </style></head><body>
    <div class="barra">
      <span style="margin-right:12px">Etiquetas QR (${cfg.cols}×${cfg.filas}) — ${list.length} partes · ${Math.ceil(list.length / porHoja)} hoja(s)</span>
      <button onclick="window.print()">🖨️ Imprimir</button>
    </div>
    ${hojas}
    <script>window.onload=()=>setTimeout(()=>window.print(),500)<\/script>
    </body></html>`);
  win.document.close();
}

function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}

// --- Utilidades ---
// Normalización ESTRICTA: mayúsculas, sin espacios. Es la clave primaria del cruce.
function norm(s) { return String(s || "").toUpperCase().replace(/\s+/g, "").trim(); }

// Normalización TOLERANTE (fallback): además quita guiones/puntos y ceros a la
// izquierda, para cruzar números que difieren solo en el formato entre el CSV de
// existencias y el PDF de marbetes (p. ej. "H431-260C" vs "H431260C", o
// "0012345" vs "12345"). Solo se usa cuando NO hubo coincidencia exacta, para no
// fusionar por error dos partes legítimamente distintas.
function normLoose(s) {
  let t = norm(s).replace(/[-.\s]/g, "");
  // Quitar ceros a la izquierda solo si lo que queda sigue teniendo contenido.
  const sinCeros = t.replace(/^0+/, "");
  return sinCeros || t;
}

// Parser CSV mínimo (separador , o ;, comillas, BOM).
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const nl = text.indexOf("\n");
  const firstLine = nl >= 0 ? text.slice(0, nl) : text;
  const SEP = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ";" : ",";
  const rows = []; let field = "", row = [], q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else {
      if (c === '"') q = true;
      else if (c === SEP) { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c === "\r") { /* ignore */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim() !== ""));
}
