// wmi.js — Base de datos amplia de WMI (World Manufacturer Identifier) → marca.
// Cubre la mayoría de marcas para inventario de autos NUEVOS y SEMINUEVOS.
// Estrategia de búsqueda: 3 caracteres exactos → 2 caracteres → tabla especial.
// Es una tabla práctica y ampliable; no pretende ser exhaustiva al 100%.

// Coincidencias por los 3 primeros caracteres (las más específicas).
export const WMI3 = {
  // ---- General Motors ----
  "1G1":"Chevrolet","1GC":"Chevrolet","1GN":"Chevrolet","1GB":"Chevrolet","1GD":"Chevrolet",
  "2G1":"Chevrolet","2GC":"Chevrolet","2GN":"Chevrolet","2CN":"Chevrolet",
  "3G1":"Chevrolet","3GC":"Chevrolet","3GN":"Chevrolet","3GB":"Chevrolet",
  "KL1":"Chevrolet","KL7":"Chevrolet","KL8":"Chevrolet",
  "9BG":"Chevrolet","8AG":"Chevrolet","93C":"Chevrolet",
  "1GT":"GMC","2GK":"GMC","3GK":"GMC","1GK":"GMC",
  "1G4":"Buick","LSG":"Buick","1G6":"Cadillac","1GY":"Cadillac","1G3":"Oldsmobile",
  "1G8":"Saturn","1GM":"Pontiac","2G2":"Pontiac",
  // ---- Ford / Lincoln / Mercury ----
  "1FA":"Ford","1FB":"Ford","1FC":"Ford","1FD":"Ford","1FM":"Ford","1FT":"Ford",
  "2FA":"Ford","2FT":"Ford","3FA":"Ford","3FE":"Ford","MAJ":"Ford","LVS":"Ford","WF0":"Ford",
  "1LN":"Lincoln","5LM":"Lincoln","1ME":"Mercury","4M2":"Mercury",
  // ---- Chrysler / Dodge / Jeep / RAM / Fiat ----
  "1C3":"Chrysler","2C3":"Chrysler","3C3":"Chrysler","1C4":"Jeep","1C6":"RAM",
  "1B3":"Dodge","2B3":"Dodge","1D4":"Dodge","1D7":"Dodge","3D7":"Dodge",
  "1J4":"Jeep","1J8":"Jeep","ZFA":"Fiat",
  // ---- Honda / Acura ----
  "1HG":"Honda","2HG":"Honda","3HG":"Honda","5FN":"Honda","5J6":"Honda","19X":"Honda",
  "JHM":"Honda","JHL":"Honda","19U":"Acura","19V":"Acura","JH4":"Acura","2HN":"Acura",
  // ---- Toyota / Lexus / Scion ----
  "JTD":"Toyota","JTE":"Toyota","JTM":"Toyota","JTN":"Toyota","JTK":"Toyota","JTL":"Toyota",
  "4T1":"Toyota","4T3":"Toyota","5TD":"Toyota","5TF":"Toyota","2T1":"Toyota","2T3":"Toyota","3TM":"Toyota",
  "JTH":"Lexus","JTJ":"Lexus","2T2":"Lexus","58A":"Lexus",
  // ---- Nissan / Infiniti ----
  "1N4":"Nissan","1N6":"Nissan","3N1":"Nissan","3N6":"Nissan","5N1":"Nissan",
  "JN1":"Nissan","JN6":"Nissan","JN8":"Nissan","JNK":"Infiniti","JNR":"Infiniti","5N3":"Infiniti",
  // ---- Mazda ----
  "JM1":"Mazda","JM3":"Mazda","JM6":"Mazda","JM7":"Mazda","3MZ":"Mazda","4F2":"Mazda","4F4":"Mazda",
  // ---- Subaru ----
  "JF1":"Subaru","JF2":"Subaru","4S3":"Subaru","4S4":"Subaru",
  // ---- Mitsubishi ----
  "JA3":"Mitsubishi","JA4":"Mitsubishi","4A3":"Mitsubishi","6MM":"Mitsubishi","ML0":"Mitsubishi",
  // ---- Suzuki ----
  "JS1":"Suzuki","JS2":"Suzuki","JS3":"Suzuki","MA3":"Suzuki","KL5":"Suzuki",
  // ---- Volkswagen Group ----
  "WVW":"Volkswagen","WVG":"Volkswagen","WV1":"Volkswagen","WV2":"Volkswagen","WV3":"Volkswagen",
  "1VW":"Volkswagen","3VW":"Volkswagen","3VV":"Volkswagen","9BW":"Volkswagen","LFV":"Volkswagen",
  "TRU":"Audi","WAU":"Audi","WA1":"Audi","93U":"Audi","WUA":"Audi",
  "WP0":"Porsche","WP1":"Porsche","VSS":"SEAT","TMB":"Škoda",
  // ---- BMW / Mini / Rolls-Royce ----
  "WBA":"BMW","WBS":"BMW","WBX":"BMW","WBY":"BMW","4US":"BMW","5UX":"BMW","5YM":"BMW",
  "WMW":"MINI","WME":"smart","SCA":"Rolls-Royce",
  // ---- Mercedes-Benz ----
  "WDB":"Mercedes-Benz","WDC":"Mercedes-Benz","WDD":"Mercedes-Benz","WDF":"Mercedes-Benz",
  "4JG":"Mercedes-Benz","55S":"Mercedes-Benz","W1K":"Mercedes-Benz","W1N":"Mercedes-Benz",
  // ---- Hyundai / Kia / Genesis ----
  "KMH":"Hyundai","KM8":"Hyundai","5NP":"Hyundai","5NM":"Hyundai","KMF":"Hyundai",
  "KNA":"Kia","KND":"Kia","KNM":"Kia","3KP":"Kia","5XX":"Kia","5XY":"Kia",
  "KMT":"Genesis","KMU":"Genesis",
  // ---- Renault / Nissan / Dacia ----
  "VF1":"Renault","VF2":"Renault","93Y":"Renault","8A1":"Renault","UU1":"Dacia",
  // ---- PSA (Peugeot / Citroën / DS / Opel) ----
  "VF3":"Peugeot","VF7":"Citroën","VR1":"DS","W0L":"Opel","W0V":"Opel","VXK":"Opel",
  // ---- Volvo / Jaguar / Land Rover ----
  "YV1":"Volvo","YV4":"Volvo","LVY":"Volvo","SAJ":"Jaguar","SAL":"Land Rover","SAD":"Land Rover",
  // ---- Tesla ----
  "5YJ":"Tesla","7SA":"Tesla","LRW":"Tesla","XP7":"Tesla",
  // ---- China (seminuevos y nuevos) ----
  "LSF":"SAIC Motor (Chevrolet/MG)","LSJ":"SAIC (MG/Roewe)","LSV":"SAIC-Volkswagen",
  "LGB":"Dongfeng","LGH":"Dongfeng","LVH":"Dongfeng-Honda","LGX":"BYD","LC0":"BYD","LC6":"BYD",
  "LZW":"Chevrolet (SAIC-GM-Wuling)","L6T":"Geely","LB2":"Geely","LZG":"Geely",
  "LGW":"Great Wall","LVV":"Chery","LFP":"FAW","LFM":"FAW-Toyota","LJ1":"JAC","LZM":"CAMC",
  "LJD":"JMC","LSD":"SAIC","LDC":"Dongfeng-Peugeot","LNB":"BAIC","LMG":"GAC","L5Y":"Yadea",
  // ---- India ----
  "MAT":"Tata","MA1":"Mahindra","MA3":"Suzuki","MA6":"Chevrolet (GM)","MBH":"Suzuki","MEE":"Renault India",
};

