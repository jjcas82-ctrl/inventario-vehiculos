// cdo.js — Carga del archivo CDO de GM ("Unidades facturadas") para precargar
// unidades en estatus "En tránsito".
//
// El CDO es un PDF con una TABLA. Al extraer su texto, cada unidad queda repartida
// en varias líneas (la celda del VIN es angosta y parte el VIN en 2 renglones).
// Este módulo:
//   1) Carga pdf.js (local vendor/ con respaldo CDN) y extrae el texto por página.
//   2) Detecta cada unidad anclándose en el VIN (17 caracteres, posiblemente partido).
//   3) Extrae marca, modelo, versión, color y año de la "Descripción del vehículo".
//
// Pensado para flotillas de 100+ unidades: parseo con progreso y guardado masivo.

import { normalizeVin } from "./vin.js";

const PDFJS_LOCAL = "../vendor/pdfjs/pdf.min.mjs";
const PDFJS_WORKER_LOCAL = "../vendor/pdfjs/pdf.worker.min.mjs";
const PDFJS_CDN = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs";
const PDFJS_WORKER_CDN = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs";

// Carga pdf.js: primero local (offline), si no, CDN.
async function loadPdfjs() {
  let mod, workerSrc;
  try {
    mod = await import(/* @vite-ignore */ PDFJS_LOCAL);
    workerSrc = PDFJS_WORKER_LOCAL;
  } catch (e) {
    mod = await import(/* @vite-ignore */ PDFJS_CDN);
    workerSrc = PDFJS_WORKER_CDN;
  }
  const pdfjs = mod.default || mod;
  if (pdfjs.GlobalWorkerOptions) pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
  return pdfjs;
}

// Extrae TODO el texto del PDF, línea por línea, respetando el orden de lectura.
// onProgress(pageActual, totalPaginas) para feedback con archivos grandes.
export async function extractPdfLines(file, onProgress) {
  const pdfjs = await loadPdfjs();
  const buf = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: buf }).promise;
  const lines = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    if (onProgress) onProgress(p, pdf.numPages);
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    // Agrupamos los fragmentos de texto por su coordenada Y (misma línea visual).
    const byLine = new Map();
    for (const item of content.items) {
      if (!item.str) continue;
      const y = Math.round(item.transform[5]); // posición vertical
      const x = item.transform[4];
      if (!byLine.has(y)) byLine.set(y, []);
      byLine.get(y).push({ x, s: item.str });
    }
    // Ordenamos: líneas de arriba hacia abajo (Y desc), y dentro, de izq. a der. (X asc).
    const ys = [...byLine.keys()].sort((a, b) => b - a);
    for (const y of ys) {
      const parts = byLine.get(y).sort((a, b) => a.x - b.x);
      const text = parts.map(p => p.s).join(" ").replace(/\s+/g, " ").trim();
      if (text) lines.push(text);
    }
  }
  return lines;
}

const VIN_RE = /\b[A-HJ-NPR-Z0-9]{17}\b/;          // VIN completo en una línea
const VIN_HEAD_RE = /([A-HJ-NPR-Z0-9]{11,13})\s*$/; // VIN partido: cola de una línea
const YEAR_RE = /\b(19|20)\d{2}\b/;
const DESC_RE = /^UN\s+(VEHICULO|CAMION)\b/i;
const DESC_ANY_RE = /UN\s+(VEHICULO|CAMION)\b/i;    // descripción en cualquier parte

// --- Patrones para los campos del ENCABEZADO de facturación del CDO ---
// (ov, cveVeh, factura, numMov, aduana, pedimento, fechaPedimento, modeloGm, fechaFactura).
const FECHA_RE = /\b(\d{4}-\d{2}-\d{2})\b/;              // fecha YYYY-MM-DD
const FACTURA_RE = /^\d{6,8}$/;                          // línea que es solo dígitos (6-8)
const NUMMOV_RE = /^[A-Z]{2,4}\d{5,}$/;                  // Num. Mov. tipo "CAD56712631"
const PEDIMENTO_RE = /^\d{4}-\w\d-\d{6,7}$/;             // pedimento "4024-F3-6002272"
// Línea del modelo GM: "1VC26 1SL/E 2026 N 351,421.31 ..." → primer token = clave GM.
const MODELO_GM_LINE_RE = /^([0-9A-Z]{4,6})\s+\S+\s+(?:19|20)\d{2}\s+N\b/;

// Marcas conocidas que aparecen en la descripción de GM.
const MARCAS = ["CHEVROLET", "GMC", "BUICK", "CADILLAC"];

