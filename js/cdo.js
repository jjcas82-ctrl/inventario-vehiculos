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
  const { lines } = await extractPdfPages(file, onProgress);
  return lines;
}

// Extrae el texto devolviendo TAMBIÉN las líneas agrupadas por página. Esto es
// clave para CDO de varias hojas: cada página tiene su propio bloque de columnas,
// así que hay que parsear página por página (si se concatenan todas, el método
// por columnas solo "ve" el primer bloque y pierde las demás hojas).
export async function extractPdfPages(file, onProgress) {
  const pdfjs = await loadPdfjs();
  const buf = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: buf }).promise;
  const lines = [];     // todas las líneas (compat.)
  const pages = [];     // array de arrays de líneas, una entrada por página
  for (let p = 1; p <= pdf.numPages; p++) {
    if (onProgress) onProgress(p, pdf.numPages);
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const byLine = new Map();
    for (const item of content.items) {
      if (!item.str) continue;
      const y = Math.round(item.transform[5]);
      const x = item.transform[4];
      if (!byLine.has(y)) byLine.set(y, []);
      byLine.get(y).push({ x, s: item.str });
    }
    const ys = [...byLine.keys()].sort((a, b) => b - a);
    const pageLines = [];
    for (const y of ys) {
      const parts = byLine.get(y).sort((a, b) => a.x - b.x);
      const text = parts.map(pp => pp.s).join(" ").replace(/\s+/g, " ").trim();
      if (text) { pageLines.push(text); lines.push(text); }
    }
    pages.push(pageLines);
  }
  return { lines, pages };
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
// Importe monetario: "351,421.31", "0.00", "10,271.00" (miles con coma, 2 decimales).
const MONEY_RE = /\d{1,3}(?:,\d{3})*\.\d{2}/g;
// Línea de precios de una unidad: "1VC26 1SL/E 2026 N 351,421.31 0.00 10,271.00 57,870.77 7,801.55"
//   = modeloGm Pq Año N/U | Precio ISAN Gastos IVA HB   (el Total va en otra columna)
const PRECIO_LINE_RE = /^([0-9A-Z]{4,6})\s+(\S+)\s+((?:19|20)\d{2})\s+([NU])\b(.*)$/;

// Convierte "351,421.31" → número 351421.31 (o null si no es importe).
function parseMoney(s) {
  if (!s) return null;
  const m = String(s).match(/\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2}/);
  if (!m) return null;
  return parseFloat(m[0].replace(/,/g, ""));
}
// Formatea número a importe con comas: 351421.31 → "351,421.31".
function fmtMoney(n) {
  if (n == null || isNaN(n)) return "";
  return Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Extrae los importes (pq, precio, isan, gastos, iva, hb) de la línea de precios
// de una unidad. El Total NO viene aquí (es otra columna), se calcula o se toma
// aparte. Devuelve objeto con strings formateados (o "").
function extractAmountsFromPriceLine(line) {
  const out = { pq: "", precio: "", isan: "", gastos: "", iva: "", hb: "" };
  const m = String(line || "").match(PRECIO_LINE_RE);
  if (!m) return out;
  out.pq = m[2] || "";
  const nums = (m[5] || "").match(MONEY_RE) || [];
  // Orden esperado tras "N": Precio, ISAN, Gastos, IVA, HB.
  if (nums[0] != null) out.precio = nums[0];
  if (nums[1] != null) out.isan = nums[1];
  if (nums[2] != null) out.gastos = nums[2];
  if (nums[3] != null) out.iva = nums[3];
  if (nums[4] != null) out.hb = nums[4];
  return out;
}

// Calcula el Total de una unidad = Precio + ISAN + Gastos + IVA + HB (si hay datos).
function computeTotal(a) {
  const n = ["precio", "isan", "gastos", "iva", "hb"].map(k => parseMoney(a[k]) || 0);
  const sum = n.reduce((x, y) => x + y, 0);
  return sum > 0 ? fmtMoney(sum) : "";
}

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
      // Importes financieros (Pq, Precio, ISAN, Gastos, IVA, HB/Holdback, Total).
      pq: "", precio: "", isan: "", gastos: "", iva: "", hb: "", total: "",
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
      // Importes: la línea de precios "clave Pq Año N Precio ISAN Gastos IVA HB".
      if (!unit.precio && PRECIO_LINE_RE.test(l)) {
        const a = extractAmountsFromPriceLine(l);
        unit.pq = a.pq; unit.precio = a.precio; unit.isan = a.isan;
        unit.gastos = a.gastos; unit.iva = a.iva; unit.hb = a.hb;
      }
    }
    // El Total por unidad = suma de los importes (si se leyeron).
    unit.total = computeTotal(unit);
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

