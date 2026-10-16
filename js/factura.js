// factura.js — Lector de FACTURAS DE TRASPASO (de otra agencia) para precargar
// unidades en estatus "En tránsito".
//
// Prioridad de formatos:
//   1) XML (CFDI 4.0 con complemento VentaVehiculos) → exacto y confiable.
//   2) PDF de la factura → secundario (texto, menos estructurado).
//   (El CDO de GM lo maneja cdo.js; aquí tratamos las facturas de traspaso.)
//
// Devuelve unidades con la MISMA forma que el CDO para reutilizar la carga masiva:
//   { vin, make, model, color, year, origin:"Traspaso", emisor, folioFiscal,
//     claveVehicular, pedimento, fechaPedimento, aduana, fechaFactura,
//     precio, iva, total, ... }

import { normalizeVin } from "./vin.js";

// Parsea un XML de CFDI (como texto) y devuelve la unidad del traspaso (o null).
export function parseFacturaXml(xmlText) {
  let doc;
  try {
    doc = new DOMParser().parseFromString(xmlText, "application/xml");
  } catch (e) { return null; }
  if (!doc || doc.getElementsByTagName("parsererror").length) return null;

  // Helper tolerante a namespaces: busca por nombre local de etiqueta/atributo.
  const firstByLocal = (local) => {
    const all = doc.getElementsByTagName("*");
    for (const el of all) {
      if (el.localName === local || el.nodeName.endsWith(":" + local) || el.nodeName === local) return el;
    }
    return null;
  };
  const attr = (el, name) => {
    if (!el) return "";
    // Busca el atributo ignorando mayúsculas/namespace.
    for (const a of el.attributes) {
      if (a.localName === name || a.name === name || a.name.toLowerCase() === name.toLowerCase()) return a.value;
    }
    return "";
  };

  const comprobante = firstByLocal("Comprobante");
  const emisor = firstByLocal("Emisor");
  const concepto = firstByLocal("Concepto");
  const venta = firstByLocal("VentaVehiculos");
  const infoAduana = firstByLocal("InformacionAduanera");
  const tfd = firstByLocal("TimbreFiscalDigital");

  // --- VIN: PRIMARIO del complemento oficial (@Niv); respaldo: Addenda NO. SERIE ---
  let vin = normalizeVin(attr(venta, "Niv"));
  const addenda = readAddenda(doc);
  if (vin.length !== 17) {
    const serieAdd = normalizeVin(addenda["NO. SERIE"] || addenda["NO.SERIE"] || "");
    if (serieAdd.length === 17) vin = serieAdd;
  }

  // --- Datos del vehículo: complemento + addenda + descripción del concepto ---
  const desc = attr(concepto, "Descripcion");
  const make = (addenda["MARCA"] || marcaFromDesc(desc) || "").trim();
  const tipo = (addenda["TIPO"] || "").trim();           // "AVEO SEDAN PAQ: D"
  const model = modelFromTipoOrDesc(tipo, desc, make);
  const year = (addenda["MODELO"] || yearFromDesc(desc) || "").trim(); // addenda "MODELO" = año
  const color = (addenda["COLOR"] || "").split("INT")[0].trim();

  // --- Datos fiscales / aduanales ---
  const folioFiscal = attr(tfd, "UUID");
  const claveVehicular = attr(venta, "ClaveVehicular") || addenda["CLAVE VEHICULAR"] || "";
  const pedimento = attr(infoAduana, "numero") || addenda["NO. PEDIMENTO ADUANAL"] || "";
  const fechaPedimento = (attr(infoAduana, "fecha") || addenda["FECHA PEDIMENTO"] || "").slice(0, 10);
  const aduana = attr(infoAduana, "aduana") || addenda["RECINTO FISCAL"] || "";
  const fechaFactura = (attr(comprobante, "Fecha") || "").slice(0, 10);
  const emisorNombre = (attr(emisor, "Nombre") || "").trim();
  const emisorRfc = attr(emisor, "Rfc");

  // --- Importes ---
  const precio = fmtMoney(attr(comprobante, "SubTotal"));
  const total = fmtMoney(attr(comprobante, "Total"));
  const iva = fmtMoney(trasladoImporte(doc));

  if (!vin || vin.length !== 17) {
    return { error: "No se encontró un VIN válido de 17 caracteres en el XML.", raw: { vinIntento: vin } };
  }

  return {
    vin, make, model, color, year,
    powertrain: tipo || "",
    origin: "Traspaso",
    emisor: emisorNombre, emisorRfc,
    folioFiscal, claveVehicular, modeloGm: claveVehicular,
    pedimento, fechaPedimento, aduana, fechaFactura,
    precio, iva, total,
    numMotor: addenda["NO. MOTOR"] || "",
    combustible: addenda["COMBUSTIBLE"] || "",
    transmission: addenda["TRANSMISION"] || "",
  };
}

// Lee la Addenda genérica (pares Nombre/Valor) a un objeto { NOMBRE: valor }.
function readAddenda(doc) {
  const out = {};
  const datos = doc.getElementsByTagName("*");
  for (const el of datos) {
    if (el.localName === "Dato") {
      const nombre = (el.getAttribute("Nombre") || "").toUpperCase().trim();
      const valor = el.getAttribute("Valor") || "";
      if (nombre) out[nombre] = valor;
    }
  }
  return out;
}

// Suma el importe de impuestos trasladados (IVA) del nodo Impuestos general.
function trasladoImporte(doc) {
  const all = doc.getElementsByTagName("*");
  for (const el of all) {
    if (el.localName === "Impuestos" && el.getAttribute("TotalImpuestosTrasladados")) {
      return el.getAttribute("TotalImpuestosTrasladados");
    }
  }
  return "";
}

const MARCAS = ["CHEVROLET", "GMC", "BUICK", "CADILLAC", "NISSAN", "VOLKSWAGEN", "TOYOTA", "FORD"];
function marcaFromDesc(desc) {
  const up = String(desc || "").toUpperCase();
  return MARCAS.find(m => up.includes(m)) || "";
}
function yearFromDesc(desc) {
  const m = String(desc || "").match(/\b(19|20)\d{2}\b/);
  return m ? m[0] : "";
}
// Modelo: del "TIPO" (ej "AVEO SEDAN PAQ: D") tomamos las primeras palabras antes
// de "PAQ"; si no hay tipo, intentamos de la descripción tras la marca.
function modelFromTipoOrDesc(tipo, desc, make) {
  if (tipo) {
    return tipo.split(/\bPAQ\b/i)[0].trim();
  }
  const up = String(desc || "").toUpperCase();
  if (make && up.includes(make)) {
    const after = String(desc).slice(up.indexOf(make) + make.length).trim();
    // tras la marca suele venir el año y luego el modelo
    return after.replace(/^\s*(19|20)\d{2}\s*/, "").split(/\s{2,}|,/)[0].trim().slice(0, 40);
  }
  return "";
}

function fmtMoney(s) {
  const n = parseFloat(String(s || "").replace(/,/g, ""));
  if (isNaN(n)) return "";
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Detecta el tipo de archivo por nombre/contenido: "xml" | "pdf" | "desconocido".
export function detectFacturaType(file) {
  const name = (file.name || "").toLowerCase();
  if (name.endsWith(".xml") || name.endsWith(".txt")) return "xml"; // el usuario a veces renombra xml→txt
  if (name.endsWith(".pdf")) return "pdf";
  return "desconocido";
}

// Lee un archivo de texto (XML/TXT) y devuelve su contenido.
export function readTextFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(new Error("No se pudo leer el archivo."));
    r.readAsText(file);
  });
}