// Intenta reconstruir el VIN a partir de la línea actual y las siguientes.
// Devuelve { vin, consumed } (consumed = cuántas líneas extra usó) o null.
function findVinAt(lines, i) {
  const line = lines[i];
  // Caso 1: VIN completo en la línea.
  const whole = line.match(VIN_RE);
  if (whole) return { vin: whole[0], consumed: 0 };
  // Caso 2: la línea termina con la cabeza del VIN (11-13 chars) y la siguiente
  // trae el resto (la celda angosta partió el VIN).
  const head = line.match(VIN_HEAD_RE);
  if (head && i + 1 < lines.length) {
    const tail = (lines[i + 1].match(/^([A-HJ-NPR-Z0-9]{3,6})\b/) || [])[1];
    if (tail) {
      const candidate = normalizeVin(head[1] + tail);
      if (candidate.length === 17 && VIN_RE.test(candidate)) {
        return { vin: candidate, consumed: 1 };
      }
    }
  }
  return null;
}

// De una línea de descripción ("UN VEHICULO CHEVROLET GROOVE SUV PAQ. E LT ...")
// separa marca, modelo y versión.
function parseDescription(desc) {
  let make = "", model = "", version = "";
  const up = desc.toUpperCase();
  const mk = MARCAS.find(m => up.includes(m));
  if (mk) {
    make = mk.charAt(0) + mk.slice(1).toLowerCase(); // Chevrolet
    // Lo que sigue a la marca: primer token = modelo; el resto = versión.
    const after = desc.slice(up.indexOf(mk) + mk.length).trim();
    const tokens = after.split(/\s+/);
    model = tokens.shift() || "";
    version = tokens.join(" ").replace(/\s+/g, " ").trim();
  } else {
    // Sin marca reconocida: dejamos todo como versión para no perder el dato.
    version = desc.replace(/^UN\s+(VEHICULO|CAMION)\s*/i, "").trim();
  }
  return { make, model, version };
}

// Extrae los campos del ENCABEZADO de facturación a partir de las líneas crudas
// (ventana) de una unidad. Es TOLERANTE: usa regex sobre cada línea y, si un
// campo no se encuentra, lo deja como "". No rompe la extracción existente.
//
// Layout típico por unidad:
//   FXFPB4 003AM05 LZWRLMGL2TB5   <- ov, cveVeh, VIN(parte1)
//   71002                          <- VIN(parte2)
//   5751787                        <- factura (solo dígitos)
//   CAD56712631                    <- numMov
//   TOLUCA,EDO. DE MÉXICO          <- aduana
//   4024-F3-6002272                <- pedimento
//   2026-07-07                     <- fechaPedimento (primera fecha)
//   1VC26 1SL/E 2026 N 351,421.31  <- modeloGm (primer token)
//   UN VEHICULO CHEVROLET GROOVE…  <- descripción
//   ROJO METALICO                  <- color
//   2026-10-12                     <- fechaFactura (última fecha)
function extractHeaderFields(rawLines, vinLine) {
  const h = {
    ov: "", cveVeh: "", factura: "", numMov: "", aduana: "",
    pedimento: "", fechaPedimento: "", modeloGm: "", fechaFactura: "",
  };
  const fechas = []; // todas las fechas encontradas, en orden de aparición

  // ov y cveVeh: los 2 primeros tokens de la línea que contiene el VIN (parte1).
  if (vinLine) {
    const toks = vinLine.trim().split(/\s+/);
    if (toks.length >= 2) {
      // Solo si parecen claves (alfanuméricas) y no el VIN completo mismo.
      if (/^[A-Z0-9]{3,8}$/i.test(toks[0]) && !VIN_RE.test(toks[0])) h.ov = toks[0];
      if (/^[A-Z0-9]{3,10}$/i.test(toks[1]) && !VIN_RE.test(toks[1])) h.cveVeh = toks[1];
    }
  }

  for (const l of rawLines) {
    const line = String(l || "").trim();
    if (!line) continue;

    // Fechas (acumulamos todas: primera = fechaPedimento, última = fechaFactura).
    const fm = line.match(FECHA_RE);
    if (fm) fechas.push(fm[1]);

    // Factura: línea que es SOLO dígitos (6-8).
    if (!h.factura && FACTURA_RE.test(line)) { h.factura = line; continue; }

    // Num. Mov.: letras+dígitos tipo "CAD56712631".
    if (!h.numMov && NUMMOV_RE.test(line)) { h.numMov = line; continue; }

    // Pedimento: "4024-F3-6002272" (o similar con guiones).
    if (!h.pedimento) {
      const pm = line.match(PEDIMENTO_RE) || line.match(/\b\d{4}-\w\d-\d{6,7}\b/);
      if (pm) { h.pedimento = pm[0] || line; continue; }
    }

    // Modelo GM: primer token de la línea "clave Pq Año N Precio…".
    if (!h.modeloGm) {
      const mm = line.match(MODELO_GM_LINE_RE);
      if (mm) { h.modeloGm = mm[1]; continue; }
    }

    // Aduana: línea con texto en mayúsculas que incluye "EDO." o estado/ciudad.
    // Heurística tolerante: contiene letras + coma y NO es descripción/color simple.
    if (!h.aduana && /[A-ZÁÉÍÓÚÑ]/.test(line) && /,/.test(line) &&
        !DESC_ANY_RE.test(line) && !FACTURA_RE.test(line) && !NUMMOV_RE.test(line)) {
      h.aduana = line.replace(/\s+/g, " ").trim();
      continue;
    }
  }

  if (fechas.length) {
    h.fechaPedimento = fechas[0];
    h.fechaFactura = fechas[fechas.length - 1];
  }
  return h;
}