// MÉTODO POR COLUMNAS: algunos PDFs del CDO se extraen "transpuestos", es decir,
// pdf.js devuelve el contenido COLUMNA por columna (todos los VIN juntos, todas
// las facturas juntas, todos los colores juntos, etc.), no fila por fila.
// Reconstruimos cada unidad emparejando por POSICIÓN dentro de cada columna.
//
// El ancla es la línea "Serie" seguida de los VIN (posiblemente partidos). De ahí
// obtenemos cuántas unidades hay y sus VIN. Luego ubicamos cada columna por su
// encabezado o por su patrón y emparejamos por índice.
export function parseCdoColumns(lines) {
  const txt = lines.map(l => String(l || "").trim());

  // 1) Localizar la línea de VIN: la que contiene 2+ secuencias tipo VIN-largo.
  //    En el ejemplo: "LZWRLMGL2TB5 71002 1GCPT9EK7T13 21682 LZWPPMGN5TF0 34551"
  //    Tras "Serie". Buscamos la línea con más tokens alfanuméricos "VIN-like".
  const vinLineIdx = findVinColumnLine(txt);
  if (vinLineIdx < 0) return [];

  const vins = reconstructVinsFromColumn(txt[vinLineIdx]);
  if (!vins.length) return [];
  const n = vins.length;

  // 2) Para cada "columna" conocida, obtener n valores emparejados por índice.
  const facturas = pickColumnValues(txt, /^Factura$/i, v => /^\d{6,8}$/.test(v), n);
  const colores = pickColorColumn(txt, n);
  // Fechas y pedimentos vienen partidos con espacio tras el guion ("2026- 10-12",
  // "4024-F3- 6002272"); por eso se reconstruyen a nivel de LÍNEA, no de token.
  const { fechasPedi, fechasFact } = pickAllFechas(txt, n);
  const pedimentos = pickPedimentos(txt, n);
  const modelosGm = pickColumnValues(txt, /^Model|^Modelo/i, v => /^[0-9A-Z]{4,6}$/.test(v) && /\d/.test(v), n);
  const anios = pickColumnValues(txt, /Año|Mod\./i, v => /^(19|20)\d{2}$/.test(v), n);
  const ovs = pickColumnValues(txt, /^O\.?\/?V\.?$/i, v => /^[A-Z0-9]{5,7}$/.test(v), n);
  const cves = pickColumnValues(txt, /Cve\.?Veh/i, v => /^[0-9A-Z]{6,8}$/.test(v), n);
  const nummovs = reconstructNumMovs(txt, n);
  // Importes: 1º por línea de precios emparejada por modeloGm; 2º respaldo por
  // columnas (Precio/ISAN/Gastos/IVA/HB como bloques de n valores cada uno).
  const amountsByModelo = extractAmountsByModelo(txt);
  const amountCols = extractAmountColumns(txt, n);

  const units = [];
  for (let k = 0; k < n; k++) {
    const unit = {
      vin: vins[k], make: "", model: "", version: "", color: "", year: "", raw: [vins[k]],
      ov: ovs[k] || "", cveVeh: cves[k] || "", factura: facturas[k] || "",
      numMov: nummovs[k] || "", aduana: "", pedimento: pedimentos[k] || "",
      fechaPedimento: fechasPedi[k] || "", modeloGm: modelosGm[k] || "",
      fechaFactura: fechasFact[k] || "",
      pq: "", precio: "", isan: "", gastos: "", iva: "", hb: "", total: "",
    };
    // Importes: 1º por clave de modelo GM (línea de precios); 2º respaldo por
    // columnas emparejadas por posición.
    const amt = amountsByModelo[modelosGm[k]];
    if (amt) {
      unit.pq = amt.pq; unit.precio = amt.precio; unit.isan = amt.isan;
      unit.gastos = amt.gastos; unit.iva = amt.iva; unit.hb = amt.hb;
    } else if (amountCols) {
      unit.precio = amountCols.precio[k] || "";
      unit.isan = amountCols.isan[k] || "";
      unit.gastos = amountCols.gastos[k] || "";
      unit.iva = amountCols.iva[k] || "";
      unit.hb = amountCols.hb[k] || "";
    }
    unit.total = computeTotal(unit);
    // En el CDO de GM la marca es siempre Chevrolet/GMC/etc.
    // NOTA: en PDFs "transpuestos" muy desordenados, los NOMBRES de modelo no se
    // pueden emparejar de forma fiable por posición (riesgo de asignar el modelo
    // equivocado). Preferimos NO adivinar: dejamos el modelo vacío (se completará
    // al dar entrada o editando la ficha). El modeloGm (clave) SÍ queda bien
    // emparejado por columna y permite identificar el modelo con certeza.
    unit.make = "Chevrolet";
    unit.model = ""; // se completa al dar entrada (NHTSA decodifica el VIN); evita emparejado erróneo
    if (colores[k]) unit.color = toTitle(colores[k]);
    if (anios[k]) unit.year = anios[k];
    units.push(unit);
  }
  return dedupeByVin(units);
}

