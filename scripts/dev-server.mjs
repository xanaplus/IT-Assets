// Local stand-in for the Vercel deployment: serves the static pages with the
// same rewrites/redirects as vercel.json, the same hidden paths as
// .vercelignore, and runs api/*.js handlers with a Vercel-shaped req/res.
//
//   npm run dev            -> http://localhost:5180 (against the local Supabase)
//
// API env comes from .env.development.local, written by `npm run db:start`.
// It points at the Docker Supabase, never production, and carries no
// SharePoint credentials, so /api/sharepoint-sync cannot write to the live list.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 5180;
const require = createRequire(import.meta.url);

const ENV_FILE = path.join(ROOT, ".env.development.local");
if (!fs.existsSync(ENV_FILE)) {
  console.error("Missing .env.development.local - run `npm run db:start` first.");
  process.exit(1);
}
for (const line of fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8"));

// vercel.json ":param" / ":param*" sources -> RegExp with named groups.
function compile(source) {
  const re = source
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\/:(\w+)\*/g, "(?:/(?<$1>.*))?")
    .replace(/:(\w+)/g, "(?<$1>[^/]+)");
  return new RegExp("^" + re + "/?$");
}
const fill = (dest, groups) => dest.replace(/:(\w+)\*?/g, (_, k) => groups?.[k] ?? "");
const redirects = (vercel.redirects || []).map((r) => ({ ...r, re: compile(r.source) }));
const rewrites = (vercel.rewrites || []).map((r) => ({ ...r, re: compile(r.source) }));

// Mirror .vercelignore so a page that works here can't depend on a file
// production refuses to serve.
const ignored = fs
  .readFileSync(path.join(ROOT, ".vercelignore"), "utf8")
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));
function isIgnored(rel) {
  const parts = rel.split("/");
  return (
    parts.some((p) => p.startsWith(".") || p === "node_modules") ||
    ignored.some((pat) => {
      if (pat.endsWith("/")) return rel === pat.slice(0, -1) || rel.startsWith(pat);
      if (pat.startsWith("*.")) return rel.endsWith(pat.slice(1));
      if (pat.endsWith("*")) return rel.startsWith(pat.slice(0, -1));
      return rel === pat;
    })
  );
}

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json",
};

function sendFile(res, rel) {
  if (isIgnored(rel)) return false;
  let file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) return false;
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
  fs.createReadStream(file).pipe(res);
  return true;
}

async function runApi(name, req, res, url) {
  const file = path.join(ROOT, "api", name + ".js");
  if (!/^[\w-]+$/.test(name) || !fs.existsSync(file)) return false;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  let body = raw;
  if ((req.headers["content-type"] || "").includes("application/json")) {
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = raw; }
  }
  req.body = body;
  req.query = Object.fromEntries(url.searchParams);
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(obj)); return res; };
  res.send = (data) => { res.end(typeof data === "string" || Buffer.isBuffer(data) ? data : JSON.stringify(data)); return res; };
  delete require.cache[file]; // pick up edits without restarting
  const handler = require(file);
  await (handler.default || handler)(req, res);
  return true;
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    let p = decodeURIComponent(url.pathname);
    try {
      for (const r of redirects) {
        const m = p.match(r.re);
        if (m) { res.writeHead(r.permanent ? 308 : 307, { Location: fill(r.destination, m.groups) }); return res.end(); }
      }
      const api = p.match(/^\/api\/([^/]+?)(?:\.js)?\/?$/);
      if (api && (await runApi(api[1], req, res, url))) return;
      for (const r of rewrites) {
        const m = p.match(r.re);
        if (m) { p = fill(r.destination, m.groups); break; }
      }
      if (sendFile(res, p.replace(/^\/+/, ""))) return;
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("404 Not Found");
    } catch (e) {
      console.error("[dev]", req.method, req.url, e);
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("500 " + (e.message || e));
    }
  })
  .listen(PORT, () => {
    console.log(`Xana Asset System (local) -> http://localhost:${PORT}`);
    console.log(`Supabase API ${process.env.SUPABASE_URL} | Studio http://localhost:55423 | Sign-in emails http://localhost:55424`);
  });
