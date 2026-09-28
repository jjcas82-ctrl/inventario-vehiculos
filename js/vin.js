// vin.js — Decodificación y validación de VIN (Vehicle Identification Number)
// Estándar ISO 3779 / norma norteamericana (17 caracteres, dígito verificador en posición 9).
//
// Estructura del VIN (posiciones 1..17):
//   1-3   WMI  → país (1), fabricante (2), tipo de vehículo/división (3)
//   4-8   VDS  → modelo, tipo de carrocería, sujeción, transmisión, motor
//   9     dígito de control (check digit)
//   10    año del modelo
//   11    planta de ensamblaje
//   12-17 número de serie de producción

const INVALID_CHARS = /[IOQ]/;               // Letras no permitidas en un VIN
const VIN_REGEX = /^[A-HJ-NPR-Z0-9]{17}$/;

const TRANSLIT = {
  A:1, B:2, C:3, D:4, E:5, F:6, G:7, H:8,
  J:1, K:2, L:3, M:4, N:5, P:7, R:9,
  S:2, T:3, U:4, V:5, W:6, X:7, Y:8, Z:9,
  0:0, 1:1, 2:2, 3:3, 4:4, 5:5, 6:6, 7:7, 8:8, 9:9,
};
const WEIGHTS = [8,7,6,5,4,3,2,10,0,9,8,7,6,5,4,3,2];

const YEAR_MAP = {
  A:1980, B:1981, C:1982, D:1983, E:1984, F:1985, G:1986, H:1987,
  J:1988, K:1989, L:1990, M:1991, N:1992, P:1993, R:1994, S:1995,
  T:1996, V:1997, W:1998, X:1999, Y:2000,
  1:2001, 2:2002, 3:2003, 4:2004, 5:2005, 6:2006, 7:2007, 8:2008, 9:2009,
};

// País por el 1.er carácter del WMI (rangos del estándar ISO 3780).
// Se refina con los dos primeros para casos comunes de Norteamérica.
function countryFromWMI(vin) {
  const c = vin[0];
  const two = vin.slice(0, 2);

  // Refinamiento Norteamérica (por rango de segundo carácter)
  const naNum = /[1-5]/.test(c);
  if (naNum) {
    // 1,4,5 = EE. UU.; 2 = Canadá; 3 = México/Centroamérica
    if (c === "2") return "Canadá";
    if (c === "3") {
      // 3A-3W → México; 3X-37 → Centroamérica (aprox.)
      return /^3[A-W]/.test(two) || /^3[0-9]/.test(two) ? "México" : "México";
    }
    return "Estados Unidos";
  }

  const ranges = [
    { re: /[6-7]/, name: "Oceanía (Australia/N. Zelanda)" },
    { re: /[89]/,  name: "Sudamérica" },
    { re: /[A-H]/, name: "África" },
    { re: /[J-R]/, name: "Asia" },
    { re: /[S-Z]/, name: "Europa" },
  ];
  const hit = ranges.find(r => r.re.test(c));
  return hit ? hit.name : "Desconocido";
}

// Marca/fabricante por WMI (3 y luego 2 caracteres). Tabla ampliable.
const WMI_MAKE = {
  // Chevrolet / GM — plantas de todo el mundo
  "1G1":"Chevrolet","1GC":"Chevrolet","1GN":"Chevrolet","1GB":"Chevrolet",
  "2G1":"Chevrolet","2GC":"Chevrolet","2GN":"Chevrolet","2CN":"Chevrolet",
  "3G1":"Chevrolet","3GC":"Chevrolet","3GN":"Chevrolet","3GB":"Chevrolet", // 3G* = GM México
  "KL1":"Chevrolet","KL8":"Chevrolet","KL7":"Chevrolet",                    // GM Corea (Aveo, Spark, etc.)
  "9BG":"Chevrolet","8AG":"Chevrolet","93C":"Chevrolet",                    // GM Brasil/Argentina
  "MA6":"Chevrolet","LZG":"Chevrolet","LSG":"Chevrolet","L2C":"Chevrolet",  // GM India/China
  "1GT":"GMC","1GK":"GMC","1GKS":"GMC","2GK":"GMC","3GK":"GMC",
  "1G4":"Buick","1G8":"Saturn","1GY":"Cadillac","1GM":"Pontiac","1G3":"Oldsmobile","1G6":"Cadillac",
  "1FA":"Ford","1FT":"Ford","1FM":"Ford","1FD":"Ford","2FA":"Ford","3FA":"Ford","MAJ":"Ford",
  "1HG":"Honda","2HG":"Honda","3HG":"Honda","JHM":"Honda","5FN":"Honda","19X":"Honda",
  "JTD":"Toyota","JTM":"Toyota","JTE":"Toyota","4T1":"Toyota","5TD":"Toyota","5TF":"Toyota","2T1":"Toyota","3TM":"Toyota",
  "1N4":"Nissan","1N6":"Nissan","3N1":"Nissan","JN1":"Nissan","JN8":"Nissan","5N1":"Nissan",
  "WVW":"Volkswagen","1VW":"Volkswagen","3VW":"Volkswagen","WV1":"Volkswagen","WV2":"Volkswagen",
  "WBA":"BMW","WBS":"BMW","4US":"BMW","5UX":"BMW",
  "WDB":"Mercedes-Benz","WDD":"Mercedes-Benz","WDC":"Mercedes-Benz","4JG":"Mercedes-Benz",
  "KMH":"Hyundai","KM8":"Hyundai","5NP":"Hyundai","KNA":"Kia","KND":"Kia","3KP":"Kia",
  "MA3":"Suzuki","JS2":"Suzuki","JS3":"Suzuki",
  "LSF":"Genérico China (LSF)","LFV":"FAW-Volkswagen","LGB":"BYD","LVS":"Ford China",
  "3VV":"Volkswagen México","3MZ":"Mazda México","JM1":"Mazda","JM3":"Mazda",
};

