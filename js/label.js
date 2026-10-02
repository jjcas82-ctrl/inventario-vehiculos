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

// Abre una ventana de impresión con la etiqueta (QR GRANDE + código de barras + VIN).
export async function printVinLabel(vehicle) {
  const qrUrl = await makeVinQrDataUrl(vehicle.vin, 420);      // QR grande, fácil de escanear
  const barUrl = await makeVinBarcodeDataUrl(vehicle.vin);     // código de barras Code 39
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const win = window.open("", "_blank", "width=520,height=720");
  if (!win) throw new Error("El navegador bloqueó la ventana de impresión. Permite ventanas emergentes.");
  win.document.write(`
    <!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
    <title>Etiqueta ${esc(vehicle.vin)}</title>
    <style>
      * { box-sizing: border-box; }
      body { font-family: system-ui, sans-serif; margin: 0; padding: 16px; text-align: center; }
      .label { border: 2px solid #0f172a; border-radius: 12px; padding: 18px; display: inline-block; max-width: 460px; }
      .brand { font-size: 14px; color: #0f204a; font-weight: 700; margin-bottom: 10px; }
      .qr { width: 340px; height: 340px; max-width: 90vw; }
      .bar { width: 100%; max-width: 420px; margin-top: 10px; }
      .vin { font-family: ui-monospace, monospace; font-size: 24px; letter-spacing: 2px; font-weight: 700; margin-top: 10px; }
      .meta { font-size: 14px; color: #334155; margin-top: 6px; }
      @media print { .no-print { display: none; } }
      button { margin-top: 16px; padding: 12px 18px; font-size: 16px; border: 1px solid #0f204a;
               background: #0f204a; color: #fff; border-radius: 8px; cursor: pointer; }
    </style></head>
    <body>
      <div class="label">
        <div class="brand">🚗 INVENTARIO DE VEHÍCULOS</div>
        <img class="qr" src="${qrUrl}" alt="QR del VIN">
        ${barUrl ? `<img class="bar" src="${barUrl}" alt="Código de barras del VIN">` : ""}
        <div class="vin">${esc(vehicle.vin)}</div>
        <div class="meta">${esc([vehicle.make, vehicle.model, vehicle.year].filter(Boolean).join(" · "))}</div>
      </div>
      <div class="no-print">
        <button onclick="window.print()">Imprimir etiqueta</button>
        <p style="color:#64748b;font-size:13px">Imprime y pega esta etiqueta en la unidad. Escanea el QR o el código de barras para registrar movimientos al instante.</p>
      </div>
      <script>window.onload = () => setTimeout(() => window.print(), 400);<\/script>
    </body></html>
  `);
  win.document.close();
}
