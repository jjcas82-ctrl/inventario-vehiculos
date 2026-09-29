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
    // Incluimos el asterisco: los VIN grabados suelen venir entre asteriscos (*VIN*).
    // Reconocerlo ayuda al OCR a separar bien el VIN de los delimitadores.
    tessedit_char_whitelist: "ABCDEFGHJKLMNPRSTUVWXYZ0123456789*",
    tessedit_pageseg_mode: "7", // una sola línea
  });
  _worker = worker;
  return _worker;
}

// Recorta una franja del video (centrada en cy, alto=heightFactor) y devuelve
// DOS versiones para OCR: gris con contraste (sin binarizar) y binarizada (Otsu).
// Probar ambas mejora mucho la lectura sobre superficies brillantes/reflejos.
function cropVariants(video, heightFactor, cy = 0.5) {
  const vw = video.videoWidth, vh = video.videoHeight;
  const cropW = Math.round(vw * 0.96);
  const cropH = Math.round(vh * heightFactor);
  const sx = Math.round((vw - cropW) / 2);
  const sy = Math.round(Math.min(Math.max(vh * cy - cropH / 2, 0), vh - cropH));
  const scale = 3;

  const base = document.createElement("canvas");
  base.width = cropW * scale; base.height = cropH * scale;
  const bctx = base.getContext("2d");
  bctx.imageSmoothingEnabled = true;
  bctx.drawImage(video, sx, sy, cropW, cropH, 0, 0, base.width, base.height);

  const img = bctx.getImageData(0, 0, base.width, base.height);
  const d = img.data, n = d.length / 4;
  const gray = new Float32Array(n);
  let min = 255, max = 0;
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    gray[j] = g; if (g < min) min = g; if (g > max) max = g;
  }
  const range = Math.max(1, max - min);

  // Versión A: escala de grises con contraste estirado (SIN binarizar).
  const grayData = bctx.createImageData(base.width, base.height);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    const s = ((gray[j] - min) / range) * 255;
    grayData.data[i] = grayData.data[i+1] = grayData.data[i+2] = s;
    grayData.data[i+3] = 255;
  }
  const grayCanvas = document.createElement("canvas");
  grayCanvas.width = base.width; grayCanvas.height = base.height;
  grayCanvas.getContext("2d").putImageData(grayData, 0, 0);

  // Versión B: binarización Otsu.
  const hist = new Array(256).fill(0);
  const norm = new Uint8Array(n);
  for (let j = 0; j < n; j++) { const s = Math.round(((gray[j] - min) / range) * 255); norm[j] = s; hist[s]++; }
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
  const binData = bctx.createImageData(base.width, base.height);
  let dark = 0;
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    const v = norm[j] > thr ? 255 : 0;
    if (v === 0) dark++;
    binData.data[i] = binData.data[i+1] = binData.data[i+2] = v;
    binData.data[i+3] = 255;
  }
  const binCanvas = document.createElement("canvas");
  binCanvas.width = base.width; binCanvas.height = base.height;
  binCanvas.getContext("2d").putImageData(binData, 0, 0);

  return {
    gray: grayCanvas.toDataURL("image/png"),
    bin: binCanvas.toDataURL("image/png"),
    inkRatio: dark / n,
  };
}

function cleanText(t) {
  return String(t || "").toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, "");
}

function bestVinCandidate(clean) {
  if (!clean) return { vin: null, best: "" };
  // 1) 17 caracteres válidos seguidos.
  const exact = clean.match(/[A-HJ-NPR-Z0-9]{17}/);
  if (exact) return { vin: exact[0], best: exact[0] };
  // 2) Si hay un bloque de 18-19 (por bordes o restos de asteriscos leídos como
  //    caracteres), probamos recortando desde el inicio hasta obtener 17 válidos.
  const parts = clean.match(/[A-HJ-NPR-Z0-9]+/g) || [];
  for (const p of parts) {
    if (p.length >= 17 && p.length <= 20) {
      for (let start = 0; start + 17 <= p.length; start++) {
        return { vin: p.slice(start, start + 17), best: p.slice(start, start + 17) };
      }
    }
  }
  const best = parts.sort((a, b) => b.length - a.length)[0] || clean;
  return { vin: null, best };
}

// Ejecuta OCR probando varias franjas (arriba/centro/abajo) y, en cada una,
// dos variantes (gris y binarizada). Elige el mejor candidato a VIN.
export async function readVinFromVideo(video, { onProgress, onCandidate } = {}) {
  const worker = await getWorker(onProgress);
  // Franjas: centro alto, centro, y una franja ancha que cubre casi todo.
  const passes = [
    { h: 0.30, cy: 0.42 },
    { h: 0.30, cy: 0.55 },
    { h: 0.55, cy: 0.50 },
  ];
  let bestOverall = "", vinFound = null, lowInk = true;

  for (let k = 0; k < passes.length && !vinFound; k++) {
    onProgress && onProgress(`Analizando imagen (${k + 1}/${passes.length})…`);
    const { gray, bin, inkRatio } = cropVariants(video, passes[k].h, passes[k].cy);
    if (inkRatio > 0.005) lowInk = false;

    for (const [name, url] of [["gris", gray], ["bin", bin]]) {
      let text = "";
      try {
        const { data } = await worker.recognize(url);
        text = data && data.text ? data.text : "";
      } catch (e) {
        onCandidate && onCandidate("(error worker: " + (e.message || e) + ")");
        continue;
      }
      const rawSeen = String(text).replace(/\s+/g, " ").trim();
      const clean = cleanText(text);
      onCandidate && onCandidate(`[${name}] "${rawSeen}" → ${clean}`);
      const { vin, best } = bestVinCandidate(clean);
      if (best.length > bestOverall.length) bestOverall = best;
      if (vin) { vinFound = vin; break; }
    }
  }
  return { vin: vinFound, raw: bestOverall, lowInk };
}
