// refacciones.js — Lógica del inventario de REFACCIONES:
//   1) Parseo del archivo de EXISTENCIAS (CSV/Excel exportado como CSV o texto).
//   2) Parseo del listado de MARBETES (PDF del sistema interno).
//   3) CRUCE por número de parte (une marbete + existencia).
//
// El cruce es la base para generar etiquetas QR y, luego, el reporte de
// diferencias (conteo físico vs. existencia del sistema).

import { extractPdfLines } from "./cdo.js"; // reutiliza el lector de PDF ya existente

// --- Parseo de EXISTENCIAS (CSV) ---
// Formato flexible. Columnas esperadas (en cualquier orden, con encabezado o sin él):
//   No. de Parte | Descripción | Existencia (cantidad) | Ubicación | Fecha
// Si no hay encabezado, se asume: parte, descripcion, cantidad, ubicacion, fecha.
export function parseExistenciasCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];

  // ¿La primera fila es encabezado? (si contiene palabras tipo "parte"/"desc").
  const first = rows[0].map(c => c.toLowerCase());
  const hasHeader = first.some(c => /parte|descrip|exist|cantidad|ubicac/.test(c));
  const dataRows = hasHeader ? rows.slice(1) : rows;

  // Mapear columnas por nombre si hay encabezado; si no, por posición.
  let idx = { parte: 0, desc: 1, cant: 2, ubic: 3 };
  if (hasHeader) {
    const find = (re) => first.findIndex(c => re.test(c));
    idx = {
      parte: find(/parte|no\.?\s*de?\s*parte|n[úu]mero/) ,
      desc:  find(/descrip/),
      cant:  find(/exist|cantidad|cant\b|stock/),
      ubic:  find(/ubicac|localiz|rack/),
    };
  }

  const out = [];
  for (const r of dataRows) {
    const numParte = (r[idx.parte] ?? "").toString().trim();
    if (!numParte) continue;
    const descripcion = (r[idx.desc] ?? "").toString().trim();
    const cantRaw = (r[idx.cant] ?? "").toString().replace(/[^0-9.\-]/g, "");
    const existencia = cantRaw === "" ? 0 : Number(cantRaw);
    // La ubicación suele traer un estatus pegado al final (ej "401B0402L");
    // la dejamos tal cual, limpiando espacios.
    const ubicacion = (r[idx.ubic] ?? "").toString().trim();
    out.push({ numParte, descripcion, existencia, ubicacion });
  }
  return out;
}

// --- Parseo de MARBETES (PDF) ---
// Cada renglón del PDF: Grupo  No.deParte  Descripción  Ubicación  Marbete  [Conteo]
// Ej: "GM 19282628 FILTRO DE AIRE 2.4 01A0101 000001-8"
// El marbete tiene forma dddddd-d (6 dígitos, guion, dígito verificador).
export async function parseMarbetesFile(file, onProgress) {
  const lines = await extractPdfLines(file, onProgress);
  const out = [];
  const MARBETE_RE = /\b(\d{6}-\d)\b/;
  // Ubicación: código alfanumérico tipo 01A0101, 02B0104, ALT0101, o "ENTREGAS", "Z999Z".
  const UBIC_RE = /\b([0-9]{2}[A-Z][0-9]{4}|ALT[0-9]{3,4}|ENTREGAS|Z999Z)\b/;

  for (const raw of lines) {
    const line = String(raw || "").trim();
    const mm = line.match(MARBETE_RE);
    if (!mm) continue;                       // sin marbete → no es renglón de parte
    const marbete = mm[1];

    // Grupo: primera palabra si es corta en mayúsculas (GM, etc.).
    const tokens = line.split(/\s+/);
    let grupo = "";
    if (/^[A-Z]{2,4}$/.test(tokens[0])) grupo = tokens[0];

    // Ubicación.
    const um = line.match(UBIC_RE);
    const ubicacion = um ? um[1] : "";

    // Número de parte: token tras el grupo. Puede ser numérico (19282628) o
    // alfanumérico (MMFR1LS, PF48M, SOEMX, BIRLOS, H431260C). Tomamos el token
    // que esté entre el grupo y la descripción y que NO sea la ubicación/marbete.
    let numParte = "";
    const startIdx = grupo ? 1 : 0;
    if (tokens[startIdx] && !UBIC_RE.test(tokens[startIdx]) && !MARBETE_RE.test(tokens[startIdx])) {
      numParte = tokens[startIdx];
    }

    // Descripción: lo que queda entre el número de parte y la ubicación.
    let descripcion = "";
    const afterParte = line.slice(line.indexOf(numParte) + numParte.length);
    const cutUbic = um ? afterParte.indexOf(um[1]) : -1;
    descripcion = (cutUbic >= 0 ? afterParte.slice(0, cutUbic) : afterParte)
      .replace(MARBETE_RE, "").replace(/\s+/g, " ").trim();

    // Filtrar "MARBETE EN BLANCO" (no es una parte real).
    if (/MARBETE EN BLANCO/i.test(line)) { out.push({ grupo, numParte: "", descripcion: "MARBETE EN BLANCO", ubicacion, marbete, enBlanco: true }); continue; }

    out.push({ grupo, numParte, descripcion, ubicacion, marbete });
  }
  return out;
}

