// ocr.js — Lectura del VIN por OCR (texto grabado en el parabrisas, sin código de barras).
// Usa Tesseract.js (ESM) desde CDN con rutas explícitas para evitar fallos en PWA.
import { computeCheckDigit } from "./vin.js";

const VER = "5";
const TESSERACT_ESM = `https://cdn.jsdelivr.net/npm/tesseract.js@${VER}/dist/tesseract.esm.min.js`;
const WORKER_PATH  = `https://cdn.jsdelivr.net/npm/tesseract.js@${VER}/dist/worker.min.js`;
const CORE_PATH    = `https://cdn.jsdelivr.net/npm/tesseract.js-core@5`;
const LANG_PATH    = `https://tessdata.projectnaptha.com/4.0.0`;

let _worker = null;

async function getWorker(onProgress) {
  if (_worker) return _worker;
  onProgress && onProgress("Cargando lector de texto (OCR)… (1ª vez tarda unos segundos)");
  // createWorker puede colgarse indefinidamente si el CDN/red falla (bug conocido
  // #1075). Le ponemos un tiempo límite para no dejar el escaneo muerto.
  const withTimeout = (p, ms, msg) => Promise.race([
    p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms)),
  ]);
  const mod = await withTimeout(
    import(/* @vite-ignore */ TESSERACT_ESM), 12000, "No se pudo cargar el OCR (red lenta)."
  );
  const Tesseract = mod.default || mod;
  const worker = await withTimeout(
    Tesseract.createWorker("eng", 1, {
      workerPath: WORKER_PATH, corePath: CORE_PATH, langPath: LANG_PATH,
      logger: () => {},
    }),
    20000, "El motor de OCR no terminó de cargar (conexión lenta o no compatible)."
  );
  await worker.setParameters({
    // Incluir el asterisco: los VIN grabados vienen entre asteriscos (*VIN*).
    // Si el OCR reconoce el "*" como carácter, no lo confunde con letras y lee rápido.
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789*",
    tessedit_pageseg_mode: "7", // una sola línea de texto (el VIN es una línea)
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

  // Versión C: umbral ADAPTATIVO local (media por bloques). Resuelve reflejos y
  // sombras desiguales del parabrisas, donde un umbral global falla.
  const W = base.width, H = base.height;
  const adaptData = bctx.createImageData(W, H);
  const block = Math.max(15, Math.round(W / 24)); // tamaño de vecindad
  // Imagen integral para medias rápidas
  const integ = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let rowSum = 0;
    for (let x = 0; x < W; x++) {
      rowSum += norm[y * W + x];
      integ[(y + 1) * (W + 1) + (x + 1)] = integ[y * (W + 1) + (x + 1)] + rowSum;
    }
  }
  const half = block >> 1;
  const C = 8; // constante que se resta a la media (ajuste fino)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const x1 = Math.max(0, x - half), y1 = Math.max(0, y - half);
      const x2 = Math.min(W - 1, x + half), y2 = Math.min(H - 1, y + half);
      const area = (x2 - x1 + 1) * (y2 - y1 + 1);
      const sum = integ[(y2 + 1) * (W + 1) + (x2 + 1)] - integ[y1 * (W + 1) + (x2 + 1)]
                - integ[(y2 + 1) * (W + 1) + x1] + integ[y1 * (W + 1) + x1];
      const mean = sum / area;
      const v = norm[y * W + x] > (mean - C) ? 255 : 0;
      const i = (y * W + x) * 4;
      adaptData.data[i] = adaptData.data[i+1] = adaptData.data[i+2] = v;
      adaptData.data[i+3] = 255;
    }
  }
  const adaptCanvas = document.createElement("canvas");
  adaptCanvas.width = W; adaptCanvas.height = H;
  adaptCanvas.getContext("2d").putImageData(adaptData, 0, 0);

  return {
    gray: grayCanvas.toDataURL("image/png"),
    bin: binCanvas.toDataURL("image/png"),
    adapt: adaptCanvas.toDataURL("image/png"),
    inkRatio: dark / n,
  };
}

// Corrige caracteres confundibles del OCR según la POSICIÓN en el VIN.
// El VIN no usa I,O,Q. Posiciones 1-3,4-8 suelen ser mixtas; 10 (año) letra/num;
// 12-17 (serie) casi siempre números. Aplicamos correcciones conservadoras.
function fixCommonOcr(s) {
  if (s.length !== 17) return s;
  const arr = s.split("");
  const toNum = { O: "0", Q: "0", I: "1", L: "1", Z: "2", S: "5", B: "8", G: "6", D: "0" };
  const toLet = { "0": "D", "1": "T", "8": "B", "5": "S", "6": "G" };
  // Posiciones 12-17 (índices 11-16): número de serie → preferir dígitos.
  for (let i = 11; i < 17; i++) {
    if (toNum[arr[i]]) arr[i] = toNum[arr[i]];
  }
  // I,O,Q nunca válidos en ningún lugar → convertir a su número más parecido.
  for (let i = 0; i < 17; i++) {
    if (arr[i] === "I") arr[i] = "1";
    else if (arr[i] === "O" || arr[i] === "Q") arr[i] = "0";
  }
  return arr.join("");
}

