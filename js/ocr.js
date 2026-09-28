// ocr.js — Lectura del VIN por OCR (texto grabado en el parabrisas, sin código de barras).
// Usa Tesseract.js (ESM) desde CDN con rutas explícitas para evitar fallos en PWA.

const VER = "5";
const TESSERACT_ESM = `https://cdn.jsdelivr.net/npm/tesseract.js@${VER}/dist/tesseract.esm.min.js`;
const WORKER_PATH  = `https://cdn.jsdelivr.net/npm/tesseract.js@${VER}/dist/worker.min.js`;
const CORE_PATH    = `https://cdn.jsdelivr.net/npm/tesseract.js-core@5`;
const LANG_PATH    = `https://tessdata.projectnaptha.com/4.0.0`;

let _worker = null;

async function getWorker(onProgress) {
  if (_worker) return _worker;
  onProgress && onProgress("Cargando lector de texto (OCR)… (1ª vez tarda unos segundos)");
  const mod = await import(/* @vite-ignore */ TESSERACT_ESM);
  const Tesseract = mod.default || mod;
  // Rutas explícitas: en PWA/HTTPS evitan que el worker interno falle en silencio.
  const worker = await Tesseract.createWorker("eng", 1, {
    workerPath: WORKER_PATH,
    corePath: CORE_PATH,
    langPath: LANG_PATH,
    logger: () => {},
    errorHandler: (err) => { throw err; },
  });
  await worker.setParameters({
    tessedit_char_whitelist: "ABCDEFGHJKLMNPRSTUVWXYZ0123456789",
    tessedit_pageseg_mode: "7", // una sola línea
  });
  _worker = worker;
  return _worker;
}

// Recorta una franja central del video, realza el texto y devuelve un dataURL PNG.
function cropDataUrl(video, heightFactor) {
  const vw = video.videoWidth, vh = video.videoHeight;
  const canvas = document.createElement("canvas");
  const cropW = Math.round(vw * 0.94);
  const cropH = Math.round(vh * heightFactor);
  const sx = Math.round((vw - cropW) / 2);
  const sy = Math.round((vh - cropH) / 2);
  const scale = 3;
  canvas.width = cropW * scale;
  canvas.height = cropH * scale;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(video, sx, sy, cropW, cropH, 0, 0, canvas.width, canvas.height);

  // Escala de grises + estiramiento de contraste + umbral de Otsu
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data, n = d.length / 4;
  const gray = new Float32Array(n);
  let min = 255, max = 0;
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    gray[j] = g; if (g < min) min = g; if (g > max) max = g;
  }
  const range = Math.max(1, max - min);
  const hist = new Array(256).fill(0);
  for (let j = 0; j < n; j++) { const s = Math.round(((gray[j] - min) / range) * 255); gray[j] = s; hist[s]++; }
  let sumAll = 0; for (let t = 0; t < 256; t++) sumAll += t * hist[t];
  let sumB = 0, wB = 0, maxVar = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = n - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sumAll - sumB) / wF;
    const bv = wB * wF * (mB - mF) * (mB - mF);
    if (bv > maxVar) { maxVar = bv; thr = t; }
  }
  let dark = 0;
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    const v = gray[j] > thr ? 255 : 0;
    if (v === 0) dark++;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return { url: canvas.toDataURL("image/png"), inkRatio: dark / n };
}

function cleanText(t) {
  return String(t || "").toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, "");
}

function bestVinCandidate(clean) {
  if (!clean) return { vin: null, best: "" };
  const exact = clean.match(/[A-HJ-NPR-Z0-9]{17}/);
  if (exact) return { vin: exact[0], best: exact[0] };
  const parts = clean.match(/[A-HJ-NPR-Z0-9]+/g) || [];
  const best = parts.sort((a, b) => b.length - a.length)[0] || clean;
  return { vin: null, best };
}

// Ejecuta OCR con varios encuadres y elige el mejor candidato.
export async function readVinFromVideo(video, { onProgress, onCandidate } = {}) {
  const worker = await getWorker(onProgress);
  const heights = [0.22, 0.30, 0.42];
  let bestOverall = "", vinFound = null, lowInk = true;

  for (let k = 0; k < heights.length; k++) {
    onProgress && onProgress(`Analizando imagen (intento ${k + 1}/${heights.length})…`);
    const { url, inkRatio } = cropDataUrl(video, heights[k]);
    if (inkRatio > 0.008) lowInk = false;
    let text = "";
    try {
      const { data } = await worker.recognize(url);
      text = data && data.text ? data.text : "";
    } catch (e) {
      onCandidate && onCandidate("(error worker: " + (e.message || e) + ")");
    }
    const clean = cleanText(text);
    onCandidate && onCandidate(clean + `  [ink ${(inkRatio * 100).toFixed(1)}%]`);
    const { vin, best } = bestVinCandidate(clean);
    if (best.length > bestOverall.length) bestOverall = best;
    if (vin) { vinFound = vin; break; }
  }
  return { vin: vinFound, raw: bestOverall, lowInk };
}
