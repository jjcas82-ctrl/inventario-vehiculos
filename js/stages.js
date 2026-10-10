// stages.js — Catálogo de etapas (estatus comercial) del vehículo.
// La etapa responde "¿en qué punto del proceso está la unidad?", distinto de la
// ubicación física (dónde está). Los reportes de gerencia se apoyan en esto.

export const STAGES_NUEVO = [
  "Recepción",
  "Preparación (PDI)",
  "Disponible",
  "Apartado",
  "Vendido",
  "Entregado",
];

export const STAGES_USADO = [
  "Recepción",
  "Valuación",
  "Reparación/Preparación",
  "Disponible",
  "Apartado",
  "Vendido",
  "Entregado",
];

// Devuelve la lista de etapas según la condición ('nuevo' | 'usado').
export function stagesFor(condition) {
  return condition === "usado" ? STAGES_USADO : STAGES_NUEVO;
}

// Todas las etapas posibles (para filtros de reportes), sin duplicados.
export function allStages() {
  return [...new Set([...STAGES_NUEVO, ...STAGES_USADO])];
}

// Etapas que representan una venta concretada.
export const STAGES_VENTA = ["Vendido", "Entregado"];

// ¿La unidad está en una etapa de venta (Vendido/Entregado)?
export function isSoldStage(stage) {
  return STAGES_VENTA.includes(stage);
}

// Una unidad se considera CERRADA (liquidada, ya no es inventario vivo) cuando
// está en etapa de venta (Vendido/Entregado) Y tiene salida registrada (status fuera).
// Las unidades cerradas: no cuentan como existencia, no se editan ni admiten nueva
// entrada; solo el administrador puede reabrirlas.
export function isClosed(vehicle) {
  if (!vehicle) return false;
  return isSoldStage(vehicle.stage) && vehicle.status === "fuera";
}
