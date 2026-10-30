// users.js — Pestaña de gestión de usuarios (solo administrador).
import * as auth from "./auth.js";
import { escapeHtml } from "./agencies.js";
import { notify, confirmDialog, promptDialog } from "./ui.js";

export function initUsers() {
  // Muestra/oculta el switch "Puede editar" en el alta según el rol elegido
  // (solo aplica a roles de edición opcional: gerente/contabilidad).
  const roleSel = document.getElementById("nu-role");
  const caneditLabel = document.getElementById("nu-canedit-label");
  const syncAltaSwitches = () => {
    if (!roleSel) return;
    const r = roleSel.value;
    if (caneditLabel) caneditLabel.style.display = auth.roleHasOptionalEdit(r) ? "" : "none";
    // El rol "refacciones" ya es exclusivo de refacciones: el switch no aplica.
    const accBox = document.getElementById("nu-access-parts")?.closest("label");
    if (accBox) accBox.style.display = auth.roleCanHaveParts(r) ? "" : "none";
  };
  if (roleSel) roleSel.addEventListener("change", syncAltaSwitches);
  syncAltaSwitches();

  document.getElementById("add-user").addEventListener("click", async () => {
    const data = {
      firstName: document.getElementById("nu-first").value,
      lastName:  document.getElementById("nu-last").value,
      email:     document.getElementById("nu-email").value,
      username:  document.getElementById("nu-username").value,
      password:  document.getElementById("nu-pass").value,
      role:      document.getElementById("nu-role").value,
      accessParts: !!document.getElementById("nu-access-parts")?.checked,
      canEdit:     !!document.getElementById("nu-can-edit")?.checked,
    };
    if (!data.firstName.trim()) { notify("Escribe el nombre.", { type: "warn" }); return; }
    if (data.email && !/^\S+@\S+\.\S+$/.test(data.email.trim())) { notify("Correo no válido.", { type: "warn" }); return; }
    const res = await auth.createUser(data);
    if (!res.ok) { notify(res.error, { type: "error" }); return; }
    // Limpiar formulario
    ["nu-first", "nu-last", "nu-email", "nu-username", "nu-pass"].forEach(id => document.getElementById(id).value = "");
    const ap = document.getElementById("nu-access-parts"); if (ap) ap.checked = false;
    const ce = document.getElementById("nu-can-edit"); if (ce) ce.checked = false;
    renderUsers();
    notify("Usuario registrado.", { type: "success" });
  });

  renderUsers();
}