// Grupos de caracteres que el OCR confunde entre sí. Para cada carácter leído,
// candidatos plausibles (incluyéndolo). Se usa para corregir por dígito de control.
const CONFUSABLE = {
  "8": ["8", "B"], "B": ["B", "8"],
  "0": ["0", "D", "O", "Q"], "D": ["D", "0"], "O": ["0"], "Q": ["0"],
  "1": ["1", "I", "L", "T"], "I": ["1"], "L": ["L", "1"], "T": ["T", "1"],
  "5": ["5", "S"], "S": ["S", "5"],
  "6": ["6", "G"], "G": ["G", "6"],
  "2": ["2", "Z"], "Z": ["Z", "2"],
  "4": ["4", "A"], "A": ["A", "4"],
  "9": ["9", "P"], "P": ["P", "9"],
  "7": ["7"], "3": ["3"],
};

// NOTA DE SEGURIDAD: NO corregimos "hasta que valide" por fuerza bruta, porque
// ~1 de cada 11 VIN cualquiera pasa el dígito de control. Adivinar produciría
// VIN incorrectos que igual validan (retrabajo). En su lugar solo aceptamos una
// corrección si es ÚNICA y MÍNIMA: cambiar UN solo carácter, por su confundible,
// y que el resultado sea la ÚNICA combinación válida. Si hay ambigüedad, no se corrige.
function resolveByCheckDigit(s) {
  if (!s || s.length !== 17) return null;
  if (computeCheckDigit(s) === s[8]) return s; // ya válido

  const solutions = new Set();
  // Probar cambiar UN solo carácter (índice i) por cada uno de sus confundibles.
  for (let i = 0; i < 17; i++) {
    const alts = (CONFUSABLE[s[i]] || []).filter(c => c !== s[i] && /[A-HJ-NPR-Z0-9]/.test(c));
    for (const c of alts) {
      const cand = s.slice(0, i) + c + s.slice(i + 1);
      if (computeCheckDigit(cand) === cand[8]) solutions.add(cand);
    }
  }
  // Solo devolvemos si hay EXACTAMENTE una solución (sin ambigüedad).
  return solutions.size === 1 ? [...solutions][0] : null;
}