// Encuentra la línea que contiene la columna de VIN. Cuenta tanto VINs COMPLETOS
// (17 chars) como "cabezas" de VIN partido (10-13 chars). Una línea Serie puede
// mezclar ambos (unos VIN vienen enteros y otros partidos). Reconstruye y verifica
// que de verdad salgan ≥1 VIN válidos para elegir la mejor línea.
function findVinColumnLine(txt) {
  let best = -1, bestCount = 0;
  for (let i = 0; i < txt.length; i++) {
    const completos = (txt[i].match(/\b[A-HJ-NPR-Z0-9]{17}\b/g) || []).length;
    const cabezas = (txt[i].match(/\b[A-HJ-NPR-Z0-9]{10,14}\b/g) || []).length;
    // "Señal" de línea de VINs: hay varias cabezas, o al menos un VIN completo + algo.
    const score = completos * 2 + cabezas;
    if (score < 2) continue;
    // Confirmar reconstruyendo: debe producir al menos 1 VIN válido.
    const vins = reconstructVinsFromColumn(txt[i]);
    if (vins.length && vins.length >= bestCount) {
      // Preferimos la línea que produce MÁS VINs válidos.
      if (vins.length > bestCount || best < 0) { bestCount = vins.length; best = i; }
    }
  }
  return best;
}

// Reconstruye los VIN de una línea tipo "AAAA 11111 BBBB 22222 CCCC 33333".
// Une cada cabeza (10-14) con la cola siguiente (3-7) hasta formar 17.
function reconstructVinsFromColumn(line) {
  const toks = String(line || "").split(/\s+/).filter(Boolean);
  const vins = [];
  let i = 0;
  while (i < toks.length) {
    let acc = toks[i].replace(/[^A-HJ-NPR-Z0-9]/g, "");
    i++;
    // Acumula tokens siguientes hasta llegar a 17 (por si viene en 2 o 3 trozos).
    while (acc.length < 17 && i < toks.length) {
      acc += toks[i].replace(/[^A-HJ-NPR-Z0-9]/g, "");
      i++;
    }
    if (acc.length === 17 && VIN_RE.test(acc)) vins.push(acc);
  }
  return vins;
}

