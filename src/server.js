// Mind Your Plate (formerly Trace) — look up food products by barcode (Open Food Facts) and flag
// substances of potential concern from a curated knowledge base (kb.json).
// Zero npm dependencies. No user data is stored server-side; ./data holds only
// a cache of public Open Food Facts responses.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Safety net: log unexpected errors instead of crashing the whole app.
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));


const PORT = Number(process.env.PORT || 3000);
const TITLE = process.env.APP_TITLE || "Mind Your Plate";
const UA = process.env.OFF_USER_AGENT || "MindYourPlate/0.1 (iakobin labs; https://mindyourplate.iakobin.com)";
const OFF = "https://world.openfoodfacts.org";
const DATA = path.join(__dirname, "data");
const CACHE_DIR = path.join(DATA, "cache");
const DAY = 86400e3;

// Limits (per client IP, per minute) and global upstream budgets (per minute).
// Per-IP limits are kept well below the shared upstream budgets so a single
// client cannot use up Open Food Facts access for everyone else.
const envInt = (name, def) => { const n = Number(process.env[name]); return Number.isFinite(n) && n > 0 ? Math.floor(n) : def; };
const LIMITS = {
  product: envInt("RATE_PRODUCT_PER_MIN", 15),
  search: envInt("RATE_SEARCH_PER_MIN", 3),
  upstreamProduct: envInt("UPSTREAM_PRODUCT_PER_MIN", 90), // OFF asks for <= 100 product reads/min
  upstreamSearch: envInt("UPSTREAM_SEARCH_PER_MIN", 10),   // OFF asks for <= 10 searches/min
};
const CACHE_MAX_FILES = envInt("CACHE_MAX_FILES", 20000); // cap on files in data/cache/{p,s}
const NOT_FOUND_TTL = 3600e3;     // "not found" products: memory only, 1 hour
const MAX_UPSTREAM_BYTES = 2e6;   // stop reading upstream bodies after ~2 MB

// ---------- knowledge base ----------
const KB = JSON.parse(fs.readFileSync(path.join(__dirname, "kb.json"), "utf8"));
const KB_JSON = JSON.stringify(KB);
const KB_BY_ID = new Map(KB.entries.map((e) => [e.id, e]));
const kbRe = new Map(); // keyword -> RegExp (prefix word boundary)
for (const e of KB.entries) {
  for (const k of e.keywords || []) {
    const esc = k.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    kbRe.set(k, new RegExp("(^|[^a-z\\u00c0-\\u024f])" + esc, "i"));
  }
}

// ---------- additive names (from the OFF taxonomy, cached to disk) ----------
let additiveNames = {};
const NAMES_FILE = path.join(CACHE_DIR, "additive-names.json");
async function loadAdditiveNames() {
  try {
    const st = fs.statSync(NAMES_FILE);
    additiveNames = JSON.parse(fs.readFileSync(NAMES_FILE, "utf8"));
    if (Date.now() - st.mtimeMs < 30 * DAY) return;
  } catch {}
  try {
    const r = await fetchT("https://static.openfoodfacts.org/data/taxonomies/additives.json", 30000);
    if (!r.ok) throw new Error("HTTP " + r.status);
    const tax = JSON.parse(await readCapped(r, 8e6)); // ~1 MB today
    const out = {};
    const strip = (s) => (s || "").replace(/^E\s?\d+[a-z]*(\([iv]+\))?\s*-\s*/i, "").trim();
    for (const [k, v] of Object.entries(tax)) {
      out[k.replace(/^en:/, "")] = {
        en: strip(v.name && v.name.en),
        nl: strip(v.name && v.name.nl),
        cls: ((v.additives_classes && v.additives_classes.en) || "").split(",")[0].replace(/^en:/, "").trim(),
      };
    }
    additiveNames = out;
    writeAtomic(NAMES_FILE, JSON.stringify(out));
    console.log("additive names loaded:", Object.keys(out).length);
  } catch (e) {
    console.warn("could not load additive names:", e.message);
  }
}

