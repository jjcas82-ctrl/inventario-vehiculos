// label.js — Genera el QR del VIN e imprime/descarga una etiqueta para pegar en la unidad.
// El QR se lee al instante con el escáner, evitando el OCR lento en cada movimiento.

const QR_CDN = "https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js";
const BARCODE_CDN = "https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js";

function loadScript(src, globalName) {
  return new Promise((resolve, reject) => {
    if (window[globalName]) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("No se pudo cargar un recurso (¿sin internet?)."));
    document.head.appendChild(s);
  });
}

async function loadQR() {
  await loadScript(QR_CDN, "QRCode");
  return window.QRCode;
}

// Genera un dataURL PNG de un código de barras Code 39 con el VIN (estándar VIN).
async function makeVinBarcodeDataUrl(vin) {
  await loadScript(BARCODE_CDN, "JsBarcode");
  const canvas = document.createElement("canvas");
  try {
    window.JsBarcode(canvas, vin, {
      format: "CODE39", displayValue: false, height: 90, width: 2, margin: 6,
    });
    return canvas.toDataURL("image/png");
  } catch (e) { return null; }
}

// Genera un dataURL PNG del QR que contiene el VIN.
export async function makeVinQrDataUrl(vin, size = 240) {
  const QR = await loadQR();
  return await QR.toDataURL(vin, {
    errorCorrectionLevel: "M",
    margin: 2,
    width: size,
    color: { dark: "#000000", light: "#ffffff" },
  });
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Genera el HTML de UNA etiqueta (para una o varias en la misma hoja).
async function labelHtml(vehicle) {
  const qrUrl = await makeVinQrDataUrl(vehicle.vin, 420);
  const barUrl = await makeVinBarcodeDataUrl(vehicle.vin);
  const meta = [vehicle.make, vehicle.model, vehicle.year].filter(Boolean).join(" · ");
  const extra = [vehicle.color, vehicle.plate].filter(Boolean).join(" · ");
  return `
    <div class="label">
      <div class="brand">GRUPO AEROPLASA · INVENTARIO DE UNIDADES</div>
      <img class="qr" src="${qrUrl}" alt="QR del VIN">
      ${barUrl ? `<img class="bar" src="${barUrl}" alt="Código de barras del VIN">` : ""}
      <div class="vin">${esc(vehicle.vin)}</div>
      <div class="meta">${esc(meta)}</div>
      ${extra ? `<div class="meta">${esc(extra)}</div>` : ""}
    </div>`;
}

const LABEL_STYLE = `
  * { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; margin: 0; padding: 16px; text-align: center; }
  .label { border: 2px solid #0f204a; border-radius: 12px; padding: 18px; display: inline-block;
           max-width: 460px; margin: 0 auto 16px; page-break-inside: avoid; }
  .brand { font-size: 13px; color: #0f204a; font-weight: 700; margin-bottom: 10px; }
  .qr { width: 320px; height: 320px; max-width: 90vw; }
  .bar { width: 100%; max-width: 400px; margin-top: 8px; }
  .vin { font-family: ui-monospace, monospace; font-size: 22px; letter-spacing: 2px; font-weight: 700; margin-top: 8px; }
  .meta { font-size: 13px; color: #334155; margin-top: 4px; }
  @media print { .no-print { display: none; } .label { page-break-after: always; } }
  button { margin: 10px 6px 0; padding: 12px 18px; font-size: 16px; border: 1px solid #0f204a;
           background: #0f204a; color: #fff; border-radius: 8px; cursor: pointer; }
`;

// Imprime la etiqueta de UN vehículo.
export async function printVinLabel(vehicle) {
  const html = await labelHtml(vehicle);
  openPrintWindow(`Etiqueta ${esc(vehicle.vin)}`, html);
}

// Imprime VARIAS etiquetas (una por hoja).
export async function printVinLabels(vehicles) {
  if (!vehicles || !vehicles.length) throw new Error("No hay unidades seleccionadas.");
  const parts = [];
  for (const v of vehicles) parts.push(await labelHtml(v));
  openPrintWindow(`Etiquetas (${vehicles.length})`, parts.join(""));
}

function openPrintWindow(title, bodyHtml) {
  const win = window.open("", "_blank", "width=560,height=760");
  if (!win) throw new Error("El navegador bloqueó la ventana de impresión. Permite ventanas emergentes.");
  win.document.write(`
    <!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
    <title>${esc(title)}</title><style>${LABEL_STYLE}</style></head>
    <body>
      ${bodyHtml}
      <div class="no-print">
        <button onclick="window.print()">Imprimir</button>
        <p style="color:#64748b;font-size:13px">Imprime y pega la etiqueta en la unidad. Escanea el QR o el código de barras para registrar movimientos al instante.</p>
      </div>
      <script>window.onload = () => setTimeout(() => window.print(), 500);<\/script>
    </body></html>
  `);
  win.document.close();
}
