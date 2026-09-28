// scanner.js — Escáner de cámara robusto para QR y códigos de barras (incluye VIN).
//
// Estrategia:
//   1) Usa la API nativa BarcodeDetector si el navegador la soporta (Chrome Android, Edge).
//   2) Si no, carga ZXing (@zxing/browser) desde CDN como respaldo.
//   3) Fallback manual siempre disponible (el usuario escribe/pega el VIN o usa lector USB).
//
// La detección se hace capturando cuadros del video en un <canvas>, que resulta
// más fiable (sobre todo para códigos de barras lineales de VIN: Code 39 / Code 128).
//
// IMPORTANTE: getUserMedia solo funciona en HTTPS o http://localhost.

const ZXING_CDN = "https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/+esm";

// Formatos que nos interesan (QR + los códigos de barras usados en etiquetas de VIN)
const FORMATS = ["qr_code", "code_128", "code_39", "data_matrix", "pdf417", "codabar", "ean_13", "itf"];

export class Scanner {
  constructor(videoEl, { onResult, onStatus, onDetect } = {}) {
    this.video = videoEl;
    this.onResult = onResult || (() => {});     // se llama con texto detectado (crudo)
    this.onStatus = onStatus || (() => {});
    this.onDetect = onDetect || (() => {});      // se llama en cada lectura (para depurar)
    this.stream = null;
    this.running = false;
    this._detector = null;
    this._zxingReader = null;
    this._zxingControls = null;
    this._timer = null;
    this._canvas = document.createElement("canvas");
    this._ctx = this._canvas.getContext("2d", { willReadFrequently: true });
    this._track = null;
  }

  static isSecureContext() {
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
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
    } catch (err) {
      // Reintento con la cámara frontal si la trasera no cumple restricciones
      if (err && (err.name === "OverconstrainedError" || err.name === "NotFoundError")) {
        try {
          this.stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        } catch (e2) { this._handleGumError(e2); throw e2; }
      } else {
        this._handleGumError(err);
        throw err;
      }
    }

    this.video.srcObject = this.stream;
    this.video.setAttribute("playsinline", "true");
    this.video.muted = true;
    await this.video.play().catch(() => {});
    this.running = true;

    // Intentar activar enfoque continuo (ayuda con las barras finas del VIN)
    this._track = this.stream.getVideoTracks()[0];
    try {
      const caps = this._track.getCapabilities ? this._track.getCapabilities() : {};
      const adv = [];
      if (caps.focusMode && caps.focusMode.includes("continuous")) adv.push({ focusMode: "continuous" });
      if (adv.length) await this._track.applyConstraints({ advanced: adv });
    } catch (e) { /* no crítico */ }

    // Elegir motor de detección
    if ("BarcodeDetector" in window) {
      try {
        const supported = await window.BarcodeDetector.getSupportedFormats();
        const formats = FORMATS.filter(f => supported.includes(f));
        this._detector = new window.BarcodeDetector(formats.length ? { formats } : undefined);
        this.onStatus("Cámara activa. Acerca y enfoca el código o QR del VIN…", "ok");
        this._loopNative();
        return;
      } catch (e) {
        // cae al respaldo ZXing
      }
    }
    await this._startZxing();
  }

  _grabFrame() {
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    if (!vw || !vh) return null;
    this._canvas.width = vw;
    this._canvas.height = vh;
    this._ctx.drawImage(this.video, 0, 0, vw, vh);
    return this._canvas;
  }

  async _loopNative() {
    if (!this.running || !this._detector) return;
    try {
      // Detectamos sobre el canvas (más fiable que sobre el <video> en algunos equipos)
      const canvas = this._grabFrame();
      const target = canvas || this.video;
      const codes = await this._detector.detect(target);
      if (codes && codes.length) {
        this.onDetect(codes[0].rawValue, codes[0].format);
        this._emit(codes[0].rawValue);
      }
    } catch (e) {
      // ignorar frames fallidos
    }
    if (this.running) {
      // ~8 fps es suficiente y ahorra batería
      this._timer = setTimeout(() => this._loopNative(), 120);
    }
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
    this._zxingReader = new BrowserMultiFormatReader();
    this.onStatus("Cámara activa (lector de respaldo). Acerca y enfoca el código…", "ok");
    this._zxingControls = await this._zxingReader.decodeFromStream(
      this.stream, this.video, (result) => {
        if (result) {
          this.onDetect(result.getText(), "zxing");
          this._emit(result.getText());
        }
      });
  }

  _emit(text) {
    if (!text) return;
    const clean = String(text).trim();
    // El consumidor decide si es VIN válido y si detener la cámara.
    this.onResult(clean);
  }

  _handleGumError(err) {
    const name = err && err.name;
    const map = {
      NotAllowedError: "Permiso de cámara denegado. Actívalo en el navegador (⋮ → Configuración de sitios → Cámara).",
      NotFoundError: "No se encontró ninguna cámara en el dispositivo.",
      NotReadableError: "La cámara está en uso por otra aplicación.",
      OverconstrainedError: "No hay una cámara que cumpla los requisitos.",
      SecurityError: "La cámara requiere HTTPS o localhost.",
    };
    this.onStatus(map[name] || `No se pudo abrir la cámara: ${name || err}`, "error");
  }

  stop() {
    this.running = false;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this._zxingControls) {
      try { this._zxingControls.stop(); } catch (e) {}
      this._zxingControls = null;
    }
    if (this._zxingReader) {
      try { this._zxingReader.reset && this._zxingReader.reset(); } catch (e) {}
      this._zxingReader = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    if (this.video) this.video.srcObject = null;
    this._detector = null;
    this._track = null;
  }
}
