// vinapi.js — Enriquecimiento del VIN con la API pública de NHTSA (vPIC).
// Devuelve modelo, carrocería, motor, etc. cuando hay internet. Sin conexión,
// la app usa el desglose local de vin.js. Es un COMPLEMENTO, no un requisito.
//
// API: https://vpic.nhtsa.dot.gov/api/  (gratuita, sin API key)
// Endpoint: /vehicles/DecodeVinValues/{vin}?format=json

const ENDPOINT = "https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/";

// Devuelve un objeto con los campos útiles (o null si falla / sin internet).
export async function enrichVin(vin, { timeoutMs = 8000 } = {}) {
  if (!navigator.onLine) return { online: false, data: null, error: "sin conexión" };

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(ENDPOINT + encodeURIComponent(vin) + "?format=json", { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return { online: true, data: null, error: "HTTP " + res.status };
    const json = await res.json();
    const row = json && json.Results && json.Results[0];
    if (!row) return { online: true, data: null, error: "sin resultados" };

    // Extraemos solo lo que aporta valor y solo si viene con contenido.
    const pick = (k) => (row[k] && String(row[k]).trim()) ? String(row[k]).trim() : null;
    const data = {
      make: pick("Make"),
      model: pick("Model"),
      year: pick("ModelYear"),
      manufacturer: pick("Manufacturer"),
      bodyClass: pick("BodyClass"),
      vehicleType: pick("VehicleType"),
      fuelType: pick("FuelTypePrimary"),
      engineCyl: pick("EngineCylinders"),
      displacementL: pick("DisplacmentL") || pick("DisplacementL"),
      engineHP: pick("EngineHP"),
      transmission: pick("TransmissionStyle"),
      driveType: pick("DriveType"),
      doors: pick("Doors"),
      plantCountry: pick("PlantCountry"),
      plantCity: pick("PlantCity"),
      series: pick("Series"),
      trim: pick("Trim"),
      errorText: pick("ErrorText"),
    };
    // NHTSA marca errores en ErrorCode; 0 = ok. Igual devolvemos lo que haya.
    return { online: true, data, error: null };
  } catch (e) {
    clearTimeout(t);
    return { online: navigator.onLine, data: null, error: e.name === "AbortError" ? "tiempo agotado" : (e.message || String(e)) };
  }
}
