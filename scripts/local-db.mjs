// Local Supabase (Docker) for testing before deploy.
//
//   npm run db:start   start the stack, load schema + seed, create test users,
//                      write .env.development.local for `npm run dev`
//   npm run db:reset   wipe and reload schema + seed (fresh data), users again
//   npm run db:stop    stop the containers (data kept until the next reset)
//   npm run db:schema  re-copy the schema from production (structure only, no
//                      rows) after a migration lands there; needs SUPABASE_DB_URL
//                      in .env.local
//
// Ports are 554xx (Studio 55423, emails 55424) so this runs beside other
// local Supabase projects on the default 543xx.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA = path.join(ROOT, "supabase", "local", "schema.sql");
const ENV_OUT = path.join(ROOT, ".env.development.local");
// Run the CLI through node directly: no shell, so arguments (the DB URL) are
// passed verbatim and never re-parsed or echoed by cmd.exe.
const CLI = path.join(ROOT, "node_modules", "supabase", "dist", "supabase.js");

// Test accounts. Local-only: the stack is bound to this machine and wiped on reset.
const USERS = [
  { email: "admin@xana.local", role: "super_admin", name: "Local Admin" },
  { email: "scanner@xana.local", role: "scanner", name: "Local Scanner" },
  { email: "viewer@xana.local", role: "asset_viewer", name: "Local Viewer" },
];
const PASSWORD = "local-test-only";

function supabase(args, opts = {}) {
  return execFileSync(process.execPath, [CLI, ...args], {
    cwd: ROOT, encoding: "utf8", stdio: opts.capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
}

function status() {
  const out = supabase(["status", "-o", "env"], { capture: true });
  return Object.fromEntries(
    out.split(/\r?\n/).map((l) => l.match(/^([A-Z_]+)="?(.*?)"?$/)).filter(Boolean).map((m) => [m[1], m[2]])
  );
}

function writeEnv(s) {
  fs.writeFileSync(
    ENV_OUT,
    [
      "# Written by scripts/local-db.mjs - points the local API at the Docker Supabase.",
      "# No SharePoint credentials on purpose: local runs must never touch the live list.",
      `SUPABASE_URL=${s.API_URL}`,
      `SUPABASE_SERVICE_ROLE_KEY=${s.SERVICE_ROLE_KEY}`,
      `SUPABASE_ANON_KEY=${s.ANON_KEY}`,
      "INVITE_REDIRECT_TO=http://localhost:5180/",
      "",
    ].join("\n")
  );
}

async function ensureUsers(s) {
  const H = { apikey: s.SERVICE_ROLE_KEY, Authorization: `Bearer ${s.SERVICE_ROLE_KEY}`, "Content-Type": "application/json" };
  const rest = (p, init) => fetch(`${s.API_URL}/rest/v1/${p}`, { ...init, headers: { ...H, Prefer: "resolution=merge-duplicates", ...(init?.headers || {}) } });
  const list = await fetch(`${s.API_URL}/auth/v1/admin/users?per_page=200`, { headers: H }).then((r) => r.json());
  for (const u of USERS) {
    let user = (list.users || []).find((x) => x.email === u.email);
    if (!user) {
      const r = await fetch(`${s.API_URL}/auth/v1/admin/users`, {
        method: "POST", headers: H,
        body: JSON.stringify({ email: u.email, password: PASSWORD, email_confirm: true, user_metadata: { full_name: u.name } }),
      });
      user = await r.json();
      if (!r.ok) throw new Error(`create ${u.email}: ${JSON.stringify(user)}`);
    }
    for (const [table, row] of [
      ["profiles", { id: user.id, email: u.email, full_name: u.name, active: true }],
      ["user_roles", { user_id: user.id, role: u.role }],
    ]) {
      const r = await rest(table, { method: "POST", body: JSON.stringify(row) });
      if (!r.ok) throw new Error(`${table} for ${u.email}: ${r.status} ${await r.text()}`);
    }
  }
}

function pullSchema() {
  const line = fs.readFileSync(path.join(ROOT, ".env.local"), "utf8").split(/\r?\n/).find((l) => l.startsWith("SUPABASE_DB_URL="));
  if (!line) throw new Error("SUPABASE_DB_URL missing from .env.local");
  // The password may hold URL-reserved characters; encode it so the CLI parses
  // the URL (and never echoes a fragment of it in a parse error).
  const raw = line.slice("SUPABASE_DB_URL=".length).trim();
  const [scheme, rest] = raw.split("://");
  const at = rest.lastIndexOf("@");
  const [user, ...pw] = rest.slice(0, at).split(":");
  const url = `${scheme}://${encodeURIComponent(user)}:${encodeURIComponent(pw.join(":"))}@${rest.slice(at + 1)}`;
  fs.mkdirSync(path.dirname(SCHEMA), { recursive: true });
  try {
    execFileSync(process.execPath, [CLI, "db", "dump", "--db-url", url, "-f", SCHEMA], { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"] });
  } catch {
    throw new Error("schema dump failed (output suppressed: it can contain the connection string)");
  }
  console.log(`Schema copied to ${path.relative(ROOT, SCHEMA)}`);
}

const cmd = process.argv[2];
try {
  if (cmd === "schema") pullSchema();
  else if (cmd === "stop") supabase(["stop"]);
  else if (cmd === "start" || cmd === "reset") {
    if (!fs.existsSync(SCHEMA) || fs.statSync(SCHEMA).size === 0) throw new Error("supabase/local/schema.sql missing - run `npm run db:schema` once.");
    if (cmd === "start") supabase(["start"]);
    else supabase(["db", "reset"]);
    const s = status();
    writeEnv(s);
    await ensureUsers(s);
    console.log(`\nLocal Supabase ready. Studio: http://localhost:55423  Emails: http://localhost:55424`);
    console.log(`Sign in at http://localhost:5180 (npm run dev) as ${USERS.map((u) => `${u.email} (${u.role})`).join(", ")}`);
    console.log(`Password for all: ${PASSWORD}  - or use the magic link from the email inbox above.`);
  } else {
    console.log("usage: node scripts/local-db.mjs start|reset|stop|schema");
    process.exit(1);
  }
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}
