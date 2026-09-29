// label.js — Genera el QR del VIN e imprime/descarga una etiqueta para pegar en la unidad.
// El QR se lee al instante con el escáner, evitando el OCR lento en cada movimiento.

const QR_CDN = "https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js";

let _qrLib = null;

async function loadQR() {
  if (_qrLib && window.QRCode) return window.QRCode;
  await new Promise((resolve, reject) => {
    if (window.QRCode) return resolve();
    const s = document.createElement("script");
    s.src = QR_CDN;
    s.onload = resolve;
    s.onerror = () => reject(new Error("No se pudo cargar el generador de QR (¿sin internet?)."));
    document.head.appendChild(s);
  });
  _qrLib = window.QRCode;
  return window.QRCode;
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

// Abre una ventana de impresión con la etiqueta (QR + VIN + marca/modelo).
export async function printVinLabel(vehicle) {
  let qrUrl;
  try {
    qrUrl = await makeVinQrDataUrl(vehicle.vin, 260);
  } catch (e) {
    throw e;
  }
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const win = window.open("", "_blank", "width=420,height=560");
  if (!win) throw new Error("El navegador bloqueó la ventana de impresión. Permite ventanas emergentes.");
  win.document.write(`
    <!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
    <title>Etiqueta ${esc(vehicle.vin)}</title>
    <style>
      * { box-sizing: border-box; }
      body { font-family: system-ui, sans-serif; margin: 0; padding: 16px; text-align: center; }
      .label { border: 2px solid #0f172a; border-radius: 12px; padding: 16px; display: inline-block; }
      .brand { font-size: 13px; color: #0f766e; font-weight: 700; margin-bottom: 6px; }
      img { width: 260px; height: 260px; }
      .vin { font-family: ui-monospace, monospace; font-size: 20px; letter-spacing: 1px; font-weight: 700; margin-top: 8px; }
      .meta { font-size: 13px; color: #334155; margin-top: 4px; }
      @media print { .no-print { display: none; } }
      button { margin-top: 14px; padding: 10px 16px; font-size: 15px; border: 1px solid #0f766e;
               background: #0f766e; color: #fff; border-radius: 8px; cursor: pointer; }
    </style></head>
    <body>
      <div class="label">
        <div class="brand">🚗 INVENTARIO DE VEHÍCULOS</div>
        <img src="${qrUrl}" alt="QR del VIN">
        <div class="vin">${esc(vehicle.vin)}</div>
        <div class="meta">${esc([vehicle.make, vehicle.model, vehicle.year].filter(Boolean).join(" · "))}</div>
      </div>
      <div class="no-print"><button onclick="window.print()">Imprimir etiqueta</button></div>
      <script>window.onload = () => setTimeout(() => window.print(), 300);<\/script>
    </body></html>
  `);
  win.document.close();
}