// Coincidencias por los 2 primeros caracteres (más generales).
export const WMI2 = {
  "1G":"General Motors","2G":"General Motors","3G":"General Motors","KL":"GM Corea",
  "1F":"Ford","2F":"Ford","3F":"Ford","1L":"Lincoln","1M":"Mercury",
  "1C":"Chrysler","2C":"Chrysler","3C":"Chrysler","1B":"Dodge","2B":"Dodge","1D":"Dodge","1J":"Jeep",
  "1H":"Honda","2H":"Honda","3H":"Honda","JH":"Honda/Acura",
  "JT":"Toyota","4T":"Toyota","5T":"Toyota","2T":"Toyota","3T":"Toyota",
  "1N":"Nissan","3N":"Nissan","5N":"Nissan","JN":"Nissan/Infiniti",
  "JM":"Mazda","3M":"Mazda","JF":"Subaru","4S":"Subaru","JA":"Mitsubishi","4A":"Mitsubishi",
  "JS":"Suzuki","WV":"Volkswagen","1V":"Volkswagen","3V":"Volkswagen","WA":"Audi","TR":"Audi","WP":"Porsche",
  "WB":"BMW","5U":"BMW","4U":"BMW","WM":"MINI/smart","WD":"Mercedes-Benz","4J":"Mercedes-Benz","W1":"Mercedes-Benz",
  "KM":"Hyundai","KN":"Kia","5X":"Kia","3K":"Kia",
  "VF":"Francia (Renault/Peugeot/Citroën)","W0":"Opel","YV":"Volvo","SA":"Reino Unido (Jaguar/Land Rover)",
  "5Y":"Tesla","7S":"Tesla","LR":"Tesla China",
  "LS":"China (SAIC)","LG":"China (Dongfeng/BYD)","LV":"China (Chery/Volvo)","LF":"China (FAW)","L6":"China (Geely)",
  "MA":"India","MB":"India","ME":"India",
};

// País por el/los primeros caracteres del WMI (ISO 3780) — resumido.
export function countryFromChar(c, two) {
  // Norteamérica
  if (c === "1" || c === "4" || c === "5") return "Estados Unidos";
  if (c === "2") return "Canadá";
  if (c === "3") return /^3[A-W0-9]/.test(two) ? "México" : "México";
  if (c === "6" || c === "7") return "Oceanía";
  if (c === "8" || c === "9") return "Sudamérica";
  if (/[A-H]/.test(c)) return "África";
  // Asia por rangos más finos (segundo carácter):
  if (c === "J") return "Japón";
  if (c === "K") return "Corea del Sur";
  if (c === "L") return "China";
  if (c === "M") {
    if (/^M[A-E]/.test(two)) return "India";
    if (/^M[F-K]/.test(two)) return "Indonesia/Tailandia";
    return "Asia";
  }
  if (c === "N") return "Turquía/otros";
  if (/[P-R]/.test(c)) return "Asia";
  if (/[S-Z]/.test(c)) return "Europa";
  return "Desconocido";
}

// Devuelve info de marca a partir del VIN, distinguiendo confiabilidad:
//   { make, confident }
//   - confident=true  → coincidencia EXACTA de 3 caracteres (fiable).
//   - confident=false → solo coincidencia de 2 caracteres (fabricante/región
//                        aproximada, AMBIGUA: el usuario debe verificar).
export function makeInfo(vin) {
  const w3 = vin.slice(0, 3);
  if (WMI3[w3]) return { make: WMI3[w3], confident: true };
  const w2 = vin.slice(0, 2);
  if (WMI2[w2]) return { make: WMI2[w2], confident: false };
  return { make: null, confident: false };
}

// Compatibilidad: devuelve solo la marca (o null).
export function makeFromVin(vin) {
  return makeInfo(vin).make;
}
