// catalogadmin.js — Panel (solo admin) para administrar los catálogos de
// autocompletar: ver, agregar y quitar valores de cada lista.
import { catalogNames, getCatalog, addToCatalog, removeFromCatalog, resetCatalog, CATALOG_LABELS,
         listClaves, aprenderClave, removeClave } from "./catalog.js";
import { escapeHtml } from "./agencies.js";
import { notify, confirmDialog } from "./ui.js";

export function initCatalogAdmin() {
  render();
}

export function renderCatalogAdmin() { render(); }

function render() {
  const cont = document.getElementById("catalog-admin");
  if (!cont) return;

  cont.innerHTML = catalogNames().map(name => {
    const vals = getCatalog(name);
    const chips = vals.map(v => `
      <span class="cat-chip">
        ${escapeHtml(v)}
        <button class="cat-del" data-cat="${escapeHtml(name)}" data-val="${escapeHtml(v)}" title="Quitar" aria-label="Quitar ${escapeHtml(v)}">✕</button>
      </span>`).join("");
    return `
      <div class="cat-group" data-cat="${escapeHtml(name)}">
        <div class="row between wrap">
          <b>${escapeHtml(CATALOG_LABELS[name] || name)}</b>
          <button class="btn btn-ghost cat-reset" data-cat="${escapeHtml(name)}" style="font-size:12px">Restaurar valores por defecto</button>
        </div>
        <div class="cat-chips">${chips || '<span class="muted">Lista vacía.</span>'}</div>
        <div class="row gap" style="margin-top:6px">
          <input type="text" class="cat-new" data-cat="${escapeHtml(name)}" placeholder="Agregar valor…" maxlength="40" style="flex:1;min-width:160px" />
          <button class="btn cat-add" data-cat="${escapeHtml(name)}">Agregar</button>
        </div>
      </div>`;
  }).join("");

  // Agregar valor
  cont.querySelectorAll(".cat-add").forEach(btn =>
    btn.addEventListener("click", () => {
      const cat = btn.dataset.cat;
      const input = cont.querySelector(`.cat-new[data-cat="${cssEsc(cat)}"]`);
      const val = (input?.value || "").trim();
      if (!val) { notify("Escribe un valor para agregar.", { type: "warn" }); return; }
      if (addToCatalog(cat, val)) { notify("Valor agregado.", { type: "success" }); render(); }
      else notify("Ese valor ya existe en la lista.", { type: "info" });
    })
  );
  // Enter en el input agrega
  cont.querySelectorAll(".cat-new").forEach(inp =>
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); const b = cont.querySelector(`.cat-add[data-cat="${cssEsc(inp.dataset.cat)}"]`); b?.click(); }
    })
  );
  // Quitar valor
  cont.querySelectorAll(".cat-del").forEach(btn =>
    btn.addEventListener("click", () => {
      removeFromCatalog(btn.dataset.cat, btn.dataset.val);
      render();
    })
  );
  // Restaurar por defecto
  cont.querySelectorAll(".cat-reset").forEach(btn =>
    btn.addEventListener("click", async () => {
      const cat = btn.dataset.cat;
      const choice = await confirmDialog({
        icon: "↩️", title: "Restaurar catálogo",
        message: `¿Restaurar "${CATALOG_LABELS[cat] || cat}" a sus valores por defecto? Se perderán los valores agregados a mano.`,
        buttons: [
          { label: "Cancelar", value: null, variant: "ghost" },
          { label: "Restaurar", value: "ok", variant: "danger" },
        ],
      });
      if (choice !== "ok") return;
      resetCatalog(cat);
      render();
      notify("Catálogo restaurado.", { type: "info" });
    })
  );

  renderClaves(cont);
}

// --- Sección: claves del fabricante → modelo (autoaprendidas) ---
function renderClaves(cont) {
  const claves = listClaves();
  const rows = claves.map(({ clave, modelo }) => `
    <tr>
      <td><code>${escapeHtml(clave)}</code></td>
      <td>${escapeHtml(modelo)}</td>
      <td><button class="btn btn-sm clave-del" data-clave="${escapeHtml(clave)}">Quitar</button></td>
    </tr>`).join("");

  const block = document.createElement("div");
  block.className = "cat-group";
  block.innerHTML = `
    <b>Claves de modelo del fabricante (ej. GM 1VC69 → Aveo)</b>
    <p class="hint" style="margin-top:2px">Se aprenden solas: al capturar el modelo de una unidad con clave vehicular, se guarda la equivalencia. Al cargar un CDO/factura, el modelo se completa desde la clave.</p>
    <div class="table-wrap" style="max-height:260px;overflow:auto">
      <table class="table"><thead><tr><th>Clave</th><th>Modelo</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="3" class="muted">Aún no hay claves aprendidas.</td></tr>'}</tbody></table>
    </div>
    <div class="row gap wrap" style="margin-top:6px">
      <input type="text" id="clave-new-k" placeholder="Clave (ej. 1VC69)" maxlength="10" style="flex:1;min-width:120px" />
      <input type="text" id="clave-new-m" placeholder="Modelo (ej. Aveo)" maxlength="40" style="flex:1;min-width:120px" />
      <button class="btn" id="clave-add">Agregar / actualizar</button>
    </div>`;
  cont.appendChild(block);

  block.querySelector("#clave-add").addEventListener("click", () => {
    const k = block.querySelector("#clave-new-k").value.trim();
    const m = block.querySelector("#clave-new-m").value.trim();
    if (!k || !m) { notify("Escribe la clave y el modelo.", { type: "warn" }); return; }
    aprenderClave(k, m);
    notify(`Clave ${k.toUpperCase()} → ${m} guardada.`, { type: "success" });
    render();
  });
  block.querySelectorAll(".clave-del").forEach(btn =>
    btn.addEventListener("click", () => { removeClave(btn.dataset.clave); render(); }));
}

// Escapa un valor para usarlo dentro de un selector CSS [data-cat="..."].
function cssEsc(s) {
  return String(s).replace(/["\\]/g, "\\$&");
}
