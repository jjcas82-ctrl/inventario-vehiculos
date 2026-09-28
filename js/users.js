// users.js — Pestaña de gestión de usuarios y PIN (solo administrador).
import * as auth from "./auth.js";
import { escapeHtml } from "./agencies.js";
import { notify, confirmDialog } from "./ui.js";

export function initUsers() {
  document.getElementById("add-user").addEventListener("click", () => {
    const name = document.getElementById("new-user-name").value.trim();
    const role = document.getElementById("new-user-role").value;
    if (!name) { notify("Escribe el nombre del usuario.", { type: "warn" }); return; }
    auth.addUser(name, role);
    document.getElementById("new-user-name").value = "";
    renderUsers();
    notify("Usuario agregado.", { type: "success" });
  });

  document.getElementById("save-pin").addEventListener("click", () => {
    const pin = document.getElementById("admin-pin").value.trim();
    if (!/^\d{4,8}$/.test(pin)) { notify("El PIN debe tener de 4 a 8 dígitos.", { type: "warn" }); return; }
    auth.setAdminPin(pin);
    document.getElementById("admin-pin").value = "";
    notify("PIN de administrador actualizado.", { type: "success" });
  });

  renderUsers();
}

export function renderUsers() {
  const tbody = document.querySelector("#users-table tbody");
  if (!tbody) return;
  const users = auth.listUsers();
  tbody.innerHTML = users.map(u => `
    <tr>
      <td>${escapeHtml(u.name)}</td>
      <td>
        <select class="user-role" data-id="${u.id}">
          ${Object.entries(auth.ROLES).map(([k, v]) =>
            `<option value="${k}" ${u.role === k ? "selected" : ""}>${escapeHtml(v.label)}</option>`).join("")}
        </select>
      </td>
      <td><button class="btn btn-danger del-user" data-id="${u.id}">Eliminar</button></td>
    </tr>`).join("");

  tbody.querySelectorAll(".user-role").forEach(sel =>
    sel.addEventListener("change", () => {
      auth.updateUser(sel.dataset.id, { role: sel.value });
      notify("Rol actualizado.", { type: "success" });
    })
  );
  tbody.querySelectorAll(".del-user").forEach(btn =>
    btn.addEventListener("click", async () => {
      const users2 = auth.listUsers();
      const target = users2.find(u => u.id === btn.dataset.id);
      // Evitar quedarse sin administradores
      const admins = users2.filter(u => u.role === "admin");
      if (target?.role === "admin" && admins.length <= 1) {
        notify("Debe existir al menos un administrador.", { type: "warn" });
        return;
      }
      const choice = await confirmDialog({
        icon: "👤", title: "Eliminar usuario",
        message: `¿Eliminar a "${target?.name}"?`,
        buttons: [
          { label: "Cancelar", value: null, variant: "ghost" },
          { label: "Eliminar", value: "del", variant: "danger" },
        ],
      });
      if (choice === "del") { auth.removeUser(btn.dataset.id); renderUsers(); }
    })
  );
}
