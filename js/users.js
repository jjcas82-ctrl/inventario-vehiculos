// users.js — Pestaña de gestión de usuarios (solo administrador).
import * as auth from "./auth.js";
import { escapeHtml } from "./agencies.js";
import { notify, confirmDialog, promptDialog } from "./ui.js";

export function initUsers() {
  document.getElementById("add-user").addEventListener("click", async () => {
    const data = {
      firstName: document.getElementById("nu-first").value,
      lastName:  document.getElementById("nu-last").value,
      email:     document.getElementById("nu-email").value,
      username:  document.getElementById("nu-username").value,
      password:  document.getElementById("nu-pass").value,
      role:      document.getElementById("nu-role").value,
    };
    if (!data.firstName.trim()) { notify("Escribe el nombre.", { type: "warn" }); return; }
    if (data.email && !/^\S+@\S+\.\S+$/.test(data.email.trim())) { notify("Correo no válido.", { type: "warn" }); return; }
    const res = await auth.createUser(data);
    if (!res.ok) { notify(res.error, { type: "error" }); return; }
    // Limpiar formulario
    ["nu-first", "nu-last", "nu-email", "nu-username", "nu-pass"].forEach(id => document.getElementById(id).value = "");
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

  tbody.innerHTML = users.map(u => `
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
      <td class="row gap">
        <button class="btn reset-pass" data-id="${u.id}">Restablecer contraseña</button>
        <button class="btn btn-danger del-user" data-id="${u.id}">Eliminar</button>
      </td>
    </tr>`).join("");

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
      auth.updateUser(sel.dataset.id, { role: sel.value });
      notify("Rol actualizado.", { type: "success" });
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
