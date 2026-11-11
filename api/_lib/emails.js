// Email bodies for check-out acceptance and the daily IT alert.
// Pure functions: data in, {subject, html} out. Tested in scanner-app/test.

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const DAY = 86400000;
const fmtDate = (d) => {
  const x = d instanceof Date ? d : new Date(String(d).length === 10 ? d + "T00:00:00Z" : d);
  return isNaN(x) ? "" : x.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Africa/Nairobi" });
};
const daysBetween = (a, b) => Math.floor((b - a) / DAY);

function shell(title, inner) {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f8fafc;font-family:Segoe UI,Arial,sans-serif;color:#0f172a">
<div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;padding:24px">
<h1 style="font-size:18px;margin:0 0 16px">${esc(title)}</h1>
${inner}
<p style="font-size:12px;color:#64748b;margin:24px 0 0">Xana IT asset register</p>
</div></body></html>`;
}

function assetList(assets) {
  return `<table style="width:100%;border-collapse:collapse;font-size:14px;margin:8px 0 16px">${assets
    .map((a) => {
      const extra = (a.accessories || []).length ? ` <span style="color:#64748b">with ${esc(a.accessories.join(", "))}</span>` : "";
      const due = a.due_back ? `<br><span style="color:#b45309;font-size:12px">Return by ${esc(fmtDate(a.due_back))}</span>` : "";
      return `<tr><td style="padding:8px 0;border-bottom:1px solid #e2e8f0"><b>${esc(a.tag)}</b> — ${esc([a.type, a.model].filter(Boolean).join(" "))}${extra}<br><span style="color:#64748b;font-size:12px">Serial ${esc(a.serial || "—")}</span>${due}</td></tr>`;
    })
    .join("")}</table>`;
}

const button = (href, label) =>
  `<a href="${esc(href)}" style="display:inline-block;background:#047857;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:10px">${esc(label)}</a>`;

// First send and reminders share one template.
function acceptanceEmail({ personName, assets, link, reminder }) {
  const first = String(personName || "").split(/\s+/)[0] || "there";
  const subject = (reminder ? "Reminder: " : "") + "Please confirm your IT equipment";
  const html = shell(
    "Please confirm your IT equipment",
    `<p style="font-size:14px;line-height:1.5">Hi ${esc(first)}, IT has given you:</p>
${assetList(assets)}
<p style="margin:0 0 16px">${button(link, "Confirm or report a problem")}</p>
<p style="font-size:12px;color:#64748b;line-height:1.5">The link works for 14 days. If something here is wrong, open it and tell IT.</p>`
  );
  return { subject, html };
}

function disputeEmail({ personName, note, assets, appUrl }) {
  return {
    subject: `Hand-over disputed by ${personName}`,
    html: shell(
      "Hand-over disputed",
      `<p style="font-size:14px"><b>${esc(personName)}</b> says something is wrong:</p>
<blockquote style="margin:0 0 12px;padding:10px 14px;background:#fef2f2;border-radius:8px;color:#991b1b">${esc(note)}</blockquote>
${assetList(assets)}
<p>${button(appUrl + "/assets?id=" + encodeURIComponent((assets[0] || {}).tag || ""), "Open in the register")}</p>`
    ),
  };
}

// ---------- Daily IT alert ----------
// data = {
//   pending:   [{person_name, created_at, tags[]}]        not confirmed for 3+ days
//   disputed:  [{person_name, dispute_note, tags[]}]
//   overdue:   [{tag, person_name, due_back}]
//   leavers:   [{person_name, tags[]}]                     left in M365, still holding kit
//   warranty:  [{tag, model, expiry}]                      expiring within 60 days
//   unseen:    {total, byLocation:[{location,count}], oldest:[{tag, location, last}]}
//   issues:    [{tag, description, event_date}]            open 7+ days
//   returns:   [{tag, person_name, condition_in, missing[]}] flagged at check-in since yesterday
//   lost:      [{tag, employee}]                           marked Lost since yesterday
//   syncFailed: number
// }
function buildDigest(data, now = new Date(), appUrl = "") {
  const sections = [];
  const link = (tag) => (appUrl ? `<a href="${esc(appUrl + "/assets?id=" + encodeURIComponent(tag))}" style="color:#047857;font-weight:600;text-decoration:none">${esc(tag)}</a>` : `<b>${esc(tag)}</b>`);
  const tags = (arr) => (arr || []).map(link).join(", ");
  const add = (title, rows) => { if (rows.length) sections.push({ title, rows }); };

  add("Disputed hand-overs", (data.disputed || []).map((d) => `${tags(d.tags)} → ${esc(d.person_name)}: “${esc(d.dispute_note)}”`));
  add("Leavers still holding assets", (data.leavers || []).map((l) => `${esc(l.person_name)}: ${tags(l.tags)}`));
  add("Overdue returns", (data.overdue || []).map((o) => `${link(o.tag)} → ${esc(o.person_name)}, due ${esc(fmtDate(o.due_back))} (${daysBetween(new Date(o.due_back + "T00:00:00Z"), now)} days late)`));
  add("Marked Lost since yesterday", (data.lost || []).map((l) => `${link(l.tag)}${l.employee ? " — last with " + esc(l.employee) : ""}`));
  add("Returned damaged or incomplete", (data.returns || []).map((r) => {
    const bits = [];
    if (String(r.condition_in || "").toLowerCase() === "damaged") bits.push("damaged");
    if ((r.missing || []).length) bits.push("missing " + r.missing.join(", "));
    return `${link(r.tag)} from ${esc(r.person_name)}: ${esc(bits.join("; "))}`;
  }));
  add("Waiting for acceptance", (data.pending || []).map((p) => `${tags(p.tags)} → ${esc(p.person_name)}, ${daysBetween(new Date(p.created_at), now)} days`));
  add("Warranty expiring in the next 60 days", (data.warranty || []).map((w) => `${link(w.tag)} ${esc(w.model || "")} — ${esc(fmtDate(w.expiry))}`));
  add("Open issues older than 7 days", (data.issues || []).map((i) => `${link(i.tag)}: ${esc(i.description)} (${daysBetween(new Date(i.event_date), now)} days)`));
  const u = data.unseen || { total: 0 };
  if (u.total) {
    const rows = [`<b>${u.total}</b> asset${u.total === 1 ? "" : "s"} not verified in 90 days: ` + (u.byLocation || []).map((b) => `${esc(b.location || "No location")} ${b.count}`).join(" · ")];
    for (const o of u.oldest || []) rows.push(`${link(o.tag)} ${esc(o.location || "")} — ${o.last ? "last seen " + esc(fmtDate(o.last)) : "never verified"}`);
    sections.push({ title: "Not seen in 90 days", rows });
  }
  if (data.syncFailed) add("SharePoint mirror", [`${data.syncFailed} row${data.syncFailed === 1 ? "" : "s"} failed to sync. Requeue them in Admin.`]);

  const count = sections.length;
  const subject = count
    ? `IT assets: ${count} thing${count === 1 ? "" : "s"} need attention — ${fmtDate(now)}`
    : `IT assets: nothing needs attention — ${fmtDate(now)}`;
  const inner = count
    ? sections.map((s) => `<h2 style="font-size:14px;margin:18px 0 6px;color:#0f172a">${esc(s.title)}</h2><ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.6">${s.rows.map((r) => `<li>${r}</li>`).join("")}</ul>`).join("")
    : `<p style="font-size:14px">Nothing needs attention today.</p>`;
  return { subject, html: shell("Daily IT asset alert", inner), sections, count };
}

module.exports = { acceptanceEmail, disputeEmail, buildDigest, esc, fmtDate };
