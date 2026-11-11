// Admin > People and Admin > Alerts. Loaded after the page's inline script;
// uses its toast() and showDialog() helpers.
"use strict";
(function () {
  const esc = window.XanaUI.esc;
  const $ = (id) => document.getElementById(id);
  let people = [];
  let bound = false;

  function msg(el, kind, text) {
    el.className = "msg " + kind + (text ? " show" : "");
    el.textContent = text || "";
  }

  // ---------- People ----------
  async function loadPeople() {
    bindOnce();
    try {
      people = await XanaSupabase.listPeople();
      renderPeople();
    } catch (e) {
      $("peopleList").innerHTML = '<div class="msg err show">' + esc(e.message) + "</div>";
    }
  }

  function renderPeople() {
    const q = $("peopleSearch").value.trim().toLowerCase();
    const f = $("peopleFilter").value;
    const rows = people.filter((p) =>
      (!q || p.full_name.toLowerCase().includes(q) || (p.email || "").includes(q)) &&
      (!f || (f === "noemail" ? !p.email && p.active : !p.active)));
    $("peopleCount").textContent = people.length;
    if (!rows.length) { $("peopleList").innerHTML = '<p class="sub" style="padding:14px 0">No one matches.</p>'; return; }
    const src = { m365: "Microsoft 365", register: "From register", manual: "Added by hand" };
    $("peopleList").innerHTML = '<div class="tbl-scroll"><table><thead><tr><th>Name</th><th>Email</th><th>Department</th><th>Source</th><th>Status</th><th></th></tr></thead><tbody>' +
      rows.slice(0, 300).map((p) =>
        `<tr data-id="${esc(p.id)}">
          <td><b>${esc(p.full_name)}</b>${p.job_title ? `<div class="sub" style="font-size:.72rem">${esc(p.job_title)}</div>` : ""}</td>
          <td><input type="email" class="p-email" value="${esc(p.email || "")}" placeholder="add email" ${p.source === "m365" ? 'title="Comes from Microsoft 365"' : ""} style="min-width:200px" /></td>
          <td>${esc(p.department || "—")}</td>
          <td style="white-space:nowrap;color:var(--muted)">${esc(src[p.source] || p.source)}</td>
          <td><button type="button" class="small ${p.active ? "secondary" : "danger"}" data-toggle="${esc(p.id)}" title="${p.active ? "Mark as left" : "Mark as active"}">${p.active ? "Active" : "Left"}</button></td>
          <td><button type="button" class="small secondary" data-del="${esc(p.id)}" data-name="${esc(p.full_name)}" title="Remove from the list">Remove</button></td>
        </tr>`).join("") +
      "</tbody></table></div>" + (rows.length > 300 ? `<p class="sub">Showing 300 of ${rows.length}. Search to narrow down.</p>` : "");
  }

  function addPersonDialog() {
    showDialog({
      title: "Add person",
      body: '<input type="text" id="npName" placeholder="Full name" style="width:100%;margin-bottom:8px" autocomplete="off" />' +
        '<input type="email" id="npEmail" placeholder="Email (optional)" style="width:100%" autocomplete="off" />',
      confirmText: "Add",
      onConfirm: async () => {
        const fullName = $("npName").value.trim();
        if (fullName.length < 2) throw new Error("Type their name");
        await XanaSupabase.addPerson({ fullName, email: $("npEmail").value });
        await loadPeople();
        return { message: fullName + " added" };
      },
    });
    setTimeout(() => $("npName")?.focus(), 150);
  }

  async function syncM365() {
    const btn = $("btnPeopleSync");
    btn.disabled = true;
    btn.textContent = "Syncing…";
    msg($("peopleMsg"), "info", "");
    try {
      const r = await XanaSupabase.syncPeopleFromM365();
      msg($("peopleMsg"), "ok", `Synced ${r.directory} accounts: ${r.added} added, ${r.updated} updated` + (r.newly_left ? `, ${r.newly_left} newly marked as left` : "") + ".");
      await loadPeople();
    } catch (e) {
      msg($("peopleMsg"), "err", e.message + (e.status === 403 || /Authorization|Insufficient/i.test(e.message) ? " — the app needs the User.Read.All permission in Entra." : ""));
    } finally {
      btn.disabled = false;
      btn.textContent = "Sync from Microsoft 365";
    }
  }

  // ---------- Alerts ----------
  async function loadAlerts(show) {
    bindOnce();
    const setup = $("alertSetup");
    try {
      const r = await XanaSupabase.previewAlert();
      const m = r.mail || {};
      const line = (ok, label, value) => `<div style="display:flex;gap:8px;font-size:.84rem;padding:4px 0"><span style="color:${ok ? "var(--green)" : "var(--orange)"}">${ok ? "✓" : "○"}</span><span style="color:var(--muted);min-width:150px">${label}</span><span>${value}</span></div>`;
      setup.innerHTML =
        line(m.configured, "Sends from", m.sender ? esc(m.sender) : "Not set up (MAIL_SENDER)") +
        line(m.recipients && m.recipients.length, "Goes to", m.recipients && m.recipients.length ? esc(m.recipients.join(", ")) : "Not set up (ALERT_TO)") +
        line(m.directory, "Microsoft 365", m.directory ? "Connected" : "Not connected here");
      $("btnAlertSend").disabled = !(m.configured && m.recipients && m.recipients.length);
      if (show) {
        const body = String(r.html).replace(/^[\s\S]*?<body[^>]*>/i, "").replace(/<\/body>[\s\S]*$/i, "");
        $("alertPreview").innerHTML = `<div class="sub" style="margin-bottom:6px">Subject: <b style="color:var(--text)">${esc(r.subject)}</b></div><div style="border:1px solid var(--hairline);border-radius:14px;overflow:auto;max-height:560px;color-scheme:light">${body}</div>`;
      }
    } catch (e) {
      setup.innerHTML = '<div class="msg err show">' + esc(e.message) + "</div>";
    }
  }

  async function sendNow() {
    const btn = $("btnAlertSend");
    btn.disabled = true;
    try {
      const r = await XanaSupabase.sendAlertNow();
      msg($("alertMsg"), "ok", "Sent to " + r.mail.recipients.join(", "));
    } catch (e) {
      msg($("alertMsg"), "err", e.message);
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- wiring ----------
  function bindOnce() {
    if (bound) return;
    bound = true;
    $("peopleSearch").addEventListener("input", renderPeople);
    $("peopleFilter").addEventListener("change", renderPeople);
    $("btnPeopleAdd").addEventListener("click", addPersonDialog);
    $("btnPeopleSync").addEventListener("click", syncM365);
    $("btnAlertPreview").addEventListener("click", () => loadAlerts(true));
    $("btnAlertSend").addEventListener("click", sendNow);

    $("peopleList").addEventListener("change", async (e) => {
      const inp = e.target.closest(".p-email");
      if (!inp) return;
      const id = inp.closest("tr").dataset.id;
      const p = people.find((x) => x.id === id);
      const email = inp.value.trim().toLowerCase() || null;
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { toast("That email doesn't look right", true); inp.value = p.email || ""; return; }
      try {
        await XanaSupabase.updatePerson(id, { email });
        p.email = email;
        toast(email ? "Email saved" : "Email removed", false);
      } catch (err) {
        toast(err.message, true);
        inp.value = p.email || "";
      }
    });

    $("peopleList").addEventListener("click", async (e) => {
      const t = e.target.closest("[data-toggle]");
      if (t) {
        const p = people.find((x) => x.id === t.dataset.toggle);
        try {
          await XanaSupabase.updatePerson(p.id, { active: !p.active });
          p.active = !p.active;
          renderPeople();
        } catch (err) { toast(err.message, true); }
        return;
      }
      const d = e.target.closest("[data-del]");
      if (d) {
        showDialog({
          title: "Remove from people",
          body: "Remove <b>" + esc(d.dataset.name) + "</b> from the people list? Assets still named after them keep that name.",
          confirmText: "Remove", danger: true,
          onConfirm: async () => { await XanaSupabase.deletePerson(d.dataset.del); await loadPeople(); return { message: "Removed" }; },
        });
      }
    });
  }

  window.XanaPeopleAdmin = { loadPeople, loadAlerts };
})();
