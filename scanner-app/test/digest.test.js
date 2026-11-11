// Daily IT alert rules (api/_lib/digest-data.js) and email bodies (api/_lib/emails.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const { shapeDigest, remindersDue, warrantyExpiry } = require("../../api/_lib/digest-data");
const { buildDigest, acceptanceEmail } = require("../../api/_lib/emails");

const NOW = new Date("2026-11-11T05:00:00Z");
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();
const assign = (tag, extra = {}) => ({ checked_in_at: null, assets: { asset_tag: tag }, ...extra });

test("pending hand-overs are flagged to IT only after 3 days", () => {
  const d = shapeDigest({
    checkouts: [
      { accept_status: "pending", person_name: "Jane", created_at: daysAgo(2), asset_assignments: [assign("XL-1")] },
      { accept_status: "pending", person_name: "Ann", created_at: daysAgo(4), asset_assignments: [assign("XL-3"), assign("XL-2")] },
    ],
  }, NOW);
  assert.deepEqual(d.pending.map((p) => p.person_name), ["Ann"]);
  assert.deepEqual(d.pending[0].tags, ["XL-2", "XL-3"]);
});

test("check-outs where everything came back are not chased", () => {
  const d = shapeDigest({
    checkouts: [
      { accept_status: "disputed", person_name: "Jane", dispute_note: "not mine", created_at: daysAgo(9), asset_assignments: [assign("XL-1", { checked_in_at: daysAgo(1) })] },
      { accept_status: "disputed", person_name: "Ann", dispute_note: "no charger", created_at: daysAgo(1), asset_assignments: [assign("XL-2")] },
    ],
  }, NOW);
  assert.deepEqual(d.disputed.map((x) => x.person_name), ["Ann"]);
});

test("overdue returns: past due and still out", () => {
  const d = shapeDigest({
    overdue: [
      { person_name: "P", due_back: "2026-11-10", checked_in_at: null, assets: { asset_tag: "XL-150" } },
      { person_name: "Q", due_back: "2026-11-11", checked_in_at: null, assets: { asset_tag: "XL-151" } },   // due today: not late
    ],
  }, NOW);
  assert.deepEqual(d.overdue.map((o) => o.tag), ["XL-150"]);
});

test("leavers are matched to the register by name, case-insensitively", () => {
  const d = shapeDigest({
    people: [{ full_name: "Jane Wanjiru", active: false }],
    assets: [
      { item_id: "1", asset_tag: "XL-2", employee: "jane wanjiru " },
      { item_id: "2", asset_tag: "XL-1", employee: "Jane Wanjiru" },
      { item_id: "3", asset_tag: "XL-9", employee: "Someone Else" },
    ],
  }, NOW);
  assert.equal(d.leavers.length, 1);
  assert.deepEqual(d.leavers[0].tags, ["XL-1", "XL-2"]);
});

test("warranty: inside the next 60 days only, retired and lost skipped", () => {
  assert.equal(warrantyExpiry({ purchase_date: "2024-01-15", warranty_months: 36 }).toISOString().slice(0, 10), "2027-01-15");
  const d = shapeDigest({
    assets: [
      { item_id: "1", asset_tag: "A", extra: { purchase_date: "2023-12-01", warranty_months: 36 } },   // 2026-12-01: in
      { item_id: "2", asset_tag: "B", extra: { purchase_date: "2024-03-01", warranty_months: 36 } },   // 2027-03-01: too far
      { item_id: "3", asset_tag: "C", extra: { purchase_date: "2023-10-01", warranty_months: 36 } },   // already expired
      { item_id: "4", asset_tag: "D", status: "Retired", extra: { purchase_date: "2023-12-01", warranty_months: 36 } },
    ],
  }, NOW);
  assert.deepEqual(d.warranty.map((w) => w.tag), ["A"]);
});

test("not seen in 90 days: never-verified first, retired and lost excluded", () => {
  const d = shapeDigest({
    assets: [
      { item_id: "1", asset_tag: "A", location: "Ruiru", extra: { last_verified: daysAgo(100) } },
      { item_id: "2", asset_tag: "B", location: "Ruiru", extra: {} },
      { item_id: "3", asset_tag: "C", location: "Katani", extra: { last_verified: daysAgo(10) } },
      { item_id: "4", asset_tag: "D", location: "Katani", status: "Lost", extra: {} },
    ],
  }, NOW);
  assert.equal(d.unseen.total, 2);
  assert.deepEqual(d.unseen.byLocation, [{ location: "Ruiru", count: 2 }]);
  assert.deepEqual(d.unseen.oldest.map((o) => o.tag), ["B", "A"]);
});

