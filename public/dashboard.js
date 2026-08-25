// Dashboard logic — vanilla JS, polls status + QR, drives connect flows.
async function api(path, opts) {
  const res = await fetch(path, opts);
  if (res.status === 401) { location.href = "/login.html"; throw new Error("unauth"); }
  return res;
}
const $ = (id) => document.getElementById(id);

// ── Session / who ────────────────────────────────────────────────────────────
(async () => {
  const me = await (await api("/auth/me")).json();
  $("who").textContent = me.user.display_name || me.user.email;
})();

$("logout").onclick = async () => {
  await fetch("/auth/logout", { method: "POST" });
  location.href = "/login.html";
};

// ── WhatsApp ─────────────────────────────────────────────────────────────────
let qrTimer = null;

async function refreshWa() {
  const s = await (await api("/whatsapp/status")).json();
  const statusEl = $("wa-status");
  const qrWrap = $("wa-qr-wrap");
  const connectBtn = $("wa-connect");
  const disconnectBtn = $("wa-disconnect");
  const resetBtn = $("wa-reset");

  // Helper: set which buttons are visible. show = array of buttons to show.
  const show = (...btns) => {
    [connectBtn, disconnectBtn, resetBtn].forEach((b) => b.classList.add("hidden"));
    btns.forEach((b) => b && b.classList.remove("hidden"));
  };

  if (s.status === "ready") {
    statusEl.innerHTML = `<span class="pill green">Connected</span> &nbsp;<b>${s.push_name || ""}</b> +${s.phone || "?"}`;
    statusEl.className = "status";
    qrWrap.classList.add("hidden");
    show(disconnectBtn, resetBtn); // disconnect OR switch number
    stopQrPolling();
  } else if (s.status === "none") {
    statusEl.innerHTML = `<span class="pill grey">Not connected</span>`;
    statusEl.className = "status";
    qrWrap.classList.add("hidden");
    connectBtn.textContent = "Connect WhatsApp";
    show(connectBtn);
  } else if (s.status === "qr_ready") {
    statusEl.innerHTML = `<span class="pill amber">Scan the QR code</span>`;
    statusEl.className = "status";
    show(resetBtn); // allow bailing out to a clean start
    if (!qrTimer) startQrPolling();
  } else if (s.status === "disconnected" || s.status === "stopped" || s.status === "failed" || s.status === "logged_out") {
    // Stopped/disconnected — reconnect the same number OR link a new one.
    statusEl.innerHTML = `<span class="pill grey">Disconnected</span>`;
    statusEl.className = "status";
    qrWrap.classList.add("hidden");
    connectBtn.textContent = "Reconnect WhatsApp";
    show(connectBtn, resetBtn);
    stopQrPolling();
  } else {
    // initializing / authenticating / connecting — transient
    statusEl.innerHTML = `<span class="pill amber">${s.status}…</span>`;
    statusEl.className = "status";
    show(resetBtn);
  }
}

async function pollQr() {
  let q;
  try { q = await (await api("/whatsapp/qr")).json(); }
  catch { return; } // transient (e.g. OpenWA mid-restart) — try again next tick
  if (q.status === "ready") { await refreshWa(); return; }
  // Always refresh the image from the latest QR so a rotated QR (OpenWA
  // regenerates every ~20-30s) replaces the expired one.
  if (q.qrCode) {
    $("wa-qr").src = q.qrCode;
    $("wa-qr-wrap").classList.remove("hidden");
  }
}
function startQrPolling() {
  stopQrPolling();
  pollQr();
  qrTimer = setInterval(pollQr, 3000);
}
function stopQrPolling() { if (qrTimer) { clearInterval(qrTimer); qrTimer = null; } }

$("wa-connect").onclick = async () => {
  $("wa-status").textContent = "Starting session…";
  await api("/whatsapp/connect", { method: "POST" });
  startQrPolling();
};
$("wa-disconnect").onclick = async () => {
  await api("/whatsapp/disconnect", { method: "POST" });
  await refreshWa();
};
$("wa-reset").onclick = async () => {
  if (!confirm("This will unlink the current WhatsApp number. You'll scan a fresh QR to link a different one. Continue?")) return;
  $("wa-status").innerHTML = `<span class="pill amber">Resetting…</span>`;
  await api("/whatsapp/reset", { method: "POST" });
  // Immediately start a fresh session so a new QR appears.
  await api("/whatsapp/connect", { method: "POST" });
  startQrPolling();
};

// ── Jira ─────────────────────────────────────────────────────────────────────
async function refreshJira() {
  const s = await (await api("/jira/status")).json();
  const statusEl = $("jira-status");
  const connectBtn = $("jira-connect");
  const projWrap = $("project-wrap");

  if (s.connected) {
    statusEl.innerHTML = `<span class="pill green">Connected</span> &nbsp;<b>${s.connection.site_name || s.connection.site_url || "Jira"}</b>` +
      (s.connection.project_key ? ` · tickets → <b>${s.connection.project_key}</b>` : "");
    statusEl.className = "status";
    connectBtn.textContent = "Reconnect Jira";
    projWrap.classList.remove("hidden");
    await loadProjects(s.connection.project_key);
  } else {
    statusEl.innerHTML = `<span class="pill grey">Not connected</span>`;
    statusEl.className = "status";
    projWrap.classList.add("hidden");
  }
}

