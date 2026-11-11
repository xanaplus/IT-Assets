// Check-out lookups and acceptance sending, shared by api/checkout.js
// (first send, re-send) and api/alerts.js (reminders).
const S = require("./server");
const { acceptanceEmail } = require("./emails");

async function checkoutWithAssets(id) {
  const rows = await S.sb(
    "checkouts?select=id,person_id,person_name,email,accept_status,emails_sent," +
      "asset_assignments(item_id,accessories_out,due_back,checked_in_at,assets(asset_tag,asset_type,model,serial))" +
      "&id=eq." + encodeURIComponent(id)
  );
  const c = rows && rows[0];
  if (!c) return null;
  c.assets = (c.asset_assignments || [])
    .filter((o) => !o.checked_in_at)
    .map((o) => ({
      tag: o.assets && o.assets.asset_tag, type: o.assets && o.assets.asset_type,
      model: o.assets && o.assets.model, serial: o.assets && o.assets.serial,
      accessories: o.accessories_out || [], due_back: o.due_back,
    }));
  return c;
}

async function sendAcceptance(c, { reminder = false, email = true } = {}) {
  const { link } = await S.issueToken(c.id);
  let sent = false, reason = "";
  if (!email) reason = "link only";
  else if (!c.email) reason = "no email address for " + c.person_name;
  else if (!S.mailConfigured()) reason = "email is not set up yet";
  else {
    try {
      const m = acceptanceEmail({ personName: c.person_name, assets: c.assets, link, reminder });
      await S.sendMail({ to: c.email, subject: m.subject, html: m.html });
      sent = true;
    } catch (e) {
      reason = e.message;
    }
  }
  const patch = sent
    ? { emails_sent: (c.emails_sent || 0) + 1, last_email_at: new Date().toISOString(), email_error: null }
    // only a real send attempt that failed is an error; "email not set up" and
    // "no address" just mean IT shares the link by hand
    : email && c.email && S.mailConfigured() ? { email_error: reason.slice(0, 300) } : null;
  if (patch) await S.sb("checkouts?id=eq." + c.id, { method: "PATCH", body: JSON.stringify(patch) });
  return { sent, link, email: c.email || null, reason };
}

module.exports = { checkoutWithAssets, sendAcceptance };
