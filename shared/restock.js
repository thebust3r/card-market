// Restock checker, shared by the site's API (manual "check now") and the
// scheduled Worker (every 5 minutes). Watches local card shops for sealed
// Pokémon product and pushes to your phone through ntfy when something comes
// back in stock or shows up for the first time.
//
// Target isn't here: since 2026 its stock lookup sits behind a bot wall
// (PerimeterX, HTTP 435 + captcha) for anything that isn't a real browser.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

export const DEFAULT_SHOPS = [
  {name: "Gear Gaming Fayetteville", url: "https://fayetteville.geargamingstore.com", platform: "shopify"},
  {name: "The Geek Realms", url: "https://thegeekrealms.com", platform: "woocommerce"},
];
const SHOPIFY_QUERIES = ["pokemon booster", "pokemon elite trainer box", "pokemon bundle", "pokemon tin", "pokemon collection"];
const TYPES = ["elite trainer box", "etb", "booster", "bundle", "tin", "collection", "blister", "premium", "build & battle", "build and battle"];
const EXCLUDE = ["sleeve", "binder", "deck box", "plush", "figure", "playmat", "storage", "case for", "video game", "switch", "costume",
  "t-shirt", "book", "single", "proxy", "toploader", "top loader", "card saver", "pin "];

// Release-day pushes ("check Target now"), in Mason's time zone.
export const TZ = "America/Chicago";
export const DEFAULT_REMINDERS = [{id: "delta-reign", date: "2026-11-06", time: "07:00", text: "Delta Reign is out today. Check Target and the shops.",
  url: "https://www.target.com/s?searchTerm=pokemon+delta+reign"}];

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS restock_items (url TEXT PRIMARY KEY, shop TEXT, name TEXT, available INTEGER,
     first_seen TEXT, last_change TEXT, last_in_stock TEXT, price REAL)`,
  `CREATE TABLE IF NOT EXISTS restock_events (id INTEGER PRIMARY KEY AUTOINCREMENT, t TEXT, kind TEXT, shop TEXT, name TEXT, url TEXT, price REAL)`,
  `CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT)`,
];

export function wanted(title, extra = "") {
  const t = `${title} ${extra}`.toLowerCase();
  if (!/pok[eé]mon/.test(t)) return false;
  if (!TYPES.some(x => t.includes(x))) return false;
  return !EXCLUDE.some(x => t.includes(x));
}

async function getJSON(url) {
  const r = await fetch(url, {headers: {"User-Agent": UA, "Accept": "application/json"}});
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

const money = v => { const n = parseFloat(v); return Number.isFinite(n) && n > 0 ? n : null; };

// One shop -> [{url, name, available, price}]
export async function checkShop(shop) {
  const base = shop.url.replace(/\/+$/, "");
  const seen = new Map();
  if (shop.platform === "woocommerce") {
    const data = await getJSON(`${base}/wp-json/wc/store/v1/products?search=pokemon&per_page=100`);
    for (const p of data) {
      if (!wanted(decode(p.name))) continue;
      const price = p.prices ? money(p.prices.price) / Math.pow(10, p.prices.currency_minor_unit ?? 2) : null;
      seen.set(p.permalink, {url: p.permalink, name: decode(p.name), available: !!p.is_in_stock, price});
    }
  } else {
    for (const q of shop.queries || SHOPIFY_QUERIES) {
      const qs = new URLSearchParams({q, "resources[type]": "product", "resources[limit]": "10"});
      const data = await getJSON(`${base}/search/suggest.json?${qs}`);
      for (const p of data?.resources?.results?.products || []) {
        if (!wanted(decode(p.title), `${p.type || ""} ${p.vendor || ""}`)) continue;
        const url = base + String(p.url || "").split("?")[0];
        seen.set(url, {url, name: decode(p.title), available: !!p.available, price: money(p.price)});
      }
    }
  }
  return [...seen.values()];
}

const decode = s => String(s || "").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, "&").replace(/&#8211;/g, "–");

export async function getSettings(DB) {
  const rows = (await DB.prepare("SELECT k, v FROM settings").all()).results || [];
  const s = Object.fromEntries(rows.map(r => [r.k, r.v]));
  return {
    ntfyTopic: s.ntfy_topic || "", ntfyServer: s.ntfy_server || "https://ntfy.sh",
    shops: s.shops ? JSON.parse(s.shops) : DEFAULT_SHOPS,
    paused: s.restock_paused === "1",
    reminders: s.reminders ? JSON.parse(s.reminders) : DEFAULT_REMINDERS,
    lastRun: s.restock_last_run ? JSON.parse(s.restock_last_run) : null,
  };
}

export async function notify(settings, title, message, click) {
  if (!settings.ntfyTopic) return "no ntfy topic set";
  const body = {topic: settings.ntfyTopic, title, message, priority: 4, tags: ["rotating_light"]};
  if (click) body.click = click;
  const r = await fetch(settings.ntfyServer.replace(/\/+$/, ""), {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)});
  if (!r.ok) throw new Error(`ntfy answered ${r.status}`);
  return "sent";
}

function localNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"}).formatToParts(new Date()).map(x => [x.type, x.value]));
  return {date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`};
}

