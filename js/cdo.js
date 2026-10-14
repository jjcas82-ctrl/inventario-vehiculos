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

// Parsea las líneas del CDO y devuelve un array de unidades detectadas.
// Cada unidad: { vin, make, model, version, color, year, raw }.
export function parseCdoLines(lines) {
  const units = [];
  for (let i = 0; i < lines.length; i++) {
    const found = findVinAt(lines, i);
    if (!found) continue;

    const unit = { vin: found.vin, make: "", model: "", version: "", color: "", year: "", raw: [] };
    unit.raw.push(lines[i]);
    if (found.consumed) unit.raw.push(lines[i + 1]);

    // Buscamos hacia adelante (ventana corta) la descripción, el año y el color.
    const windowEnd = Math.min(lines.length, i + 12);
    for (let j = i + 1 + found.consumed; j < windowEnd; j++) {
      const l = lines[j];
      // Si aparece otro VIN, cortamos: empieza otra unidad.
      if (findVinAt(lines, j)) break;

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

function toTitle(s) {
  return String(s || "").toLowerCase().replace(/\b([a-záéíóúñ])/g, c => c.toUpperCase()).trim();
}

// Orquesta: lee el PDF y devuelve las unidades parseadas.
export async function parseCdoFile(file, onProgress) {
  const lines = await extractPdfLines(file, onProgress);
  const units = parseCdoLines(lines);
  return { units, totalLines: lines.length };
}
