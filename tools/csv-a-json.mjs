#!/usr/bin/env node
// tools/csv-a-json.mjs — Convierte los CSV de marcas + modelos en data/modelos.json
// con el formato que consume la app:  { "Marca": ["Modelo1", "Modelo2", ...], ... }
//
// Relación esperada (confirmada con las capturas):
//   brand.csv    : id, Nombre, Slug           -> cada marca tiene un id y un Nombre
//   modelos.csv  : id_marca, id, Nombre, slug  -> cada modelo apunta a una marca por id_marca
//
// Uso:
//   node tools/csv-a-json.mjs <brand.csv> <modelos.csv> [salida.json]
//
// Ejemplos:
//   node tools/csv-a-json.mjs data/csv/brand.csv data/csv/modelos.csv
//   node tools/csv-a-json.mjs data/csv/brand.csv data/csv/modelos.csv data/modelos.json
//
// Es tolerante a:
//   - separador coma (,) o punto y coma (;), autodetectado
//   - comillas dobles y comas dentro de comillas
//   - BOM al inicio del archivo
//   - nombres de columna en cualquier mayúscula/minúscula y con/sin acentos

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ---------- Parser CSV mínimo pero correcto (maneja comillas) ----------
function parseCSV(text) {
  // Quita BOM si existe.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  // Autodetecta el separador mirando la primera línea: gana el más frecuente entre ; y ,
  const firstLine = text.slice(0, text.indexOf("\n") >= 0 ? text.indexOf("\n") : text.length);
  const nSemi = (firstLine.match(/;/g) || []).length;
  const nComma = (firstLine.match(/,/g) || []).length;
  const SEP = nSemi > nComma ? ";" : ",";

  const rows = [];
  let field = "";
  let row = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } // comilla escapada ""
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === SEP) { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c === "\r") { /* ignora CR */ }
      else field += c;
    }
  }
  // Último campo/fila si el archivo no termina en salto de línea.
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// Normaliza un encabezado para comparar: minúsculas, sin acentos, sin espacios.
function normHeader(s) {
  return String(s || "")
    .trim().toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "");
}

// Dado el array de encabezados, devuelve el índice de la primera columna cuyo nombre
// normalizado esté en la lista de candidatos. -1 si no se encuentra.
function findCol(headers, candidates) {
  const norm = headers.map(normHeader);
  for (const cand of candidates) {
    const i = norm.indexOf(normHeader(cand));
    if (i !== -1) return i;
  }
  return -1;
}

// Convierte un CSV ya parseado en { headers, dataRows }.
function splitHeader(rows) {
  const nonEmpty = rows.filter((r) => r.some((c) => String(c).trim() !== ""));
  if (!nonEmpty.length) return { headers: [], dataRows: [] };
  return { headers: nonEmpty[0], dataRows: nonEmpty.slice(1) };
}

// ---------- Programa principal ----------
function main() {
  const [brandPath, modelsPath, outPath = "data/modelos.json"] = process.argv.slice(2);

  if (!brandPath || !modelsPath) {
    console.error("Uso: node tools/csv-a-json.mjs <brand.csv> <modelos.csv> [salida.json]");
    process.exit(1);
  }

  // --- Marcas: id -> Nombre ---
  const brandRows = parseCSV(readFileSync(brandPath, "utf8"));
  const { headers: bHead, dataRows: bData } = splitHeader(brandRows);
  const bIdCol = findCol(bHead, ["id", "id_marca", "marca_id", "idmarca"]);
  const bNameCol = findCol(bHead, ["nombre", "name", "marca", "brand"]);
  if (bIdCol === -1 || bNameCol === -1) {
    console.error(`No encuentro columnas id/Nombre en ${brandPath}. Encabezados: ${bHead.join(" | ")}`);
    process.exit(2);
  }

  const brandById = new Map(); // id (string) -> nombre marca
  for (const r of bData) {
    const id = String(r[bIdCol] ?? "").trim();
    const name = String(r[bNameCol] ?? "").trim();
    if (id && name) brandById.set(id, name);
  }

  // --- Modelos: agrupa por marca usando id_marca ---
  const modelRows = parseCSV(readFileSync(modelsPath, "utf8"));
  const { headers: mHead, dataRows: mData } = splitHeader(modelRows);
  const mBrandCol = findCol(mHead, ["id_marca", "marca_id", "idmarca", "brand_id", "id_brand"]);
  const mNameCol = findCol(mHead, ["nombre", "name", "modelo", "model"]);
  if (mBrandCol === -1 || mNameCol === -1) {
    console.error(`No encuentro columnas id_marca/Nombre en ${modelsPath}. Encabezados: ${mHead.join(" | ")}`);
    process.exit(3);
  }

  const catalog = {};              // { Marca: Set(modelos) }
  let totalModels = 0;
  let huerfanos = 0;               // modelos cuyo id_marca no existe en brand.csv

  for (const r of mData) {
    const brandId = String(r[mBrandCol] ?? "").trim();
    const modelName = String(r[mNameCol] ?? "").trim();
    if (!modelName) continue;
    const brandName = brandById.get(brandId);
    if (!brandName) { huerfanos++; continue; }
    (catalog[brandName] ??= new Set()).add(modelName);
    totalModels++;
  }

  // Convierte Sets -> arrays ordenados, y ordena las marcas alfabéticamente.
  const out = {};
  for (const brand of Object.keys(catalog).sort((a, b) => a.localeCompare(b, "es"))) {
    out[brand] = [...catalog[brand]].sort((a, b) => a.localeCompare(b, "es"));
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(out, null, 0) + "\n", "utf8");

  // Resumen legible.
  const marcas = Object.keys(out).length;
  const sizeKB = (Buffer.byteLength(JSON.stringify(out)) / 1024).toFixed(1);
  console.log(`✅ Generado ${outPath}`);
  console.log(`   Marcas:  ${marcas}`);
  console.log(`   Modelos: ${totalModels} (únicos por marca)`);
  console.log(`   Tamaño:  ${sizeKB} KB`);
  if (huerfanos) {
    console.log(`   ⚠️  ${huerfanos} modelos sin marca válida (id_marca no está en brand.csv) — se omitieron.`);
  }
  // Muestra un par de ejemplos para verificación rápida.
  const sample = Object.keys(out).slice(0, 3);
  for (const s of sample) {
    console.log(`   Ej: ${s} -> ${out[s].slice(0, 6).join(", ")}${out[s].length > 6 ? ", …" : ""}`);
  }
}

main();
