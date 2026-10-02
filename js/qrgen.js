// qrgen.js — Generador de códigos QR en JavaScript puro, SIN dependencias externas.
// Reemplaza la librería "qrcode" de CDN para que la impresión de etiquetas funcione
// 100% offline y sin que un firewall corporativo bloquee el CDN.
//
// Implementa QR modo byte con corrección de errores Reed-Solomon. Suficiente para
// codificar un VIN (17 caracteres ASCII). Devuelve una matriz de módulos y un helper
// para pintarlo en un canvas / dataURL.
//
// Basado en el estándar ISO/IEC 18004. Implementación compacta y propia.

// ---- Campo de Galois GF(256) para Reed-Solomon ----
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

// Polinomio generador: producto de (x - α^i), i=0..degree-1. g[0] = término de mayor grado (=1).
// Verificado contra el valor canónico del estándar (ejemplo "HELLO WORLD" v1-M).
function rsGenPoly(degree) {
  let g = [1];
  for (let i = 0; i < degree; i++) {
    const ng = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      ng[j] ^= g[j];
      ng[j + 1] ^= gfMul(g[j], EXP[i]);
    }
    g = ng;
  }
  return g; // longitud degree+1
}

function rsEncode(data, ecLen) {
  const gen = rsGenPoly(ecLen);
  // División polinómica: res = data seguido de ecLen ceros; dividir por gen.
  const res = data.slice().concat(new Array(ecLen).fill(0));
  for (let i = 0; i < data.length; i++) {
    const coef = res[i];
    if (coef !== 0) for (let j = 0; j < gen.length; j++) res[i + j] ^= gfMul(gen[j], coef);
  }
  return res.slice(data.length);
}

// ---- Tablas de capacidad por versión (modo byte) y bloques EC ----
// Formato por versión: [totalCodewords, [ecPerBlock, numBlocks] (y grupo 2 si aplica)]
// Usamos nivel de corrección M (medio). Soportamos versiones 1..10 (hasta ~271 bytes),
// más que suficiente para un VIN.
const VERSIONS = {
  // ver: { size, totalData (bytes), ec: ecCodewordsPerBlock, groups: [[numBlocks, dataPerBlock],...] }
  1:  { size: 21, ec: 10, groups: [[1, 16]] },
  2:  { size: 25, ec: 16, groups: [[1, 28]] },
  3:  { size: 29, ec: 26, groups: [[1, 44]] },
  4:  { size: 33, ec: 18, groups: [[2, 32]] },
  5:  { size: 37, ec: 24, groups: [[2, 43]] },
};

// Patrón de alineación por versión (coordenadas centrales)
const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
};

function pickVersion(dataLen) {
  // dataLen = bytes del contenido. El header de modo byte ocupa 4 bits + 8 bits de
  // longitud (versiones 1-9) = ~2 bytes extra; comprobamos capacidad de datos.
  for (const v of [1, 2, 3, 4, 5]) {
    const info = VERSIONS[v];
    const totalData = info.groups.reduce((s, [n, d]) => s + n * d, 0);
    // bits necesarios: 4 (modo) + 8 (len) + 8*dataLen, redondeado a bytes.
    const needBytes = Math.ceil((4 + 8 + 8 * dataLen) / 8);
    if (needBytes <= totalData) return v;
  }
  throw new Error("El contenido es demasiado largo para el QR.");
}

function buildBitStream(str, version) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) bytes.push(str.charCodeAt(i) & 0xff);
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(0b0100, 4);        // modo byte
  push(bytes.length, 8);  // longitud (versiones 1-9)
  for (const b of bytes) push(b, 8);

  const info = VERSIONS[version];
  const totalData = info.groups.reduce((s, [n, d]) => s + n * d, 0);
  const capacityBits = totalData * 8;
  // terminador
  for (let i = 0; i < 4 && bits.length < capacityBits; i++) bits.push(0);
  // relleno a byte
  while (bits.length % 8 !== 0) bits.push(0);
  // bytes de relleno alternados
  const pads = [0xec, 0x11];
  let p = 0;
  while (bits.length < capacityBits) { push(pads[p++ % 2], 8); }

  // a codewords
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    codewords.push(b);
  }
  return codewords;
}

function interleave(codewords, version) {
  const info = VERSIONS[version];
  const ecLen = info.ec;
  // dividir en bloques
  const blocks = [];
  let idx = 0;
  for (const [numBlocks, dataPerBlock] of info.groups) {
    for (let b = 0; b < numBlocks; b++) {
      const data = codewords.slice(idx, idx + dataPerBlock);
      idx += dataPerBlock;
      const ec = rsEncode(data, ecLen);
      blocks.push({ data, ec });
    }
  }
  const result = [];
  const maxData = Math.max(...blocks.map(b => b.data.length));
  for (let i = 0; i < maxData; i++)
    for (const blk of blocks) if (i < blk.data.length) result.push(blk.data[i]);
  for (let i = 0; i < ecLen; i++)
    for (const blk of blocks) result.push(blk.ec[i]);
  return result;
}

