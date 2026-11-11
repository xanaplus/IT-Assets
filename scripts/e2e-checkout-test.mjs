// End-to-end test of check-out / acceptance / check-in / alerts against the
// LOCAL stack only (npm run db:start + npm run dev). Refuses any other target.
//
//   node scripts/e2e-checkout-test.mjs
//
// Leaves the asset it borrows exactly as it found it.
import fs from "node:fs";

const env = Object.fromEntries(
  fs.readFileSync(".env.development.local", "utf8").split(/\r?\n/).map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]])
);
const SB = env.SUPABASE_URL;
const APP = "http://localhost:5180";
if (!/^http:\/\/(127\.0\.0\.1|localhost)/.test(SB)) throw new Error("local only: SUPABASE_URL is " + SB);

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log("  ✓ " + label); }
  else { fail++; console.log("  ✗ " + label + (extra ? "  → " + JSON.stringify(extra).slice(0, 300) : "")); }
};

const svc = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY, "Content-Type": "application/json" };
async function rest(path, init = {}, headers = svc) {
  const r = await fetch(SB + "/rest/v1/" + path, { ...init, headers: { ...headers, ...(init.headers || {}) } });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null };
}
async function signIn(email) {
  const r = await fetch(SB + "/auth/v1/token?grant_type=password", {
    method: "POST", headers: { apikey: env.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "local-test-only" }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("sign-in failed for " + email);
  return { apikey: env.SUPABASE_ANON_KEY, Authorization: "Bearer " + d.access_token, "Content-Type": "application/json" };
}
const api = async (path, body, headers, method = "POST") => {
  const r = await fetch(APP + path, { method, headers: { ...(headers || {}), "Content-Type": "application/json" }, body: method === "GET" ? undefined : JSON.stringify(body || {}) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

const scanner = await signIn("scanner@xana.local");
const viewer = await signIn("viewer@xana.local");
const admin = await signIn("admin@xana.local");

// Borrow one asset and remember it exactly.
const [asset] = (await rest("assets?select=item_id,asset_tag,employee,status,extra&deleted_at=is.null&order=item_id&limit=1&item_id=eq.LOCAL-8")).body;
if (!asset) throw new Error("LOCAL-8 missing from the local seed");
const original = { employee: asset.employee, status: asset.status, extra: asset.extra };
console.log(`Borrowing ${asset.asset_tag} (${asset.employee || "unassigned"}, ${asset.status})`);
const email = `e2e.checkout.${Date.now()}@example.com`;
let personId = null;

try {
  console.log("\nCheck-out guards");
  let r = await rest("rpc/checkin_assets", { method: "POST", body: JSON.stringify({ p_item_ids: [asset.item_id] }) }, scanner);
  ok(r.status === 200 && r.body[0].from === ((asset.employee || "").trim() || null), "scanner checks in an asset assigned before check-out existed", r.body);

  r = await rest("people", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ full_name: "E2E Checkout Person", email: email.toUpperCase() }) }, scanner);
  personId = r.body && r.body[0] && r.body[0].id;
  ok(r.status === 201 && r.body[0].email === email, "scanner adds a person; email is lower-cased", r.body);

  r = await rest("rpc/checkout_assets", { method: "POST", body: JSON.stringify({ p_person_id: personId, p_item_ids: [asset.item_id] }) }, viewer);
  ok(r.status >= 400, "view-only user cannot check out", r);

  r = await rest("rpc/checkout_assets", { method: "POST", body: JSON.stringify({ p_person_id: personId, p_item_ids: [asset.item_id], p_due_back: "2001-01-01" }) }, scanner);
  ok(r.status >= 400 && /past/.test(r.body.message), "return date in the past is refused", r.body);

  console.log("\nCheck-out");
  r = await rest("rpc/checkout_assets", { method: "POST", body: JSON.stringify({ p_person_id: personId, p_item_ids: [asset.item_id], p_condition: "Good", p_accessories: ["Charger", "Bag"], p_request_acceptance: true }) }, scanner);
  const co = r.body;
  ok(r.status === 200 && co.accept_status === "pending", "scanner checks out with acceptance requested", co);
  const [after] = (await rest("assets?select=employee,status&item_id=eq." + asset.item_id)).body;
  ok(after.employee === "E2E Checkout Person" && after.status === "In Use", "asset now In Use with the person", after);

  r = await rest("rpc/checkout_assets", { method: "POST", body: JSON.stringify({ p_person_id: personId, p_item_ids: [asset.item_id] }) }, scanner);
  ok(r.status >= 400 && /already checked out/.test(r.body.message), "double check-out refused", r.body);

  r = await rest("checkout_tokens?select=token_hash", {}, scanner);
  ok(r.status === 200 && Array.isArray(r.body) && r.body.length === 0, "tokens are invisible to signed-in users", r.body);

  console.log("\nAcceptance link");
  r = await api("/api/checkout", { action: "send", checkoutId: co.checkout_id }, { Authorization: viewer.Authorization });
  ok(r.status === 403, "view-only user cannot send links", r);
  r = await api("/api/checkout", { action: "send", checkoutId: co.checkout_id }, { Authorization: scanner.Authorization });
  ok(r.status === 200 && r.body.sent === false && /^http:\/\/localhost:5180\/accept\?t=/.test(r.body.link), "no email set up locally: link returned to copy", r.body);
  const token = new URL(r.body.link).searchParams.get("t");

  r = await api("/api/accept?t=" + token, null, {}, "GET");
  ok(r.status === 200 && r.body.assets.length === 1 && r.body.assets[0].accessories.includes("Charger") && r.body.status === "pending", "employee sees the hand-over", r.body);
  ok(!("checkout_id" in r.body) && !("email" in r.body), "public view carries no ids or emails", Object.keys(r.body));
  r = await api("/api/accept?t=" + "x".repeat(32), null, {}, "GET");
  ok(r.status === 404, "unknown token rejected", r);
  r = await api("/api/accept", { t: token, accept: false, name: "E2E" }, {});
  ok(r.status === 400 && /what is wrong/i.test(r.body.error), "dispute needs a note", r.body);
  r = await api("/api/accept", { t: token, accept: true, name: "E2E Checkout Person" }, {});
  ok(r.status === 200 && r.body.status === "accepted", "employee confirms", r.body);
  r = await api("/api/accept", { t: token, accept: true, name: "E2E Checkout Person" }, {});
  ok(r.status === 400 && /already answered/i.test(r.body.error), "second answer refused", r.body);
  const [c] = (await rest("checkouts?select=accept_status,accepted_name,accepted_at&id=eq." + co.checkout_id)).body;
  ok(c.accept_status === "accepted" && c.accepted_name === "E2E Checkout Person" && c.accepted_at, "confirmation stored with name and time", c);

  console.log("\nAlerts");
  r = await api("/api/alerts", { action: "preview" }, { Authorization: scanner.Authorization });
  ok(r.status === 403, "alert preview is admin only", r);
  r = await api("/api/alerts", { action: "preview" }, { Authorization: admin.Authorization });
  ok(r.status === 200 && /IT assets:/.test(r.body.subject) && r.body.mail.configured === false, "admin previews the digest", { subject: r.body.subject, mail: r.body.mail });
  r = await api("/api/alerts", null, {}, "GET");
  ok(r.status === 401, "cron endpoint needs the secret", r);
  r = await api("/api/alerts", null, { Authorization: "Bearer " + env.CRON_SECRET }, "GET");
  ok(r.status === 200 && r.body.log.some((l) => /email not set up|nothing to report/.test(l)), "daily job runs, sends nothing without email", r.body);

  console.log("\nCheck-in");
  r = await rest("rpc/checkin_assets", { method: "POST", body: JSON.stringify({ p_item_ids: [asset.item_id], p_condition: "Damaged", p_returned: ["Charger"], p_wiped: true, p_notes: "e2e cracked" }) }, scanner);
  ok(r.status === 200 && r.body[0].damaged && r.body[0].missing.join() === "Bag", "check-in records damage and the missing bag", r.body);
  const ev = (await rest("asset_events?select=event_type,resolved,description&item_id=eq." + asset.item_id + "&order=id.desc&limit=3")).body;
  ok(ev.filter((e) => e.event_type === "issue" && !e.resolved).length === 2, "two open issues logged (damage, missing bag)", ev);
  r = await api("/api/accept?t=" + token, null, {}, "GET");
  ok(r.status === 200 && r.body.assets.length === 0, "the old link now shows nothing left to confirm", r.body);
} finally {
  // Put the asset back exactly as found, and remove what the test created.
  const assignments = (await rest("asset_assignments?select=checkout_id&item_id=eq." + asset.item_id)).body || [];
  await rest("asset_events?item_id=eq." + asset.item_id + "&description=ilike.*E2E*", { method: "DELETE" });
  await rest("asset_events?item_id=eq." + asset.item_id + "&created_at=gte." + new Date(Date.now() - 600000).toISOString(), { method: "DELETE" });
  for (const a of assignments) await rest("checkouts?id=eq." + a.checkout_id, { method: "DELETE" });
  await rest("assets?item_id=eq." + asset.item_id, { method: "PATCH", body: JSON.stringify(original) });
  if (personId) await rest("people?id=eq." + personId, { method: "DELETE" });
  const [back] = (await rest("assets?select=employee,status&item_id=eq." + asset.item_id)).body;
  ok(back.employee === original.employee && back.status === original.status, "asset restored to how it was", back);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
