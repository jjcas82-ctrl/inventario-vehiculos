// barcode39.js — Generador de código de barras Code 39 en JS puro, SIN dependencias.
// Reemplaza "jsbarcode" de CDN para que la etiqueta funcione 100% offline.
// Code 39 es el estándar usado en los VIN. Cada carácter = 9 barras (5 negras, 4 blancas),
// 3 de ellas anchas. Patrón "nnnnb..." codificado como 9 bits ancho(1)/estrecho(0),
// alternando barra/espacio empezando por barra.

const CODE39 = {
  "0": "000110100", "1": "100100001", "2": "001100001", "3": "101100000",
  "4": "000110001", "5": "100110000", "6": "001110000", "7": "000100101",
  "8": "100100100", "9": "001100100", "A": "100001001", "B": "001001001",
  "C": "101001000", "D": "000011001", "E": "100011000", "F": "001011000",
  "G": "000001101", "H": "100001100", "I": "001001100", "J": "000011100",
  "K": "100000011", "L": "001000011", "M": "101000010", "N": "000010011",
  "O": "100010010", "P": "001010010", "Q": "000000111", "R": "100000110",
  "S": "001000110", "T": "000010110", "U": "110000001", "V": "011000001",
  "W": "111000000", "X": "010010001", "Y": "110010000", "Z": "011010000",
  "-": "010000101", ".": "110000100", " ": "011000100", "$": "010101000",
  "/": "010100010", "+": "010001010", "%": "000101010", "*": "010010100",
};

// Devuelve un dataURL PNG del código de barras Code 39 del texto dado.
// Se envuelve automáticamente con el carácter de inicio/fin "*".
export function barcode39DataUrl(text, { barWidth = 2, height = 90, margin = 10 } = {}) {
  const data = "*" + String(text).toUpperCase().replace(/[^0-9A-Z\-. $/+%]/g, "") + "*";
  // Construir la secuencia de anchos de módulo (ancho=3, estrecho=1), con 1 módulo
  // de separación (espacio estrecho) entre caracteres.
  const bars = []; // { on: bool, width: n }
  for (let k = 0; k < data.length; k++) {
    const pat = CODE39[data[k]];
    if (!pat) continue;
    for (let i = 0; i < 9; i++) {
      const wide = pat[i] === "1";
      const on = i % 2 === 0; // empieza en barra, alterna
      bars.push({ on, width: wide ? 3 : 1 });
    }
    if (k < data.length - 1) bars.push({ on: false, width: 1 }); // separador
  }

  const unit = barWidth;
  const totalUnits = bars.reduce((s, b) => s + b.width, 0);
  const w = totalUnits * unit + margin * 2;
  const h = height + margin * 2;
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#000000";
  let x = margin;
  for (const b of bars) {
    const bw = b.width * unit;
    if (b.on) ctx.fillRect(x, margin, bw, height);
    x += bw;
  }
  return canvas.toDataURL("image/png");
}
