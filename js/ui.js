// ui.js — Diálogos y avisos propios (no usa alert/confirm del navegador).
// Objetivo: avisos claros, profesionales y NO tediosos.
//   - notify(): banner discreto que se cierra solo (no bloquea).
//   - confirmDialog(): tarjeta modal con botones personalizados (solo cuando importa).

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---- Aviso no intrusivo (banner). Tipos: info | success | warn | error ----
let _stack = null;
function ensureStack() {
  if (_stack) return _stack;
  _stack = document.createElement("div");
  _stack.className = "notify-stack";
  document.body.appendChild(_stack);
  return _stack;
}

export function notify(message, { type = "info", timeout = 3500, title } = {}) {
  const stack = ensureStack();
  const el = document.createElement("div");
  el.className = "notify notify-" + type;
  const icon = { info: "ℹ️", success: "✓", warn: "⚠️", error: "✕" }[type] || "ℹ️";
  el.innerHTML =
    `<span class="notify-ico">${icon}</span>
     <div class="notify-body">${title ? `<b>${esc(title)}</b><br>` : ""}${esc(message)}</div>
     <button class="notify-x" aria-label="Cerrar">✕</button>`;
  stack.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));

  const close = () => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 200);
  };
  el.querySelector(".notify-x").addEventListener("click", close);
  if (timeout) setTimeout(close, timeout);
  return close;
}

// ---- Diálogo de confirmación con botones personalizados ----
// buttons: [{ label, value, variant }]  variant: primary | danger | ghost
// Devuelve una promesa que resuelve con el "value" del botón pulsado (o null si se cierra).
export function confirmDialog({ title, message, icon = "⚠️", buttons }) {
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "dlg-back";
    const btns = (buttons || [{ label: "Aceptar", value: true, variant: "primary" }])
      .map((b, i) => `<button class="btn ${b.variant ? "btn-" + b.variant : ""}" data-i="${i}">${esc(b.label)}</button>`)
      .join("");
    back.innerHTML =
      `<div class="dlg-card" role="dialog" aria-modal="true">
         <div class="dlg-head"><span class="dlg-ico">${icon}</span><h3>${esc(title || "Confirmar")}</h3></div>
         <div class="dlg-msg">${esc(message || "")}</div>
         <div class="dlg-actions">${btns}</div>
       </div>`;
    document.body.appendChild(back);
    requestAnimationFrame(() => back.classList.add("show"));

    const done = (val) => {
      back.classList.remove("show");
      setTimeout(() => back.remove(), 180);
      resolve(val);
    };
    back.querySelectorAll(".dlg-actions .btn").forEach(btn =>
      btn.addEventListener("click", () => done(buttons[+btn.dataset.i].value))
    );
    back.addEventListener("click", (e) => { if (e.target === back) done(null); });
    document.addEventListener("keydown", function onEsc(ev) {
      if (ev.key === "Escape") { document.removeEventListener("keydown", onEsc); done(null); }
    });
  });
}

// ---- Diálogo con campo de texto. Devuelve el texto (o null si cancela). ----
export function promptDialog({ title, message, placeholder = "", value = "", icon = "✏️", okLabel = "Guardar" }) {
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "dlg-back";
    back.innerHTML =
      `<div class="dlg-card" role="dialog" aria-modal="true">
         <div class="dlg-head"><span class="dlg-ico">${icon}</span><h3>${esc(title || "")}</h3></div>
         ${message ? `<div class="dlg-msg">${esc(message)}</div>` : ""}
         <input class="dlg-input" type="text" placeholder="${esc(placeholder)}" value="${esc(value)}" />
         <div class="dlg-actions">
           <button class="btn btn-ghost" data-v="cancel">Cancelar</button>
           <button class="btn btn-primary" data-v="ok">${esc(okLabel)}</button>
         </div>
       </div>`;
    document.body.appendChild(back);
    requestAnimationFrame(() => back.classList.add("show"));
    const input = back.querySelector(".dlg-input");
    setTimeout(() => { input.focus(); input.select(); }, 60);

    const done = (val) => { back.classList.remove("show"); setTimeout(() => back.remove(), 180); resolve(val); };
    back.querySelector('[data-v="ok"]').addEventListener("click", () => done(input.value));
    back.querySelector('[data-v="cancel"]').addEventListener("click", () => done(null));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") done(input.value);
      if (e.key === "Escape") done(null);
    });
    back.addEventListener("click", (e) => { if (e.target === back) done(null); });
  });
}