// Devuelve n valores de una "columna": busca una línea que haga match con `header`
// y toma los valores (de esa línea o de las siguientes) que cumplan `valid`.
// Si `inline` es true, los valores pueden venir TODOS en una sola línea.
function pickColumnValues(txt, headerRe, valid, n, inline = false) {
  for (let i = 0; i < txt.length; i++) {
    if (!headerRe.test(txt[i])) continue;
    // Reunir candidatos desde la misma línea y las siguientes.
    const pool = [];
    for (let j = i; j < Math.min(txt.length, i + 6); j++) {
      const toks = txt[j].split(/\s+/).filter(Boolean);
      for (const t of toks) if (valid(t)) pool.push(t);
      if (pool.length >= n) break;
    }
    if (pool.length >= n) return pool.slice(0, n);
  }
  // Respaldo: buscar en TODO el texto los que cumplan el patrón.
  const all = [];
  for (const l of txt) for (const t of l.split(/\s+/)) if (valid(t)) all.push(t);
  return all.slice(0, n);
}

// Color: busca la línea con colores (p. ej. "ROJO METALICO GRIS TIBURON ...").
// Los colores son 1-2 palabras en mayúsculas; emparejamos por índice.
function pickColorColumn(txt, n) {
  const COLORS = ["ROJO", "GRIS", "BLANCO", "NEGRO", "AZUL", "PLATA", "PLATEADO", "VERDE",
    "CAFE", "CAFÉ", "BEIGE", "DORADO", "AMARILLO", "NARANJA", "VINO", "ARENA", "COBRE"];
  for (let i = 0; i < txt.length; i++) {
    const up = txt[i].toUpperCase();
    const hits = COLORS.filter(c => up.includes(c)).length;
    if (hits >= 1 && /METALICO|TIBURON|PERLA|MATE|SOLIDO|METÁLICO/.test(up) || hits >= 2) {
      // Partir en colores de 1-2 palabras.
      const words = txt[i].split(/\s+/);
      const out = [];
      for (let w = 0; w < words.length; w++) {
        const base = words[w].toUpperCase();
        if (COLORS.includes(base)) {
          // ¿La siguiente palabra es un modificador (METALICO, etc.)?
          const next = (words[w + 1] || "").toUpperCase();
          if (/METALICO|METÁLICO|TIBURON|PERLA|MATE|SOLIDO|CLARO|OSCURO/.test(next)) {
            out.push(words[w] + " " + words[w + 1]); w++;
          } else out.push(words[w]);
        }
      }
      if (out.length) return padTo(out, n);
    }
  }
  return padTo([], n);
}

// Descripciones: todas las "UN VEHICULO/CAMION ..." en orden.
function pickDescriptions(txt, n) {
  const flat = txt.join(" ");
  const out = (flat.match(/UN\s+(?:VEHICULO|CAMION)\b[^]*?(?=UN\s+(?:VEHICULO|CAMION)\b|$)/gi) || [])
    .map(s => s.replace(/\s+/g, " ").trim());
  return padTo(out, n);
}

// Num. Mov.: suele venir partido "CAD5671 2631". Reunir y re-emparejar.
function reconstructNumMovs(txt, n) {
  for (let i = 0; i < txt.length; i++) {
    if (!/Num\.?\s*Mov/i.test(txt[i])) continue;
    const pool = [];
    for (let j = i; j < Math.min(txt.length, i + 6); j++) {
      const toks = txt[j].split(/\s+/).filter(Boolean);
      for (const t of toks) if (/^[A-Z]{2,4}\d{3,}$|^\d{3,}$/.test(t)) pool.push(t);
    }
    // Unir pares cabeza+cola (CAD5671 + 2631) → CAD56712631.
    const out = [];
    for (let k = 0; k < pool.length; k++) {
      if (/^[A-Z]{2,4}\d+$/.test(pool[k]) && /^\d+$/.test(pool[k + 1] || "")) {
        out.push(pool[k] + pool[k + 1]); k++;
      } else if (/^[A-Z]{2,4}\d{5,}$/.test(pool[k])) out.push(pool[k]);
    }
    if (out.length) return padTo(out, n);
  }
  return padTo([], n);
}

