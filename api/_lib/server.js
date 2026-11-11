// Shared helpers for the check-out, acceptance and alert functions.
// Files under api/_lib are bundled into the functions that require them;
// Vercel does not expose underscore paths as endpoints.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY            (always)
//      TENANT, CLIENT_ID, CLIENT_SECRET                    (Microsoft Graph, same app as the SharePoint sync)
//      MAIL_SENDER   mailbox the app sends from, e.g. it@xanalife.com. Unset = no email, links only.
//      ALERT_TO      comma-separated recipients of the daily IT alert
//      APP_URL       public base URL for links (default https://it-assets-alpha.vercel.app)
const crypto = require("node:crypto");

const TENANT = process.env.TENANT || "refrontiergroup.onmicrosoft.com";
const CLIENT_ID = process.env.CLIENT_ID || "7caa51af-9f32-42d8-8264-da5b97c2f8eb";

function appUrl() {
  return (process.env.APP_URL || "https://it-assets-alpha.vercel.app").replace(/\/+$/, "");
}

// ---------- Supabase (service role) ----------
function serviceHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  return { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" };
}

async function sb(path, options = {}) {
  const res = await fetch(process.env.SUPABASE_URL + "/rest/v1/" + path, {
    ...options,
    headers: { ...serviceHeaders(), ...(options.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text).message || text; } catch (e) { /* raw */ }
    const err = new Error(String(msg).slice(0, 300));
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

const rpc = (name, args) => sb("rpc/" + name, { method: "POST", body: JSON.stringify(args || {}) });

// ---------- Caller verification ----------
// Resolves the Supabase JWT in the Authorization header to {id, email, roles}
// for an active profile, or null. Never trusts anything the browser sends
// beyond the token itself.
async function caller(req) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return null;
  try {
    const res = await fetch(process.env.SUPABASE_URL + "/auth/v1/user", {
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY || "", Authorization: auth },
    });
    if (!res.ok) return null;
    const me = await res.json();
    if (!me || !me.id) return null;
    const prof = await sb("profiles?select=active&id=eq." + encodeURIComponent(me.id));
    if (!prof || !prof.length || !prof[0].active) return null;
    const roles = (await sb("user_roles?select=role&user_id=eq." + encodeURIComponent(me.id))) || [];
    return { id: me.id, email: me.email, roles: roles.map((r) => r.role) };
  } catch (e) {
    console.error("[auth] caller verify failed:", e.message);
    return null;
  }
}

const isWriter = (c) => !!c && c.roles.some((r) => r === "scanner" || r === "admin" || r === "super_admin");
const isAdmin = (c) => !!c && c.roles.some((r) => r === "admin" || r === "super_admin");

// ---------- Acceptance tokens ----------
const TOKEN_DAYS = 14;
const hashToken = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");

// A fresh link for a check-out. Earlier links stay valid until they expire, so
// the first email still works after a reminder has gone out.
async function issueToken(checkoutId) {
  const token = crypto.randomBytes(24).toString("base64url");
  await sb("checkout_tokens", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      token_hash: hashToken(token),
      checkout_id: checkoutId,
      expires_at: new Date(Date.now() + TOKEN_DAYS * 86400000).toISOString(),
    }),
  });
  return { token, link: appUrl() + "/accept?t=" + token };
}

// ---------- Microsoft Graph ----------
let _token = null;
let _tokenExpiry = 0;

function graphConfigured() {
  return !!process.env.CLIENT_SECRET;
}
function mailConfigured() {
  return graphConfigured() && !!process.env.MAIL_SENDER;
}
function alertRecipients() {
  return String(process.env.ALERT_TO || "")
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s));
}

async function graphToken() {
  if (_token && Date.now() < _tokenExpiry - 120000) return _token;
  const res = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: process.env.CLIENT_SECRET || "",
      scope: "https://graph.microsoft.com/.default",
    }),
  });
  if (!res.ok) throw new Error("Graph token failed " + res.status);
  const data = await res.json();
  _token = data.access_token;
  _tokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
  return _token;
}

async function graph(method, url, payload) {
  const token = await graphToken();
  const res = await fetch(url.startsWith("http") ? url : "https://graph.microsoft.com/v1.0" + url, {
    method,
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  if (!res.ok) {
    let detail = await res.text().catch(() => res.statusText);
    try { detail = JSON.parse(detail).error.message || detail; } catch (e) { /* raw */ }
    const err = new Error(`Graph ${res.status}: ${String(detail).slice(0, 250)}`);
    err.status = res.status;
    throw err;
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Sends from MAIL_SENDER. Throws if mail is not configured, so callers decide
// whether "no email" is an error or just means "show the link instead".
async function sendMail({ to, subject, html }) {
  if (!mailConfigured()) throw new Error("email is not set up (MAIL_SENDER)");
  const list = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!list.length) throw new Error("no recipient");
  await graph("POST", "/users/" + encodeURIComponent(process.env.MAIL_SENDER) + "/sendMail", {
    message: {
      subject,
      body: { contentType: "HTML", content: html },
      toRecipients: list.map((address) => ({ emailAddress: { address } })),
    },
    saveToSentItems: true,
  });
}

// Every enabled and disabled member account in the tenant (guests excluded).
async function directoryUsers() {
  const out = [];
  let url = "/users?$select=id,displayName,mail,userPrincipalName,department,officeLocation,jobTitle,accountEnabled,userType&$top=999";
  for (let page = 0; url && page < 20; page++) {
    const data = await graph("GET", url);
    for (const u of data.value || []) {
      if (u.userType && u.userType !== "Member") continue;
      const email = u.mail || (/@/.test(u.userPrincipalName || "") && !/#EXT#/i.test(u.userPrincipalName) ? u.userPrincipalName : "");
      if (!u.displayName || !email) continue;
      out.push({
        id: u.id, name: u.displayName, email: email.toLowerCase(),
        department: u.department || "", office: u.officeLocation || "", title: u.jobTitle || "",
        enabled: u.accountEnabled !== false,
      });
    }
    url = data["@odata.nextLink"] || "";
  }
  return out;
}

async function syncPeople() {
  if (!graphConfigured()) throw new Error("Microsoft 365 is not connected here (CLIENT_SECRET missing)");
  const users = await directoryUsers();
  const result = await rpc("sync_people_from_directory", { p_users: users });
  return { ...result, directory: users.length };
}

// ---------- HTTP plumbing ----------
async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body || "{}"); } catch (e) { return {}; }
  }
  return {};
}

function send(res, status, obj) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(obj);
}

module.exports = {
  appUrl, sb, rpc, caller, isWriter, isAdmin,
  hashToken, issueToken, TOKEN_DAYS,
  graphConfigured, mailConfigured, alertRecipients, sendMail, syncPeople,
  readBody, send,
};
