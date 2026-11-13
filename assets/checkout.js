// Check-out / check-in for the register (/assets).
// Loaded after the page's inline script, so it uses the page's globals:
// allItems, showDetail, toast, esc, load, canWrite, openSheet, closeSheet,
// getChoices, view, renderPeople, copyText, fmtWhen.
"use strict";
(function () {
  const ACCESSORIES = ["Charger", "Bag", "Mouse", "Keyboard", "Headset", "Docking station"];
  const CONDITIONS = ["New", "Good", "Fair", "Damaged"];
  const NOT_ISSUABLE = new Set(["retired", "lost"]);

  let assignments = new Map();   // item_id -> open assignment (+ checkouts)
  let people = [];
  let coItems = [];              // assets on the open check-out sheet
  let ciItems = [];              // assets on the open check-in sheet

  const $ = (id) => document.getElementById(id);
  const key = (s) => String(s || "").trim().toLowerCase();
  const fmtDay = (d) => new Date(String(d).length === 10 ? d + "T00:00:00" : d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const today = () => new Date().toISOString().slice(0, 10);

  // ---------- styles + sheets (injected once) ----------
  const css = `
  .co-chips{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 8px}
  .co-chip{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;background:var(--card2);border:1px solid var(--hairline);font-size:.8rem;font-weight:600}
  .co-chip small{font-weight:400;color:var(--muted)}
  .co-chip button{border:0;background:none;color:var(--muted);cursor:pointer;font-size:.85rem;padding:0 0 0 2px;box-shadow:none}
  .co-checks{display:flex;flex-wrap:wrap;gap:6px}
  .co-checks label{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border:1px solid var(--border);border-radius:var(--radius-md);font-size:.8rem;cursor:pointer;background:var(--card)}
  .co-checks label:has(input:checked){border-color:var(--accent);color:var(--accent)}
  .sheet .co-checks input,.sheet .co-tick input{width:auto;margin:0;accent-color:var(--accent)}
  .sheet-panel > label.co-tick{display:flex;align-items:flex-start;gap:8px;font-size:.84rem;font-weight:500;color:var(--text);text-transform:none;letter-spacing:normal;margin-top:16px;cursor:pointer;line-height:1.4}
  .co-tick .co-hint{display:block;margin:2px 0 0;font-weight:400}
  #ciAccWrap > label{font-size:.7rem;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin:14px 0 5px;display:block}
  .co-row{display:flex;gap:6px}
  .co-row input{flex:1}
  .co-hint{font-size:.76rem;color:var(--muted);margin:-2px 0 6px;line-height:1.45}
  .co-hint.warn{color:var(--orange)}
  .co-new{display:none;margin-top:6px}
  .co-badge{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;font-size:.68rem;font-weight:700;white-space:nowrap}
  .co-badge svg{width:11px;height:11px}
  .co-badge.ok{background:color-mix(in oklch,var(--green) 14%,transparent);color:var(--green)}
  .co-badge.wait{background:color-mix(in oklch,var(--orange) 14%,transparent);color:var(--orange)}
  .co-badge.bad{background:color-mix(in oklch,var(--red) 14%,transparent);color:var(--red)}
  .co-badge.none{background:var(--card2);color:var(--muted)}
  .co-link{display:flex;gap:6px;margin-top:10px}
  .co-link input{flex:1;font-size:.76rem}
  .sheet-panel > textarea{width:100%;min-height:64px;padding:9px 12px;border-radius:var(--radius-lg);border:1px solid var(--input);background:var(--card);color:var(--text);font:inherit;font-size:.9rem;resize:vertical}
  [data-theme="dark"] .sheet-panel > textarea{background:color-mix(in oklch, var(--input) 30%, transparent)}
  `;

  const sheetsHtml = `
<div class="sheet" id="coSheet" role="dialog" aria-modal="true" aria-labelledby="coTitle">
  <div class="sheet-backdrop" data-close="co"></div>
  <div class="sheet-panel">
    <h2 id="coTitle">Check out <button type="button" class="theme-toggle" data-close="co" aria-label="Close">✕</button></h2>
    <label>Assets</label>
    <div class="co-chips" id="coChips"></div>
    <div class="co-row"><input type="text" id="coAddAsset" placeholder="Add another: tag or serial, or scan" list="coAssetList" autocomplete="off" /><button type="button" class="btn secondary" id="coAddAssetBtn">Add</button></div>
    <datalist id="coAssetList"></datalist>
    <label for="coPerson">To *</label>
    <input type="text" id="coPerson" placeholder="Start typing a name" list="coPeopleList" autocomplete="off" />
    <datalist id="coPeopleList"></datalist>
    <div class="co-hint" id="coPersonHint"></div>
    <div class="co-new" id="coNew">
      <input type="email" id="coNewEmail" placeholder="Their email (needed to confirm by email)" autocomplete="off" />
    </div>
    <label>Also giving</label>
    <div class="co-checks" id="coAcc"></div>
    <input type="text" id="coAccOther" placeholder="Anything else, comma separated" style="margin-top:6px" />
    <label for="coCondition">Condition</label>
    <select id="coCondition"></select>
    <label for="coDue">Return by</label>
    <input type="date" id="coDue" />
    <div class="co-hint">Leave blank if it's theirs to keep. Set a date for loans.</div>
    <label for="coNotes">Notes</label>
    <textarea id="coNotes" placeholder="Optional"></textarea>
    <label class="co-tick"><input type="checkbox" id="coAsk" checked /> <span>Ask them to confirm they received it<br><span class="co-hint" id="coAskHint"></span></span></label>
    <div id="coMsg"></div>
    <div class="form-actions"><button class="btn secondary" data-close="co">Cancel</button><button class="btn" id="coSave">Check out</button></div>
  </div>
</div>
<div class="sheet" id="ciSheet" role="dialog" aria-modal="true" aria-labelledby="ciTitle">
  <div class="sheet-backdrop" data-close="ci"></div>
  <div class="sheet-panel">
    <h2 id="ciTitle">Check in <button type="button" class="theme-toggle" data-close="ci" aria-label="Close">✕</button></h2>
    <div class="co-chips" id="ciChips"></div>
    <label for="ciCondition">Condition</label>
    <select id="ciCondition"></select>
    <div id="ciAccWrap"><label>Came back with</label><div class="co-checks" id="ciAcc"></div><div class="co-hint">Untick anything that wasn't returned. It's logged as an open issue.</div></div>
    <label class="co-tick"><input type="checkbox" id="ciWiped" /> <span>Wiped / reset for the next person</span></label>
    <label for="ciStatus">Status after</label>
    <select id="ciStatus"></select>
    <label for="ciNotes">Notes</label>
    <textarea id="ciNotes" placeholder="e.g. cracked screen corner"></textarea>
    <div id="ciMsg"></div>
    <div class="form-actions"><button class="btn secondary" data-close="ci">Cancel</button><button class="btn" id="ciSave">Check in</button></div>
  </div>
</div>`;

  function inject() {
    const st = document.createElement("style");
    st.textContent = css;
    document.head.appendChild(st);
    document.body.insertAdjacentHTML("beforeend", sheetsHtml);
    $("coCondition").innerHTML = CONDITIONS.map((c) => `<option${c === "Good" ? " selected" : ""}>${c}</option>`).join("");
    $("ciCondition").innerHTML = CONDITIONS.filter((c) => c !== "New").map((c) => `<option${c === "Good" ? " selected" : ""}>${c}</option>`).join("");
    $("coAcc").innerHTML = ACCESSORIES.map((a) => `<label><input type="checkbox" value="${esc(a)}" /> ${esc(a)}</label>`).join("");

    document.addEventListener("click", (e) => {
      const c = e.target.closest("[data-close]");
      if (!c) return;
      closeSheet($(c.dataset.close === "co" ? "coSheet" : "ciSheet"));
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || document.querySelector("dialog:modal")) return;
      for (const id of ["coSheet", "ciSheet"]) if ($(id).classList.contains("open")) closeSheet($(id));
    });

    $("coPerson").addEventListener("input", personChanged);
    $("coAddAssetBtn").addEventListener("click", addAssetFromInput);
    $("coAddAsset").addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      // Enter also confirms an IME composition; don't act on a half-typed value.
      if (e.isComposing || e.keyCode === 229) return;
      addAssetFromInput();
    });
    $("coChips").addEventListener("click", (e) => {
      const b = e.target.closest("[data-rm]");
      if (!b) return;
      coItems = coItems.filter((it) => String(it.id) !== b.dataset.rm);
      renderCoChips();
    });
    $("coSave").addEventListener("click", saveCheckout);
    $("ciSave").addEventListener("click", saveCheckin);
    $("ciCondition").addEventListener("change", () => {
      // damaged kit usually goes for repair rather than straight back to stock
      const st = $("ciStatus");
      if ($("ciCondition").value === "Damaged" && [...st.options].some((o) => o.value === "In Repair")) st.value = "In Repair";
      else if (st.value === "In Repair") st.value = "Available";
    });
  }

  // ---------- data ----------
  async function refresh() {
    try {
      const [a, p] = await Promise.all([XanaSupabase.listOpenAssignments(), XanaSupabase.listPeople()]);
      assignments = a;
      people = p;
    } catch (e) {
      console.warn("[checkout] could not load assignments", e);
    }
  }

  const assignmentOf = (it) => assignments.get(String(it.id)) || null;

  function findPerson(name) {
    const k = key(name);
    if (!k) return null;
    const hits = people.filter((p) => key(p.full_name) === k);
    return hits.find((p) => p.active && p.email) || hits.find((p) => p.active) || hits[0] || null;
  }

  // Can this asset go to this person? (mirrors the checks in checkout_assets)
  function issuable(it, personName) {
    if (assignmentOf(it)) return false;
    if (NOT_ISSUABLE.has(key(it.status))) return false;
    return !key(it.employee) || (personName && key(it.employee) === key(personName));
  }

  // ---------- the asset card ----------
  function acceptBadge(a) {
    const c = a.checkouts || {};
    if (c.accept_status === "accepted") return `<span class="co-badge ok" title="Confirmed ${esc(fmtWhen(c.accepted_at) || "")}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7"/></svg>Confirmed ${esc(fmtDay(c.accepted_at))}</span>`;
    if (c.accept_status === "disputed") return `<span class="co-badge bad" title="${esc(c.dispute_note || "")}">Disputed: ${esc((c.dispute_note || "").slice(0, 60))}</span>`;
    if (c.accept_status === "pending") {
      const why = c.email_error ? " (email failed, resend or copy the link)" : "";
      return `<span class="co-badge wait"${c.email_error ? ` title="${esc(c.email_error)}"` : ""}>Waiting for confirmation${esc(why)}</span>`;
    }
    return `<span class="co-badge none">No confirmation asked</span>`;
  }

  const initials = (name) => String(name || "").trim().split(/\s+/).slice(0, 2).map((w) => w[0] || "").join("").toUpperCase() || "?";

  // The strip under the card header: who holds the asset, since when, whether
  // they confirmed, and the hand-over actions beside that context.
  function holderHtml(it) {
    const a = assignmentOf(it);
    const holder = a ? a.person_name : (it.employee || "").trim();
    const w = canWrite();
    let acts = "";
    if (w) {
      if (a || holder) acts += '<button class="btn" id="ciBtn">Check in</button>';
      if (!a && !NOT_ISSUABLE.has(key(it.status))) acts += `<button class="btn${holder ? " secondary" : ""}" id="coBtn">${holder ? "Get confirmation" : "Check out"}</button>`;
      if (a && a.checkouts && a.checkouts.accept_status !== "accepted") acts += `<button class="btn secondary" id="coLinkBtn">${a.checkouts.accept_status === "not_required" ? "Ask to confirm" : "Resend link"}</button>`;
    }
    let who, meta = [];
    if (a) {
      who = esc(a.person_name);
      meta.push("Since " + esc(fmtDay(a.checked_out_at)));
      if ((a.accessories_out || []).length) meta.push("with " + esc(a.accessories_out.join(", ")));
      if (a.due_back) {
        const late = a.due_back < today();
        meta.push(`<span class="${late ? "late" : ""}">${late ? "Overdue, was due " : "Due back "}${esc(fmtDay(a.due_back))}</span>`);
      }
      meta.push(acceptBadge(a));
    } else if (holder) {
      who = esc(holder);
      meta.push("No hand-over record");
    } else {
      who = NOT_ISSUABLE.has(key(it.status)) ? esc(it.status) : "Not assigned";
      meta.push(NOT_ISSUABLE.has(key(it.status)) ? "Can't be checked out" : "In stock");
    }
    const av = a || holder ? `<span class="av" aria-hidden="true">${esc(initials(holder))}</span>` : '<span class="av empty" aria-hidden="true">—</span>';
    return `<div class="holder">${av}<div class="who"><b>${who}</b><div class="meta">${meta.map((m) => `<span>${m}</span>`).join("")}</div></div>${acts ? `<div class="acts">${acts}</div>` : ""}</div>`;
  }

  function bind(it) {
    $("coBtn")?.addEventListener("click", () => openCheckout([it], key(it.employee) ? it.employee : ""));
    $("ciBtn")?.addEventListener("click", () => openCheckin([it]));
    $("coLinkBtn")?.addEventListener("click", async function () {
      const a = assignmentOf(it);
      this.disabled = true;
      this.textContent = "Sending…";
      try {
        const person = people.find((p) => p.id === a.person_id);
        const r = await XanaSupabase.sendAcceptance(a.checkout_id, { email: !!(person && person.email) });
        await afterChange();
        showLinkResult(r, a.person_name);
      } catch (e) {
        toast(e.message, true);
        this.disabled = false;
        this.textContent = "Resend link";
      }
    });
  }

  // ---------- check-out sheet ----------
  function renderCoChips() {
    $("coChips").innerHTML = coItems.map((it) =>
      `<span class="co-chip">${esc(it.tag || "#" + it.id)} <small>${esc(it.model || it.type || "")}</small>${coItems.length > 1 ? `<button type="button" data-rm="${esc(String(it.id))}" aria-label="Remove ${esc(it.tag || "")}">✕</button>` : ""}</span>`).join("");
    const name = $("coPerson").value;
    const inList = new Set(coItems.map((it) => String(it.id)));
    $("coAssetList").innerHTML = allItems
      .filter((it) => !inList.has(String(it.id)) && issuable(it, name) && it.tag)
      .slice(0, 400)
      .map((it) => `<option value="${esc(it.tag)}">${esc([it.type, it.model].filter(Boolean).join(" "))}</option>`).join("");
    $("coSave").textContent = coItems.length > 1 ? `Check out ${coItems.length} assets` : "Check out";
  }

  function addAssetFromInput() {
    const inp = $("coAddAsset");
    const q = key(inp.value);
    if (!q) return;
    const it = allItems.find((x) => key(x.tag) === q) || allItems.find((x) => key(x.serial) === q);
    if (!it) { toast("No asset with tag or serial " + inp.value.trim(), true); return; }
    if (coItems.some((x) => String(x.id) === String(it.id))) { inp.value = ""; return; }
    if (!issuable(it, $("coPerson").value)) {
      const a = assignmentOf(it);
      toast(`${it.tag} is ${a ? "checked out to " + a.person_name : it.employee ? "assigned to " + it.employee : "marked " + it.status} — check it in first`, true);
      return;
    }
    coItems.push(it);
    inp.value = "";
    renderCoChips();
  }

  function personChanged() {
    const name = $("coPerson").value.trim();
    const p = findPerson(name);
    const hint = $("coPersonHint");
    const isNew = !!name && !p;
    $("coNew").style.display = isNew ? "block" : "none";
    hint.className = "co-hint";
    if (!name) hint.textContent = "";
    else if (isNew) hint.textContent = "Not in the people list yet. They'll be added.";
    else if (!p.active) { hint.className = "co-hint warn"; hint.textContent = p.full_name + " has left (disabled in Microsoft 365). Assets can't be checked out to them."; }
    else hint.textContent = [p.email || "no email address", p.department, p.office].filter(Boolean).join(" · ");
    updateAskHint();
    renderCoChips();
  }

  function updateAskHint() {
    const p = findPerson($("coPerson").value);
    const email = p ? p.email : $("coNewEmail").value.trim();
    $("coAskHint").textContent = email
      ? "They get an email with a link to confirm. You can also copy the link."
      : "No email address, so you'll get a link to send them yourself (e.g. on WhatsApp).";
  }

  async function openCheckout(items, presetName) {
    if (!canWrite()) return;
    coItems = items.slice();
    for (const id of ["coPerson", "coNewEmail", "coAccOther", "coDue", "coNotes", "coAddAsset"]) $(id).value = "";
    $("coDue").min = today();
    $("coCondition").value = "Good";
    $("coAsk").checked = true;
    $("coMsg").innerHTML = "";
    $("coAcc").querySelectorAll("input").forEach((c) => (c.checked = false));
    $("coPeopleList").innerHTML = people.filter((p) => p.active)
      .map((p) => `<option value="${esc(p.full_name)}">${esc([p.email, p.department].filter(Boolean).join(" · ") || "no email")}</option>`).join("");
    if (presetName) $("coPerson").value = presetName;
    $("coNewEmail").oninput = updateAskHint;
    $("coTitle").firstChild.textContent = presetName ? "Get confirmation " : "Check out ";
    personChanged();
    openSheet($("coSheet"), presetName ? $("coSave") : $("coPerson"));
  }

  async function saveCheckout() {
    const btn = $("coSave");
    const msg = $("coMsg");
    msg.innerHTML = "";
    const name = $("coPerson").value.trim();
    if (!name) { flash(msg, "err", "Who is it going to?"); $("coPerson").focus(); return; }
    if (!coItems.length) { flash(msg, "err", "Add at least one asset"); return; }
    const accessories = [...$("coAcc").querySelectorAll("input:checked")].map((c) => c.value)
      .concat($("coAccOther").value.split(",").map((s) => s.trim()).filter(Boolean));
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      let p = findPerson(name);
      if (!p) {
        p = await XanaSupabase.addPerson({ fullName: name, email: $("coNewEmail").value });
        people.push(p);
      }
      if (!p.active) throw new Error(p.full_name + " has left and can't be given assets");
      const ask = $("coAsk").checked;
      const r = await XanaSupabase.checkoutAssets({
        personId: p.id,
        itemIds: coItems.map((it) => it.id),
        condition: $("coCondition").value,
        accessories,
        dueBack: $("coDue").value || null,
        notes: $("coNotes").value,
        requestAcceptance: ask,
      });
      let link = null;
      if (ask) {
        try { link = await XanaSupabase.sendAcceptance(r.checkout_id, { email: !!p.email }); }
        catch (e) { link = { sent: false, reason: e.message }; }
      }
      closeSheet($("coSheet"));
      const first = coItems[0];
      await afterChange(first);
      if (link) showLinkResult(link, p.full_name);
      else toast(`Checked out ${coItems.length} asset${coItems.length === 1 ? "" : "s"} to ${p.full_name}`, false);
    } catch (e) {
      flash(msg, "err", e.message);
    } finally {
      btn.disabled = false;
      renderCoChips();
    }
  }

  // After a send: emailed -> toast; otherwise show the link to copy.
  function showLinkResult(r, name) {
    if (r.sent) { toast("Confirmation email sent to " + (r.email || name), false); return; }
    if (!r.link) { toast("Checked out. Couldn't make a confirmation link: " + (r.reason || "unknown error"), true); return; }
    const why = r.reason === "email is not set up yet" ? "Email isn't set up yet, so send " + esc(name) + " this link yourself."
      : r.reason === "link only" || /no email address/.test(r.reason || "") ? "Send " + esc(name) + " this link (WhatsApp, Teams or SMS)."
      : "The email didn't go (" + esc(r.reason || "") + "). Send " + esc(name) + " this link instead.";
    showConfirm("Confirmation link",
      why + '<div class="co-link"><input type="text" id="coLinkOut" readonly value="' + esc(r.link) + '" /></div><div class="co-hint" style="margin-top:6px">Works for 14 days.</div>',
      "Copy link", "var(--accent)", async () => { await copyText(r.link, "Link copied"); });
    setTimeout(() => $("coLinkOut")?.select(), 200);
  }

  // ---------- check-in sheet ----------
  async function openCheckin(items) {
    if (!canWrite()) return;
    ciItems = items.slice();
    const holders = [...new Set(ciItems.map((it) => (assignmentOf(it) || {}).person_name || it.employee).filter(Boolean))];
    $("ciTitle").firstChild.textContent = (ciItems.length > 1 ? `Check in ${ciItems.length} assets` : "Check in") + (holders.length === 1 ? " from " + holders[0] + " " : " ");
    $("ciChips").innerHTML = ciItems.map((it) => `<span class="co-chip">${esc(it.tag || "#" + it.id)} <small>${esc(it.model || it.type || "")}</small></span>`).join("");
    const acc = [...new Set(ciItems.flatMap((it) => (assignmentOf(it) || {}).accessories_out || []))];
    $("ciAccWrap").style.display = acc.length ? "" : "none";
    $("ciAcc").innerHTML = acc.map((a) => `<label><input type="checkbox" value="${esc(a)}" checked /> ${esc(a)}</label>`).join("");
    const ch = await getChoices();
    const statuses = ch.status.filter((s) => !["In Use", "Left With"].includes(s));
    $("ciStatus").innerHTML = statuses.map((s) => `<option${s === "Available" ? " selected" : ""}>${esc(s)}</option>`).join("");
    $("ciCondition").value = "Good";
    $("ciWiped").checked = false;
    $("ciNotes").value = "";
    $("ciMsg").innerHTML = "";
    $("ciSave").textContent = ciItems.length > 1 ? `Check in ${ciItems.length} assets` : "Check in";
    openSheet($("ciSheet"), $("ciCondition"));
  }

  async function saveCheckin() {
    const btn = $("ciSave");
    const msg = $("ciMsg");
    msg.innerHTML = "";
    if ($("ciCondition").value === "Damaged" && !$("ciNotes").value.trim()) { flash(msg, "err", "Say what's damaged"); $("ciNotes").focus(); return; }
    const hasAcc = $("ciAccWrap").style.display !== "none";
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      const res = await XanaSupabase.checkinAssets({
        itemIds: ciItems.map((it) => it.id),
        condition: $("ciCondition").value,
        returned: hasAcc ? [...$("ciAcc").querySelectorAll("input:checked")].map((c) => c.value) : null,
        wiped: $("ciWiped").checked,
        notes: $("ciNotes").value,
        status: $("ciStatus").value,
      });
      closeSheet($("ciSheet"));
      const flagged = res.filter((r) => r.damaged || (r.missing || []).length);
      await afterChange(ciItems.length === 1 ? ciItems[0] : null);
      toast(`Checked in ${res.length} asset${res.length === 1 ? "" : "s"}` + (flagged.length ? ` · ${flagged.length} logged as an issue` : ""), false);
    } catch (e) {
      flash(msg, "err", e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = ciItems.length > 1 ? `Check in ${ciItems.length} assets` : "Check in";
    }
  }

  // Reload the register and re-open the card that was showing.
  async function afterChange(focusItem) {
    const openId = focusItem ? String(focusItem.id) : document.querySelector("#assetCard") ? (coItems[0] || ciItems[0] || {}).id : null;
    await load();
    if (typeof view !== "undefined" && view === "people") renderPeople();
    if (openId != null) {
      const fresh = allItems.find((x) => String(x.id) === String(openId));
      if (fresh) showDetail(fresh);
    }
  }

  // People view: one badge per asset row.
  function peopleBadge(it) {
    const a = assignmentOf(it);
    return a ? acceptBadge(a) : "";
  }

  inject();
  window.XanaCheckout = { refresh, holderHtml, bind, openCheckout, openCheckin, peopleBadge, assignmentOf };
})();