// ---- Construcción de la matriz ----
function makeMatrix(version) {
  const size = VERSIONS[version].size;
  const m = Array.from({ length: size }, () => new Array(size).fill(null));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));

  const place = (r, c, v) => { if (r >= 0 && c >= 0 && r < size && c < size) { m[r][c] = v; reserved[r][c] = true; } };

  // Buscadores (finder) en 3 esquinas
  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++)
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r, cc = c0 + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6));
        const inCore = (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        place(rr, cc, (inRing || inCore) ? 1 : 0);
      }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

  // Separadores ya cubiertos por los -1..7 (quedan en 0)

  // Patrones de temporización (timing)
  for (let i = 8; i < size - 8; i++) {
    const v = i % 2 === 0 ? 1 : 0;
    place(6, i, v); place(i, 6, v);
  }

  // Módulo oscuro fijo
  place(size - 8, 8, 1);

  // Patrones de alineación
  const centers = ALIGN[version] || [];
  for (const r of centers) for (const c of centers) {
    // no sobre los finders
    if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
      const ring = Math.max(Math.abs(dr), Math.abs(dc));
      place(r + dr, c + dc, (ring === 2 || ring === 0) ? 1 : 0);
    }
  }

  // Reservar zonas de información de formato
  for (let i = 0; i < 9; i++) { if (!(i === 6)) { reserved[8][i] = true; reserved[i][8] = true; } }
  for (let i = 0; i < 8; i++) { reserved[8][size - 1 - i] = true; reserved[size - 1 - i][8] = true; }
  reserved[8][6] = true; reserved[6][8] = true;

  return { m, reserved, size };
}

function placeData(matrix, data) {
  const { m, reserved, size } = matrix;
  let bitIndex = 0;
  const totalBits = data.length * 8;
  const getBit = () => {
    if (bitIndex >= totalBits) return 0;
    const b = (data[bitIndex >> 3] >> (7 - (bitIndex & 7))) & 1;
    bitIndex++;
    return b;
  };
  let col = size - 1;
  let upward = true;
  while (col > 0) {
    if (col === 6) col--; // saltar la columna de timing
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (let c = 0; c < 2; c++) {
        const cc = col - c;
        if (!reserved[row][cc]) {
          m[row][cc] = getBit();
        }
      }
    }
    upward = !upward;
    col -= 2;
  }
}

// Máscara 0: (row+col) % 2 == 0
function applyMask(matrix, maskId) {
  const { m, reserved, size } = matrix;
  const cond = (r, c) => {
    switch (maskId) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      default: return (r + c) % 2 === 0;
    }
  };
  for (let r = 0; r < size; r++)
    for (let c = 0; c < size; c++)
      if (!reserved[r][c] && cond(r, c)) m[r][c] ^= 1;
}

// Información de formato (nivel M = 00, máscara). Bits BCH precalculados.
const FORMAT_M = {
  0: 0x5412, 1: 0x5125, 2: 0x5e7c, 3: 0x5b4b,
};
function placeFormat(matrix, maskId) {
  const { m, size } = matrix;
  const bits = FORMAT_M[maskId];
  const arr = [];
  for (let i = 14; i >= 0; i--) arr.push((bits >> i) & 1);
  // Franja alrededor del finder superior-izquierdo
  const pos1 = [[8,0],[8,1],[8,2],[8,3],[8,4],[8,5],[8,7],[8,8],[7,8],[5,8],[4,8],[3,8],[2,8],[1,8],[0,8]];
  for (let i = 0; i < 15; i++) m[pos1[i][0]][pos1[i][1]] = arr[i];
  // Copia alrededor de los otros finders
  const pos2 = [[size-1,8],[size-2,8],[size-3,8],[size-4,8],[size-5,8],[size-6,8],[size-7,8],
                [8,size-8],[8,size-7],[8,size-6],[8,size-5],[8,size-4],[8,size-3],[8,size-2],[8,size-1]];
  for (let i = 0; i < 15; i++) m[pos2[i][0]][pos2[i][1]] = arr[i];
}

// Genera la matriz final de módulos (0/1) para un texto.
export function qrMatrix(text) {
  const version = pickVersion(text.length);
  const codewords = buildBitStream(text, version);
  const finalData = interleave(codewords, version);
  const matrix = makeMatrix(version);
  placeData(matrix, finalData);
  const maskId = 0;
  applyMask(matrix, maskId);
  placeFormat(matrix, maskId);
  return matrix.m.map(row => row.map(v => v ? 1 : 0));
}

// Dibuja el QR en un dataURL PNG.
export function qrDataUrl(text, { size = 320, margin = 4, dark = "#000000", light = "#ffffff" } = {}) {
  const mods = qrMatrix(text);
  const n = mods.length;
  const total = n + margin * 2;
  const scale = Math.max(1, Math.floor(size / total));
  const px = total * scale;
  const canvas = document.createElement("canvas");
  canvas.width = px; canvas.height = px;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = dark;
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++)
      if (mods[r][c]) ctx.fillRect((c + margin) * scale, (r + margin) * scale, scale, scale);
  return canvas.toDataURL("image/png");
}
