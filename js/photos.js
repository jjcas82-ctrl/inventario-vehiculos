// photos.js — Fotos del estado de la unidad (golpes, rayones, documentos…).
// Se guardan en IndexedDB (NO en localStorage) porque las imágenes son grandes:
// localStorage tiene ~5 MB; IndexedDB admite cientos de MB. Cada foto se COMPRIME
// antes de guardar (redimensionar a máx. 1280 px y JPEG de calidad media) para que
// entren muchas sin llenar el dispositivo.
//
// Modelo de cada foto:
//   { id, vin, dataUrl, note, kind, by, at, w, h, bytes }
//     kind: 'dano' | 'estado' | 'documento' | 'otro'
//
// En la Fase 2 (backend) estas fotos se podrán sincronizar entre dispositivos.

const DB_NAME = "inv_fotos";
const DB_VERSION = 1;
const STORE = "fotos";

let _dbPromise = null;

function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) { reject(new Error("Este navegador no soporta IndexedDB.")); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: "id" });
        os.createIndex("vin", "vin", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("No se pudo abrir la base de fotos."));
  });
  return _dbPromise;
}

function tx(mode) {
  return openDb().then(db => {
    const t = db.transaction(STORE, mode);
    return { store: t.objectStore(STORE), done: new Promise((res, rej) => {
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    }) };
  });
}

function newId() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return "foto-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Comprime un File/Blob de imagen a un dataURL JPEG, redimensionando a maxSide px.
export async function compressImage(file, { maxSide = 1280, quality = 0.7 } = {}) {
  const bitmap = await loadBitmap(file);
  const { width: w0, height: h0 } = bitmap;
  const scale = Math.min(1, maxSide / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, w, h);
  if (bitmap.close) bitmap.close();
  const dataUrl = canvas.toDataURL("image/jpeg", quality);
  return { dataUrl, w, h, bytes: Math.round(dataUrl.length * 0.75) };
}

function loadBitmap(file) {
  if ("createImageBitmap" in window) {
    return createImageBitmap(file).catch(() => loadImageEl(file));
  }
  return loadImageEl(file);
}
function loadImageEl(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { resolve(img); setTimeout(() => URL.revokeObjectURL(url), 1000); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("No se pudo leer la imagen.")); };
    img.src = url;
  });
}

// Guarda una foto comprimida para un VIN. Devuelve el registro guardado.
export async function addPhoto(vin, file, { note = "", kind = "dano", by = "" } = {}) {
  if (!vin) throw new Error("Falta el VIN.");
  const { dataUrl, w, h, bytes } = await compressImage(file);
  const rec = { id: newId(), vin, dataUrl, note: note || "", kind, by: by || "—",
                at: new Date().toISOString(), w, h, bytes };
  const { store, done } = await tx("readwrite");
  store.put(rec);
  await done;
  return rec;
}

// Lista las fotos de un VIN (ordenadas de más reciente a más antigua).
export async function listPhotos(vin) {
  const { store } = await tx("readonly");
  return new Promise((resolve, reject) => {
    const out = [];
    const idx = store.index("vin");
    const req = idx.openCursor(IDBKeyRange.only(vin));
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) { out.push(cur.value); cur.continue(); }
      else { out.sort((a, b) => (b.at || "").localeCompare(a.at || "")); resolve(out); }
    };
    req.onerror = () => reject(req.error);
  });
}

// Actualiza la nota/tipo de una foto.
export async function updatePhoto(id, patch) {
  const { store, done } = await tx("readwrite");
  await new Promise((resolve, reject) => {
    const r = store.get(id);
    r.onsuccess = () => {
      const rec = r.result;
      if (rec) { Object.assign(rec, patch); store.put(rec); }
      resolve();
    };
    r.onerror = () => reject(r.error);
  });
  await done;
}

// Elimina una foto por id.
export async function deletePhoto(id) {
  const { store, done } = await tx("readwrite");
  store.delete(id);
  await done;
}

// Cuenta cuántas fotos tiene un VIN (para mostrar el total sin cargar las imágenes).
export async function countPhotos(vin) {
  const { store } = await tx("readonly");
  return new Promise((resolve, reject) => {
    const idx = store.index("vin");
    const req = idx.count(IDBKeyRange.only(vin));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Elimina todas las fotos de un VIN (p. ej. al borrar una unidad).
export async function deletePhotosForVin(vin) {
  const fotos = await listPhotos(vin);
  const { store, done } = await tx("readwrite");
  fotos.forEach(f => store.delete(f.id));
  await done;
}

export const PHOTO_KINDS = {
  dano: "⚠️ Daño / Imperfección",
  estado: "📋 Estado general",
  documento: "📄 Documento",
  otro: "🔖 Otro",
};