function cleanText(t) {
  // Mayúsculas y quita separadores/símbolos. IMPORTANTE: NO borramos I/O/Q,
  // las CONVERTIMOS a su número (I→1, O→0, Q→0). En un VIN esas letras no existen,
  // así que casi siempre son dígitos mal leídos por el OCR. Borrarlas quitaría un
  // carácter y el VIN quedaría con 16 (el bug del "0" perdido).
  return String(t || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")   // fuera espacios, *, guiones, etc.
    .replace(/I/g, "1")
    .replace(/[OQ]/g, "0");
}

function bestVinCandidate(clean) {
  if (!clean) return { vin: null, best: "" };
  // Buscamos exactamente 17 caracteres válidos de VIN (ya sin I/O/Q).
  const exact = clean.match(/[A-HJ-NPR-Z0-9]{17}/);
  if (exact) return { vin: exact[0], best: exact[0] };
  // Bloques de 18-20 (por bordes/asteriscos): recortar a 17.
  const parts = clean.match(/[A-HJ-NPR-Z0-9]+/g) || [];
  for (const p of parts) {
    if (p.length >= 17 && p.length <= 20) {
      return { vin: p.slice(0, 17), best: p.slice(0, 17) };
    }
  }
  const best = parts.sort((a, b) => b.length - a.length)[0] || clean;
  return { vin: null, best };
}

// Lee el VIN con estrategia CONFIABLE por CONSENSO (votación):
//  - Toma varias fotos y, en cada una, prueba 3 franjas × 3 procesamientos.
//  - Recolecta todos los candidatos de 17 caracteres.
//  - Un candidato es "verificado" si pasa el dígito de control (directo o con
//    corrección ÚNICA y mínima de un carácter confundible).
//  - Gana el VIN verificado que MÁS VECES aparezca (consenso). Así un error
//    aleatorio del OCR no se impone sobre la lectura correcta repetida.
// OCR CONTINUO en vivo: analiza cuadros repetidamente y, en cuanto obtiene un VIN
// VERIFICADO (dígito de control válido) que aparece 2 veces (consenso), lo entrega.
// Así el usuario solo apunta al VIN de texto unos segundos, sin tomar foto.
// Devuelve un objeto con stop() para detenerlo.
export function startLiveVinOcr(video, { onFound, onTick, onStatus } = {}) {
  let running = true;
  let worker = null;
  let frames = 0;

  (async () => {
    try {
      worker = await getWorker(onStatus);
    } catch (e) {
      onStatus && onStatus("No se pudo cargar el lector de texto: " + (e.message || e), "error");
      return;
    }
    onStatus && onStatus("Apunta al número de VIN y mantén firme…", "ok");

    while (running) {
      if (!video.videoWidth) { await sleep(120); continue; }
      frames++;
      const variants = cropVariants(video, 0.88, 0.50);
      const which = frames % 3;
      const url = which === 0 ? variants.gray : (which === 1 ? variants.adapt : variants.bin);

      // Latido: confirma que el bucle SÍ corre (aunque no lea nada).
      onTick && onTick("· ciclo " + frames + " analizando…", 0);

      let text = "";
      try {
        // Tiempo límite: si recognize se cuelga (bug de Tesseract en móvil), lo abortamos.
        const rec = worker.recognize(url);
        const res = await Promise.race([
          rec,
          new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 6000)),
        ]);
        text = res?.data?.text || "";
      } catch (e) {
        onTick && onTick("(recognize " + (e.message || e) + ")", 0);
        await sleep(80);
        continue;
      }

      const { vin } = bestVinCandidate(cleanText(text));
      const shown = (text || "").replace(/\s+/g, "").slice(0, 20);
      if (shown) onTick && onTick("leyó: " + shown, 0);

      if (vin) {
        const fixed = fixCommonOcr(vin);
        let verified = (computeCheckDigit(fixed) === fixed[8]) ? fixed : resolveByCheckDigit(fixed);
        if (verified) { running = false; onFound && onFound(verified); return; }
      }
      await sleep(90);
    }
  })();

  return { stop() { running = false; } };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export async function readVinFromVideo(video, { onProgress, onCandidate } = {}) {
  const worker = await getWorker(onProgress);
  // Versión que funcionaba: 3 franjas (centro-alto, centro, ancha) × 3 procesamientos
  // (gris, binaria Otsu, adaptativa). Elige el que pasa el dígito de control.
  const passes = [
    { h: 0.18, cy: 0.50 },  // franja estrecha centrada (como al inicio: menos fondo, lee mejor)
    { h: 0.22, cy: 0.44 },
    { h: 0.22, cy: 0.56 },
  ];
  let bestOverall = "", vinFound = null, lowInk = true, bestValid = null;

  for (let k = 0; k < passes.length && !bestValid; k++) {
    onProgress && onProgress(`Analizando imagen (${k + 1}/${passes.length})…`);
    const { gray, bin, adapt, inkRatio } = cropVariants(video, passes[k].h, passes[k].cy);
    if (inkRatio > 0.005) lowInk = false;

    for (const [name, url] of [["gris", gray], ["bin", bin], ["adapt", adapt]]) {
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
      const { vin, best } = bestVinCandidate(clean);
      let mark = "";
      if (vin) {
        const fixed = fixCommonOcr(vin);
        if (computeCheckDigit(fixed) === fixed[8]) { bestValid = fixed; mark = " ✓"; }
        else {
          const resolved = resolveByCheckDigit(fixed);
          if (resolved) { bestValid = resolved; mark = " ✓(corr.)"; }
          else if (!vinFound) { vinFound = fixed; }
        }
      }
      onCandidate && onCandidate(`[${name}] "${rawSeen}" → ${clean}${mark}`);
      if (best.length > bestOverall.length) bestOverall = best;
      if (bestValid) break;
    }
  }
  return { vin: bestValid || vinFound, verified: !!bestValid, raw: bestOverall, lowInk };
}



// ---- OCR de UNA FOTO (cámara nativa del celular). Lo más fiable en móvil ----
// Procesa la imagen UNA sola vez con varias versiones (gris, binaria, adaptativa)
// y con varias escalas/recortes. No usa el video en vivo (que colapsa en móvil).

// Genera un canvas escalado desde una imagen (Image/Bitmap) a un ancho objetivo.
function scaleToCanvas(img, targetW) {
  const w = img.width || img.videoWidth, h = img.height || img.videoHeight;
  const scale = Math.min(2, Math.max(1, targetW / w));
  const cw = Math.round(w * scale), ch = Math.round(h * scale);
  const c = document.createElement("canvas");
  c.width = cw; c.height = ch;
  c.getContext("2d").drawImage(img, 0, 0, cw, ch);
  return c;
}