// Fechas: en el PDF transpuesto hay una línea con las fechas de FACTURA (tras
// "Fecha"/"Factura") y otra con las de PEDIMENTO (tras "Fecha Pedi."). Vienen
// partidas con espacio ("2026- 10-12"); las normalizamos. Devolvemos ambas.
function pickAllFechas(txt, n) {
  const fechasEnLinea = (l) => {
    // Captura "2026- 10-12" o "2026-10-12" (con posible espacio tras guiones).
    const ms = l.match(/\d{4}-\s?\d{2}-\s?\d{2}/g) || [];
    return ms.map(f => f.replace(/\s/g, ""));
  };
  let fechasFact = [], fechasPedi = [];
  for (let i = 0; i < txt.length; i++) {
    const line = txt[i];
    const inThis = fechasEnLinea(line);
    if (inThis.length >= n) {
      // ¿Es la línea de pedimento? (cerca de un encabezado "Fecha Pedi.")
      const ctx = (txt[i - 1] || "") + " " + line;
      if (/Pedi/i.test(ctx)) { if (!fechasPedi.length) fechasPedi = inThis.slice(0, n); }
      else { if (!fechasFact.length) fechasFact = inThis.slice(0, n); }
    }
  }
  // Respaldo: si no se distinguieron, repartir todas las fechas encontradas.
  if (!fechasFact.length || !fechasPedi.length) {
    const todas = [];
    for (const l of txt) for (const f of fechasEnLinea(l)) todas.push(f);
    if (!fechasPedi.length && todas.length >= n) fechasPedi = todas.slice(0, n);
    if (!fechasFact.length && todas.length >= 2 * n) fechasFact = todas.slice(n, 2 * n);
    else if (!fechasFact.length && todas.length >= n) fechasFact = todas.slice(-n);
  }
  return { fechasPedi: padTo(fechasPedi, n), fechasFact: padTo(fechasFact, n) };
}

// Pedimentos: vienen partidos ("4024-F3- 6002272"). Los reconstruimos por línea.
function pickPedimentos(txt, n) {
  for (let i = 0; i < txt.length; i++) {
    const line = txt[i];
    const ms = line.match(/\d{4}-\w\d-\s?\d{6,7}/g) || [];
    const clean = ms.map(x => x.replace(/\s/g, ""));
    if (clean.length >= n) return clean.slice(0, n);
    // A veces el encabezado "Pedimento" está en una línea y los valores en la sgte.
    if (/Pedimento/i.test(line)) {
      for (let j = i; j < Math.min(txt.length, i + 4); j++) {
        const m2 = (txt[j].match(/\d{4}-\w\d-\s?\d{6,7}/g) || []).map(x => x.replace(/\s/g, ""));
        if (m2.length >= n) return m2.slice(0, n);
      }
    }
  }
  return padTo([], n);
}

// Busca las líneas de precios "clave Pq Año N Precio ISAN Gastos IVA HB" y
// devuelve un mapa { modeloGm → {pq, precio, isan, gastos, iva, hb} }.
// En el formato por columnas estas líneas pueden seguir viniendo "fila por fila"
// (es la parte numérica que pdf.js suele mantener junta).
function extractAmountsByModelo(txt) {
  const map = {};
  for (const l of txt) {
    const m = String(l).match(PRECIO_LINE_RE);
    if (!m) continue;
    const clave = m[1];
    const a = extractAmountsFromPriceLine(l);
    if (a.precio) map[clave] = a;
  }
  return map;
}

