// ocr.js — Lectura del VIN por OCR (texto grabado en el parabrisas, sin código de barras).
// Usa Tesseract.js (ESM) desde CDN. Hace varios intentos y elige el mejor candidato.

const TESSERACT_CDN = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.esm.min.js";

let _worker = null;

async function getWorker(onProgress) {
  if (_worker) return _worker;
  onProgress && onProgress("Cargando lector de texto (OCR)… puede tardar la 1ª vez.");
  const mod = await import(/* @vite-ignore */ TESSERACT_CDN);
  const Tesseract = mod.default || mod;
  const worker = await Tesseract.createWorker("eng");
  await worker.setParameters({
    tessedit_char_whitelist: "ABCDEFGHJKLMNPRSTUVWXYZ0123456789",
    tessedit_pageseg_mode: "7", // una sola línea de texto
  });
  _worker = worker;
  return _worker;
}

// Recorta una franja central del video con un factor de altura dado y realza el texto.
function crop(video, heightFactor) {
  const vw = video.videoWidth, vh = video.videoHeight;
  const canvas = document.createElement("canvas");
  const cropW = Math.round(vw * 0.94);
  const cropH = Math.round(vh * heightFactor);
  const sx = Math.round((vw - cropW) / 2);
  const sy = Math.round((vh - cropH) / 2);
  const scale = 3; // ampliar para dar detalle al OCR
  canvas.width = cropW * scale;
  canvas.height = cropH * scale;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(video, sx, sy, cropW, cropH, 0, 0, canvas.width, canvas.height);

  // Escala de grises + binarización adaptativa simple (umbral por promedio)
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  let sum = 0;
  const gray = new Float32Array(d.length / 4);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    gray[j] = g; sum += g;
  }
  const mean = sum / gray.length;
  const thr = mean * 0.9; // ligeramente por debajo del promedio
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    const v = gray[j] > thr ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function cleanText(t) {
  return String(t || "").toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, "");
}

// Devuelve el mejor candidato a VIN de una cadena limpia.
function bestVinCandidate(clean) {
  if (!clean) return { vin: null, best: "" };
  // 1) exacto 17
  const exact = clean.match(/[A-HJ-NPR-Z0-9]{17}/);
  if (exact) return { vin: exact[0], best: exact[0] };
  // 2) el fragmento contiguo más largo (para mostrar/corregir)
  const parts = clean.match(/[A-HJ-NPR-Z0-9]+/g) || [];
  const best = parts.sort((a, b) => b.length - a.length)[0] || clean;
  return { vin: null, best };
}

// Ejecuta OCR varias veces (varios encuadres) y elige el mejor resultado.
export async function readVinFromVideo(video, { onProgress, onCandidate } = {}) {
  const worker = await getWorker(onProgress);
  const heights = [0.22, 0.30, 0.40]; // prueba franjas de distinta altura
  let bestOverall = "";
  let vinFound = null;

  for (let k = 0; k < heights.length; k++) {
    onProgress && onProgress(`Analizando imagen (intento ${k + 1}/${heights.length})…`);
    const canvas = crop(video, heights[k]);
    let text = "";
    try {
      const { data } = await worker.recognize(canvas);
      text = data && data.text ? data.text : "";
    } catch (e) { /* seguir con el siguiente intento */ }
    const clean = cleanText(text);
    onCandidate && onCandidate(clean);
    const { vin, best } = bestVinCandidate(clean);
    if (best.length > bestOverall.length) bestOverall = best;
    if (vin) { vinFound = vin; break; }
  }
  return { vin: vinFound, raw: bestOverall };
}
