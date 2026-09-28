// ocr.js — Lectura del VIN por OCR (texto grabado en el parabrisas, sin código de barras).
// Usa Tesseract.js (ESM) desde CDN. Devuelve el texto reconocido; app.js extrae el VIN.

const TESSERACT_CDN = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.esm.min.js";

let _worker = null;

async function getWorker(onProgress) {
  if (_worker) return _worker;
  onProgress && onProgress("Cargando lector de texto (OCR)… puede tardar la 1ª vez.");
  const mod = await import(/* @vite-ignore */ TESSERACT_CDN);
  const Tesseract = mod.default || mod;
  const worker = await Tesseract.createWorker("eng");
  // Restringimos a caracteres válidos de VIN (sin I, O, Q) y tratamos como una línea.
  await worker.setParameters({
    tessedit_char_whitelist: "ABCDEFGHJKLMNPRSTUVWXYZ0123456789",
    tessedit_pageseg_mode: "7", // PSM_SINGLE_LINE
  });
  _worker = worker;
  return _worker;
}

// Recorta la franja central (donde se apunta el VIN) y realza el texto.
function cropCenter(video) {
  const vw = video.videoWidth, vh = video.videoHeight;
  const canvas = document.createElement("canvas");
  const cropW = Math.round(vw * 0.92);
  const cropH = Math.round(vh * 0.30);
  const sx = Math.round((vw - cropW) / 2);
  const sy = Math.round((vh - cropH) / 2);
  canvas.width = cropW * 2;   // escalar x2 para más detalle
  canvas.height = cropH * 2;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(video, sx, sy, cropW, cropH, 0, 0, canvas.width, canvas.height);
  // Escala de grises + aumento de contraste
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const v = g > 115 ? 255 : (g < 75 ? 0 : g);
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// Toma una foto del video y ejecuta OCR. Devuelve el texto (string).
export async function readVinFromVideo(video, { onProgress } = {}) {
  const worker = await getWorker(onProgress);
  const canvas = cropCenter(video);
  onProgress && onProgress("Analizando la imagen…");
  const { data } = await worker.recognize(canvas);
  return (data && data.text) ? data.text : "";
}