// ---------- helpers ----------
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + "." + process.pid + "." + Math.random().toString(36).slice(2) + ".tmp";
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
function fetchT(url, ms = 12000) {
  return fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(ms) });
}
// Read a response body as text, aborting once it exceeds maxBytes.
async function readCapped(r, maxBytes = MAX_UPSTREAM_BYTES) {
  const len = Number(r.headers.get("content-length"));
  if (len > maxBytes) { r.body && r.body.cancel().catch(() => {}); throw new Error("upstream response too large"); }
  if (!r.body) return "";
  const reader = r.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { reader.cancel().catch(() => {}); throw new Error("upstream response too large"); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
async function fetchJSON(url, ms) {
  const r = await fetchT(url, ms);
  const text = await readCapped(r);
  if (r.status === 404) { try { return JSON.parse(text); } catch { return { status: 0 }; } }
  if (!r.ok) throw new Error("upstream HTTP " + r.status);
  try { return JSON.parse(text); } catch { throw new Error("upstream returned non-JSON (probably overloaded)"); }
}
function clientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (xf) return String(xf).split(",")[0].trim().slice(0, 64);
  return req.socket.remoteAddress || "unknown";
}

// Fixed-window counters. key -> {n, reset}
const windows = new Map();
function hit(key, limit, windowMs = 60e3) {
  const now = Date.now();
  let w = windows.get(key);
  if (!w || now >= w.reset) { w = { n: 0, reset: now + windowMs }; windows.set(key, w); }
  w.n++;
  return { ok: w.n <= limit, retry: Math.max(1, Math.ceil((w.reset - now) / 1000)) };
}
setInterval(() => { const now = Date.now(); for (const [k, w] of windows) if (now >= w.reset) windows.delete(k); }, 60e3).unref();

// Two-level cache: small in-memory LRU + JSON files under data/cache.
const mem = new Map();
const MEM_MAX = 1500;
function cacheFile(ns, key) {
  const safe = /^[a-z0-9]{1,40}$/.test(key) ? key : crypto.createHash("sha1").update(key).digest("hex");
  return path.join(CACHE_DIR, ns, safe + ".json");
}
function memSet(mk, v) { mem.delete(mk); mem.set(mk, v); if (mem.size > MEM_MAX) mem.delete(mem.keys().next().value); }
function cacheGet(ns, key) {
  const mk = ns + ":" + key;
  if (mem.has(mk)) { const v = mem.get(mk); memSet(mk, v); return v; }
  try {
    const v = JSON.parse(fs.readFileSync(cacheFile(ns, key), "utf8"));
    memSet(mk, v);
    return v;
  } catch { return null; }
}
function cachePut(ns, key, data, ttl, { memOnly = false } = {}) {
  const v = { t: Date.now(), exp: Date.now() + ttl, data };
  memSet(ns + ":" + key, v);
  if (memOnly) return;
  try { writeAtomic(cacheFile(ns, key), JSON.stringify(v)); } catch (e) { console.warn("cache write failed", e.message); }
}
// Hourly: drop files older than 30 days, stray .tmp files and old on-disk
// "not found" entries, then enforce CACHE_MAX_FILES (oldest deleted first).
function pruneDisk() {
  const now = Date.now();
  const keep = [];
  for (const ns of ["p", "s"]) {
    const dir = path.join(CACHE_DIR, ns);
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      const p = path.join(dir, f);
      try {
        const st = fs.statSync(p);
        let drop = now - st.mtimeMs > 30 * DAY || f.endsWith(".tmp");
        if (!drop && ns === "p" && st.size < 200) { try { drop = JSON.parse(fs.readFileSync(p, "utf8")).data == null; } catch { drop = true; } }
        if (drop) fs.unlinkSync(p); else keep.push({ p, m: st.mtimeMs });
      } catch {}
    }
  }
  if (keep.length > CACHE_MAX_FILES) {
    keep.sort((a, b) => a.m - b.m);
    for (const { p } of keep.slice(0, keep.length - CACHE_MAX_FILES)) { try { fs.unlinkSync(p); } catch {} }
    console.log("cache pruned to", CACHE_MAX_FILES, "files");
  }
}
const inflight = new Map();
function once(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
function httpError(status, message, retry) { const e = new Error(message); e.status = status; e.retry = retry; return e; }

// ---------- products ----------
const PRODUCT_FIELDS = [
  "code", "product_name", "product_name_nl", "product_name_en", "generic_name_nl", "brands", "quantity",
  "image_front_url", "image_front_small_url", "ingredients_text", "ingredients_text_nl", "ingredients_text_en",
  "additives_tags", "ingredients_tags", "nova_group", "nutriscore_grade", "categories", "countries_tags",
  "allergens_tags", "ingredients_analysis_tags", "last_modified_t",
].join(",");

function trimProduct(p) {
  const s = (v, n = 4000) => (typeof v === "string" ? v.slice(0, n) : "");
  const arr = (v, n = 300) => (Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, n) : []);
  return {
    code: s(p.code, 20),
    name: s(p.product_name_nl || p.product_name || p.product_name_en || p.generic_name_nl, 200),
    brands: s(p.brands, 200),
    quantity: s(p.quantity, 60),
    image: s(p.image_front_url || p.image_front_small_url, 400),
    ingredients: s(p.ingredients_text_nl || p.ingredients_text || p.ingredients_text_en, 5000),
    ingredientsEn: s(p.ingredients_text_en, 5000),
    additives: arr(p.additives_tags),
    ingredientTags: arr(p.ingredients_tags),
    nova: [1, 2, 3, 4].includes(Number(p.nova_group)) ? Number(p.nova_group) : null,
    nutriscore: /^[a-e]$/.test(p.nutriscore_grade || "") ? p.nutriscore_grade : null,
    categories: s(p.categories, 400),
    countries: arr(p.countries_tags, 20),
    allergens: arr(p.allergens_tags, 30),
    analysis: arr(p.ingredients_analysis_tags, 10),
    updated: Number(p.last_modified_t) || null,
  };
}

