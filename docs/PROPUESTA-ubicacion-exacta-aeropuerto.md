# Propuesta — Ubicación exacta de unidades en la Agencia Aeropuerto

> Estado: **PROPUESTA / PENDIENTE** para una versión futura.
> No implementado todavía. Documento de planeación acordado con el usuario.

## 1. Problema a resolver

La **Agencia Aeropuerto** es la más grande. Hoy, el área interna donde queda una
unidad se **elige a mano** en un movimiento interno. Se quiere que la ubicación sea
**más fácil de encontrar y, en lo posible, automática**, para no depender de que el
capturista teclee bien el lugar — y poder **localizar rápido** cada auto en un patio
grande (incluidos interiores como taller/naves donde el GPS no funciona).

## 2. Requisitos acordados con el usuario

1. Aplica **principalmente a la Agencia Aeropuerto** (la más grande).
2. Debe ser de **costo nulo o mínimo** (preferir solución sobre la PWA actual, sin
   comprar hardware).
3. Se necesita **ubicación precisa dentro de la agencia**: por **piso y cajón**
   (ej. *Piso 1, Cajón 1B*), además de las zonas de proceso: **Taller, Lavado,
   Sala de Exhibición**, etc.
4. Se quiere apoyo **visual con un plano** de la agencia.

## 3. Realidad técnica (importante)

- El **GPS del celular no entra bajo techo** y tiene error de 5–15 m: no sirve para
  distinguir un cajón de otro dentro de una nave.
- La **ubicación exacta automática** (saber el cajón solo, sin ningún gesto) **siempre
  requiere hardware** (balizas BLE, UWB/RTLS) y, en el caso de BLE, muy probablemente
  una **app nativa** (los navegadores limitan el Bluetooth en segundo plano). Eso tiene
  **costo** y es un proyecto aparte.
- Conclusión: **no existe una forma gratuita y 100% automática** de obtener el cajón
  exacto en interiores. Lo gratuito y confiable es la **precisión por zona/sub-zona**
  mediante un gesto rápido de escaneo.

## 4. Solución propuesta por fases

### Fase 1 — QR por ubicación (piso/cajón/zona)  🟢 costo casi cero
- Modelar la agencia con una jerarquía fina:
  - **Estacionamiento** → Piso 1, Piso 2… → Cajón 1A, 1B, 1C… (cajones numerados).
  - **Zonas de proceso** sin cajón: Taller, Lavado, Sala de Exhibición, Entregas…
- Imprimir y pegar un **QR en cada ubicación** (cada cajón y cada zona).
- Flujo del capturista: escanea el **QR de la ubicación** + el **QR del auto** → el
  sistema registra "Auto X → Piso 1, Cajón 1B" **sin teclear**.
- Ventajas: casi gratis, funciona en interiores y exteriores, se implementa sobre la
  **PWA actual** (ya existe escáner QR y generador de etiquetas).
- Límite: no es el metro exacto, pero sí la ubicación "casi exacta" (el cajón). Requiere
  el gesto de escanear el letrero de la ubicación (2 segundos).

### Fase 2 — Plano visual de la agencia  🟢🟡 sin hardware
- Dibujar un **croquis/plano** del Aeropuerto (pisos, filas de cajones, zonas).
- Al seleccionar una unidad, **iluminar su cajón/zona** en el plano para localizarla de
  un vistazo. También: ver el plano "lleno/vacío" por cajón.
- Requiere trabajo de diseño del plano una sola vez. Sin costo de equipo.

### Fase 3 — Ubicación exacta automática  🔴 con costo (solo si Fase 1+2 no bastan)
- **Balizas BLE** por zona: precisión por zona, bajo costo de equipo, pero
  probablemente **app nativa**.
- **UWB / RTLS**: precisión ~0.5 m, totalmente automático, pero **caro** e industrial.
- Se evaluaría solo si en el futuro deciden invertir en hardware + app nativa.

## 5. Recomendación

Empezar por **Fase 1 (QR por piso/cajón/zona)** y, para la parte visual, **Fase 2
(plano de la agencia)**. Juntas cumplen el objetivo real —localizar rápido cada unidad
en la agencia grande— **sin costo de equipo** y **sobre la app actual**. La Fase 3 queda
reservada por si más adelante se requiere precisión al metro con inversión en hardware.

## 6. Alcance de implementación (cuando se retome)

Cambios previstos sobre el proyecto actual (resumen, no definitivo):
- **storage/agencias**: permitir jerarquía Piso → Cajón para la Agencia Aeropuerto
  (hoy el modelo es Área → sububicaciones; se extendería a pisos y cajones numerables).
- **Generador de etiquetas** (`js/label.js`): nuevo tipo de etiqueta "Ubicación"
  (QR que codifica la zona/piso/cajón) para pegar en el patio.
- **Escáner / registro** (`js/app.js`, `js/events.js`): modo "escanear ubicación +
  auto" para registrar el movimiento interno sin selección manual.
- **Mapa/plano** (`js/map.js` o módulo nuevo): vista de plano de la agencia con
  resaltado del cajón/zona de la unidad seleccionada.

## 7. Decisiones registradas

- Subdivisión del Aeropuerto: **por piso y por cajón** (ej. *Piso 1, Cajón 1B*), más
  zonas de proceso (**Taller, Lavado, Sala de Exhibición**, …).
- Preferencia de **costo mínimo** → se prioriza la solución QR sobre PWA (Fase 1).
- Se desea **plano visual** (Fase 2).
- La ubicación "exacta" se logra a nivel **cajón** mediante QR; el metro exacto
  automático (Fase 3) queda fuera por costo salvo decisión posterior.
