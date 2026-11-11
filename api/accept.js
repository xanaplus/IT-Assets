// Vercel serverless function — the employee's side of a check-out.
// Public: the emailed token is the only credential, so it is checked by hash
// and the response carries nothing beyond what the email already showed.
//   GET  /api/accept?t=<token>                       -> the hand-over to confirm
//   POST /api/accept {t, accept: true|false, name, note?}
// A dispute emails ALERT_TO straight away.
const S = require("./_lib/server");
const { disputeEmail } = require("./_lib/emails");

// Best-effort brake on token guessing (24 random bytes make guessing hopeless
// anyway); per instance, not a security boundary.
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 500) hits.clear();
  return arr.length > 30;
}

const validToken = (t) => typeof t === "string" && /^[A-Za-z0-9_-]{20,64}$/.test(t);

async function load(token) {
  return S.rpc("checkout_by_token", { p_token_hash: S.hashToken(token) });
}

function publicView(c) {
  return {
    personName: c.person_name,
    status: c.accept_status,
    acceptedAt: c.accepted_at,
    expired: !!c.expired,
    assets: (c.assets || []).filter((a) => !a.returned).map((a) => ({
      tag: a.tag, type: a.type, model: a.model, serial: a.serial,
      accessories: a.accessories || [], dueBack: a.due_back, condition: a.condition,
    })),
  };
}

async function handler(req, res) {
  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();
  if (limited(ip)) return S.send(res, 429, { error: "Too many attempts. Try again in a minute." });

  try {
    if (req.method === "GET") {
      const t = req.query && req.query.t;
      if (!validToken(t)) return S.send(res, 404, { error: "This link is not valid." });
      const c = await load(t);
      if (!c) return S.send(res, 404, { error: "This link is not valid." });
      return S.send(res, 200, publicView(c));
    }

    if (req.method === "POST") {
      const b = await S.readBody(req);
      if (!validToken(b.t)) return S.send(res, 404, { error: "This link is not valid." });
      const accept = b.accept === true;
      const name = String(b.name || "").trim().slice(0, 120);
      const note = String(b.note || "").trim().slice(0, 1000);
      await S.rpc("respond_to_checkout", { p_token_hash: S.hashToken(b.t), p_accept: accept, p_name: name, p_note: note });
      const c = await load(b.t);

      if (!accept) {
        const to = S.alertRecipients();
        if (S.mailConfigured() && to.length) {
          try {
            const m = disputeEmail({ personName: c.person_name + (name && name.toLowerCase() !== String(c.person_name).toLowerCase() ? ` (signed as ${name})` : ""), note, assets: (c.assets || []).filter((a) => !a.returned), appUrl: S.appUrl() });
            await S.sendMail({ to, subject: m.subject, html: m.html });
          } catch (e) {
            console.error("[accept] dispute alert failed:", e.message);   // the dispute itself is saved
          }
        }
      }
      return S.send(res, 200, publicView(c));
    }

    return S.send(res, 405, { error: "Method not allowed" });
  } catch (e) {
    // respond_to_checkout raises plain-language messages (expired, already answered…)
    const msg = /expired|already answered|type your name|tell IT|not recognised/.test(e.message) ? e.message : "Something went wrong. Try again.";
    if (msg.startsWith("Something")) console.error("[accept]", e.message);
    return S.send(res, msg.startsWith("Something") ? 500 : 400, { error: msg.charAt(0).toUpperCase() + msg.slice(1) + (msg.endsWith(".") ? "" : ".") });
  }
}

module.exports = handler;
module.exports.maxDuration = 15;