// Parsea las líneas del CDO y devuelve un array de unidades detectadas.
// Cada unidad: { vin, make, model, version, color, year, raw } + campos del
// encabezado de facturación (ov, cveVeh, factura, numMov, aduana, pedimento,
// fechaPedimento, modeloGm, fechaFactura).
export function parseCdoLines(lines) {
  const units = [];
  for (let i = 0; i < lines.length; i++) {
    const found = findVinAt(lines, i);
    if (!found) continue;

    const unit = {
      vin: found.vin, make: "", model: "", version: "", color: "", year: "", raw: [],
      // Campos del encabezado de facturación (se completan abajo).
      ov: "", cveVeh: "", factura: "", numMov: "", aduana: "",
      pedimento: "", fechaPedimento: "", modeloGm: "", fechaFactura: "",
    };
    const vinLine = lines[i]; // línea que contiene el VIN (parte1) → ov/cveVeh
    unit.raw.push(lines[i]);
    if (found.consumed) unit.raw.push(lines[i + 1]);

    // Ventana de líneas crudas de ESTA unidad (para extraer el encabezado).
    const windowLines = [];

    // Buscamos hacia adelante (ventana corta) la descripción, el año y el color.
    const windowEnd = Math.min(lines.length, i + 12);
    for (let j = i + 1 + found.consumed; j < windowEnd; j++) {
      const l = lines[j];
      // Si aparece otro VIN, cortamos: empieza otra unidad.
      if (findVinAt(lines, j)) break;
      windowLines.push(l);

      if (!unit.model && DESC_RE.test(l)) {
        const { make, model, version } = parseDescription(l);
        unit.make = make; unit.model = model; unit.version = version;
        unit.raw.push(l);
        // El color suele venir en la MISMA zona (línea siguiente a la descripción).
        const next = lines[j + 1] || "";
        if (next && !DESC_RE.test(next) && !findVinAt(lines, j + 1) && /^[A-ZÁÉÍÓÚÑ ]{3,30}$/.test(next)) {
          unit.color = toTitle(next);
        }
        continue;
      }
      // Año del modelo (p. ej. en "1VC26 1SL/E 2026 N 351,421.31 ...").
      if (!unit.year) {
        const ym = l.match(YEAR_RE);
        if (ym) unit.year = ym[0];
      }
    }
    // Ampliación best-effort: campos del encabezado de facturación.
    // La ventana incluye la línea del VIN (parte2) para no perder la factura
    // cuando viene inmediatamente después del VIN partido.
    const headerWindow = (found.consumed ? [lines[i + 1]] : []).concat(windowLines);
    Object.assign(unit, extractHeaderFields(headerWindow, vinLine));
    units.push(unit);
    i += found.consumed; // saltar la línea del VIN partido ya consumida
  }
  return dedupeByVin(units);
}

function dedupeByVin(units) {
  const seen = new Map();
  for (const u of units) if (!seen.has(u.vin)) seen.set(u.vin, u);
  return [...seen.values()];
}