// RESPALDO de importes por COLUMNAS: busca las líneas de encabezado Precio/ISAN/
// Gastos/IVA/HB y toma los n valores monetarios de cada columna, emparejados por
// posición. Devuelve {precio:[],isan:[],gastos:[],iva:[],hb:[]} o null si no hay.
function extractAmountColumns(txt, n) {
  const money = (l) => (String(l).match(MONEY_RE) || []);
  // Localiza, para un encabezado dado, la línea con >= n importes cercana.
  const colFor = (headerRe) => {
    for (let i = 0; i < txt.length; i++) {
      if (!headerRe.test(txt[i])) continue;
      for (let j = i; j < Math.min(txt.length, i + 5); j++) {
        const nums = money(txt[j]);
        if (nums.length >= n) return nums.slice(0, n);
      }
    }
    return null;
  };
  const precio = colFor(/^Precio$/i);
  // Si ni siquiera hay columna de Precio clara, no usamos este respaldo.
  if (!precio) return null;
  return {
    precio,
    isan: colFor(/^ISAN$/i) || padTo([], n),
    gastos: colFor(/^Gastos$/i) || padTo([], n),
    iva: colFor(/^IVA$/i) || padTo([], n),
    hb: colFor(/^HB$/i) || padTo([], n),
  };
}

// Extrae los TOTALES del pie del CDO: "Total de facturas 3 1,531,820.17 0.00
// 29,583.00 249,824.51 34,006.40 1,845,234.08" → conteo + sumas.
// Orden de sumas: Precio, ISAN, Gastos, IVA, HB, Total.
export function extractCdoTotals(lines) {
  for (const l of lines) {
    const line = String(l || "");
    if (!/Total\s+de\s+facturas/i.test(line)) continue;
    // Conteo: el primer entero tras "Total de facturas".
    const cnt = line.match(/Total\s+de\s+facturas\D*(\d{1,5})/i);
    const nums = line.match(MONEY_RE) || [];
    return {
      totalFacturas: cnt ? parseInt(cnt[1], 10) : null,
      sumaPrecio: nums[0] || "",
      sumaIsan: nums[1] || "",
      sumaGastos: nums[2] || "",
      sumaIva: nums[3] || "",
      sumaHb: nums[4] || "",
      sumaTotal: nums[5] || (nums.length ? nums[nums.length - 1] : ""),
    };
  }
  return null;
}

function padTo(arr, n) {
  const out = arr.slice(0, n);
  while (out.length < n) out.push("");
  return out;
}

// Orquesta: lee el PDF y devuelve las unidades parseadas.
// Prueba 3 métodos en orden: por líneas → robusto → por columnas (PDF transpuesto).
// IMPORTANTE: para CDO de varias hojas, el método por columnas se aplica PÁGINA
// POR PÁGINA y se acumulan todas las unidades (cada hoja es un bloque de columnas).
// Devuelve también las líneas crudas (diagnóstico) y el método que funcionó.
export async function parseCdoFile(file, onProgress) {
  const { lines, pages } = await extractPdfPages(file, onProgress);

  // 1) Método por líneas sobre todo el documento (formato "fila por fila").
  let units = parseCdoLines(lines);
  let method = "lineas";

  // 2) Robusto sobre todo el documento.
  if (!units.length) { units = parseCdoWhole(lines); method = "robusto"; }

  // 3) Por columnas: se procesa CADA PÁGINA por separado y se acumula.
  if (!units.length) {
    const all = [];
    for (const pageLines of pages) {
      const u = parseCdoColumns(pageLines);
      if (u.length) all.push(...u);
    }
    units = dedupeByVin(all);
    method = "columnas";
  }

  const totals = extractCdoTotals(lines);
  return { units, totalLines: lines.length, lines, method, pageCount: pages.length, totals };
}