const normCode = (c) => String(c).toLowerCase().replace(/^en:/, "").replace(/[\s\-()]/g, "");
// e322i -> e322 ; e160aii -> e160a (strip roman-numeral sub-variants only)
const baseCode = (c) => c.replace(/(?<=\d[a-z]?)(iv|v|i{1,3})$/, "");

function analyse(p) {
  const codes = new Set();
  for (const t of p.additives) { const c = normCode(t); codes.add(c); codes.add(baseCode(c)); }
  const text = (p.ingredients + " \n " + p.ingredientsEn).toLowerCase();
  for (const m of text.matchAll(/\be\s?-?(\d{3,4}[a-f]?)/g)) codes.add("e" + m[1]);
  const tags = new Set(p.ingredientTags);
  const found = [];
  for (const e of KB.entries) {
    const why = [];
    for (const c of e.e || []) if (codes.has(c)) why.push(c.toUpperCase());
    for (const t of e.tags || []) if (tags.has(t)) why.push(t.replace(/^[a-z]{2}:/, "").replace(/-/g, " "));
    if (!why.length) {
      const t = e.exclude ? e.exclude.reduce((acc, x) => acc.replace(new RegExp(x, "gi"), " "), text) : text;
      for (const k of e.keywords || []) if (kbRe.get(k).test(t)) { why.push("“" + k + "”"); break; }
    }
    if (why.length) found.push({ id: e.id, matched: [...new Set(why)].slice(0, 6) });
  }
  const rank = (id) => KB.levels[KB_BY_ID.get(id).level].rank;
  found.sort((a, b) => rank(b.id) - rank(a.id));
  const additives = [...new Set(p.additives.map(normCode))].map((c) => {
    const n = additiveNames[c] || additiveNames[baseCode(c)] || {};
    return { code: c.toUpperCase(), name: n.en || "", nameNl: n.nl || "", cls: n.cls || "" };
  });
  return { substances: found, additives };
}

async function getProduct(code) {
  const c = cacheGet("p", code);
  if (c && c.exp > Date.now()) return { data: c.data };
  return once("p:" + code, async () => {
    if (!hit("upstream:product", LIMITS.upstreamProduct).ok) {
      if (c) return { data: c.data, stale: true };
      throw httpError(503, "Mind Your Plate is busy right now — please try again in a minute.", 30);
    }
    try {
      const j = await fetchJSON(`${OFF}/api/v2/product/${code}.json?fields=${PRODUCT_FIELDS}`);
      const data = j && j.status === 1 && j.product ? trimProduct({ ...j.product, code }) : null;
      if (data) cachePut("p", code, data, 7 * DAY);
      else cachePut("p", code, null, NOT_FOUND_TTL, { memOnly: true }); // keep junk barcodes off disk
      return { data };
    } catch (e) {
      console.warn("product fetch failed", code, e.message);
      if (c) return { data: c.data, stale: true };
      throw httpError(502, "Open Food Facts is not responding right now. Please try again in a minute.");
    }
  });
}