// MÉTODO ROBUSTO (respaldo): opera sobre el texto completo del documento.
// Útil cuando pdf.js no separa las líneas igual que en el ejemplo. Busca TODOS
// los VIN de 17 caracteres (incluso partidos por espacios/saltos) y, para cada
// uno, toma la descripción "UN VEHICULO/CAMION..." más cercana a continuación.
function parseCdoWhole(lines) {
  // Texto plano con marcadores de salto para poder ubicar descripciones.
  const full = lines.join("\n");
  // 1) Quitar espacios DENTRO de posibles VIN: unimos tokens alfanuméricos
  //    contiguos separados solo por espacios/saltos y luego buscamos 17 chars.
  //    Para no romper el texto, trabajamos sobre una copia "compacta".
  const compact = full.replace(/[ \t]*\n[ \t]*/g, "\n");

  const units = [];
  // Busca VIN completos primero.
  const vinGlobal = /[A-HJ-NPR-Z0-9]{17}/g;
  // También intenta VIN partido por UN salto de línea: 11-14 + resto hasta 17.
  const vinSplit = /([A-HJ-NPR-Z0-9]{10,14})\n([A-HJ-NPR-Z0-9]{3,7})/g;

  const foundVins = new Set();

  // a) partidos por salto de línea
  let m;
  while ((m = vinSplit.exec(compact))) {
    const cand = (m[1] + m[2]).replace(/[^A-HJ-NPR-Z0-9]/g, "");
    if (cand.length === 17) foundVins.add(cand);
  }
  // b) completos en una corrida
  while ((m = vinGlobal.exec(full.replace(/\s+/g, " ")))) {
    foundVins.add(m[0]);
  }

  // Para cada VIN, buscar su descripción (la más cercana después de su aparición).
  const descMatches = [];
  const descGlobal = /UN\s+(?:VEHICULO|CAMION)[^\n]*/gi;
  let dm;
  const flat = full.replace(/\s+/g, " ");
  while ((dm = descGlobal.exec(flat))) descMatches.push({ idx: dm.index, text: dm[0] });

  for (const vin of foundVins) {
    const unit = {
      vin, make: "", model: "", version: "", color: "", year: "", raw: [vin],
      // Campos del encabezado de facturación (best-effort en el método robusto).
      ov: "", cveVeh: "", factura: "", numMov: "", aduana: "",
      pedimento: "", fechaPedimento: "", modeloGm: "", fechaFactura: "",
    };
    // Posición del VIN en el texto plano (para asociar la descripción siguiente).
    const pos = flat.indexOf(vin.slice(0, 8)); // por si el VIN está partido, buscar su cabeza
    const desc = descMatches.find(d => d.idx > (pos >= 0 ? pos : 0)) || descMatches[0];
    if (desc) {
      const parsed = parseDescription(desc.text);
      unit.make = parsed.make; unit.model = parsed.model; unit.version = parsed.version;
      // Color: palabra(s) en mayúsculas justo después de la descripción.
      const after = flat.slice(desc.idx + desc.text.length, desc.idx + desc.text.length + 40);
      const col = after.match(/\b([A-ZÁÉÍÓÚÑ]{3,}(?:\s+[A-ZÁÉÍÓÚÑ]{2,})?)\b/);
      if (col) unit.color = toTitle(col[1]);
    }
    const ym = flat.match(YEAR_RE);
    if (ym) unit.year = ym[0];

    // Ampliación best-effort del encabezado: tomamos la ventana de líneas
    // crudas cercana a la aparición del VIN y reutilizamos el extractor.
    // Si no se puede ubicar con claridad, los campos quedan en "".
    try {
      const vinIdx = lines.findIndex(l => l.includes(vin.slice(0, 8)) || l.includes(vin));
      if (vinIdx >= 0) {
        const win = lines.slice(vinIdx, Math.min(lines.length, vinIdx + 13));
        Object.assign(unit, extractHeaderFields(win, lines[vinIdx]));
      }
    } catch (e) { /* best-effort: no romper el parseo robusto */ }

    units.push(unit);
  }
  return dedupeByVin(units);
}

function toTitle(s) {
  return String(s || "").toLowerCase().replace(/\b([a-záéíóúñ])/g, c => c.toUpperCase()).trim();
}

// Orquesta: lee el PDF y devuelve las unidades parseadas.
// Usa el método por líneas y, si detecta pocas unidades, el método robusto
// sobre el texto completo. Devuelve también las líneas crudas (diagnóstico).
export async function parseCdoFile(file, onProgress) {
  const lines = await extractPdfLines(file, onProgress);
  let units = parseCdoLines(lines);
  let method = "lineas";
  if (!units.length) {
    units = parseCdoWhole(lines);
    method = "robusto";
  }
  return { units, totalLines: lines.length, lines, method };
}