test("returns since yesterday: only damaged or incomplete ones", () => {
  const d = shapeDigest({
    returns: [
      { person_name: "J", condition_in: "Damaged", accessories_missing: [], checked_in_at: daysAgo(0.5), assets: { asset_tag: "A" } },
      { person_name: "J", condition_in: "Good", accessories_missing: ["Charger"], checked_in_at: daysAgo(0.5), assets: { asset_tag: "B" } },
      { person_name: "J", condition_in: "Good", accessories_missing: [], checked_in_at: daysAgo(0.5), assets: { asset_tag: "C" } },
      { person_name: "J", condition_in: "Damaged", accessories_missing: [], checked_in_at: daysAgo(2), assets: { asset_tag: "D" } },
    ],
  }, NOW);
  assert.deepEqual(d.returns.map((r) => r.tag), ["A", "B"]);
});

test("marked Lost since yesterday, from the audit trail", () => {
  const d = shapeDigest({
    history: [
      { item_id: "1", changed_at: daysAgo(0.2), old_row: { status: "In Use", employee: "Jane" }, new_row: { status: "Lost", asset_tag: "XL-5" } },
      { item_id: "2", changed_at: daysAgo(0.2), old_row: { status: "Lost" }, new_row: { status: "Lost", asset_tag: "XL-6" } },   // edit of an already-lost asset
    ],
  }, NOW);
  assert.deepEqual(d.lost, [{ tag: "XL-5", employee: "Jane" }]);
});

test("old open issues only", () => {
  const d = shapeDigest({
    assets: [{ item_id: "1", asset_tag: "XL-1" }],
    issues: [
      { item_id: "1", event_type: "issue", resolved: false, description: "screen", event_date: daysAgo(8) },
      { item_id: "1", event_type: "issue", resolved: false, description: "new", event_date: daysAgo(1) },
    ],
  }, NOW);
  assert.deepEqual(d.issues.map((i) => i.description), ["screen"]);
  assert.equal(d.issues[0].tag, "XL-1");
});

test("reminders: day 2 then day 5, only after a first email, never twice a day", () => {
  const base = { accept_status: "pending", email: "j@x.com", asset_assignments: [assign("XL-1")] };
  const due = remindersDue([
    { ...base, id: "a", emails_sent: 1, created_at: daysAgo(2.1), last_email_at: daysAgo(2.1) },   // first reminder
    { ...base, id: "b", emails_sent: 1, created_at: daysAgo(1), last_email_at: daysAgo(1) },       // too early
    { ...base, id: "c", emails_sent: 2, created_at: daysAgo(5.2), last_email_at: daysAgo(3) },     // second reminder
    { ...base, id: "d", emails_sent: 3, created_at: daysAgo(9), last_email_at: daysAgo(4) },       // done chasing
    { ...base, id: "e", emails_sent: 0, created_at: daysAgo(4), last_email_at: null },             // first never went out
    { ...base, id: "f", emails_sent: 1, created_at: daysAgo(3), last_email_at: daysAgo(0.2) },     // re-sent today
    { ...base, id: "g", email: null, emails_sent: 1, created_at: daysAgo(3), last_email_at: daysAgo(3) },
  ], NOW);
  assert.deepEqual(due.map((c) => c.id), ["a", "c"]);
});

test("digest: empty day says so; sections escape user text", () => {
  const empty = buildDigest(shapeDigest({}, NOW), NOW);
  assert.equal(empty.count, 0);
  assert.match(empty.subject, /nothing needs attention/);

  const d = buildDigest(shapeDigest({
    checkouts: [{ accept_status: "disputed", person_name: "<b>Eve</b>", dispute_note: "<script>x</script>", created_at: daysAgo(1), asset_assignments: [assign("XL-1")] }],
    syncFailed: 2,
  }, NOW), NOW, "https://app.example");
  assert.equal(d.count, 2);
  assert.match(d.subject, /2 things need attention/);
  assert.ok(!d.html.includes("<script>"));
  assert.ok(d.html.includes("&lt;b&gt;Eve&lt;/b&gt;"));
  assert.ok(d.html.includes("https://app.example/assets?id=XL-1"));
});

test("acceptance email lists assets and the link", () => {
  const m = acceptanceEmail({ personName: "Jane Wanjiru", link: "https://app/accept?t=abc", assets: [{ tag: "XL-207", type: "Laptop", model: "Dell", serial: "7HX", accessories: ["Charger"] }] });
  assert.equal(m.subject, "Please confirm your IT equipment");
  assert.ok(m.html.includes("Hi Jane,"));
  assert.ok(m.html.includes("XL-207") && m.html.includes("with Charger") && m.html.includes("https://app/accept?t=abc"));
  assert.match(acceptanceEmail({ personName: "J", link: "x", assets: [], reminder: true }).subject, /^Reminder:/);
});
