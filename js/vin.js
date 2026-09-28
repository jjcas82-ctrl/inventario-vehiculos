// vin.js — Decodificación y validación de VIN (Vehicle Identification Number)
// Estándar ISO 3779 / norma norteamericana (17 caracteres, dígito verificador en posición 9).

// Letras no permitidas en un VIN: I, O, Q
const INVALID_CHARS = /[IOQ]/;
const VIN_REGEX = /^[A-HJ-NPR-Z0-9]{17}$/;

// Valor de transliteración de cada carácter para el dígito verificador
const TRANSLIT = {
  A:1, B:2, C:3, D:4, E:5, F:6, G:7, H:8,
  J:1, K:2, L:3, M:4, N:5, P:7, R:9,
  S:2, T:3, U:4, V:5, W:6, X:7, Y:8, Z:9,
  0:0, 1:1, 2:2, 3:3, 4:4, 5:5, 6:6, 7:7, 8:8, 9:9,
};

// Peso por posición (1..17)
const WEIGHTS = [8,7,6,5,4,3,2,10,0,9,8,7,6,5,4,3,2];

// Año del modelo por el carácter en la posición 10
const YEAR_MAP = {
  A:1980, B:1981, C:1982, D:1983, E:1984, F:1985, G:1986, H:1987,
  J:1988, K:1989, L:1990, M:1991, N:1992, P:1993, R:1994, S:1995,
  T:1996, V:1997, W:1998, X:1999, Y:2000,
  1:2001, 2:2002, 3:2003, 4:2004, 5:2005, 6:2006, 7:2007, 8:2008, 9:2009,
};
// El ciclo de letras se repite; a partir de 2010 las letras vuelven a A.
// Regla: los códigos de letra se repiten cada 30 años. Usamos la posición 7
// (número o letra) para desambiguar el ciclo 1980-2009 vs 2010-2039.

// País de origen por el primer carácter (WMI). Rango simplificado.
function countryFromWMI(vin) {
  const c = vin[0];
  const ranges = [
    { test: /[1-5]/, name: "Estados Unidos" },
    { test: /[6-7]/, name: "Oceanía" },
    { test: /[89]/,  name: "Sudamérica" },
    { test: /[A-H]/, name: "África" },
    { test: /[J-R]/, name: "Asia" },
    { test: /[S-Z]/, name: "Europa" },
  ];
  // Casos comunes de México / Canadá que ayudan al usuario
  const two = vin.slice(0, 2);
  if (["3G","3N","3H","3V","3F","3C","3M","3W","3A"].includes(two)) return "México";
  if (/^[1-5]/.test(c) && ["1","4","5"].includes(c)) return "Estados Unidos";
  if (c === "2") return "Canadá";
  if (c === "3") return "México";
  const hit = ranges.find(r => r.test.test(c));
  return hit ? hit.name : "Desconocido";
}

// Marca/fabricante aproximado por WMI (primeros 3 caracteres). Tabla parcial y ampliable.
const WMI_MAKE = {
  "1G1": "Chevrolet",
  "1GC": "Chevrolet",
  "1GN": "Chevrolet",
  "3GN": "Chevrolet",
  "KL1": "Chevrolet",
  "1G4": "Buick",
  "1G8": "Saturn",
  "1GY": "Cadillac",
  "1GM": "Pontiac",
  "1GK": "GMC",
  "2G1": "Chevrolet",
  "3G1": "Chevrolet",
  "1FA": "Ford", "1FT": "Ford", "1FM": "Ford", "3FA": "Ford",
  "1HG": "Honda", "2HG": "Honda", "JHM": "Honda",
  "JTD": "Toyota", "4T1": "Toyota", "5TD": "Toyota", "JTM": "Toyota",
  "1N4": "Nissan", "3N1": "Nissan", "JN1": "Nissan",
  "WVW": "Volkswagen", "3VW": "Volkswagen", "1VW": "Volkswagen",
  "WBA": "BMW", "WDB": "Mercedes-Benz", "WDD": "Mercedes-Benz",
  "KMH": "Hyundai", "KNA": "Kia", "KND": "Kia",
  "MAJ": "Ford", "MA3": "Suzuki",
};

function makeFromWMI(vin) {
  const wmi3 = vin.slice(0, 3);
  if (WMI_MAKE[wmi3]) return WMI_MAKE[wmi3];
  const wmi2 = vin.slice(0, 2);
  const byTwo = Object.entries(WMI_MAKE).find(([k]) => k.startsWith(wmi2));
  return byTwo ? byTwo[1] : "Desconocido";
}

// Calcula el dígito verificador esperado (posición 9)
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

// Estima el año considerando el ciclo de 30 años.
function estimateYear(vin) {
  const code = vin[9];
  const base = YEAR_MAP[code];
  if (base === undefined) return null;
  // Si el año base es menor a ~1995 y estamos en la época moderna,
  // asumimos el ciclo +30 (2010-2039). Heurística práctica.
  const now = new Date().getFullYear();
  let year = base;
  if (year + 30 <= now + 1) year += 30; // preferir el ciclo reciente si es plausible
  return year;
}

// Normaliza (mayúsculas, sin espacios)
export function normalizeVin(raw) {
  return (raw || "").toUpperCase().replace(/[\s-]/g, "").trim();
}

// Decodifica el VIN y devuelve datos básicos + validación
export function decodeVin(raw) {
  const vin = normalizeVin(raw);
  const result = {
    vin,
    valid: false,
    errors: [],
    make: null,
    country: null,
    year: null,
    wmi: null,
    vds: null,
    vis: null,
    checkDigit: { expected: null, actual: null, ok: false },
  };

  if (vin.length !== 17) {
    result.errors.push("El VIN debe tener 17 caracteres.");
    return result;
  }
  if (INVALID_CHARS.test(vin)) {
    result.errors.push("El VIN no puede contener las letras I, O ni Q.");
  }
  if (!VIN_REGEX.test(vin)) {
    result.errors.push("El VIN contiene caracteres no válidos.");
    return result;
  }

  result.wmi = vin.slice(0, 3);   // World Manufacturer Identifier
  result.vds = vin.slice(3, 9);   // Vehicle Descriptor Section
  result.vis = vin.slice(9, 17);  // Vehicle Identifier Section
  result.make = makeFromWMI(vin);
  result.country = countryFromWMI(vin);
  result.year = estimateYear(vin);

  const expected = computeCheckDigit(vin);
  const actual = vin[8];
  result.checkDigit = {
    expected,
    actual,
    ok: expected !== null && expected === actual,
  };
  if (!result.checkDigit.ok) {
    result.errors.push("El dígito verificador no coincide (posible VIN inválido o mal capturado).");
  }

  result.valid = result.errors.length === 0;
  return result;
}
