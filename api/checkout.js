// Vercel serverless function — acceptance links for check-outs, and the
// Microsoft 365 people sync button.
// POST /api/checkout   Authorization: Bearer <Supabase access token>
//   { action: "send", checkoutId, email?: true }
//        Issues a fresh acceptance link. Emails it to the person when email is
//        set up and email !== false; always returns the link so IT can copy it
//        (e.g. into WhatsApp) when there is no mailbox or email is not set up.
//        A disputed check-out goes back to "waiting" when it is re-sent.
//   { action: "sync_people" }   admin only: pull staff from Microsoft 365
const S = require("./_lib/server");
const { checkoutWithAssets, sendAcceptance } = require("./_lib/checkouts");

async function handler(req, res) {
  if (req.method !== "POST") return S.send(res, 405, { error: "POST only" });
  const me = await S.caller(req);
  if (!me) return S.send(res, 401, { error: "Sign in again" });
  const body = await S.readBody(req);

  try {
    if (body.action === "sync_people") {
      if (!S.isAdmin(me)) return S.send(res, 403, { error: "Admins only" });
      return S.send(res, 200, await S.syncPeople());
    }

    if (body.action === "send") {
      if (!S.isWriter(me)) return S.send(res, 403, { error: "Not permitted" });
      const id = String(body.checkoutId || "");
      if (!/^[0-9a-f-]{36}$/i.test(id)) return S.send(res, 400, { error: "checkoutId required" });
      let c = await checkoutWithAssets(id);
      if (!c) return S.send(res, 404, { error: "Check-out not found" });
      if (!c.assets.length) return S.send(res, 409, { error: "Everything on this check-out has been returned" });
      if (c.accept_status === "accepted") return S.send(res, 409, { error: "Already confirmed" });

      // The person may have gained an email since the hand-over.
      const person = (await S.sb("people?select=email&id=eq." + c.person_id))[0] || {};
      const patch = {};
      if (person.email && person.email !== c.email) patch.email = person.email;
      if (c.accept_status === "not_required" && (person.email || body.email === false)) patch.accept_status = "pending";
      if (c.accept_status === "disputed") await S.rpc("reopen_checkout", { p_checkout_id: id });
      if (Object.keys(patch).length) await S.sb("checkouts?id=eq." + id, { method: "PATCH", body: JSON.stringify(patch) });
      c = { ...c, ...patch };

      return S.send(res, 200, await sendAcceptance(c, { email: body.email !== false }));
    }

    return S.send(res, 400, { error: "Unknown action" });
  } catch (e) {
    console.error("[checkout]", body.action, e.message);
    return S.send(res, e.status && e.status < 500 ? e.status : 500, { error: e.message });
  }
}

module.exports = handler;
module.exports.maxDuration = 30;
