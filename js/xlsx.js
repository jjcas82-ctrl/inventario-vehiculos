// xlsx.js — Lector MÍNIMO de archivos .xlsx (sin dependencias).
//
// Un .xlsx es un ZIP con XML dentro. Aquí solo se extrae lo necesario para leer
// el TEXTO de la primera hoja: tabla de cadenas compartidas (sharedStrings) y las
// celdas de la hoja. Usa DecompressionStream("deflate-raw") del navegador para
// descomprimir (Chrome/Edge/Android 80+, Safari 16.4+). Sin fórmulas, estilos ni
// fechas con formato: devuelve el valor crudo de cada celda como texto.

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("Este navegador no puede abrir archivos .xlsx. Actualízalo o sube el PDF.");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Índice del ZIP (directorio central): nombre → { method, csize, lho }.
function readZipIndex(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("El archivo no es un .xlsx válido.");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries = new Map();
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true);
    const elen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nlen));
    entries.set(name, { method, csize, lho });
    p += 46 + nlen + elen + clen;
  }
  return entries;
}

async function readZipText(buf, entries, name) {
  const e = entries.get(name);
  if (!e) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const nlen = dv.getUint16(e.lho + 26, true);
  const elen = dv.getUint16(e.lho + 28, true);
  const start = e.lho + 30 + nlen + elen;
  const data = buf.subarray(start, start + e.csize);
  let raw;
  if (e.method === 0) raw = data;
  else if (e.method === 8) raw = await inflateRaw(data);
  else throw new Error("Compresión de .xlsx no soportada.");
  return new TextDecoder("utf-8").decode(raw);
}

function unescapeXml(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function parseSharedStrings(xml) {
  const out = [];
  if (!xml) return out;
  const src = xml.replace(/<si\s*\/>/g, "<si></si>");
  const re = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = re.exec(src))) {
    let s = "";
    const tre = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let t;
    while ((t = tre.exec(m[1]))) s += t[1];
    out.push(unescapeXml(s));
  }
  return out;
}

// "AB12" → índice de columna (0-based) de "AB".
function colIndex(ref) {
  const letters = (/^[A-Z]+/i.exec(ref) || [""])[0].toUpperCase();
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseSheetRows(xml, shared) {
  const rows = [];
  const src = xml.replace(/<row\b[^>]*\/>/g, "");
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(src))) {
    const cells = [];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cellRe.exec(rm[1]))) {
      const attrs = cm[1] || "";
      const body = cm[2] || "";
      const ref = (/\br="([^"]+)"/.exec(attrs) || [])[1] || "";
      const type = (/\bt="([^"]+)"/.exec(attrs) || [])[1] || "";
      let val = "";
      if (type === "s") {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body);
        val = v ? (shared[Number(v[1])] ?? "") : "";
      } else if (type === "inlineStr") {
        let s = "";
        const tre = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
        let t;
        while ((t = tre.exec(body))) s += t[1];
        val = unescapeXml(s);
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body);
        val = v ? unescapeXml(v[1]) : "";
      }
      cells.push({ c: ref ? colIndex(ref) : cells.length, v: String(val) });
    }
    cells.sort((a, b) => a.c - b.c);
    rows.push(cells.map(x => x.v));
  }
  return rows;
}

// Lee la PRIMERA hoja de un .xlsx. Devuelve un arreglo de filas (arreglos de texto).
export async function readXlsxRows(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const entries = readZipIndex(buf);
  const shared = parseSharedStrings(await readZipText(buf, entries, "xl/sharedStrings.xml"));

  // Localiza la primera hoja vía workbook.xml + rels (por si no se llama sheet1).
  let sheetPath = "xl/worksheets/sheet1.xml";
  try {
    const wb = await readZipText(buf, entries, "xl/workbook.xml");
    const rels = await readZipText(buf, entries, "xl/_rels/workbook.xml.rels");
    const rid = wb && (/<sheet\b[^>]*\br:id="([^"]+)"/.exec(wb) || [])[1];
    if (rid && rels) {
      const relRe = /<Relationship\b[^>]*>/g;
      let rr;
      while ((rr = relRe.exec(rels))) {
        if (new RegExp(`\\bId="${rid}"`).test(rr[0])) {
          const target = (/\bTarget="([^"]+)"/.exec(rr[0]) || [])[1];
          if (target) sheetPath = target.startsWith("/") ? target.slice(1) : "xl/" + target.replace(/^\.\//, "");
          break;
        }
      }
    }
  } catch (e) { /* usa la ruta por defecto */ }

  const sheetXml = await readZipText(buf, entries, sheetPath);
  if (!sheetXml) throw new Error("No se encontró la hoja de cálculo dentro del .xlsx.");
  return parseSheetRows(sheetXml, shared);
}

// Filas → líneas de texto (celdas no vacías unidas por espacio).
export async function readXlsxLines(file) {
  const rows = await readXlsxRows(file);
  return rows
    .map(r => r.map(s => String(s).replace(/\s+/g, " ").trim()).filter(Boolean).join(" "))
    .filter(Boolean);
}