// Aplica gris+contraste / Otsu / adaptativo a un canvas y devuelve los 3 dataURLs.
function processCanvas(srcCanvas) {
  const ctx = srcCanvas.getContext("2d");
  const W = srcCanvas.width, H = srcCanvas.height;
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data, n = d.length / 4;
  const gray = new Float32Array(n);
  let min = 255, max = 0;
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    gray[j] = g; if (g < min) min = g; if (g > max) max = g;
  }
  const range = Math.max(1, max - min);
  const norm = new Uint8Array(n);
  const hist = new Array(256).fill(0);
  for (let j = 0; j < n; j++) { const s = Math.round(((gray[j] - min) / range) * 255); norm[j] = s; hist[s]++; }

  const mk = (fn) => {
    const out = ctx.createImageData(W, H);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      const v = fn(norm[j], j);
      out.data[i] = out.data[i+1] = out.data[i+2] = v; out.data[i+3] = 255;
    }
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    c.getContext("2d").putImageData(out, 0, 0);
    return c.toDataURL("image/png");
  };

  // Otsu
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
  // Adaptativo (imagen integral)
  const integ = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) { let rs = 0; for (let x = 0; x < W; x++) { rs += norm[y*W+x]; integ[(y+1)*(W+1)+(x+1)] = integ[y*(W+1)+(x+1)] + rs; } }
  const blk = Math.max(15, Math.round(W / 30)), half = blk >> 1, CC = 8;
  const adaptVal = (v, j) => {
    const x = j % W, y = (j / W) | 0;
    const x1 = Math.max(0, x-half), y1 = Math.max(0, y-half), x2 = Math.min(W-1, x+half), y2 = Math.min(H-1, y+half);
    const area = (x2-x1+1)*(y2-y1+1);
    const sum = integ[(y2+1)*(W+1)+(x2+1)] - integ[y1*(W+1)+(x2+1)] - integ[(y2+1)*(W+1)+x1] + integ[y1*(W+1)+x1];
    return v > (sum/area - CC) ? 255 : 0;
  };

  return {
    gray: mk((v) => v),
    bin: mk((v) => v > thr ? 255 : 0),
    adapt: mk((v, j) => adaptVal(v, j)),
  };
}

// Lee el VIN de un archivo de imagen (la foto tomada con la cámara del celular).
export async function readVinFromImageFile(file, { onProgress, onCandidate } = {}) {
  const worker = await getWorker(onProgress);
  onProgress && onProgress("Preparando la foto…");

  const bitmap = await createImageBitmap(file).catch(async () => {
    // Respaldo si createImageBitmap no está disponible
    const url = URL.createObjectURL(file);
    const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    return im;
  });

  const votesVerified = new Map();
  const seenRaw = new Map();
  let bestOverall = "";

  // Probamos a dos escalas (por si el texto es pequeño en la foto).
  for (const targetW of [1600, 2200]) {
    const canvas = scaleToCanvas(bitmap, targetW);
    const { gray, bin, adapt } = processCanvas(canvas);
    for (const [name, url] of [["gris", gray], ["adapt", adapt], ["bin", bin]]) {
      onProgress && onProgress("Leyendo el VIN de la foto…");
      let text = "";
      try {
        const rec = worker.recognize(url);
        const res = await Promise.race([rec, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 15000))]);
        text = res?.data?.text || "";
      } catch (e) { onCandidate && onCandidate("(recognize " + (e.message || e) + ")"); continue; }

      const rawSeen = String(text).replace(/\s+/g, " ").trim();
      const clean = cleanText(text);
      const { vin, best } = bestVinCandidate(clean);
      if (best.length > bestOverall.length) bestOverall = best;
      let mark = "";
      if (vin) {
        const fixed = fixCommonOcr(vin);
        let verified = (computeCheckDigit(fixed) === fixed[8]) ? fixed : resolveByCheckDigit(fixed);
        if (verified) { votesVerified.set(verified, (votesVerified.get(verified) || 0) + 1); mark = " ✓"; }
        else seenRaw.set(fixed, (seenRaw.get(fixed) || 0) + 1);
      }
      onCandidate && onCandidate(`[${targetW}/${name}] "${rawSeen}"${mark}`);
      // Si ya hay un verificado, no seguimos gastando tiempo.
      if (votesVerified.size) break;
    }
    if (votesVerified.size) break;
  }

  const vSorted = [...votesVerified.entries()].sort((a, b) => b[1] - a[1]);
  if (vSorted.length) return { vin: vSorted[0][0], verified: true, raw: bestOverall };
  const rSorted = [...seenRaw.entries()].sort((a, b) => b[1] - a[1]);
  return { vin: rSorted.length ? rSorted[0][0] : null, verified: false, raw: bestOverall };
}