// ---------- search ----------
function trimHit(h) {
  const s = (v, n) => (Array.isArray(v) ? v.join(", ") : typeof v === "string" ? v : "").slice(0, n);
  return { code: s(h.code, 20), name: s(h.product_name_nl || h.product_name, 160), brands: s(h.brands, 120), quantity: s(h.quantity, 40), image: s(h.image_front_small_url, 400) };
}
// One upstream search per user search: fetch a larger worldwide page and put
// Dutch products first (instead of a second "worldwide" call when NL is empty).
async function offSearch(q) {
  const fields = "code,product_name,product_name_nl,brands,quantity,image_front_small_url,countries_tags";
  const u = new URL(OFF + "/cgi/search.pl");
  u.search = new URLSearchParams({ search_terms: q, search_simple: "1", action: "process", json: "1", page_size: "50", sort_by: "unique_scans_n", fields });
  try {
    const j = await fetchJSON(u.toString(), 15000);
    return j.products || [];
  } catch (e) {
    // Fallback: the newer search-a-licious service.
    console.warn("search.pl failed, trying search-a-licious:", e.message);
    const u2 = new URL("https://search.openfoodfacts.org/search");
    const safeQ = q.replace(/[:"()\[\]{}^~*?\\/!+-]/g, " ");
    u2.search = new URLSearchParams({ q: safeQ, page_size: "50", fields });
    const j = await fetchJSON(u2.toString(), 15000);
    return j.hits || [];
  }
}
async function search(q) {
  const key = q.toLowerCase();
  const c = cacheGet("s", key);
  if (c && c.exp > Date.now()) return c.data;
  return once("s:" + key, async () => {
    if (!hit("upstream:search", LIMITS.upstreamSearch).ok) {
      if (c) return c.data;
      throw httpError(503, "Search is busy right now — please wait a minute and try again.", 30);
    }
    let results;
    try {
      const list = await offSearch(q);
      const isNl = (h) => Array.isArray(h.countries_tags) && h.countries_tags.includes("en:netherlands");
      const nl = list.filter(isNl);
      const scope = nl.length ? "nl" : "world";
      const ordered = nl.length ? [...nl, ...list.filter((h) => !isNl(h))] : list;
      const seen = new Set();
      const items = ordered.map(trimHit).filter((h) => /^\d{6,14}$/.test(h.code) && h.name && !seen.has(h.code) && seen.add(h.code));
      results = { scope, items: items.slice(0, 15) };
    } catch (e) {
      console.warn("search failed", e.message);
      if (c) return c.data;
      throw httpError(502, "Open Food Facts search is not responding right now. Please try again shortly.");
    }
    cachePut("s", key, results, DAY);
    return results;
  });
}

// ---------- static files ----------
const PUB = path.join(__dirname, "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };
const statics = new Map();
for (const f of fs.readdirSync(PUB)) {
  let body = fs.readFileSync(path.join(PUB, f));
  if (f.endsWith(".html")) body = Buffer.from(body.toString("utf8").replaceAll("__TITLE__", TITLE));
  statics.set("/" + f, { body, type: TYPES[path.extname(f)] || "application/octet-stream", etag: '"' + crypto.createHash("sha1").update(body).digest("hex").slice(0, 16) + '"' });
}
statics.set("/", statics.get("/index.html"));

// Exact jsDelivr paths used by app.js (html5-qrcode, tesseract.js) and what the
// tesseract worker loads itself (core wasm.js via importScripts, language data
// via fetch). Keep in sync with LIBS in public/app.js.
const JSD = "https://cdn.jsdelivr.net/npm/";
const CDN_SCRIPTS = [
  JSD + "html5-qrcode@2.3.8/html5-qrcode.min.js",
  JSD + "tesseract.js@5.1.1/dist/tesseract.min.js",
  JSD + "tesseract.js@5.1.1/dist/worker.min.js",
  JSD + "tesseract.js-core@5.1.1/",
].join(" ");
const CDN_DATA = [JSD + "@tesseract.js-data/nld/", JSD + "@tesseract.js-data/eng/"].join(" ");
const CSP = [
  "default-src 'self'",
  `script-src 'self' ${CDN_SCRIPTS} blob: 'wasm-unsafe-eval'`,
  `worker-src 'self' blob: ${JSD}tesseract.js@5.1.1/dist/worker.min.js`,
  `connect-src 'self' ${CDN_DATA} blob: data:`,
  "img-src 'self' https://images.openfoodfacts.org https://static.openfoodfacts.org data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "media-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

function send(res, status, type, body, extra = {}) {
  res.writeHead(status, { "Content-Type": type, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin", ...extra });
  res.end(body);
}
function json(res, status, obj, extra = {}) {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(obj), { "Cache-Control": "no-store", ...extra });
}
function limited(res, r) {
  json(res, 429, { error: `Too many requests — please wait ${r.retry}s and try again.` }, { "Retry-After": String(r.retry) });
}

http.createServer(async (req, res) => {
  try {
    if (req.url.length > 600) return json(res, 414, { error: "URL too long" });
    if (req.method !== "GET" && req.method !== "HEAD") {
      req.resume(); // no endpoint accepts a body
      return json(res, 405, { error: "Method not allowed" }, { Allow: "GET, HEAD" });
    }
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    if (p === "/health") return send(res, 200, "text/plain", "ok");
    if (p === "/api/kb") return send(res, 200, "application/json; charset=utf-8", KB_JSON, { "Cache-Control": "public, max-age=3600" });

    const m = p.match(/^\/api\/product\/([^/]{1,40})$/);
    if (m) {
      let code;
      try { code = decodeURIComponent(m[1]).replace(/\s/g, ""); } catch { code = ""; }
      if (!/^\d{8,14}$/.test(code)) return json(res, 400, { error: "A barcode is 8 to 14 digits." });
      const r = hit("ip:product:" + clientIp(req), LIMITS.product);
      if (!r.ok) return limited(res, r);
      const { data, stale } = await getProduct(code);
      if (!data) return json(res, 404, { error: "This product is not in Open Food Facts yet.", code });
      const { ingredientTags, ingredientsEn, ...pub } = data;
      return json(res, 200, { product: pub, ...analyse(data), stale: !!stale });
    }

    if (p === "/api/search") {
      const q = String(url.searchParams.get("q") || "").replace(/[\u0000-\u001f\u007f<>"]/g, " ").replace(/\s+/g, " ").trim();
      if (q.length < 2 || q.length > 80) return json(res, 400, { error: "Search text must be 2–80 characters." });
      const r = hit("ip:search:" + clientIp(req), LIMITS.search);
      if (!r.ok) return limited(res, r);
      return json(res, 200, await search(q));
    }

    const s = statics.get(p);
    if (s) {
      const headers = { ETag: s.etag, "Cache-Control": s.type.startsWith("text/html") ? "no-cache" : "public, max-age=300" };
      if (s.type.startsWith("text/html")) Object.assign(headers, { "Content-Security-Policy": CSP, "Permissions-Policy": "camera=(self), microphone=(), geolocation=()" });
      if (req.headers["if-none-match"] === s.etag) { res.writeHead(304, headers); return res.end(); }
      return send(res, 200, s.type, req.method === "HEAD" ? "" : s.body, headers);
    }
    json(res, 404, { error: "Not found" });
  } catch (e) {
    if (e.status) return json(res, e.status, { error: e.message }, e.retry ? { "Retry-After": String(e.retry) } : {});
    console.error(e);
    json(res, 500, { error: "Server error" });
  }
})
  .on("clientError", (err, sock) => sock.destroy())
  .listen(PORT, () => {
    console.log(`${TITLE} listening on ${PORT}`);
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    pruneDisk();
    setInterval(pruneDisk, 3600e3).unref();
    loadAdditiveNames();
  });