// Sends any reminder that's due (same day, at or after its time) once.
export async function sendReminders(DB, settings) {
  const now = localNow();
  let changed = false;
  for (const r of settings.reminders) {
    if (r.sent || r.date !== now.date || now.time < (r.time || "00:00")) continue;
    try { await notify(settings, "Card Market reminder", r.text || "Release day", r.url || null); r.sent = true; changed = true; } catch {}
  }
  if (changed) await DB.prepare("INSERT OR REPLACE INTO settings VALUES ('reminders', ?)").bind(JSON.stringify(settings.reminders)).run();
}

// Check every shop, record changes, push alerts. Returns a summary for the UI.
export async function runRestock(DB, {force = false} = {}) {
  await DB.batch(SCHEMA.map(s => DB.prepare(s)));
  const settings = await getSettings(DB);
  const now = new Date().toISOString();
  const summary = {t: now, shops: [], alerts: 0};
  await sendReminders(DB, settings);
  if (settings.paused && !force) return {...summary, paused: true};
  for (const shop of settings.shops) {
    const res = {name: shop.name, ok: false, items: 0, inStock: 0};
    try {
      const items = await checkShop(shop);
      res.ok = true; res.items = items.length; res.inStock = items.filter(i => i.available).length;
      const known = new Map(((await DB.prepare("SELECT url, available FROM restock_items WHERE shop = ?").bind(shop.name).all()).results || [])
        .map(r => [r.url, r.available]));
      const firstScan = known.size === 0;   // don't alert for everything the first time we see a shop
      const stmts = [], fresh = [];
      for (const it of items) {
        const was = known.get(it.url);
        const changed = was === undefined || !!was !== it.available;
        if (was === undefined) {
          stmts.push(DB.prepare(`INSERT INTO restock_items VALUES (?,?,?,?,?,?,?,?)`).bind(it.url, shop.name, it.name, it.available ? 1 : 0,
            now, now, it.available ? now : null, it.price));
        } else {
          stmts.push(DB.prepare(`UPDATE restock_items SET name=?, available=?, price=?, last_change=CASE WHEN available<>? THEN ? ELSE last_change END,
            last_in_stock=CASE WHEN ? THEN ? ELSE last_in_stock END WHERE url=?`).bind(it.name, it.available ? 1 : 0, it.price, it.available ? 1 : 0, now,
            it.available ? 1 : 0, now, it.url));
        }
        if (changed && it.available && !firstScan) {
          const kind = was === undefined ? "new" : "restock";
          fresh.push({...it, kind});
          stmts.push(DB.prepare("INSERT INTO restock_events (t, kind, shop, name, url, price) VALUES (?,?,?,?,?,?)").bind(now, kind, shop.name, it.name, it.url, it.price));
        } else if (changed && !it.available && was) {
          stmts.push(DB.prepare("INSERT INTO restock_events (t, kind, shop, name, url, price) VALUES (?,?,?,?,?,?)").bind(now, "sold out", shop.name, it.name, it.url, it.price));
        }
      }
      if (stmts.length) await DB.batch(stmts);
      for (const f of fresh.slice(0, 5)) {
        try {
          await notify(settings, `${f.kind === "new" ? "New" : "Back in stock"}: ${f.name}`,
            `${shop.name}${f.price ? " · $" + f.price.toFixed(2) : ""}`, f.url);
          summary.alerts++;
        } catch (e) { res.notifyError = String(e.message || e); }
      }
      if (fresh.length > 5) {
        try { await notify(settings, `${fresh.length - 5} more in stock at ${shop.name}`, "Open Card Market → Restock", null); } catch {}
      }
      if (firstScan) res.note = "first scan: saved what's there, alerts start next check";
    } catch (e) {
      res.error = String(e.message || e);
    }
    summary.shops.push(res);
  }
  await DB.prepare("INSERT OR REPLACE INTO settings VALUES ('restock_last_run', ?)").bind(JSON.stringify(summary)).run();
  await DB.prepare("DELETE FROM restock_events WHERE id < (SELECT MAX(id) - 500 FROM restock_events)").run();
  return summary;
}
