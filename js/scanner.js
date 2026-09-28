// scanner.js — Escáner de cámara robusto para QR y códigos de barras (incluye VIN).
//
// Estrategia:
//   1) Usa la API nativa BarcodeDetector si el navegador la soporta (Chrome Android, Edge).
//   2) Si no, carga ZXing (@zxing/browser) desde CDN como respaldo.
//   3) Fallback manual siempre disponible (el usuario escribe/pega el VIN o usa lector USB).
//
// IMPORTANTE: getUserMedia solo funciona en HTTPS o http://localhost.

const ZXING_CDN = "https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/+esm";

// Formatos que nos interesan (QR + los códigos de barras usados en etiquetas de VIN)
const FORMATS = ["qr_code", "code_128", "code_39", "data_matrix", "pdf417", "codabar", "ean_13"];

export class Scanner {
  constructor(videoEl, { onResult, onStatus } = {}) {
    this.video = videoEl;
    this.onResult = onResult || (() => {});
    this.onStatus = onStatus || (() => {});
    this.stream = null;
    this.running = false;
    this._detector = null;
    this._zxingControls = null;
    this._rafId = null;
  }

  static isSecureContext() {
    // getUserMedia requiere contexto seguro (HTTPS o localhost)
    return window.isSecureContext ||
      ["localhost", "127.0.0.1"].includes(location.hostname);
  }

  async start() {
    if (this.running) return;

    if (!Scanner.isSecureContext()) {
      this.onStatus("⚠️ La cámara requiere HTTPS o localhost. Usa la captura manual del VIN.", "error");
      throw new Error("insecure-context");
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      this.onStatus("Este navegador no permite acceso a la cámara. Usa la captura manual.", "error");
      throw new Error("no-getusermedia");
    }

    this.onStatus("Solicitando permiso de cámara…");
    try {
      // Preferimos la cámara trasera (environment)
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
    } catch (err) {
      this._handleGumError(err);
      throw err;
    }

    this.video.srcObject = this.stream;
    this.video.setAttribute("playsinline", "true");
    await this.video.play().catch(() => {});
    this.running = true;

    // Elegir motor de detección
    if ("BarcodeDetector" in window) {
      try {
        const supported = await window.BarcodeDetector.getSupportedFormats();
        const formats = FORMATS.filter(f => supported.includes(f));
        this._detector = new window.BarcodeDetector({ formats: formats.length ? formats : undefined });
        this.onStatus("Cámara activa (detector nativo). Apunta al código.", "ok");
        this._loopNative();
        return;
      } catch (e) {
        // cae al respaldo ZXing
      }
    }
    await this._startZxing();
  }

  async _startZxing() {
    this.onStatus("Cargando lector de respaldo…");
    let mod;
    try {
      mod = await import(/* @vite-ignore */ ZXING_CDN);
    } catch (e) {
      this.onStatus("No se pudo cargar el lector de respaldo (¿sin internet?). Usa la captura manual.", "error");
      return;
    }
    const { BrowserMultiFormatReader } = mod;
    const reader = new BrowserMultiFormatReader();
    this.onStatus("Cámara activa (lector de respaldo). Apunta al código.", "ok");
    this._zxingControls = await reader.decodeFromStream(this.stream, this.video, (result, err) => {
      if (result) this._emit(result.getText());
    });
  }

  async _loopNative() {
    if (!this.running || !this._detector) return;
    try {
      const codes = await this._detector.detect(this.video);
      if (codes && codes.length) {
        this._emit(codes[0].rawValue);
      }
    } catch (e) {
      // ignorar frames fallidos
    }
    if (this.running) {
      this._rafId = requestAnimationFrame(() => this._loopNative());
    }
  }

  _emit(text) {
    if (!text) return;
    const clean = String(text).trim();
    this.onResult(clean);
    // Nota: no detenemos automáticamente para permitir varios escaneos;
    // el consumidor decide si llamar stop().
  }

  _handleGumError(err) {
    const name = err && err.name;
    const map = {
      NotAllowedError: "Permiso de cámara denegado. Actívalo en el navegador (⋮ → Configuración de sitios → Cámara).",
      NotFoundError: "No se encontró ninguna cámara en el dispositivo.",
      NotReadableError: "La cámara está en uso por otra aplicación.",
      OverconstrainedError: "No hay una cámara que cumpla los requisitos. Se intentará con la cámara frontal.",
      SecurityError: "La cámara requiere HTTPS o localhost.",
    };
    this.onStatus(map[name] || `No se pudo abrir la cámara: ${name || err}`, "error");
  }

  stop() {
    this.running = false;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = null;
    if (this._zxingControls) {
      try { this._zxingControls.stop(); } catch (e) {}
      this._zxingControls = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    if (this.video) this.video.srcObject = null;
    this._detector = null;
  }
}
