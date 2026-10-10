// pdf.js — Ficha imprimible / "PDF" de la unidad y encabezado corporativo para
// reportes. No usa librerías externas: abre una ventana con HTML listo para imprimir
// (el usuario elige "Guardar como PDF" en el diálogo de impresión del navegador).
import { makeVinQrDataUrl } from "./label.js";
import { listPhotos, PHOTO_KINDS } from "./photos.js";
import { EVENT_LABELS } from "./events.js";
import { store } from "./storage.js";

const BRAND = "GRUPO AEROPLASA · INVENTARIO DE UNIDADES";
const LOGO = "icons/logo.png";

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Estilo común de los documentos imprimibles (tamaño carta, encabezado con logo).
const DOC_STYLE = `
  * { box-sizing: border-box; }
  @page { size: letter; margin: 14mm; }
  body { font-family: system-ui, Segoe UI, Roboto, sans-serif; margin: 0; color: #0f172a; }
  .doc-head { display: flex; align-items: center; gap: 14px; border-bottom: 3px solid #0f204a; padding-bottom: 10px; margin-bottom: 16px; }
  .doc-head img { height: 54px; width: auto; }
  .doc-head .t { font-size: 13px; color: #0f204a; font-weight: 700; line-height: 1.3; }
  .doc-head .t small { display:block; font-weight: 400; color:#475569; font-size: 11px; margin-top: 2px; }
  h1 { font-size: 18px; margin: 0 0 12px; color: #0f204a; }
  h2 { font-size: 14px; margin: 18px 0 8px; color: #0f204a; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { border: 1px solid #cbd5e1; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: #f1f5f9; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 24px; font-size: 13px; }
  .grid2 .row { display: flex; justify-content: space-between; border-bottom: 1px dotted #e2e8f0; padding: 4px 0; }
  .grid2 .row b { color: #334155; font-weight: 600; }
  .qr { text-align: center; }
  .qr img { width: 180px; height: 180px; }
  .fotos { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .fotos figure { margin: 0; border: 1px solid #cbd5e1; border-radius: 6px; overflow: hidden; }
  .fotos img { width: 100%; height: 110px; object-fit: cover; display: block; }
  .fotos figcaption { font-size: 10px; padding: 4px 6px; color: #475569; }
  .foot { margin-top: 20px; font-size: 10px; color: #94a3b8; border-top: 1px solid #e2e8f0; padding-top: 8px; }
  .no-print { text-align: center; margin: 14px 0; }
  .no-print button { padding: 10px 18px; font-size: 15px; border: 1px solid #0f204a; background: #0f204a; color: #fff; border-radius: 8px; cursor: pointer; }
  @media print { .no-print { display: none; } }
`;

function head() {
  return `<div class="doc-head">
    <img src="${LOGO}" alt="Logo" onerror="this.style.display='none'">
    <div class="t">${esc(BRAND)}<small>Documento generado el ${esc(new Date().toLocaleString())}</small></div>
  </div>`;
}

function openDoc(title, inner) {
  const win = window.open("", "_blank", "width=820,height=900");
  if (!win) { throw new Error("El navegador bloqueó la ventana. Permite ventanas emergentes para imprimir."); }
  win.document.write(`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
    <title>${esc(title)}</title><style>${DOC_STYLE}</style></head>
    <body>${head()}${inner}
    <div class="foot">Grupo Aeroplasa · Sistema de Inventario de Unidades · Documento interno.</div>
    <div class="no-print"><button onclick="window.print()">🖨️ Imprimir / Guardar PDF</button></div>
    <script>window.onload=()=>setTimeout(()=>window.print(),400);<\/script>
    </body></html>`);
  win.document.close();
}