function makeFromWMI(vin) {
  const wmi3 = vin.slice(0, 3);
  if (WMI_MAKE[wmi3]) return WMI_MAKE[wmi3];
  const wmi2 = vin.slice(0, 2);
  const byTwo = Object.entries(WMI_MAKE).find(([k]) => k.startsWith(wmi2));
  return byTwo ? byTwo[1] : "Desconocido";
}

export function computeCheckDigit(vin) {
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const val = TRANSLIT[vin[i]];
    if (val === undefined) return null;
    sum += val * WEIGHTS[i];
  }
  const rem = sum % 11;
  return rem === 10 ? "X" : String(rem);
}

// Estima el año del modelo (posición 10) considerando el ciclo de 30 años.
function estimateYear(vin) {
  const code = vin[9];
  const base = YEAR_MAP[code];
  if (base === undefined) return null;
  const now = new Date().getFullYear();
  let year = base;
  if (year + 30 <= now + 1) year += 30; // preferir el ciclo reciente si es plausible
  return year;
}

export function normalizeVin(raw) {
  return (raw || "").toUpperCase().replace(/[\s-]/g, "").trim();
}

// Decodifica el VIN y devuelve datos + desglose por sección
export function decodeVin(raw) {
  const vin = normalizeVin(raw);
  const result = {
    vin,
    valid: false,
    errors: [],
    // Datos básicos
    make: null,
    manufacturer: null,   // fabricante (posición 2 dentro del WMI)
    country: null,
    year: null,
    // Secciones
    wmi: null,            // 1-3
    vds: null,            // 4-8
    vis: null,            // 9-17
    vehicleType: null,    // 4-8 (descripción de chasis/carrocería, sin catálogo por marca)
    checkDigit: { expected: null, actual: null, ok: false }, // 9
    plant: null,          // 11
    serial: null,         // 12-17
    breakdown: [],        // desglose posición por posición para mostrar
  };

  if (vin.length !== 17) {
    result.errors.push("El VIN debe tener 17 caracteres. Van " + vin.length + ".");
    return result;
  }
  if (INVALID_CHARS.test(vin)) {
    result.errors.push("El VIN no puede contener las letras I, O ni Q.");
  }
  if (!VIN_REGEX.test(vin)) {
    result.errors.push("El VIN contiene caracteres no válidos.");
    return result;
  }

  result.wmi = vin.slice(0, 3);
  result.vds = vin.slice(3, 8);   // posiciones 4-8 (5 caracteres)
  result.vis = vin.slice(8, 17);  // posiciones 9-17
  result.make = makeFromWMI(vin);
  result.manufacturer = vin[1];   // 2.º carácter identifica al fabricante dentro del país
  result.country = countryFromWMI(vin);
  result.year = estimateYear(vin);
  result.plant = vin[10];         // posición 11 → planta de ensamblaje
  result.serial = vin.slice(11);  // posiciones 12-17 → número de serie

  const expected = computeCheckDigit(vin);
  const actual = vin[8];          // posición 9
  result.checkDigit = { expected, actual, ok: expected !== null && expected === actual };
  if (!result.checkDigit.ok) {
    result.errors.push("El dígito verificador (posición 9) no coincide: se esperaba “" +
      expected + "” y el VIN trae “" + actual + "”. Revisa la lectura.");
  }

  // Desglose por sección (según el estándar y tu diagrama)
  result.breakdown = [
    { pos: "1",     value: vin[0],           label: "País de origen",        detail: result.country },
    { pos: "2",     value: vin[1],           label: "Fabricante",            detail: "" },
    { pos: "3",     value: vin[2],           label: "Tipo de vehículo / división", detail: "" },
    { pos: "4-8",   value: vin.slice(3, 8),  label: "Descripción del vehículo", detail: "Modelo, carrocería, sujeción, transmisión y motor" },
    { pos: "9",     value: vin[8],           label: "Dígito de control",     detail: result.checkDigit.ok ? "Válido" : "No coincide" },
    { pos: "10",    value: vin[9],           label: "Año del modelo",        detail: result.year ? String(result.year) : "" },
    { pos: "11",    value: vin[10],          label: "Planta de ensamblaje",  detail: "" },
    { pos: "12-17", value: vin.slice(11),    label: "Número de serie",       detail: "" },
  ];

  result.valid = result.errors.length === 0;
  return result;
}