// --- CRUCE por número de parte ---
// Devuelve { items, soloMarbete, soloExistencia, resumen }.
//   items: unidades con marbete Y existencia (lo normal), o lo que haya.
// Cada item: { numParte, descripcion, ubicacion, grupo, marbete, existencia, enExistencias, enMarbetes }
export function cruzar(marbetes, existencias) {
  const exByParte = new Map();
  for (const e of existencias) if (e.numParte) exByParte.set(norm(e.numParte), e);

  const items = [];
  const vistos = new Set();

  // 1) Recorremos los MARBETES (definen el orden del conteo físico).
  for (const m of marbetes) {
    if (m.enBlanco) { items.push({ ...m, existencia: null, enExistencias: false, enMarbetes: true }); continue; }
    const key = norm(m.numParte);
    const ex = exByParte.get(key);
    vistos.add(key);
    items.push({
      grupo: m.grupo || "",
      numParte: m.numParte,
      descripcion: m.descripcion || (ex ? ex.descripcion : ""),
      ubicacion: m.ubicacion || (ex ? ex.ubicacion : ""),
      marbete: m.marbete,
      existencia: ex ? ex.existencia : null,
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
      ubicacion: e.ubicacion, marbete: "", existencia: e.existencia,
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

// --- Generación de ETIQUETAS QR (Janel 32×64 mm, 12 por hoja: 3 col × 4 filas) ---
// Abre una ventana imprimible. Cada etiqueta: QR (con numParte|desc|ubic) a la
// izquierda + número de parte y descripción a la derecha. Incluye controles de
// margen/separación para calibrar la impresión con las etiquetas físicas.
import { qrDataUrl } from "./qrgen.js";

export async function printPartLabels(parts, opts = {}) {
  const list = (parts || []).filter(p => p.numParte);
  if (!list.length) throw new Error("No hay partes con número para generar etiquetas.");

  // Medidas por defecto (ajustables). Janel 32×64 mm, 3 columnas × 4 filas.
  const cfg = {
    etiqAncho: opts.etiqAncho ?? 64,   // mm (la etiqueta es 64 de ancho × 32 de alto)
    etiqAlto:  opts.etiqAlto  ?? 32,
    cols: opts.cols ?? 3,
    filas: opts.filas ?? 4,
    margenSup: opts.margenSup ?? 12,   // mm desde arriba a la 1ª fila
    margenIzq: opts.margenIzq ?? 6,    // mm desde la izquierda a la 1ª columna
    sepH: opts.sepH ?? 2,              // mm separación horizontal entre etiquetas
    sepV: opts.sepV ?? 2,              // mm separación vertical entre etiquetas
    prueba: !!opts.prueba,             // modo "hoja de prueba" (dibuja bordes)
  };

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
      .barra{padding:8px;background:#0f204a;color:#fff;text-align:center}
      .barra button{padding:8px 16px;font-size:14px;border:0;border-radius:6px;cursor:pointer}
      @media print{.barra{display:none}}
    </style></head><body>
    <div class="barra">
      <span style="margin-right:12px">Etiquetas Janel 32×64 — ${list.length} partes · ${Math.ceil(list.length / porHoja)} hoja(s)</span>
      <button onclick="window.print()">🖨️ Imprimir</button>
    </div>
    ${hojas}
    <script>window.onload=()=>setTimeout(()=>window.print(),500)<\/script>
    </body></html>`);
  win.document.close();
}

function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}

// --- Utilidades ---
function norm(s) { return String(s || "").toUpperCase().replace(/\s+/g, "").trim(); }

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
