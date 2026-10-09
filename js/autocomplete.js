// autocomplete.js — Autocompletar propio (NO usa <datalist>, que es poco fiable en
// navegadores móviles). Funciona igual en celular y PC: muestra una lista de
// sugerencias filtrada en vivo mientras se escribe, navegable con teclado o toque.
//
// Uso:
//   attachAutocomplete(inputEl, () => ["Blanco", "Negro", ...]);
// El segundo argumento es una función que devuelve la lista de opciones (así puede
// cambiar en caliente, p. ej. tras agregar valores al catálogo).

let _idSeq = 0;

export function attachAutocomplete(input, getOptions) {
  if (!input || input.__acAttached) return;
  input.__acAttached = true;
  input.setAttribute("autocomplete", "off");
  input.setAttribute("autocorrect", "off");
  input.setAttribute("autocapitalize", "off");

  // Contenedor posicionado para colocar el desplegable justo bajo el input.
  const wrap = document.createElement("div");
  wrap.className = "ac-wrap";
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);

  const list = document.createElement("ul");
  list.className = "ac-list";
  list.hidden = true;
  const listId = "ac-list-" + (++_idSeq);
  list.id = listId;
  wrap.appendChild(list);

  let activeIndex = -1;
  let items = [];

  const close = () => { list.hidden = true; list.innerHTML = ""; activeIndex = -1; };

  const open = (filterText) => {
    const all = (getOptions() || []).map(String);
    const q = (filterText || "").toLowerCase().trim();
    // Si hay texto, filtra por "contiene"; si no, muestra todas (hasta 50).
    items = (q ? all.filter(o => o.toLowerCase().includes(q)) : all).slice(0, 50);
    if (!items.length) { close(); return; }
    list.innerHTML = items.map((o, i) =>
      `<li class="ac-item" role="option" data-i="${i}">${escapeHtml(o)}</li>`).join("");
    list.hidden = false;
    activeIndex = -1;

    list.querySelectorAll(".ac-item").forEach(li => {
      // mousedown/touchstart en vez de click: se dispara ANTES del blur del input,
      // así no se cierra la lista antes de poder seleccionar.
      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        choose(Number(li.dataset.i));
      });
    });
  };

  const choose = (i) => {
    if (i < 0 || i >= items.length) return;
    input.value = items[i];
    close();
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.focus();
  };

  const setActive = (i) => {
    const lis = [...list.querySelectorAll(".ac-item")];
    lis.forEach(el => el.classList.remove("is-active"));
    if (i >= 0 && i < lis.length) {
      lis[i].classList.add("is-active");
      lis[i].scrollIntoView({ block: "nearest" });
    }
  };

  input.addEventListener("focus", () => open(input.value));
  input.addEventListener("input", () => open(input.value));
  input.addEventListener("blur", () => setTimeout(close, 150));
  input.addEventListener("keydown", (e) => {
    if (list.hidden) return;
    if (e.key === "ArrowDown") { e.preventDefault(); activeIndex = Math.min(activeIndex + 1, items.length - 1); setActive(activeIndex); }
    else if (e.key === "ArrowUp") { e.preventDefault(); activeIndex = Math.max(activeIndex - 1, 0); setActive(activeIndex); }
    else if (e.key === "Enter") { if (activeIndex >= 0) { e.preventDefault(); choose(activeIndex); } }
    else if (e.key === "Escape") { close(); }
  });
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
