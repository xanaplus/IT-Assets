// Turns raw query results into the input buildDigest() expects.
// Pure (no I/O) so the rules are unit-tested: scanner-app/test/digest.test.js
const DAY = 86400000;

const PENDING_FLAG_DAYS = 3;     // IT hears about an unconfirmed hand-over after this
const REMINDER_DAYS = [2, 5];    // employee reminders: email #2 on day 2, #3 on day 5
const WARRANTY_AHEAD_DAYS = 60;
const UNSEEN_DAYS = 90;
const ISSUE_OLD_DAYS = 7;

const tagOf = (a) => (a && (a.asset_tag || a.title)) || "";
const openTags = (c) => (c.asset_assignments || []).filter((o) => !o.checked_in_at).map((o) => tagOf(o.assets)).filter(Boolean).sort();

function warrantyExpiry(extra) {
  const months = parseFloat(extra && extra.warranty_months);
  const bought = extra && extra.purchase_date ? new Date(String(extra.purchase_date).slice(0, 10) + "T00:00:00Z") : null;
  if (!(months > 0) || !bought || isNaN(bought)) return null;
  const d = new Date(bought);
  d.setUTCMonth(d.getUTCMonth() + Math.round(months));
  return d;
}

// raw = {checkouts, overdue, people, assets, issues, returns, history, syncFailed}
function shapeDigest(raw, now = new Date()) {
  const t = now.getTime();
  const assets = (raw.assets || []).filter((a) => !a.deleted_at);
  const tagById = new Map(assets.map((a) => [a.item_id, tagOf(a)]));

  const pending = [], disputed = [];
  for (const c of raw.checkouts || []) {
    const tags = openTags(c);
    if (!tags.length) continue;                                  // all returned: nothing to chase
    if (c.accept_status === "disputed") disputed.push({ person_name: c.person_name, dispute_note: c.dispute_note, tags });
    else if (c.accept_status === "pending" && t - new Date(c.created_at).getTime() >= PENDING_FLAG_DAYS * DAY)
      pending.push({ person_name: c.person_name, created_at: c.created_at, tags });
  }

  const today = now.toISOString().slice(0, 10);
  const overdue = (raw.overdue || [])
    .filter((o) => !o.checked_in_at && o.due_back && o.due_back < today)
    .map((o) => ({ tag: tagOf(o.assets), person_name: o.person_name, due_back: o.due_back }))
    .sort((a, b) => a.due_back.localeCompare(b.due_back));

  // Leavers: disabled in Microsoft 365 but still named on an asset.
  const gone = new Set((raw.people || []).filter((p) => p.active === false).map((p) => String(p.full_name).trim().toLowerCase()));
  const leaverMap = new Map();
  for (const a of assets) {
    const k = String(a.employee || "").trim().toLowerCase();
    if (!k || !gone.has(k)) continue;
    if (!leaverMap.has(k)) leaverMap.set(k, { person_name: a.employee.trim(), tags: [] });
    leaverMap.get(k).tags.push(tagOf(a));
  }
  const leavers = [...leaverMap.values()].map((l) => ({ ...l, tags: l.tags.sort() }));

  const warranty = [];
  for (const a of assets) {
    if (a.status === "Retired" || a.status === "Lost") continue;
    const exp = warrantyExpiry(a.extra || {});
    if (!exp) continue;
    const days = (exp.getTime() - t) / DAY;
    if (days >= 0 && days <= WARRANTY_AHEAD_DAYS) warranty.push({ tag: tagOf(a), model: a.model, expiry: exp.toISOString().slice(0, 10) });
  }
  warranty.sort((a, b) => a.expiry.localeCompare(b.expiry));

  const unseenRows = [];
  for (const a of assets) {
    if (a.status === "Retired" || a.status === "Lost") continue;
    const lv = a.extra && a.extra.last_verified ? new Date(a.extra.last_verified) : null;
    if (!lv || isNaN(lv) || t - lv.getTime() > UNSEEN_DAYS * DAY) unseenRows.push({ tag: tagOf(a), location: a.location || "", last: lv && !isNaN(lv) ? lv.toISOString() : null });
  }
  const byLoc = new Map();
  for (const u of unseenRows) byLoc.set(u.location, (byLoc.get(u.location) || 0) + 1);
  const unseen = {
    total: unseenRows.length,
    byLocation: [...byLoc].map(([location, count]) => ({ location, count })).sort((a, b) => b.count - a.count),
    // the ten that have gone longest: never-verified first, then oldest
    oldest: unseenRows.sort((a, b) => (a.last || "").localeCompare(b.last || "")).slice(0, 10),
  };

  const issues = (raw.issues || [])
    .filter((e) => e.event_type === "issue" && !e.resolved && t - new Date(e.event_date).getTime() >= ISSUE_OLD_DAYS * DAY)
    .map((e) => ({ tag: tagById.get(e.item_id) || e.item_id, description: e.description, event_date: e.event_date }));

  const since = t - DAY;
  const returns = (raw.returns || [])
    .filter((r) => r.checked_in_at && new Date(r.checked_in_at).getTime() >= since)
    .filter((r) => String(r.condition_in || "").toLowerCase() === "damaged" || (r.accessories_missing || []).length)
    .map((r) => ({ tag: tagOf(r.assets), person_name: r.person_name, condition_in: r.condition_in, missing: r.accessories_missing || [] }));

  const lost = (raw.history || [])
    .filter((h) => h.new_row && h.new_row.status === "Lost" && (!h.old_row || h.old_row.status !== "Lost") && new Date(h.changed_at).getTime() >= since)
    .map((h) => ({ tag: tagOf(h.new_row) || tagById.get(h.item_id) || h.item_id, employee: (h.old_row && h.old_row.employee) || h.new_row.employee || "" }));

  return { pending, disputed, overdue, leavers, warranty, unseen, issues, returns, lost, syncFailed: raw.syncFailed || 0 };
}

// Which pending check-outs get a reminder today. Only check-outs whose first
// email actually went out are chased; at most two reminders each.
function remindersDue(checkouts, now = new Date()) {
  const t = now.getTime();
  return (checkouts || []).filter((c) => {
    if (c.accept_status !== "pending" || !c.email || !openTags(c).length) return false;
    const sent = c.emails_sent || 0;
    if (sent < 1 || sent > REMINDER_DAYS.length) return false;
    const ageDays = (t - new Date(c.created_at).getTime()) / DAY;
    const lastDays = c.last_email_at ? (t - new Date(c.last_email_at).getTime()) / DAY : Infinity;
    return ageDays >= REMINDER_DAYS[sent - 1] && lastDays >= 0.9;   // never two in one day
  });
}

module.exports = { shapeDigest, remindersDue, warrantyExpiry, PENDING_FLAG_DAYS, REMINDER_DAYS };
