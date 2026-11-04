// existunidades.js — Lectura del reporte "ANÁLISIS DE UNIDADES EN INVENTARIO"
// (existencias de unidades que emite el sistema de la agencia, en PDF o Excel).
//
// Cada unidad ocupa 1 línea con: Catálogo · Inv. · Orden · Serie(VIN) · Color ·
// Financ. · Fecha compra · DP · Fecha interés · DI · costos…, y DEBAJO una línea
// con la ubicación/nota del sistema (p. ej. "Patio TyT Queretaro", "Sala Exh").
// Al convertir el PDF las columnas angostas se desbordan: el VIN queda pegado al
// Orden y al Color, por eso el VIN se localiza por su forma (11 caracteres + 6
// dígitos finales), no por columnas.
//
// NO se importan los costos (precios, holdback, intereses): son información
// financiera que no pertenece a la ficha de la unidad.

import { extractPdfLines } from "./cdo.js";
import { readXlsxLines } from "./xlsx.js";

// Nombres de modelo a partir del prefijo del catálogo (truncado a 5-6 letras).
// Todos son modelos CHEVROLET. La marca se toma de aquí y NO del VIN: el WMI de
// una planta compartida (p. ej. Onix, LSG) se confundía con Buick.
const MARCA = "Chevrolet";
const MODELOS = {
  "AVEO": "Aveo", "AVEOH": "Aveo Hatchback", "BLAZE": "Blazer", "CAPTI": "Captiva",
  "COLOR": "Colorado", "EXPRE": "Express", "GROOV": "Groove", "MONTA": "Montana",
  "ONIX": "Onix", "S10M": "S10 Max", "SILVE": "Silverado", "SUBUR": "Suburban",
  "TORNA": "Tornado", "TRACK": "Track", "TRAX": "Trax", "TRAVE": "Traverse",
};

function clean(s) { return String(s || "").replace(/\s+/g, " ").trim(); }

// Localiza el VIN dentro de una línea. Devuelve { vin, index } o null.
// VIN = 17 caracteres [A-HJ-NPR-Z0-9] cuyos últimos 6 son dígitos. La corrida de
// caracteres puede traer pegado el Orden antes y el Color después; el VIN válido
// es la ventana de 17 que termina exactamente donde acaba la racha de dígitos.
export function findVin(line) {
  const runRe = /[A-HJ-NPR-Z0-9]{17,}/g;
  let m;
  while ((m = runRe.exec(line))) {
    const run = m[0];
    for (let s = 0; s + 17 <= run.length; s++) {
      const w = run.slice(s, s + 17);
      if (!/^[A-HJ-NPR-Z0-9]{11}\d{6}$/.test(w)) continue;
      const next = run[s + 17];
      if (next && /\d/.test(next)) continue;     // la racha de dígitos sigue: ventana corrida
      return { vin: w, index: m.index + s };
    }
  }
  return null;
}

// ddmmyy → "20yy-mm-dd" (o "" si no es una fecha válida).
function fechaDdmmyy(s) {
  const m = /^(\d{2})(\d{2})(\d{2})$/.exec(String(s || ""));
  if (!m) return "";
  const dd = Number(m[1]), mm = Number(m[2]);
  if (dd < 1 || dd > 31 || mm < 1 || mm > 12) return "";
  return `20${m[3]}-${m[2]}-${m[1]}`;
}

function titulo(s) {
  return String(s || "").toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
}

