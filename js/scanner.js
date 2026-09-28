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
const ZXING_LIB_CDN = "https://cdn.jsdelivr.net/npm/@zxing/library@0.20.0/+esm";

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

    // Ejecutamos los DOS motores en paralelo:
    //  - BarcodeDetector nativo: rápido para QR / data matrix.
    //  - ZXing: mucho mejor para códigos de barras LINEALES del VIN (Code 39 / Code 128).
    // El primero que detecte un código gana.
    let started = false;

    if ("BarcodeDetector" in window) {
      try {
        const supported = await window.BarcodeDetector.getSupportedFormats();
        const formats = FORMATS.filter(f => supported.includes(f));
        this.onDetect("motor nativo · formatos: " + (supported.join(",") || "?"), "info");
        this._detector = new window.BarcodeDetector(formats.length ? { formats } : undefined);
        this._loopNative();
        started = true;
      } catch (e) {
        this.onDetect("BarcodeDetector no disponible", "info");
      }
    } else {
      this.onDetect("Sin BarcodeDetector nativo", "info");
    }

    // ZXing siempre, en paralelo, para asegurar la lectura de códigos de barras del VIN.
    await this._startZxing();

    this.onStatus("Cámara activa. Acerca y ENFOCA el código de barras del VIN…", "ok");
    if (!started && !this._zxingReader) {
      this.onStatus("No se pudo iniciar ningún lector. Usa la captura manual.", "error");
    }
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
      this._frames = (this._frames || 0) + 1;
      if (this._frames === 1) {
        this.onDetect(`analizando cuadros (${target.width || this.video.videoWidth}x${target.height || this.video.videoHeight})…`, "info");
      }
      const codes = await this._detector.detect(target);
      if (codes && codes.length) {
        this.onDetect(codes[0].rawValue, codes[0].format);
        this._emit(codes[0].rawValue);
      }
    } catch (e) {
      if (!this._loopErrShown) { this._loopErrShown = true; this.onDetect("error al analizar: " + (e.name || e), "info"); }
    }
    if (this.running) {
      this._timer = setTimeout(() => this._loopNative(), 120);
    }
  }

  async _startZxing() {
    let browserMod, libMod;
    try {
      [browserMod, libMod] = await Promise.all([
        import(/* @vite-ignore */ ZXING_CDN),
        import(/* @vite-ignore */ ZXING_LIB_CDN).catch(() => null),
      ]);
    } catch (e) {
      this.onDetect("no se pudo cargar ZXing (¿sin internet?)", "info");
      return;
    }
    try {
      const { BrowserMultiFormatReader } = browserMod;
      // Hints: prioriza los formatos del VIN (Code 39 / Code 128) + QR/DataMatrix.
      // DecodeHintType/BarcodeFormat viven en @zxing/library.
      const L = libMod || browserMod;
      let hints;
      if (L && L.DecodeHintType && L.BarcodeFormat) {
        hints = new Map();
        hints.set(L.DecodeHintType.POSSIBLE_FORMATS, [
          L.BarcodeFormat.CODE_39,
          L.BarcodeFormat.CODE_128,
          L.BarcodeFormat.DATA_MATRIX,
          L.BarcodeFormat.QR_CODE,
          L.BarcodeFormat.ITF,
          L.BarcodeFormat.CODABAR,
        ]);
        hints.set(L.DecodeHintType.TRY_HARDER, true);
        this.onDetect("ZXing con hints VIN (Code39/128) ✓", "info");
      } else {
        this.onDetect("ZXing listo (sin hints)", "info");
      }
      this._zxingReader = new BrowserMultiFormatReader(hints, 200);
      this._zxingControls = await this._zxingReader.decodeFromStream(
        this.stream, this.video, (result) => {
          if (result) {
            this.onDetect(result.getText(), "ZXing");
            this._emit(result.getText());
          }
        });
    } catch (e) {
      this.onDetect("ZXing falló al iniciar: " + (e.name || e), "info");
    }
  }

  _emit(text) {
    if (!text) return;
    const clean = String(text).trim();
    // Evita reprocesar el mismo texto en ráfaga (los dos motores pueden repetir).
    const now = Date.now();
    if (clean === this._lastEmit && now - (this._lastEmitAt || 0) < 1200) return;
    this._lastEmit = clean;
    this._lastEmitAt = now;
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