async function loadProjects(currentKey) {
  try {
    const data = await (await api("/jira/projects")).json();
    const sel = $("project-select");
    sel.innerHTML = "";
    const projects = data.projects || [];
    for (const p of projects) {
      const opt = document.createElement("option");
      opt.value = p.key;
      opt.textContent = `${p.key} — ${p.name}`;
      opt.dataset.name = p.name;
      if (p.key === currentKey) opt.selected = true;
      sel.appendChild(opt);
    }
    // If nothing is saved yet but projects exist, auto-save the first one so
    // the support line is immediately usable (no silent "looks selected" trap).
    if (!currentKey && projects.length > 0) {
      sel.value = projects[0].key;
      await saveProject();
    }
  } catch { /* ignore */ }
}

async function saveProject() {
  const sel = $("project-select");
  const key = sel.value;
  if (!key) return;
  const name = sel.selectedOptions[0]?.dataset.name || key;
  const res = await api("/jira/project", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_key: key, project_name: name }),
  });
  const msg = $("project-msg");
  if (res.ok) { msg.textContent = "Saved ✓ tickets will be created in " + key; msg.className = "msg ok"; }
  else { msg.textContent = "Failed to save"; msg.className = "msg err"; }
}

// Save explicitly on button click AND automatically when the selection changes,
// so there's no "looks selected but isn't saved" trap.
$("save-project").onclick = saveProject;
$("project-select").addEventListener("change", saveProject);

// ── Tickets ──────────────────────────────────────────────────────────────────
async function refreshTickets() {
  const data = await (await api("/tickets")).json();
  const tbody = $("tickets").querySelector("tbody");
  if (!data.tickets || data.tickets.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted">No tickets yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = data.tickets.map((t) => `
    <tr>
      <td class="mono">${t.jira_url ? `<a href="${t.jira_url}" target="_blank">${t.jira_key}</a>` : t.jira_key}</td>
      <td class="mono">+${t.sender_phone || "?"}</td>
      <td>${(t.issue_text || "").slice(0, 60)}</td>
      <td><span class="pill green">Created</span> <span class="muted" style="margin-left:8px">${new Date(t.created_at).toLocaleString()}</span></td>
    </tr>`).join("");
}

// ── People & access (space-scoped roles) ────────────────────────────────────
const ROLE_LABEL = { operator: "Operator", admin: "Admin", super_admin: "Super admin" };

// Populate the space picker from the connected Jira site's projects.
async function refreshSpaces() {
  const sel = $("role-space");
  try {
    const data = await (await api("/roles/spaces")).json();
    const opts = (data.spaces || [])
      .map((sp) => `<option value="${sp.key}">${sp.key} — ${sp.name}</option>`)
      .join("");
    sel.innerHTML = `<option value="">Select space…</option>` + opts;
  } catch {
    sel.innerHTML = `<option value="">Select space…</option>`;
  }
}

// A super admin spans every space, so the space picker is meaningless for it.
function syncSpaceEnabled() {
  const isSuper = $("role-role").value === "super_admin";
  const sel = $("role-space");
  sel.disabled = isSuper;
  if (isSuper) sel.value = "";
  sel.style.opacity = isSuper ? "0.5" : "1";
}
$("role-role").onchange = syncSpaceEnabled;

async function refreshRoles() {
  const tbody = $("roles").querySelector("tbody");
  let rows = [];
  try {
    const data = await (await api("/roles")).json();
    rows = data.roles || [];
  } catch {
    // Server unreachable, or the migration has not been applied yet. Say so
    // rather than leaving the table stuck on its placeholder.
    tbody.innerHTML = `<tr><td colspan="6" class="muted">Could not load access list.</td></tr>`;
    return;
  }
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted">No one added yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((r) => `
    <tr>
      <td class="mono">+${r.phone}</td>
      <td>${r.label || "—"}</td>
      <td>${ROLE_LABEL[r.role] || r.role}</td>
      <td class="mono">${r.space_key || "All spaces"}</td>
      <td class="muted">${new Date(r.created_at).toLocaleDateString()}</td>
      <td><button class="ghost role-del" data-id="${r.id}" style="padding:4px 10px;font-size:12px">Remove</button></td>
    </tr>`).join("");
  tbody.querySelectorAll(".role-del").forEach((btn) => {
    btn.onclick = async () => {
      await api(`/roles/${btn.dataset.id}`, { method: "DELETE" });
      refreshRoles();
    };
  });
}

$("role-add-btn").onclick = async () => {
  const phone = $("role-phone").value.trim();
  const label = $("role-label").value.trim();
  const role  = $("role-role").value;
  const space = $("role-space").value;
  const msg   = $("role-msg");

  if (!phone) { msg.textContent = "Enter a phone number"; msg.className = "msg err"; return; }
  if (role !== "super_admin" && !space) {
    msg.textContent = "Pick a space for this role";
    msg.className = "msg err";
    return;
  }

  const res = await api("/roles", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, label, role, space_key: role === "super_admin" ? null : space }),
  });

  if (res.ok) {
    $("role-phone").value = ""; $("role-label").value = "";
    msg.textContent = "Added ✓"; msg.className = "msg ok";
    refreshRoles();
  } else {
    const d = await res.json().catch(() => ({}));
    const errs = {
      invalid_phone: "That phone number looks invalid",
      space_required: "Pick a space for this role",
      super_admin_is_global: "Super admins cover every space — leave the space blank",
    };
    msg.textContent = errs[d.error] || "Failed to add";
    msg.className = "msg err";
  }
};

// ── Init ─────────────────────────────────────────────────────────────────────
refreshWa();
refreshJira();
refreshTickets();
refreshRoles();
refreshSpaces();
syncSpaceEnabled();
setInterval(refreshTickets, 15000);
setInterval(refreshWa, 10000);
// If we just came back from Jira OAuth, refresh.
if (location.search.includes("jira=connected")) {
  history.replaceState({}, "", "/dashboard.html");
}
