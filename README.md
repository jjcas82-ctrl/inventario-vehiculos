# Control de Inventario de Vehículos (PWA)

Sistema web instalable (PWA) para llevar el control de inventario de vehículos desde
**celular Android** y **PC Windows**. Permite:

- Registrar **entradas, salidas y movimientos** de vehículos escaneando su **VIN / código QR / código de barras**.
- Decodificar el **VIN** (marca, fabricante, país, año) con validación del **dígito verificador**.
- Guardar la **ubicación GPS** de cada evento.
- **Trazar el movimiento interno** dentro de una agencia (Piso 1/2/3, Área de servicio, Taller, Lavado, Accesorios, Sala de exhibición).
- Completar manualmente la **ficha del vehículo** desde celular o computadora.
- Consultar **Inventario** y generar **Reportes con filtros** directamente en la app (sin depender de Excel), con impresión/PDF y copiar.

> Esta versión guarda los datos **localmente en el navegador** (offline-first).
> La conexión a una base de datos central (MariaDB) y la API se agregarán en fases posteriores.

## Estructura

```
sandbox/
├── index.html            # App principal (una sola página, pestañas)
├── manifest.webmanifest  # Metadatos PWA (instalable)
├── sw.js                 # Service worker (offline básico)
├── css/
│   └── styles.css        # Estilos (responsive: celular y escritorio)
├── js/
│   ├── app.js            # Arranque, navegación por pestañas, estado global
│   ├── vin.js            # Decodificación y validación de VIN
│   ├── scanner.js        # Escáner de cámara (QR + código de barras) robusto
│   ├── storage.js        # Persistencia local (localStorage)
│   ├── agencies.js       # Agencias y ubicaciones internas
│   ├── inventory.js      # Inventario y ficha editable del vehículo
│   ├── events.js         # Registro de entradas/salidas/movimientos + GPS
│   ├── map.js            # Mapa / trazado de movimientos
│   └── reports.js        # Reportes con filtros
└── icons/                # Íconos PWA
```

## ⚠️ La cámara requiere HTTPS o localhost

La API de cámara del navegador (`getUserMedia`) **solo funciona en `https://` o en `http://localhost`**.
Si abres el archivo directamente (`file://`) o por una IP local sin HTTPS, la cámara **no** funcionará.

### Probar en la PC (Windows)

Con Python instalado, desde la carpeta del proyecto:

```bash
python -m http.server 8000
```

Luego abre `http://localhost:8000` en Chrome/Edge. La cámara funciona porque es `localhost`.

### Probar en el celular Android

Para usar la cámara en el celular necesitas **HTTPS**. Opciones:

- Servir el proyecto detrás de HTTPS (tu servidor / Synology con certificado), o
- Usar un túnel de desarrollo con HTTPS (por ejemplo `ngrok http 8000`) y abrir la URL `https://...` en Chrome del celular.

Cuando el navegador lo pida, **permite Cámara y Ubicación**.
