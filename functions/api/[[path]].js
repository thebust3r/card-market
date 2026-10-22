// Card Market API (Cloudflare Pages Function).
//
// Everything under /api/*:
//   POST /api/login                  {password} -> {token}
//   GET  /api/me                     watchlist, collection, recent lookups
//   POST /api/watch                  {pid, sub, on}
//   POST /api/recent                 {pid, sub}
//   POST /api/collection             {action: add|update|delete, ...}
//   GET  /api/comps?pid=&range=      TCGplayer sales history + latest sales
//   GET  /api/health                 checks that TCGplayer answers from here
//
// Bindings (set up by the deploy workflow): DB (D1), APP_PASSWORD (secret).

const TCG_HISTORY = (pid, range) => `https://infinite-api.tcgplayer.com/price/history/${pid}/detailed?range=${range}`;
const TCG_SALES = pid => `https://mpapi.tcgplayer.com/v2/product/${pid}/latestsales`;
const TCG_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36",
  "Accept": "application/json", "Origin": "https://www.tcgplayer.com", "Referer": "https://www.tcgplayer.com/",
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS watch (pid INTEGER, sub TEXT, added TEXT, PRIMARY KEY (pid, sub))`,
  `CREATE TABLE IF NOT EXISTS recents (pid INTEGER, sub TEXT, t INTEGER, PRIMARY KEY (pid, sub))`,
  `CREATE TABLE IF NOT EXISTS collection (id INTEGER PRIMARY KEY AUTOINCREMENT, pid INTEGER, sub TEXT,
     qty INTEGER, condition TEXT, grade TEXT, cost REAL, bought TEXT, value_override REAL, note TEXT, added TEXT)`,
];
let schemaReady = false;

const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), {
  status, headers: {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra},
});
const fail = (msg, status = 400) => json({error: msg}, status);

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), {name: "HMAC", hash: "SHA-256"}, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}
const tokenFor = env => hmac(env.APP_PASSWORD, "card-market-session-v1");

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function authed(request, env) {
  if (!env.APP_PASSWORD) return true;  // no password set: open (local testing)
  const h = request.headers.get("Authorization") || "";
  const t = h.startsWith("Bearer ") ? h.slice(7) : "";
  return t && safeEqual(t, await tokenFor(env));
}

async function db(env) {
  if (!env.DB) throw new Error("Database isn't connected (DB binding missing).");
  if (!schemaReady) {
    await env.DB.batch(SCHEMA.map(s => env.DB.prepare(s)));
    schemaReady = true;
  }
  return env.DB;
}

// ------------------------------------------------------------------ TCGplayer

const f = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

async function cached(key, ttl, make) {
  const cache = caches.default, req = new Request("https://cache.card-market/" + key);
  const hit = await cache.match(req);
  if (hit) return hit.json();
  const val = await make();
  await cache.put(req, new Response(JSON.stringify(val), {headers: {"Cache-Control": `max-age=${ttl}`}}));
  return val;
}

async function salesHistory(pid, range) {
  const r = await fetch(TCG_HISTORY(pid, range), {headers: TCG_HEADERS});
  if (!r.ok) throw new Error(`TCGplayer history answered ${r.status}`);
  const data = await r.json();
  return (data.result || []).map(it => ({
    condition: it.condition, variant: it.variant, language: it.language,
    totalSold: f(it.totalQuantitySold) || 0,
    buckets: (it.buckets || []).map(b => ({
      date: b.bucketStartDate, market: f(b.marketPrice), low: f(b.lowSalePrice), high: f(b.highSalePrice),
      sold: f(b.quantitySold) || 0, orders: f(b.transactionCount) || 0,
    })).sort((a, b) => (a.date < b.date ? -1 : 1)),
  }));
}

async function latestSales(pid, pages = 2) {
  const sales = [];
  for (let page = 0; page < pages; page++) {
    const body = {conditions: [], languages: [], variants: [], listingType: "All", offset: page * 25, limit: 25, time: Date.now()};
    const r = await fetch(TCG_SALES(pid), {method: "POST", headers: {...TCG_HEADERS, "Content-Type": "application/json"}, body: JSON.stringify(body)});
    if (!r.ok) throw new Error(`TCGplayer sales answered ${r.status}`);
    const data = await r.json();
    const rows = data.data || [];
    for (const x of rows) {
      const price = f(x.purchasePrice);
      if (price == null) continue;
      sales.push({date: x.orderDate, price, ship: f(x.shippingPrice), condition: x.condition, variant: x.variant,
                  language: x.language, qty: x.quantity || 1, title: x.title || "", type: x.listingType});
    }
    if (rows.length < 25 || !data.nextPage) break;
  }
  return sales;
}

async function comps(pid, range) {
  return cached(`comps/${pid}/${range}`, 600, async () => {
    const out = {pid, range, history: [], sales: []};
    const [h, s] = await Promise.allSettled([salesHistory(pid, range), latestSales(pid)]);
    if (h.status === "fulfilled") out.history = h.value; else out.historyError = String(h.reason.message || h.reason);
    if (s.status === "fulfilled") out.sales = s.value; else out.salesError = String(s.reason.message || s.reason);
    return out;
  });
}

// ------------------------------------------------------------------ handler

export async function onRequest({request, env, params}) {
  const url = new URL(request.url);
  const path = "/" + [].concat(params.path || []).join("/");
  const method = request.method;
  try {
    if (path === "/login" && method === "POST") {
      const {password} = await request.json();
      if (!env.APP_PASSWORD) return json({token: "open"});
      if (typeof password !== "string" || !safeEqual(await hmac("pw", password), await hmac("pw", env.APP_PASSWORD))) {
        await new Promise(r => setTimeout(r, 800));  // slow down guessing
        return fail("Wrong password.", 401);
      }
      return json({token: await tokenFor(env)});
    }
    if (path === "/health") {
      const out = {ok: true};
      try { out.history = (await salesHistory(696687, "month")).length > 0; } catch (e) { out.history = String(e.message); }
      try { out.sales = (await latestSales(696687, 1)).length > 0; } catch (e) { out.sales = String(e.message); }
      return json(out);
    }
    if (!(await authed(request, env))) return fail("Sign in first.", 401);

    if (path === "/comps" && method === "GET") {
      const pid = parseInt(url.searchParams.get("pid"), 10);
      const range = ["month", "quarter", "semi-annual", "annual"].includes(url.searchParams.get("range")) ? url.searchParams.get("range") : "quarter";
      if (!pid) return fail("pid missing");
      return json(await comps(pid, range));
    }

    const DB = await db(env);
    if (path === "/me" && method === "GET") {
      const [w, c, r] = await DB.batch([
        DB.prepare("SELECT pid, sub, added FROM watch ORDER BY added"),
        DB.prepare("SELECT * FROM collection ORDER BY added DESC"),
        DB.prepare("SELECT pid, sub, t FROM recents ORDER BY t DESC LIMIT 40"),
      ]);
      return json({watch: w.results, collection: c.results, recents: r.results});
    }
    if (method !== "POST") return fail("Not found", 404);
    const b = await request.json();
    const pid = parseInt(b.pid, 10), sub = String(b.sub || "Normal").slice(0, 60);

    if (path === "/watch") {
      if (!pid) return fail("pid missing");
      if (b.on === false) await DB.prepare("DELETE FROM watch WHERE pid=? AND sub=?").bind(pid, sub).run();
      else await DB.prepare("INSERT OR IGNORE INTO watch VALUES (?,?,?)").bind(pid, sub, new Date().toISOString()).run();
      return json({ok: true});
    }
    if (path === "/recent") {
      if (!pid) return fail("pid missing");
      await DB.batch([
        DB.prepare("INSERT OR REPLACE INTO recents VALUES (?,?,?)").bind(pid, sub, Date.now()),
        DB.prepare("DELETE FROM recents WHERE t < (SELECT t FROM recents ORDER BY t DESC LIMIT 1 OFFSET 59)"),
      ]);
      return json({ok: true});
    }
    if (path === "/recent/clear") {
      await DB.prepare("DELETE FROM recents").run();
      return json({ok: true});
    }
    if (path === "/collection") {
      const n = v => (v === "" || v == null ? null : Number(v));
      const s = v => (v == null || v === "" ? null : String(v).slice(0, 200));
      if (b.action === "add") {
        if (!pid) return fail("pid missing");
        const r = await DB.prepare(`INSERT INTO collection (pid, sub, qty, condition, grade, cost, bought, value_override, note, added)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(pid, sub, Math.max(1, parseInt(b.qty, 10) || 1), s(b.condition) || "Near Mint",
          s(b.grade), n(b.cost), s(b.bought), n(b.value_override), s(b.note), new Date().toISOString()).run();
        return json({ok: true, id: r.meta.last_row_id});
      }
      const id = parseInt(b.id, 10);
      if (!id) return fail("id missing");
      if (b.action === "delete") {
        await DB.prepare("DELETE FROM collection WHERE id=?").bind(id).run();
        return json({ok: true});
      }
      if (b.action === "update") {
        await DB.prepare(`UPDATE collection SET qty=?, condition=?, grade=?, cost=?, bought=?, value_override=?, note=? WHERE id=?`)
          .bind(Math.max(1, parseInt(b.qty, 10) || 1), s(b.condition), s(b.grade), n(b.cost), s(b.bought), n(b.value_override), s(b.note), id).run();
        return json({ok: true});
      }
      return fail("Unknown action");
    }
    return fail("Not found", 404);
  } catch (e) {
    return fail(String(e && e.message || e), 500);
  }
}