// Ficha completa de una unidad: datos + QR + historial + fotos.
export async function printVehicleSheet(vehicle) {
  if (!vehicle) throw new Error("Sin unidad.");
  const v = vehicle;
  const qr = await makeVinQrDataUrl(v.vin, 300).catch(() => null);
  let fotos = [];
  try { fotos = await listPhotos(v.vin); } catch (e) {}

  const row = (label, val) => `<div class="row"><b>${esc(label)}</b><span>${esc(val || "—")}</span></div>`;
  const km = (v.mileage != null && v.mileage !== "") ? Number(v.mileage).toLocaleString() + " km" : "—";

  const eventos = store.eventsForVin(v.vin);
  const histRows = eventos.slice().reverse().map(e => {
    const quien = e.person && e.person.name ? `${e.person.name}${e.person.type ? " (" + e.person.type + ")" : ""}` : "";
    return `<tr>
      <td>${esc(new Date(e.at).toLocaleString())}</td>
      <td>${esc(EVENT_LABELS[e.type] || e.type)}</td>
      <td>${esc(e.location || "")} ${e.agency ? "(" + esc(e.agency) + ")" : ""}</td>
      <td>${esc(e.by || "")}</td>
      <td>${esc(quien)}</td>
    </tr>`;
  }).join("");

  const fotosHtml = fotos.length ? `
    <h2>Fotos / evidencia (${fotos.length})</h2>
    <div class="fotos">${fotos.slice(0, 9).map(f => `
      <figure><img src="${f.dataUrl}" alt="foto">
        <figcaption>${esc(PHOTO_KINDS[f.kind] || "Foto")}${f.note ? " · " + esc(f.note) : ""}</figcaption>
      </figure>`).join("")}</div>` : "";

  const inner = `
    <h1>Ficha de unidad · ${esc(v.vin)}</h1>
    <div style="display:flex; gap:20px; align-items:flex-start">
      <div style="flex:1">
        <div class="grid2">
          ${row("Marca", v.make)} ${row("Modelo", v.model)}
          ${row("Año", v.year)} ${row("Color", v.color)}
          ${row("Tipo / carrocería", v.vehType || v.bodyClass)} ${row("Versión / tren motriz", v.powertrain)}
          ${row("Transmisión", v.transmission)} ${row("No. de motor", v.engineNo)}
          ${row("Kilometraje", km)} ${row("Placa", v.plate)}
          ${row("Condición", v.condition)} ${row("Etapa", v.stage)}
          ${row("Estado", v.status === "dentro" ? "Dentro" : (v.status === "fuera" ? "Fuera" : "—"))} ${row("Agencia", v.currentAgency)}
          ${row("Ubicación", v.currentLocation)} ${row("País (VIN)", v.country)}
        </div>
      </div>
      <div class="qr">${qr ? `<img src="${qr}" alt="QR ${esc(v.vin)}"><div style="font-size:11px">Escanea para ubicar</div>` : ""}</div>
    </div>
    <h2>Historial de movimientos</h2>
    <table>
      <thead><tr><th>Fecha</th><th>Tipo</th><th>Ubicación</th><th>Capturó</th><th>Entregó/Recibió</th></tr></thead>
      <tbody>${histRows || '<tr><td colspan="5">Sin eventos.</td></tr>'}</tbody>
    </table>
    ${fotosHtml}`;

  openDoc("Ficha " + v.vin, inner);
}

// Reporte tabular con encabezado corporativo (lo usa la pestaña Reportes).
export function printReport(title, cols, rows) {
  const thead = "<tr>" + cols.map(c => `<th>${esc(c)}</th>`).join("") + "</tr>";
  const tbody = rows.map(r => "<tr>" + r.map(c => `<td>${esc(c)}</td>`).join("") + "</tr>").join("");
  const inner = `
    <h1>${esc(title)}</h1>
    <p style="font-size:12px;color:#475569">Total de registros: ${rows.length}</p>
    <table><thead>${thead}</thead><tbody>${tbody || `<tr><td colspan="${cols.length}">Sin datos.</td></tr>`}</tbody></table>`;
  openDoc(title, inner);
}
