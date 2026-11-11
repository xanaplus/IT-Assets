// Vercel serverless function — the daily IT alert.
// GET  /api/alerts   Vercel Cron, Authorization: Bearer <CRON_SECRET>
//      1. pull staff from Microsoft 365 (leaver flags), if connected
//      2. remind employees who have not confirmed a hand-over (day 2, day 5)
//      3. email the digest to ALERT_TO, only when something needs attention
// POST /api/alerts   Authorization: Bearer <Supabase access token>, admins only
//      { action: "preview" }  -> the email as it would go out now; sends nothing
//      { action: "send" }     -> send the digest now (even when it is empty)
const S = require("./_lib/server");
const { buildDigest } = require("./_lib/emails");
const { shapeDigest, remindersDue } = require("./_lib/digest-data");
const { checkoutWithAssets, sendAcceptance } = require("./_lib/checkouts");

const CO_SELECT = "id,person_name,email,accept_status,dispute_note,created_at,emails_sent,last_email_at,asset_assignments(checked_in_at,assets(asset_tag,title))";

async function gather(now) {
  const dayAgo = new Date(now.getTime() - 86400000).toISOString();
  const [checkouts, overdue, people, assets, issues, returns, history, failed] = await Promise.all([
    S.sb("checkouts?select=" + CO_SELECT + "&accept_status=in.(pending,disputed)"),
    S.sb("asset_assignments?select=person_name,due_back,checked_in_at,assets(asset_tag,title)&checked_in_at=is.null&due_back=not.is.null"),
    S.sb("people?select=full_name,active&active=eq.false"),
    S.sb("assets?select=item_id,asset_tag,title,model,location,status,employee,deleted_at,extra&deleted_at=is.null"),
    S.sb("asset_events?select=item_id,event_type,description,event_date,resolved&event_type=eq.issue&resolved=eq.false"),
    S.sb("asset_assignments?select=person_name,condition_in,accessories_missing,checked_in_at,assets(asset_tag,title)&checked_in_at=gte." + encodeURIComponent(dayAgo)),
    S.sb("asset_history?select=item_id,changed_at,old_row,new_row&op=eq.UPDATE&changed_at=gte." + encodeURIComponent(dayAgo)),
    S.sb("sharepoint_sync?select=id&status=eq.failed"),
  ]);
  return { checkouts, raw: { checkouts, overdue, people, assets, issues, returns, history, syncFailed: (failed || []).length } };
}

async function runDaily({ now = new Date(), log = [] } = {}) {
  if (S.graphConfigured()) {
    try {
      const r = await S.syncPeople();
      log.push(`people: ${r.added} added, ${r.updated} updated, ${r.newly_left} newly left`);
    } catch (e) {
      log.push("people sync failed: " + e.message);   // the digest still goes out
    }
  }

  let { checkouts, raw } = await gather(now);

  let reminded = 0;
  if (S.mailConfigured()) {
    for (const c of remindersDue(checkouts, now)) {
      try {
        const full = await checkoutWithAssets(c.id);
        const r = await sendAcceptance(full, { reminder: true });
        if (r.sent) reminded++;
      } catch (e) {
        log.push(`reminder for ${c.person_name} failed: ${e.message}`);
      }
    }
    if (reminded) ({ checkouts, raw } = await gather(now));
  }
  log.push(`reminders sent: ${reminded}`);

  const digest = buildDigest(shapeDigest(raw, now), now, S.appUrl());
  const to = S.alertRecipients();
  if (!digest.count) log.push("digest: nothing to report, not sent");
  else if (!S.mailConfigured() || !to.length) log.push("digest: email not set up (MAIL_SENDER / ALERT_TO)");
  else {
    await S.sendMail({ to, subject: digest.subject, html: digest.html });
    log.push(`digest sent to ${to.length} recipient(s): ${digest.count} section(s)`);
  }
  return { log, count: digest.count };
}

async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const secret = process.env.CRON_SECRET;
      if (!secret || req.headers.authorization !== "Bearer " + secret) return S.send(res, 401, { error: "Unauthorized" });
      const out = await runDaily();
      console.log("[alerts]", out.log.join(" | "));
      return S.send(res, 200, out);
    }

    if (req.method === "POST") {
      const me = await S.caller(req);
      if (!S.isAdmin(me)) return S.send(res, 403, { error: "Admins only" });
      const body = await S.readBody(req);
      const now = new Date();
      const { raw } = await gather(now);
      const digest = buildDigest(shapeDigest(raw, now), now, S.appUrl());
      const mail = { configured: S.mailConfigured(), sender: process.env.MAIL_SENDER || null, recipients: S.alertRecipients(), directory: S.graphConfigured() };

      if (body.action === "preview") return S.send(res, 200, { subject: digest.subject, html: digest.html, count: digest.count, mail });
      if (body.action === "send") {
        if (!mail.configured || !mail.recipients.length) return S.send(res, 409, { error: "Email is not set up yet (MAIL_SENDER and ALERT_TO)", mail });
        await S.sendMail({ to: mail.recipients, subject: digest.subject, html: digest.html });
        return S.send(res, 200, { sent: true, count: digest.count, mail });
      }
      return S.send(res, 400, { error: "Unknown action" });
    }

    return S.send(res, 405, { error: "Method not allowed" });
  } catch (e) {
    console.error("[alerts]", e.message);
    return S.send(res, 500, { error: e.message });
  }
}

module.exports = handler;
module.exports.maxDuration = 60;