export function renderUsers() {
  const tbody = document.querySelector("#users-table tbody");
  if (!tbody) return;
  const users = auth.listUsers();
  const me = auth.currentUser();

  tbody.innerHTML = users.map(u => {
    const partsOn = auth.hasPartsAccess(u);
    const canHaveParts = auth.roleCanHaveParts(u.role);
    const optEdit = auth.roleHasOptionalEdit(u.role);
    return `
    <tr>
      <td>${escapeHtml([u.firstName, u.lastName].filter(Boolean).join(" ") || "—")}</td>
      <td><code>${escapeHtml(u.username || "—")}</code></td>
      <td class="muted">${escapeHtml(u.email || "")}</td>
      <td>
        <select class="user-role" data-id="${u.id}">
          ${Object.entries(auth.ROLES).map(([k, v]) =>
            `<option value="${k}" ${u.role === k ? "selected" : ""}>${escapeHtml(v.label)}</option>`).join("")}
        </select>
      </td>
      <td style="text-align:center">
        ${canHaveParts
          ? `<input type="checkbox" class="user-parts" data-id="${u.id}" ${partsOn ? "checked" : ""} title="Acceso al inventario de refacciones" />`
          : `<span class="muted" title="El rol Refacciones ya es exclusivo de refacciones">✔</span>`}
      </td>
      <td style="text-align:center">
        ${optEdit
          ? `<input type="checkbox" class="user-canedit" data-id="${u.id}" ${u.canEdit ? "checked" : ""} title="Permitir editar fichas (edición opcional)" />`
          : `<span class="muted" title="La edición de este rol no es opcional">—</span>`}
      </td>
      <td class="row gap">
        <button class="btn edit-user" data-id="${u.id}">✏️ Editar datos</button>
        <button class="btn reset-pass" data-id="${u.id}">Restablecer contraseña</button>
        <button class="btn btn-danger del-user" data-id="${u.id}">Eliminar</button>
      </td>
    </tr>`;
  }).join("");

  tbody.querySelectorAll(".user-role").forEach(sel =>
    sel.addEventListener("change", () => {
      // Evitar dejar el sistema sin administradores
      const admins = auth.listUsers().filter(u => u.role === "admin");
      const target = auth.listUsers().find(u => u.id === sel.dataset.id);
      if (target?.role === "admin" && sel.value !== "admin" && admins.length <= 1) {
        notify("Debe existir al menos un administrador.", { type: "warn" });
        sel.value = "admin";
        return;
      }
      const patch = { role: sel.value };
      // Al cambiar a un rol sin edición opcional, limpiamos canEdit.
      if (!auth.roleHasOptionalEdit(sel.value)) patch.canEdit = undefined;
      auth.updateUser(sel.dataset.id, patch);
      notify("Rol actualizado.", { type: "success" });
      renderUsers();   // refresca columnas de switches según el nuevo rol
    })
  );

  // Switch: acceso a refacciones por usuario.
  tbody.querySelectorAll(".user-parts").forEach(chk =>
    chk.addEventListener("change", () => {
      auth.updateUser(chk.dataset.id, { accessParts: chk.checked });
      notify(chk.checked ? "Acceso a refacciones activado." : "Acceso a refacciones quitado.", { type: "success" });
    })
  );

  // Switch: edición opcional por usuario (gerente/contabilidad).
  tbody.querySelectorAll(".user-canedit").forEach(chk =>
    chk.addEventListener("change", () => {
      auth.updateUser(chk.dataset.id, { canEdit: chk.checked });
      notify(chk.checked ? "Edición activada para el usuario." : "Edición desactivada.", { type: "success" });
    })
  );

  // Editar DATOS personales del usuario (nombre, apellidos, correo).
  tbody.querySelectorAll(".edit-user").forEach(btn =>
    btn.addEventListener("click", async () => {
      if (!auth.isAdmin()) { notify("Solo el administrador puede editar usuarios.", { type: "warn" }); return; }
      const u = auth.listUsers().find(x => x.id === btn.dataset.id);
      if (!u) return;
      const first = await promptDialog({
        icon: "✏️", title: "Editar usuario — Nombre(s)",
        message: `Usuario: ${u.username}`,
        placeholder: "Nombre(s)", value: u.firstName || "", okLabel: "Siguiente",
      });
      if (first === null) return;
      const last = await promptDialog({
        icon: "✏️", title: "Editar usuario — Apellidos",
        message: `Usuario: ${u.username}`,
        placeholder: "Apellidos", value: u.lastName || "", okLabel: "Siguiente",
      });
      if (last === null) return;
      const email = await promptDialog({
        icon: "✏️", title: "Editar usuario — Correo",
        message: `Usuario: ${u.username}`,
        placeholder: "correo@empresa.com", value: u.email || "", okLabel: "Guardar",
      });
      if (email === null) return;
      if (!first.trim()) { notify("El nombre no puede quedar vacío.", { type: "warn" }); return; }
      if (email.trim() && !/^\S+@\S+\.\S+$/.test(email.trim())) { notify("Correo no válido.", { type: "warn" }); return; }
      auth.updateUser(u.id, {
        firstName: first.trim(), lastName: last.trim(), email: email.trim(),
      });
      renderUsers();
      notify("Datos del usuario actualizados.", { type: "success" });
    })
  );

  tbody.querySelectorAll(".reset-pass").forEach(btn =>
    btn.addEventListener("click", async () => {
      const nueva = await promptDialog({
        icon: "🔑", title: "Restablecer contraseña",
        message: "Escribe la nueva contraseña para este usuario (mínimo 4 caracteres).",
        placeholder: "Nueva contraseña", okLabel: "Guardar",
      });
      if (nueva === null) return;
      const res = await auth.resetPassword(btn.dataset.id, nueva);
      if (!res.ok) { notify(res.error, { type: "error" }); return; }
      notify("Contraseña restablecida.", { type: "success" });
    })
  );

  tbody.querySelectorAll(".del-user").forEach(btn =>
    btn.addEventListener("click", async () => {
      // Solo el administrador puede eliminar usuarios (defensa en profundidad:
      // la pestaña ya está restringida por permiso, pero reforzamos aquí).
      if (!auth.isAdmin()) { notify("Solo el administrador puede eliminar usuarios.", { type: "warn" }); return; }
      const users2 = auth.listUsers();
      const target = users2.find(u => u.id === btn.dataset.id);
      const admins = users2.filter(u => u.role === "admin");
      if (target?.role === "admin" && admins.length <= 1) {
        notify("Debe existir al menos un administrador.", { type: "warn" });
        return;
      }
      if (me && target && me.id === target.id) {
        notify("No puedes eliminar tu propio usuario mientras tienes la sesión abierta.", { type: "warn" });
        return;
      }
      const choice = await confirmDialog({
        icon: "👤", title: "Eliminar usuario",
        message: `¿Eliminar a "${[target?.firstName, target?.lastName].filter(Boolean).join(" ") || target?.username}"?`,
        buttons: [
          { label: "Cancelar", value: null, variant: "ghost" },
          { label: "Eliminar", value: "del", variant: "danger" },
        ],
      });
      if (choice === "del") { auth.removeUser(btn.dataset.id); renderUsers(); }
    })
  );
}