// Interpreta una línea de unidad ya localizado su VIN.
function parseUnitLine(L, f) {
  const before = L.slice(0, f.index).trim();
  const after = L.slice(f.index + 17);

  // Catálogo · Inv. · Orden (lo que hay antes del VIN).
  let catalogo = "", inv = "", orden = "";
  const mb = before.match(/^(\d{2}[A-Z0-9 ]{2,8}?-[A-Z]{1,2}?)\s*([DI]?[0-9O]{4}\/\d{2})\s*(.*)$/);
  if (mb) { catalogo = mb[1].trim(); inv = mb[2]; orden = mb[3].trim(); }
  else { catalogo = before.split(" ")[0] || ""; }

  const yy = /^\d{2}/.exec(catalogo);
  const year = yy ? `20${yy[0]}` : "";
  // El catálogo trae "S10 M" (2026) y "S10M" (2027): se busca sin espacios.
  const prefijoRaw = clean(catalogo.replace(/^\d{2}/, "").split("-")[0]);
  const prefijo = prefijoRaw.replace(/\s+/g, "").toUpperCase();
  const model = MODELOS[prefijo] || titulo(prefijoRaw);

  // Color · Financiera · Fecha compra · DP · Fecha interés · DI (lo que sigue al VIN).
  let color = "", financiera = "", fechaCompra = "";
  const mt = after.match(/^(.*?)\s+([A-Z]{2,4})\s+(\d{6})\s+(\d+)\s+(\d{6})\s+(\d+)\b/);
  if (mt) {
    color = clean(mt[1]); financiera = mt[2]; fechaCompra = fechaDdmmyy(mt[3]);
  } else {
    color = clean(after).slice(0, 60);
  }

  return {
    vin: f.vin,
    catalogo, invNumero: inv, orden,
    year, model,
    // Solo si el modelo está en la tabla; si es desconocido, se deja vacía.
    make: MODELOS[prefijo] ? MARCA : "",
    color, financiera, fechaCompra,
    ubicacionSistema: "",
  };
}

// Líneas que NO son ubicación (encabezados/pies repetidos en cada hoja).
const NO_UBIC_RE = /(Catalogo|Compra|Interes|Accesorios|Varios|HoldBac|Hold Back|Pag\.|ANALISIS|Ya Pagado|Finan|D I A S|UNIDADES EN GENERAL|Costo|Total)/i;
// Línea que parece de unidad (catálogo + inv.) aunque no se haya podido leer el VIN.
const UNIT_LIKE_RE = /^\d{2}[A-Z0-9 ]{2,8}-[A-Z]{1,2}\s*[DI]?[0-9O]{4}\/\d{2}/;

// Analiza las líneas del reporte. Devuelve { units, errores, esperado, duplicadosEnArchivo }.
//   esperado: total que declara el propio reporte ("UNIDADES EN GENERAL: N"), para
//   verificar que se leyó todo.
export function parseExistenciaUnidades(lines) {
  const units = [], errores = [];
  const vistos = new Set();
  let esperado = null, duplicadosEnArchivo = 0;
  const ls = (lines || []).map(clean);

  for (let i = 0; i < ls.length; i++) {
    const L = ls[i];
    if (!L) continue;

    const mt = /UNIDADES EN GENERAL\s*:?\s*(\d+)/i.exec(L);
    if (mt) { esperado = Number(mt[1]); continue; }

    const f = findVin(L);
    if (!f) {
      if (UNIT_LIKE_RE.test(L)) errores.push({ raw: L });
      continue;
    }
    const u = parseUnitLine(L, f);

    // Línea siguiente = ubicación/nota del sistema (si no es otra unidad ni encabezado).
    const next = ls[i + 1];
    if (next && !findVin(next) && !UNIT_LIKE_RE.test(next) && !NO_UBIC_RE.test(next) && next.length <= 90) {
      u.ubicacionSistema = next;
    }

    if (vistos.has(u.vin)) { duplicadosEnArchivo++; continue; }
    vistos.add(u.vin);
    units.push(u);
  }
  return { units, errores, esperado, duplicadosEnArchivo };
}

// Lee el archivo (xlsx o pdf) y devuelve las líneas de texto del reporte.
export async function readExistenciaUnidadesLines(file, onProgress) {
  const name = String(file.name || "").toLowerCase();
  if (name.endsWith(".xlsx")) return readXlsxLines(file);
  if (name.endsWith(".pdf") || file.type === "application/pdf") return extractPdfLines(file, onProgress);
  throw new Error("Formato no soportado. Sube el reporte en Excel (.xlsx) o PDF.");
}
