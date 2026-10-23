import {forecast, backtest, changeOver} from "./forecast.js";

// ================================================================ helpers
const $ = (sel, el = document) => el.querySelector(sel);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[c]);
const money = v => v == null || !isFinite(v) ? "–" : (v < 0 ? "-" : "") + "$" + (Math.abs(v) >= 1000 ? Math.round(Math.abs(v)).toLocaleString() : Math.abs(v).toFixed(2));
const axisMoney = v => v >= 100 ? "$" + Math.round(v).toLocaleString() : money(v);
function pct(v, plain) {
  if (v == null || !isFinite(v)) return '<span class="flat">–</span>';
  const s = (v > 0 ? "+" : "") + (v * 100).toFixed(Math.abs(v) < .1 ? 1 : 0) + "%";
  if (plain) return s;
  const c = v > .005 ? "up" : v < -.005 ? "down" : "flat";
  return `<span class="${c}">${v > .005 ? "▲" : v < -.005 ? "▼" : ""}${s}</span>`;
}
const signed = v => v == null ? "–" : `<span class="${v > 0 ? "up" : v < 0 ? "down" : "flat"}">${v > 0 ? "+" : ""}${money(v)}</span>`;
const img = (pid, w = 200) => `https://tcgplayer-cdn.tcgplayer.com/product/${pid}_${w}w.jpg`;
const tcgUrl = pid => `https://www.tcgplayer.com/product/${pid}`;
const thumb = (pid, cls = "") => `<img class="thumb ${cls}" src="${img(pid)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`;
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 2300); }
const daysAgo = iso => { const d = (Date.now() - Date.parse(iso)) / 864e5; return d < 1 ? "today" : d < 2 ? "yesterday" : Math.floor(d) + "d ago"; };
const SIG = {rising: ["▲ Rising", "up"], falling: ["▼ Falling", "down"], steady: ["● Steady", "flat"]};
const sigPill = f => f && f.ok ? `<span class="pill ${SIG[f.signal][1]}">${SIG[f.signal][0]}</span>` : "";

// ================================================================ server
let token = store.get("token", null);
async function api(path, body) {
  const r = await fetch("/api" + path, {
    method: body ? "POST" : "GET",
    headers: {"Content-Type": "application/json", ...(token ? {Authorization: "Bearer " + token} : {})},
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = {};
  try { j = await r.json(); } catch {}
  if (r.status === 401 && path !== "/login") { token = null; store.set("token", null); renderLogin(); throw new Error("Sign in first."); }
  if (!r.ok || j.error) throw new Error(j.error || `Server answered ${r.status}`);
  return j;
}

// ================================================================ data
const D = {meta: null, catalog: [], sets: new Map(), byPid: new Map(), setFiles: new Map(), movers: null};
let ME = store.get("me", {watch: [], collection: [], recents: []});

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}
async function loadData() {
  const [meta, sets, catalog] = await Promise.all([getJSON("/data/meta.json"), getJSON("/data/sets.json"), getJSON("/data/catalog.json")]);
  D.meta = meta;
  for (const [gid, name, abbr, published, supplemental] of sets) D.sets.set(gid, {gid, name, abbr, published, supplemental});
  D.catalog = catalog.map(([pid, name, gid, sealed, number, rarity, sub, price, ch7, ch30]) => {
    const row = {pid, name, gid, sealed, number, rarity, sub, price, ch7, ch30};
    row.hay = (name + " " + (D.sets.get(gid)?.name || "") + " " + number + " " + rarity).toLowerCase().replace(/[-–'’:]/g, " ");
    D.byPid.set(pid, row);
    return row;
  });
}
function setFile(gid) {
  if (!D.setFiles.has(gid)) D.setFiles.set(gid, getJSON(`/data/set/${gid}.json`).catch(e => { D.setFiles.delete(gid); throw e; }));
  return D.setFiles.get(gid);
}
// Everything the app knows about one printing of one product.
async function item(pid, sub) {
  const row = D.byPid.get(pid);
  if (!row) return null;
  const s = await setFile(row.gid);
  const prod = s.products.find(p => p[0] === pid) || [pid, row.name, row.number, row.rarity, row.sealed, null];
  const subs = Object.keys(s.series[pid] || {});
  sub = sub && subs.includes(sub) ? sub : row.sub && subs.includes(row.sub) ? row.sub : subs[0] || "Normal";
  const cents = (s.series[pid] || {})[sub] || [];
  const series = [];
  cents.forEach((c, i) => { if (c != null) series.push([s.dates[i], c / 100]); });
  const latest = (s.latest[pid] || {})[sub] || null;
  const f = forecast(series);
  return {pid, sub, subs, name: prod[1], number: prod[2], rarity: prod[3], sealed: prod[4], packs: prod[5], gid: row.gid,
          set: D.sets.get(row.gid), series, now: series.length ? series[series.length - 1][1] : null,
          asOf: series.length ? series[series.length - 1][0] : null, low: latest ? latest[2] : null, mid: latest ? latest[3] : null,
          ch7: changeOver(series, 7), ch30: changeOver(series, 30), ch90: changeOver(series, 90), ch365: changeOver(series, 365),
          forecast: f, backtest: backtest(series)};
}
async function refreshMe() {
  try { ME = await api("/me"); store.set("me", ME); } catch {}
}

// ================================================================ search
const ALIASES = {etb: ["elite", "trainer", "box"], upc: ["ultra", "premium", "collection"], spc: ["super", "premium", "collection"],
  sir: ["special", "illustration"], ir: ["illustration", "rare"], bb: ["booster", "box"], fa: ["full", "art"], pc: ["pokemon", "center"]};
function search(q, kind = "all", limit = 80) {
  const words = q.toLowerCase().replace(/[-–'’:]/g, " ").split(/\s+/).filter(Boolean).flatMap(w => ALIASES[w] || [w]);
  if (!words.length) return [];
  const hits = [];
  for (const r of D.catalog) {
    if ((kind === "cards" && r.sealed) || (kind === "sealed" && !r.sealed)) continue;
    if (words.every(w => r.hay.includes(w))) hits.push(r);
  }
  hits.sort((a, b) => (b.price ?? -1) - (a.price ?? -1));
  return hits.slice(0, limit);
}
const prow = (r, href) => `<a class="prow" href="${href || `#/card/${r.pid}/${encodeURIComponent(r.sub || "")}`}">
  ${thumb(r.pid)}<div class="t"><div class="n">${esc(r.name)} ${r.sealed ? '<span class="tag">sealed</span>' : ""}</div>
  <div class="m">${esc(D.sets.get(r.gid)?.name || "")}${r.rarity ? " · " + esc(r.rarity) : ""}</div></div>
  <div class="p"><b>${money(r.price)}</b>${r.ch30 != null ? `<span>${pct(r.ch30)}</span>` : ""}</div></a>`;

// ================================================================ shell
const ICONS = {
  comps: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/><path d="M8 13l2-2 2 1.5 2.5-3"/></svg>',
  market: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/></svg>',
  ev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="18" height="12" rx="2"/><path d="M3 12h18M8 8V5h8v3"/></svg>',
  collection: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="12" height="16" rx="2"/><path d="M8 21h10a2 2 0 0 0 2-2V7"/></svg>',
  restock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
};
const MARK = '<svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><rect x="5" y="2" width="22" height="28" rx="4" fill="var(--accent)"/><path d="M10 21l4-5 3 3 5-7" fill="none" stroke="var(--accent-ink)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const TABS = [["comps", "Comps", "#/"], ["market", "Market", "#/market"], ["ev", "Box EV", "#/ev"], ["restock", "Restock", "#/restock"], ["collection", "Collection", "#/collection"]];

function renderShell() {
  const nav = cls => TABS.map(([k, label, href]) => `<a href="${href}" data-tab="${k}">${ICONS[k]}<span>${label}</span></a>`).join("");
  $("#root").innerHTML = `<div class="app">
    <nav class="rail"><div class="brand">${MARK}Card Market</div>${nav()}<div class="foot" id="railFoot"></div></nav>
    <main class="main">
      <div class="topline"><div class="brand">${MARK}Card Market</div><div class="status" id="status"><i></i><span></span></div></div>
      <div class="search" id="searchWrap">
        <div class="searchbox">${ICONS.search}<input id="q" type="search" placeholder="Search any card or product" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" aria-label="Search cards and products">
          <div class="chipset" id="kind"><button data-k="all" class="on">All</button><button data-k="cards">Cards</button><button data-k="sealed">Sealed</button></div></div>
        <div class="results" id="results" hidden></div>
      </div>
      <div id="view"></div>
    </main>
    <nav class="tabbar">${nav()}</nav></div>`;
  wireSearch();
  updateStatus();
}
function updateStatus() {
  const m = D.meta, el = $("#status");
  if (!el || !m) return;
  const age = (Date.now() - Date.parse(m.generated)) / 36e5;
  el.className = "status" + (age > 36 ? " stale" : "");
  el.querySelector("span").textContent = `Prices ${m.as_of}`;
  const foot = $("#railFoot");
  if (foot) foot.innerHTML = `Prices as of ${esc(m.as_of)}<br>${m.products.toLocaleString()} products · ${m.history_days} days of history<br><a href="#" id="signout">Sign out</a>`;
}
let kind = "all";
function wireSearch() {
  const q = $("#q"), box = $("#results");
  let t;
  const run = () => {
    const v = q.value.trim();
    if (v.length < 2) { box.hidden = true; return; }
    const hits = search(v, kind);
    box.innerHTML = hits.length ? hits.map(r => prow(r)).join("") + (hits.length >= 80 ? '<div class="more">Showing the top 80. Add a word to narrow it down.</div>' : "")
      : '<div class="empty">No matches. Try fewer words, a card number like “161”, or a set name.</div>';
    box.hidden = false;
  };
  q.addEventListener("input", () => { clearTimeout(t); t = setTimeout(run, 120); });
  q.addEventListener("focus", () => { if (q.value.trim().length >= 2) run(); });
  q.addEventListener("keydown", e => {
    if (e.key === "Escape") { box.hidden = true; q.blur(); }
    if (e.key === "Enter") { const a = box.querySelector("a.prow"); if (a) { location.hash = a.getAttribute("href"); } }
  });
  $("#kind").addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    kind = b.dataset.k; [...$("#kind").children].forEach(x => x.classList.toggle("on", x === b)); run(); q.focus();
  });
  document.addEventListener("pointerdown", e => { if (!e.target.closest("#searchWrap")) box.hidden = true; });
  box.addEventListener("click", e => { if (e.target.closest("a.prow")) { box.hidden = true; q.blur(); } });
}

// ================================================================ router
async function route() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  const page = parts[0] || "comps";
  const tab = page === "card" ? "comps" : page;
  document.querySelectorAll("[data-tab]").forEach(a => a.classList.toggle("on", a.dataset.tab === tab));
  const view = $("#view");
  $("#results").hidden = true;
  scrollTo(0, 0);
  try {
    if (page === "card") await pageCard(view, +parts[1], parts[2]);
    else if (page === "market") await pageMarket(view);
    else if (page === "ev") await pageEV(view, +parts[1] || null);
    else if (page === "restock") await pageRestock(view);
    else if (page === "collection" && parts[1] === "sets") await pageSets(view, +parts[2] || null);
    else if (page === "collection") await pageCollection(view);
    else await pageHome(view);
  } catch (e) {
    view.innerHTML = `<div class="panel"><div class="empty">Something went wrong: ${esc(e.message)}</div></div>`;
  }
}

// ================================================================ home (comps)
async function pageHome(view) {
  const recents = (ME.recents || []).filter(r => D.byPid.has(r.pid));
  view.innerHTML = `<div class="stack">
    <div class="panel"><h2 class="sec">Recently looked up</h2>
      <div class="list">${recents.length ? recents.slice(0, 25).map(r => { const c = D.byPid.get(r.pid);
        return prow({...c, sub: r.sub}); }).join("") : '<div class="empty">Search for a card above. It shows recent TCGplayer sales by condition, a sales graph, and one-tap links to TCGplayer and eBay.</div>'}</div>
      ${recents.length ? '<div class="head" style="margin:8px 0 0"><div class="right"><button class="btn sm ghost" id="clearRecent">Clear</button></div></div>' : ""}
    </div>
    ${D.movers ? moversPanel("d7", 6, "Moving this week") : ""}
  </div>`;
  const c = $("#clearRecent");
  if (c) c.onclick = async () => { await api("/recent/clear", {}); ME.recents = []; store.set("me", ME); pageHome(view); };
}

// ================================================================ card page
const COND = c => /near mint/i.test(c) ? 0 : /lightly/i.test(c) ? 1 : 2;
const COND_NAME = ["Near Mint", "Lightly Played", "Moderately Played or worse"];
const COND_SHORT = c => ({"Near Mint": "NM", "Lightly Played": "LP", "Moderately Played": "MP", "Heavily Played": "HP", "Damaged": "DMG"})[c] || c || "?";
const COND_COLOR = ["var(--c1)", "var(--c2)", "var(--c3)"];
let range = "1y";

function compLinks(it) {
  const name = it.name.split(" - ")[0], n = (it.number || "").split("/")[0].replace(/^0+/, "");
  const q = ["pokemon", name, n, it.sealed ? "" : it.set?.name].filter(Boolean).join(" ");
  const ebay = "https://www.ebay.com/sch/i.html?LH_Sold=1&LH_Complete=1&_nkw=";
  return [["TCGplayer", tcgUrl(it.pid), "tcg"], ["eBay sold", ebay + encodeURIComponent(q)],
    ...(it.sealed ? [] : [["eBay PSA 10", ebay + encodeURIComponent(q + " PSA 10")]]),
    ["PriceCharting", "https://www.pricecharting.com/search-products?type=prices&q=" + encodeURIComponent(q)]];
}

function historyPanel(it) {
  const f = it.forecast, bt = it.backtest;
  return `        <div class="head"><h2 class="sec">Price history</h2><div class="right"><div class="seg" id="rangeSeg">${["3m", "1y", "all"].map(r => `<button data-r="${r}" class="${r === range ? "on" : ""}">${{"3m": "3M", "1y": "1Y", all: "All"}[r]}</button>`).join("")}</div></div></div>
        <div class="chart"><svg id="hist" role="img" aria-label="Market price history and estimate"></svg><div class="tip" id="htip" hidden></div></div>
        <div class="legend"><span><span class="ln"></span>Market price</span>${f.ok ? '<span><span class="ln dash"></span>Estimate</span><span><span class="bandkey"></span>Likely range</span>' : ""}${it.dailyFrom ? `<span class="faint">Before ${esc(it.dailyFrom)}: weekly, from TCGplayer's sales history</span>` : ""}</div>
        ${f.ok ? `<div class="fc">${f.points.map(p => `<div><div class="k">${p.label}</div><div class="v">${money(p.price)}</div><div class="r">${pct(p.change, true)} · ${money(p.low)}–${money(p.high)}</div></div>`).join("")}</div>
          <p class="note" style="margin:12px 0 0">${sigPill(f)} Confidence <b>${f.confidence}</b>. Trend ≈ <b>${pct(f.trendPerYear, true)}</b>/yr, assumed to fade; it typically swings ±${(f.weeklySwing * 100).toFixed(1)}% a week.
          ${bt ? `Check on the last month: it would have said ${money(bt.predicted)}, the real price was ${money(bt.actual)} (off ${(bt.error * 100).toFixed(0)}%, vs ${(bt.naiveError * 100).toFixed(0)}% for “no change”).` : ""}
          Rough estimate from past prices, not financial advice.</p>`
          : `<p class="note">${esc(f.reason)}</p>`}`;
}

async function pageCard(view, pid, sub) {
  view.innerHTML = '<div class="panel"><div class="skeleton" style="height:180px"></div></div>';
  const it = await item(pid, sub);
  if (!it) { view.innerHTML = '<div class="panel"><div class="empty">That product isn\'t in the catalog.</div></div>'; return; }
  api("/recent", {pid, sub: it.sub}).then(() => { ME.recents = [{pid, sub: it.sub, t: Date.now()}, ...(ME.recents || []).filter(r => !(r.pid === pid && r.sub === it.sub))]; store.set("me", ME); }).catch(() => {});
  const watching = (ME.watch || []).some(w => w.pid === pid && w.sub === it.sub);
  const f = it.forecast, bt = it.backtest;
  view.innerHTML = `<div class="cols card">
    <div class="stack">
      <div class="panel">
        <div class="cardhead"><img src="${img(pid, 400)}" alt="" onerror="this.style.display='none'">
          <div style="min-width:0">
            <div class="meta">${esc(it.set?.name || "")}${it.number ? " · #" + esc(it.number) : ""}${it.rarity ? " · " + esc(it.rarity) : ""}</div>
            <h1>${esc(it.name)}</h1>
            <div class="price">${money(it.now)}</div>
            <div class="price-sub">TCGplayer market${it.sub !== "Normal" ? " · " + esc(it.sub) : ""}${it.asOf ? " · " + it.asOf : ""}${it.low ? ` · lowest listing ${money(it.low)}` : ""}</div>
            <div class="deltas" id="deltas"><span class="delta"><span>7d</span>${pct(it.ch7)}</span><span class="delta"><span>30d</span>${pct(it.ch30)}</span><span class="delta"><span>1y</span>${pct(it.ch365)}</span></div>
          </div></div>
        <div class="linkbar">${compLinks(it).map(([l, u, c]) => `<a class="${c || ""}" href="${esc(u)}" target="_blank" rel="noopener">${l} ↗</a>`).join("")}</div>
        <div class="actions" style="margin-top:10px">
          ${it.subs.length > 1 ? `<select class="input" id="subSel" style="width:auto;font-size:14px">${it.subs.map(s => `<option ${s === it.sub ? "selected" : ""}>${esc(s)}</option>`).join("")}</select>` : ""}
          <button class="btn ${watching ? "" : "primary"}" id="watchBtn">${watching ? "★ Watching" : "☆ Watch"}</button>
          <button class="btn" id="addBtn">+ Collection</button>
          ${it.sealed ? `<a class="btn" href="#/ev/${pid}">Box EV</a>` : ""}
        </div>
        <div id="addForm"></div>
      </div>
      <div class="panel" id="comps"><div class="head"><h2 class="sec">Recent sales <span class="faint" id="compsNote">asking TCGplayer…</span></h2></div>
        <div class="skeleton" style="height:200px"></div></div>
      <div class="panel" id="sellPanel"></div>
    </div>
    <div class="stack">
      <div class="panel" id="histPanel">${historyPanel(it)}</div>
    </div>
  </div>`;
  if ($("#subSel")) $("#subSel").onchange = e => { location.hash = `#/card/${pid}/${encodeURIComponent(e.target.value)}`; };
  bindHistory(it);
  $("#watchBtn").onclick = async () => {
    const on = !(ME.watch || []).some(w => w.pid === pid && w.sub === it.sub);
    try { await api("/watch", {pid, sub: it.sub, on}); } catch (e) { return toast(e.message); }
    ME.watch = on ? [...ME.watch, {pid, sub: it.sub, added: new Date().toISOString()}] : ME.watch.filter(w => !(w.pid === pid && w.sub === it.sub));
    store.set("me", ME);
    $("#watchBtn").textContent = on ? "★ Watching" : "☆ Watch"; $("#watchBtn").className = "btn" + (on ? "" : " primary");
    toast(on ? "Added to watchlist" : "Removed from watchlist");
  };
  $("#addBtn").onclick = () => addForm(it);
  drawHistory(it);
  renderSell(it);
  loadComps(it).finally(() => extendHistory(it));
}

function bindHistory(it) {
  $("#rangeSeg").onclick = e => { const b = e.target.closest("button"); if (!b) return; range = b.dataset.r;
    [...$("#rangeSeg").children].forEach(x => x.classList.toggle("on", x === b)); drawHistory(it); };
}

// Our own daily history only goes back to when the data job started. When it's short,
// fill in the past year from TCGplayer's sales history (Near Mint market price per bucket).
async function extendHistory(it) {
  if (it.series.length && dayOf(it.asOf) - dayOf(it.series[0][0]) > 300) return;
  let k;
  try { k = await api(`/comps?pid=${it.pid}&range=annual`); } catch { return; }
  let hist = k.history || [];
  if (hist.some(h => h.variant === it.sub)) hist = hist.filter(h => h.variant === it.sub);
  const nm = (hist.find(h => /near mint/i.test(h.condition)) || hist[0] || {buckets: []}).buckets.filter(b => b.market);
  const first = it.series.length ? it.series[0][0] : "9999";
  const older = nm.filter(b => b.date < first).map(b => [b.date, b.market]);
  if (older.length < 2 || !$("#histPanel")) return;
  it.dailyFrom = first === "9999" ? older[older.length - 1][0] : first;
  it.series = [...older, ...it.series];
  if (it.now == null) { it.now = it.series[it.series.length - 1][1]; it.asOf = it.series[it.series.length - 1][0]; }
  Object.assign(it, {ch7: changeOver(it.series, 7), ch30: changeOver(it.series, 30), ch365: changeOver(it.series, 365),
                     forecast: forecast(it.series), backtest: backtest(it.series)});
  $("#histPanel").innerHTML = historyPanel(it);
  if ($("#deltas")) $("#deltas").innerHTML = `<span class="delta"><span>7d</span>${pct(it.ch7)}</span><span class="delta"><span>30d</span>${pct(it.ch30)}</span><span class="delta"><span>1y</span>${pct(it.ch365)}</span>`;
  bindHistory(it);
  drawHistory(it);
}

function addForm(it) {
  const box = $("#addForm");
  if (box.innerHTML) { box.innerHTML = ""; return; }
  box.innerHTML = `<div style="margin-top:14px;border-top:1px solid var(--line);padding-top:14px">
    <div class="form">
      <div class="field"><label for="fQty">Quantity</label><input class="input" id="fQty" type="number" min="1" value="1" inputmode="numeric"></div>
      <div class="field"><label for="fCost">Paid each ($)</label><input class="input" id="fCost" type="number" min="0" step="0.01" inputmode="decimal" placeholder="${it.now ? it.now.toFixed(2) : ""}"></div>
      <div class="field"><label for="fCond">Condition</label><select class="input" id="fCond">${["Near Mint", "Lightly Played", "Moderately Played", "Heavily Played", "Damaged", "Sealed"].map(x => `<option ${it.sealed && x === "Sealed" ? "selected" : ""}>${x}</option>`).join("")}</select></div>
      <div class="field"><label for="fGrade">Graded</label><input class="input" id="fGrade" placeholder="e.g. PSA 10"></div>
      <div class="field"><label for="fDate">Bought</label><input class="input" id="fDate" type="date" value="${new Date().toISOString().slice(0, 10)}"></div>
      <div class="field"><label for="fNote">Note</label><input class="input" id="fNote" placeholder="show, seller…"></div>
    </div>
    <div class="actions" style="margin-top:10px"><button class="btn primary" id="fSave">Add to collection</button><span class="faint small">Graded cards: set their value in Collection (TCGplayer prices raw cards).</span></div></div>`;
  $("#fSave").onclick = async () => {
    const body = {action: "add", pid: it.pid, sub: it.sub, qty: $("#fQty").value, cost: $("#fCost").value, condition: $("#fCond").value,
                  grade: $("#fGrade").value.trim(), bought: $("#fDate").value, note: $("#fNote").value.trim()};
    try { await api("/collection", body); box.innerHTML = ""; toast("Added to collection"); refreshMe(); } catch (e) { toast(e.message); }
  };
}

async function loadComps(it) {
  const el = $("#comps");
  let k;
  try { k = await api(`/comps?pid=${it.pid}&range=quarter`); }
  catch (e) { k = {sales: [], history: [], error: e.message}; }
  if (!document.body.contains(el)) return;
  // keep the printing on screen when TCGplayer's variant names line up with ours
  let sales = k.sales || [], hist = k.history || [];
  if (sales.some(s => s.variant === it.sub)) sales = sales.filter(s => s.variant === it.sub);
  if (hist.some(h => h.variant === it.sub)) hist = hist.filter(h => h.variant === it.sub);
  const order = ["Near Mint", "Lightly Played", "Moderately Played", "Heavily Played", "Damaged"];
  const conds = [...new Set(sales.map(s => s.condition))].sort((a, b) => (order.indexOf(a) + 9) % 18 - (order.indexOf(b) + 9) % 18);
  const med = v => { const s = [...v].sort((a, b) => a - b), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
  const nm = (hist.find(h => /near mint/i.test(h.condition)) || hist[0] || {buckets: []}).buckets.filter(b => b.market);
  let h = `<div class="head"><h2 class="sec">Recent sales <span class="faint">${sales.length ? `last ${sales.length} on TCGplayer · newest ${daysAgo(sales[0].date)}` : ""}</span></h2></div>`;
  if (conds.length) h += `<div class="medians">${conds.map(c => { const cs = sales.filter(s => s.condition === c), l10 = cs.slice(0, 10).map(s => s.price);
    return `<div class="median"><div class="k"><span class="dot" style="background:${COND_COLOR[COND(c)]}"></span>${esc(c)}</div><div class="v">${money(med(l10))}</div>
      <div class="r">median of last ${l10.length} · ${money(Math.min(...l10))}–${money(Math.max(...l10))}</div></div>`; }).join("")}</div>`;
  if (sales.length || nm.length > 1) {
    h += `<div class="chart"><svg id="sales" role="img" aria-label="Recent sales"></svg><div class="tip" id="stip" hidden></div></div>
      <div class="legend">${sales.length ? [0, 1, 2].filter(i => sales.some(s => COND(s.condition) === i)).map(i => `<span><span class="dot" style="background:${COND_COLOR[i]};margin-right:5px"></span>${COND_NAME[i]}</span>`).join("") + (nm.length > 1 ? '<span><span class="ln mute"></span>NM market</span>' : "")
        : '<span><span class="ln"></span>NM market</span><span><span class="bandkey"></span>Low–high sale</span>'}</div>`;
  }
  if (sales.length) h += `<div class="scroll-x"><table class="sales">${sales.slice(0, 15).map(s => `<tr>
      <td>${new Date(s.date).toLocaleDateString(undefined, {month: "short", day: "numeric"})}</td>
      <td><span class="dot" style="background:${COND_COLOR[COND(s.condition)]}"></span> ${esc(COND_SHORT(s.condition))}${s.language && s.language !== "English" ? " · " + esc(s.language) : ""}</td>
      <td class="num">${s.qty > 1 ? "×" + s.qty + " " : ""}<b>${money(s.price)}</b></td><td class="num faint">${s.ship ? "+" + money(s.ship) : ""}</td></tr>`).join("")}</table></div>`;
  const errs = [k.error, k.salesError && "individual sales: " + k.salesError, k.historyError && "sales history: " + k.historyError].filter(Boolean);
  if (errs.length) h += `<p class="warn">TCGplayer didn't answer everything (${esc(errs.join("; "))}). The links above still work.</p>`;
  if (!sales.length && nm.length < 2 && !errs.length) h += '<div class="empty">No recent TCGplayer sales for this one.</div>';
  const sp = sellSpeed(hist);
  if (sp) h += `<div class="speed"><span class="pill ${sp.cls}">${sp.label}</span> <b>${sp.total}</b> sold on TCGplayer in the last 30 days${sp.parts ? ` <span class="faint">(${sp.parts})</span>` : ""}. ${sp.note}</div>`;
  el.innerHTML = h;
  drawSales(sales, nm);
  const nmSales = sales.filter(s => s.condition === "Near Mint").slice(0, 10).map(s => s.price);
  it.nmMedian = nmSales.length >= 3 ? med(nmSales) : null;
  it.speed = sp;
  if ($("#sellPanel")) renderSell(it);
}

// Copies sold in the last 30 days, per condition, from the sales-history buckets.
function sellSpeed(hist) {
  if (!hist.length) return null;
  const cut = Date.now() / DAY - 30, by = [];
  for (const h of hist) {
    const n = h.buckets.filter(b => dayOf(b.date) >= cut).reduce((a, b) => a + (b.sold || 0), 0);
    if (n) by.push([COND_SHORT(h.condition), n]);
  }
  const total = by.reduce((a, b) => a + b[1], 0);
  const [label, cls, note] = total >= 30 ? ["Sells fast", "up", "A fair price should sell within days."]
    : total >= 8 ? ["Sells steadily", "flat", "Expect a week or two at a fair price."]
    : total >= 1 ? ["Sells slowly", "down", "Few buyers: price to sell, or expect to wait."]
    : ["No recent sales", "down", "Nobody bought one in a month; comps may be stale."];
  return {total, label, cls, note, parts: by.length > 1 ? by.sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(" · ") : ""};
}

// ================================================================ sell + grade
// Seller fees as of 2026. They change now and then; the note under the table says which ones are used.
const FEES = {
  tcg: {name: "TCGplayer", pct: .1075 + .025, flat: .30, note: "10.75% commission + 2.5% + $0.30 payment processing"},
  ebay: {name: "eBay", pct: .1325, flat: null, note: "13.25% of the total + $0.30 per order ($0.40 over $10)"},
  pp: {name: "PayPal / Venmo (goods & services)", pct: .0349, flat: .49, note: "3.49% + $0.49"},
  cash: {name: "Cash at a show", pct: 0, flat: 0, note: "no fees"},
};
let sellTab = "sell";
function renderSell(it) {
  const box = $("#sellPanel"); if (!box) return;
  const head = `<div class="head"><h2 class="sec">Sell or grade</h2><div class="right"><div class="seg" id="sellSeg">
    <button data-t="sell" class="${sellTab === "sell" ? "on" : ""}">Sell</button><button data-t="grade" class="${sellTab === "grade" ? "on" : ""}">Grade</button></div></div></div>`;
  box.innerHTML = head + `<div id="sellBody"></div>`;
  $("#sellSeg").onclick = e => { const b = e.target.closest("button"); if (!b) return; sellTab = b.dataset.t; renderSell(it); };
  sellTab === "sell" ? sellBody(it) : gradeBody(it);
}
function sellBody(it) {
  const body = $("#sellBody");
  const suggest = it.nmMedian || it.now;
  const st = store.get("sell", {});
  const price = st.pid === it.pid && st.price ? st.price : suggest ? +suggest.toFixed(2) : "";
  const ship = st.ship ?? (price && price < 20 ? 1 : 5);
  body.innerHTML = `<div class="form">
      <div class="field"><label for="sPrice">Sale price ($)</label><input class="input" id="sPrice" type="number" step="0.01" min="0" inputmode="decimal" value="${price}"></div>
      <div class="field"><label for="sShip">Your shipping cost ($)</label><input class="input" id="sShip" type="number" step="0.01" min="0" inputmode="decimal" value="${ship}"></div>
    </div>
    <p class="note" style="margin:8px 0">${it.nmMedian ? `Recent Near Mint sales: median ${money(it.nmMedian)}. List around there to sell at a normal pace, a little under to sell fast.` : `Market price ${money(it.now)}.`}
      ${it.speed ? ` ${esc(it.speed.label)} (${it.speed.total} sold in 30 days).` : ""}</p>
    <div class="scroll-x"><table class="t" id="sTable"></table></div>
    <p class="faint small" style="margin:8px 0 0">Shipping: about $1 for a plain envelope, $5 tracked. Fees used: ${Object.values(FEES).filter(f => f.pct).map(f => `${f.name} ${f.note}`).join("; ")}. Dealers at shows usually pay 60–80% of market in cash, more in trade.</p>`;
  const calc = save => {
    const p = +$("#sPrice").value || 0, sh = +$("#sShip").value || 0;
    if (save) store.set("sell", {pid: it.pid, price: p, ship: sh});
    const rows = Object.entries(FEES).map(([k, f]) => {
      const flat = f.flat ?? (p > 10 ? .40 : .30), fee = p ? p * f.pct + flat : 0, ship = k === "cash" ? 0 : sh, net = p - fee - ship;
      return `<tr><td>${f.name}</td><td class="num">${money(fee)}</td><td class="num"><b>${money(net)}</b></td><td class="num faint">${p ? Math.round(net / p * 100) + "%" : ""}</td></tr>`;
    });
    $("#sTable").innerHTML = `<thead><tr><th>Where</th><th class="num">Fees</th><th class="num">You keep</th><th class="num"></th></tr></thead><tbody>${rows.join("")}</tbody>`;
  };
  body.oninput = () => calc(true);
  calc(false);
}
function gradeBody(it) {
  const body = $("#sellBody");
  if (it.sealed) { body.innerHTML = '<p class="note">Grading is for single cards.</p>'; return; }
  const key = "grade:" + it.pid, g = {raw: +(it.nmMedian || it.now || 0).toFixed(2), p10: "", p9: "", p8: "", c10: 30, c9: 50, fee: 25, ship: 6, sellPct: 13.25, ...store.get(key, {})};
  const name = it.name.split(" - ")[0], n = (it.number || "").split("/")[0].replace(/^0+/, "");
  const ebay = grade => "https://www.ebay.com/sch/i.html?LH_Sold=1&LH_Complete=1&_nkw=" + encodeURIComponent(`pokemon ${name} ${n} ${grade}`);
  const f = (k, label, extra = 'step="0.01"') => `<div class="field"><label for="g_${k}">${label}</label><input class="input" id="g_${k}" data-g="${k}" type="number" min="0" inputmode="decimal" ${extra} value="${g[k]}"></div>`;
  body.innerHTML = `<div class="form">
      ${f("raw", "Raw value ($)")}${f("p10", "PSA 10 value ($)")}${f("p9", "PSA 9 value ($)")}${f("p8", "PSA 8 value ($)")}
      ${f("c10", "Chance of a 10 (%)", 'step="1" max="100"')}${f("c9", "Chance of a 9 (%)", 'step="1" max="100"')}
      ${f("fee", "Grading fee ($)")}${f("ship", "Shipping + insurance ($)")}
    </div>
    <div class="linkbar" style="margin-top:10px"><a href="${ebay("PSA 10")}" target="_blank" rel="noopener">PSA 10 sold ↗</a><a href="${ebay("PSA 9")}" target="_blank" rel="noopener">PSA 9 sold ↗</a><a href="${ebay("PSA 8")}" target="_blank" rel="noopener">PSA 8 sold ↗</a></div>
    <div id="gOut" style="margin-top:12px"></div>
    <p class="faint small" style="margin:8px 0 0">Gem rates vary a lot by set and by how clean your copy is; 30% is a rough modern-pack-fresh guess. Anything below a 9 is valued at the PSA 8 price (or raw if empty). Values are after ${g.sellPct}% selling fees.</p>`;
  const calc = save => {
    for (const i of body.querySelectorAll("[data-g]")) g[i.dataset.g] = i.value === "" ? "" : +i.value;
    if (save) store.set(key, g);
    const keep = 1 - g.sellPct / 100, c10 = Math.min(1, (+g.c10 || 0) / 100), c9 = Math.min(1 - c10, (+g.c9 || 0) / 100), rest = 1 - c10 - c9;
    const v8 = g.p8 === "" ? +g.raw : +g.p8, cost = (+g.fee || 0) + (+g.ship || 0), rawNet = (+g.raw || 0) * keep;
    if (g.p10 === "") { $("#gOut").innerHTML = '<p class="note">Add what a PSA 10 sells for (tap “PSA 10 sold”) to see if it\'s worth grading.</p>'; return; }
    const v9 = g.p9 === "" ? v8 : +g.p9;
    const ev = (c10 * g.p10 + c9 * v9 + rest * v8) * keep - cost;
    const at = v => v * keep - cost - rawNet;
    const breakEven = g.p10 * keep - v8 * keep > 0 ? Math.max(0, (rawNet + cost - (c9 * v9 + (1 - c9) * v8) * keep) / ((g.p10 - v8) * keep)) : null;
    const gain = ev - rawNet, verdict = gain > cost * .5 ? ["Worth grading", "up"] : gain > 0 ? ["Marginal", "flat"] : ["Sell it raw", "down"];
    $("#gOut").innerHTML = `<div class="ev-big">
        <div><div class="k">Sell raw</div><div class="v">${money(rawNet)}</div><div class="faint small">after fees</div></div>
        <div><div class="k">Grade, on average</div><div class="v">${money(ev)}</div><div class="faint small">after grading + fees</div></div>
        <div><div class="k">Difference</div><div class="v ${verdict[1]}">${signed(gain)}</div><div class="faint small">${verdict[0]}</div></div></div>
      <p class="note" style="margin:10px 0 0">If it gets a 10: ${signed(at(+g.p10))}. A 9: ${signed(at(v9))}. Lower: ${signed(at(v8))}.
        ${breakEven == null ? "" : breakEven <= 0 ? "It pays off on average even without a 10." : breakEven >= 1 ? "Even a sure 10 wouldn't beat selling raw." : `It pays off on average if your chance of a 10 is over <b>${Math.round(breakEven * 100)}%</b>.`}</p>`;
  };
  body.oninput = () => calc(true);
  calc(false);
}

// ================================================================ charts
const DAY = 864e5, dayOf = d => Date.parse(d.length <= 10 ? d + "T00:00:00Z" : d) / DAY;
const fmtMonth = new Intl.DateTimeFormat(undefined, {month: "short", year: "2-digit", timeZone: "UTC"});
const fmtDay = new Intl.DateTimeFormat(undefined, {month: "short", day: "numeric", timeZone: "UTC"});
function frame(svg, t0, t1, mn, mx, fmt) {
  const W = svg.clientWidth || 600, H = 220, pad = {l: 50, r: 8, t: 10, b: 24};
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const X = t => pad.l + (t - t0) / ((t1 - t0) || 1) * (W - pad.l - pad.r);
  const Y = v => pad.t + (1 - (v - mn) / ((mx - mn) || 1)) * (H - pad.t - pad.b);
  let g = "";
  for (let i = 0; i <= 4; i++) { const v = mn + (mx - mn) * i / 4, y = Y(v);
    g += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y}" y2="${y}" stroke="var(--grid)"/><text x="${pad.l - 6}" y="${y + 4}" text-anchor="end">${axisMoney(v)}</text>`; }
  const n = Math.max(2, Math.floor((W - pad.l - pad.r) / 80));
  for (let i = 0; i <= n; i++) { const t = t0 + (t1 - t0) * i / n;
    g += `<text x="${X(t)}" y="${H - 6}" text-anchor="${i === 0 ? "start" : i === n ? "end" : "middle"}">${fmt.format(new Date(t * DAY))}</text>`; }
  g += `<line class="cross" y1="${pad.t}" y2="${H - pad.b}" stroke="var(--ink-3)" visibility="hidden"/>`;
  return {W, H, pad, X, Y, g};
}
function scale(vals) {
  let mn = Math.min(...vals), mx = Math.max(...vals);
  const pv = (mx - mn) * .1 || mx * .1 || 1;
  return [Math.max(0, mn - pv), mx + pv];
}
function hover(svg, tip, fr, pts, label) {
  const move = cx => {
    const rect = svg.getBoundingClientRect(), mx = (cx - rect.left) * fr.W / rect.width;
    let b = pts[0];
    for (const p of pts) if (Math.abs(fr.X(p.t) - mx) < Math.abs(fr.X(b.t) - mx)) b = p;
    const x = fr.X(b.t), y = fr.Y(b.p), cross = svg.querySelector(".cross"), dot = svg.querySelector(".hdot");
    cross.setAttribute("x1", x); cross.setAttribute("x2", x); cross.setAttribute("visibility", "visible");
    dot.setAttribute("cx", x); dot.setAttribute("cy", y); dot.setAttribute("visibility", "visible");
    tip.innerHTML = label(b); tip.hidden = false;
    const px = x * rect.width / fr.W, w = tip.offsetWidth;
    tip.style.left = (px + 12 + w < rect.width ? px + 12 : Math.max(0, px - w - 12)) + "px";
    tip.style.top = Math.max(0, y * rect.height / fr.H - 30) + "px";
  };
  svg.onpointermove = e => move(e.clientX);
  svg.onpointerdown = e => move(e.clientX);
  svg.onpointerleave = () => { tip.hidden = true; svg.querySelector(".cross").setAttribute("visibility", "hidden"); svg.querySelector(".hdot").setAttribute("visibility", "hidden"); };
}
const hdot = '<circle class="hdot" r="5" fill="none" stroke="var(--ink)" stroke-width="2" visibility="hidden"/>';

function drawHistory(it) {
  const svg = $("#hist"); if (!svg) return;
  let s = it.series.map(([d, p]) => ({t: dayOf(d), d, p}));
  if (s.length < 2) {
    const W = svg.clientWidth || 600;
    svg.setAttribute("viewBox", `0 0 ${W} 220`);
    svg.innerHTML = `<text x="${W / 2}" y="110" text-anchor="middle">${s.length ? "Only one price so far: history builds daily" : "No price history for this printing"}</text>`;
    return;
  }
  const f = it.forecast, last = s[s.length - 1].t;
  const back = {"3m": 91, "1y": 365, all: 1e9}[range], fh = {"3m": 1, "1y": 3, all: 3}[range];
  s = s.filter(x => x.t >= last - back);
  const lp = s[s.length - 1].p;
  const fp = f.ok ? [{t: last, p: lp, low: lp, high: lp}, ...f.points.slice(0, fh + 1).map(p => ({t: last + p.days, p: p.price, low: p.low, high: p.high, label: p.label}))] : [];
  const [mn, mx] = scale([...s.map(x => x.p), ...fp.flatMap(x => [x.low, x.high])]);
  const fr = frame(svg, s[0].t, fp.length ? fp[fp.length - 1].t : last, mn, mx, fmtMonth);
  let g = fr.g;
  if (fp.length) {
    g += `<line x1="${fr.X(last)}" x2="${fr.X(last)}" y1="${fr.pad.t}" y2="${fr.H - fr.pad.b}" stroke="var(--line)" stroke-dasharray="3 3"/>`;
    g += `<polygon fill="var(--band)" points="${fp.map(x => `${fr.X(x.t)},${fr.Y(x.high)}`).join(" ")} ${[...fp].reverse().map(x => `${fr.X(x.t)},${fr.Y(x.low)}`).join(" ")}"/>`;
    g += `<polyline fill="none" stroke="var(--chart)" stroke-width="2" stroke-dasharray="6 5" points="${fp.map(x => `${fr.X(x.t)},${fr.Y(x.p)}`).join(" ")}"/>`;
  }
  g += `<polyline fill="none" stroke="var(--chart)" stroke-width="2" stroke-linejoin="round" points="${s.map(x => `${fr.X(x.t).toFixed(1)},${fr.Y(x.p).toFixed(1)}`).join(" ")}"/>`;
  g += `<circle cx="${fr.X(last)}" cy="${fr.Y(lp)}" r="4" fill="var(--chart)"/>`;
  svg.innerHTML = g + hdot;
  const pts = [...s, ...fp.slice(1).map(x => ({...x, e: true}))];
  hover(svg, $("#htip"), fr, pts, b => b.e ? `<b>~${money(b.p)}</b> in ${b.label}<br>likely ${money(b.low)}–${money(b.high)}` : `<b>${money(b.p)}</b><br>${b.d}`);
}

function drawSales(sales, nm) {
  const svg = $("#sales"); if (!svg) return;
  if (sales.length) {
    const pts = sales.map(s => ({t: dayOf(s.date), p: s.price, s}));
    const t0 = Math.min(...pts.map(p => p.t)), t1 = Math.max(...pts.map(p => p.t)), span = Math.max(1, t1 - t0);
    const a = t0 - span * .04, z = t1 + span * .04;
    const line = nm.map(b => ({t: dayOf(b.date), p: b.market})).filter(b => b.t >= a && b.t <= z);
    const [mn, mx] = scale([...pts.map(p => p.p), ...line.map(b => b.p)]);
    const fr = frame(svg, a, z, mn, mx, fmtDay);
    let g = fr.g;
    if (line.length > 1) g += `<polyline fill="none" stroke="var(--ink-3)" stroke-width="2" stroke-dasharray="4 4" points="${line.map(b => `${fr.X(b.t)},${fr.Y(b.p)}`).join(" ")}"/>`;
    for (const p of [...pts].reverse()) g += `<circle cx="${fr.X(p.t).toFixed(1)}" cy="${fr.Y(p.p).toFixed(1)}" r="5" fill="${COND_COLOR[COND(p.s.condition)]}" stroke="var(--panel)" stroke-width="2"/>`;
    svg.innerHTML = g + hdot;
    hover(svg, $("#stip"), fr, pts, x => `<b>${money(x.p)}</b> · ${esc(COND_SHORT(x.s.condition))}${x.s.qty > 1 ? " ×" + x.s.qty : ""}<br>${new Date(x.s.date).toLocaleString(undefined, {month: "short", day: "numeric", hour: "numeric", minute: "2-digit"})}`);
  } else {
    const pts = nm.map(b => ({t: dayOf(b.date), p: b.market, b}));
    const sold = pts.filter(x => x.b.sold && x.b.low);
    const [mn, mx] = scale(pts.flatMap(x => [x.p, x.b.low || x.p, x.b.high || x.p]));
    const fr = frame(svg, pts[0].t, pts[pts.length - 1].t, mn, mx, fmtDay);
    let g = fr.g;
    if (sold.length > 1) g += `<polygon fill="var(--band)" points="${sold.map(x => `${fr.X(x.t)},${fr.Y(x.b.high)}`).join(" ")} ${[...sold].reverse().map(x => `${fr.X(x.t)},${fr.Y(x.b.low)}`).join(" ")}"/>`;
    g += `<polyline fill="none" stroke="var(--chart)" stroke-width="2" points="${pts.map(x => `${fr.X(x.t)},${fr.Y(x.p)}`).join(" ")}"/>`;
    svg.innerHTML = g + hdot;
    hover(svg, $("#stip"), fr, pts, x => `<b>${money(x.p)}</b> NM market · ${x.b.date}<br>${x.b.sold ? `${x.b.sold} sold, ${money(x.b.low)}–${money(x.b.high)}` : "no sales"}`);
  }
}

// ================================================================ market
let moverSpan = "d7";
function moversPanel(span, n, title) {
  const m = D.movers[span];
  const row = x => { const c = D.byPid.get(x.pid) || {pid: x.pid, name: x.name, gid: x.gid};
    return `<a class="prow" href="#/card/${x.pid}/${encodeURIComponent(x.sub)}">${thumb(x.pid, "sm")}<div class="t"><div class="n">${esc(x.name)}</div>
      <div class="m">${esc(D.sets.get(x.gid)?.name || "")}${x.sub !== "Normal" ? " · " + esc(x.sub) : ""}</div></div>
      <div class="p"><b>${pct(x.change)}</b><span class="faint">${money(x.then)} → ${money(x.now)}</span></div></a>`; };
  return `<div class="cols two">
    <div class="panel"><h2 class="sec">${title ? esc(title) + ": up" : "Biggest risers"}</h2><div class="list">${m.up.slice(0, n).map(row).join("") || '<div class="empty">Needs more price history.</div>'}</div></div>
    <div class="panel"><h2 class="sec">${title ? esc(title) + ": down" : "Biggest drops"}</h2><div class="list">${m.down.slice(0, n).map(row).join("") || '<div class="empty">Needs more price history.</div>'}</div></div></div>`;
}
async function pageMarket(view) {
  view.innerHTML = '<div class="panel"><div class="skeleton" style="height:160px"></div></div>';
  const items = (await Promise.all((ME.watch || []).filter(w => D.byPid.has(w.pid)).map(w => item(w.pid, w.sub).catch(() => null)))).filter(Boolean);
  const value = items.reduce((a, i) => a + (i.now || 0), 0);
  let now = 0, then = 0;
  for (const i of items) if (i.now && i.ch30 != null) { now += i.now; then += i.now / (1 + i.ch30); }
  view.innerHTML = `<div class="stack">
    <h1 class="page">Market</h1>
    <div class="stats">
      <div class="stat"><div class="k">Watching</div><div class="v">${items.length}</div><div class="s">${D.meta.products.toLocaleString()} products tracked</div></div>
      <div class="stat"><div class="k">Watchlist value</div><div class="v">${items.length ? money(value) : "–"}</div><div class="s">market prices</div></div>
      <div class="stat"><div class="k">Watchlist, 30d</div><div class="v">${then ? pct(now / then - 1) : "–"}</div><div class="s">${then ? money(then) + " → " + money(now) : " "}</div></div>
      <div class="stat"><div class="k">Prices as of</div><div class="v">${esc(D.meta.as_of.slice(5))}</div><div class="s">${D.meta.history_days} days of history</div></div>
    </div>
    <div class="panel"><h2 class="sec">Watchlist</h2><div class="list">${items.length ? items.map(i => `<a class="prow" href="#/card/${i.pid}/${encodeURIComponent(i.sub)}">${thumb(i.pid)}
        <div class="t"><div class="n">${esc(i.name)} ${i.sealed ? '<span class="tag">sealed</span>' : ""}</div>
        <div class="m">${esc(i.set?.name || "")}${i.sub !== "Normal" ? " · " + esc(i.sub) : ""}</div>
        <div class="m">7d ${pct(i.ch7)} · 30d ${pct(i.ch30)} ${sigPill(i.forecast)}</div></div>
        <div class="p"><b>${money(i.now)}</b><span class="faint">${i.forecast.ok ? "1y ~" + money(i.forecast.points[3].price) : ""}</span></div></a>`).join("")
      : '<div class="empty">Open any card and press “Watch” to follow it here.</div>'}</div></div>
    <div class="panel" id="deals"><h2 class="sec">Deals right now</h2><div class="skeleton" style="height:80px"></div></div>
    <div class="head"><h2 class="sec">Biggest moves</h2><div class="right"><div class="seg" id="mvSeg"><button data-s="d7" class="${moverSpan === "d7" ? "on" : ""}">7 days</button><button data-s="d30" class="${moverSpan === "d30" ? "on" : ""}">30 days</button></div></div></div>
    <div id="movers">${moversPanel(moverSpan, 25)}</div>
    <p class="faint small">Moves cover every Pokémon product worth $5 or more. Estimates are rough guesses from past prices, not financial advice.</p>
  </div>`;
  dealsPanel();
  $("#mvSeg").onclick = e => { const b = e.target.closest("button"); if (!b) return; moverSpan = b.dataset.s;
    [...$("#mvSeg").children].forEach(x => x.classList.toggle("on", x === b)); $("#movers").innerHTML = moversPanel(moverSpan, 25); };
}

let dealKind = "cards";
async function dealsPanel() {
  const el = $("#deals"); if (!el) return;
  if (!D.deals) D.deals = await getJSON("/data/deals.json").catch(() => ({deals: [], volume: false, missing: true}));
  const all = D.deals.deals.filter(d => D.byPid.has(d.pid));
  const list = all.filter(d => (dealKind === "sealed") === !!D.byPid.get(d.pid).sealed);
  el.innerHTML = `<div class="head"><h2 class="sec">Deals right now</h2><div class="right"><div class="seg" id="dealSeg">
      <button data-k="cards" class="${dealKind === "cards" ? "on" : ""}">Cards</button><button data-k="sealed" class="${dealKind === "sealed" ? "on" : ""}">Sealed</button></div></div></div>
    <div class="list">${list.slice(0, 25).map(d => { const c = D.byPid.get(d.pid);
      return `<div class="prow">${thumb(d.pid, "sm")}<a class="t" href="#/card/${d.pid}/${encodeURIComponent(d.sub)}" style="text-decoration:none">
        <div class="n">${esc(c.name)}</div><div class="m">${esc(D.sets.get(d.gid)?.name || "")}${d.sub !== "Normal" ? " · " + esc(d.sub) : ""}</div>
        <div class="m"><span class="up">${Math.round(d.off * 100)}% under</span> market ${money(d.market)}</div>
        ${d.sold30 != null ? `<div class="m">${d.sold30} sold in 30 days${d.nm30 != null ? ` (${d.nm30} NM)` : ""}</div>` : ""}</a>
        <div class="p"><b>${money(d.low)}</b><a class="btn sm" href="${tcgUrl(d.pid)}" target="_blank" rel="noopener" style="margin-top:4px">Listings ↗</a></div></div>`; }).join("")
      || `<div class="empty">${D.deals.missing ? "Deals appear after the next daily price update." : "No deals right now."}</div>`}</div>
    <p class="faint small" style="margin:8px 0 0">Cheapest TCGplayer listing 20–50% under market, for things worth $5+${D.deals.volume ? " that sold in Near Mint in the last 30 days" : ""}. The cheapest listing can still be a played copy or carry high shipping, so open the listings before you buy. Updated daily (${esc(D.deals.as_of || "")}).</p>`;
  $("#dealSeg").onclick = e => { const b = e.target.closest("button"); if (!b) return; dealKind = b.dataset.k; dealsPanel(); };
}

// ================================================================ box EV
// Expected cards of each rarity per pack (approximate Scarlet & Violet odds; editable).
const DEFAULT_RATES = {"Common": 4, "Uncommon": 3, "Rare": .66, "Holo Rare": .33, "Double Rare": .2, "Ultra Rare": .067,
  "Illustration Rare": .077, "Special Illustration Rare": .0116, "Hyper Rare": .0072, "ACE SPEC Rare": .05,
  "Shiny Rare": .08, "Shiny Ultra Rare": .015, "Black White Rare": .006};
const REVERSE_SLOTS = 1.85;
async function boxEV(pid, rates, packs) {
  const row = D.byPid.get(pid), s = await setFile(row.gid);
  const prod = s.products.find(p => p[0] === pid);
  const mainPrice = id => { const l = s.latest[id] || {}; let best = null;
    for (const [sub, v] of Object.entries(l)) if (sub !== "Reverse Holofoil" && (best == null || v[1] > best)) best = v[1]; return best; };
  const byR = new Map(), rev = [];
  for (const [id, name, , rarity, sealed] of s.products) {
    if (sealed) continue;
    const p = mainPrice(id);
    const r = (s.latest[id] || {})["Reverse Holofoil"];
    if (r) rev.push(r[1]);
    if (p != null) { const k = rarity || "Unknown"; if (!byR.has(k)) byR.set(k, []); byR.get(k).push({id, name, price: p}); }
  }
  const R = {...DEFAULT_RATES, ...rates};
  let evPack = 0;
  const rows = [], top = [];
  for (const [rarity, cs] of byR) {
    const avg = cs.reduce((a, c) => a + c.price, 0) / cs.length, rate = R[rarity] ?? null, ev = rate ? avg * rate : 0;
    evPack += ev;
    rows.push({rarity, cards: cs.length, avg, rate, ev});
    if (rate) for (const c of cs) top.push({...c, rarity, perPack: rate / cs.length});
  }
  const revAvg = rev.length ? rev.reduce((a, b) => a + b, 0) / rev.length : 0;
  evPack += revAvg * REVERSE_SLOTS;
  rows.sort((a, b) => b.ev - a.ev);
  top.sort((a, b) => b.price * b.perPack - a.price * a.perPack);
  const n = packs || (prod && prod[5]) || null;
  const sealedPrice = mainPrice(pid);
  const total = n ? evPack * n : null;
  const sealedList = s.products.filter(p => p[4]).map(([id, name, , , , packs]) => ({id, name, packs, price: mainPrice(id)}));
  return {pid, name: row.name, set: D.sets.get(row.gid), packs: n, sealedList, sealedPrice, evPack, total, ratio: total && sealedPrice ? total / sealedPrice : null,
          revAvg, rows, top: top.filter(t => t.perPack < 1 && t.price >= 1).slice(0, 12), priced: [...byR.values()].reduce((a, c) => a + c.length, 0)};
}
// Every sealed product in the set with a known pack count, cheapest per pack first.
function packsTable(e) {
  const rows = e.sealedList.filter(x => x.packs && x.price).map(x => ({...x, per: x.price / x.packs})).sort((a, b) => a.per - b.per);
  if (!rows.length) return '<div class="empty">No sealed products with a known pack count in this set.</div>';
  return `<div class="scroll-x"><table class="t"><thead><tr><th>Product</th><th class="num">Per pack</th><th class="num">EV ÷ price</th></tr></thead><tbody>
    ${rows.map((x, i) => `<tr${x.id === e.pid ? ' class="hl"' : ""}><td><a href="#/ev/${x.id}">${esc(x.name.replace(e.set?.name || "\u0000", "").replace(/^\s*[-–:]\s*/, "") || x.name)}</a>${i === 0 ? ' <span class="pill up">cheapest</span>' : ""}
      <div class="faint small">${money(x.price)} · ${x.packs} pack${x.packs > 1 ? "s" : ""}</div></td>
      <td class="num"><b>${money(x.per)}</b></td>
      <td class="num">${e.evPack ? (e.evPack / x.per).toFixed(2) + "×" : "–"}</td></tr>`).join("")}</tbody></table></div>
    <p class="faint small" style="margin:8px 0 0">Pack counts come from TCGplayer's product descriptions. EV ÷ price above 1 means the pulls are worth more than you paid on average. ETBs and collections also include promos, sleeves and dice that aren't counted.</p>`;
}
let evState = {rates: {}, packs: null};
async function pageEV(view, pid) {
  const popular = D.catalog.filter(r => r.sealed && r.price && /booster box$|elite trainer box$|booster bundle$/i.test(r.name)).slice(0, 0);
  view.innerHTML = `<div class="stack"><h1 class="page">Box EV</h1>
    <div class="panel"><p class="note" style="margin-top:0">Is it worth opening? Pick a booster box, ETB, bundle or pack. EV is what the cards you'd pull are worth on average at today's prices.</p>
      <input class="input" id="evQ" type="search" placeholder="e.g. “prismatic etb” or “surging sparks booster box”" autocomplete="off" aria-label="Search sealed products">
      <div class="list" id="evRes"></div></div>
    <div id="evOut"></div></div>`;
  $("#evQ").oninput = () => { const v = $("#evQ").value.trim();
    $("#evRes").innerHTML = v.length < 2 ? "" : search(v, "sealed", 25).map(r => prow(r, `#/ev/${r.pid}`)).join("") || '<div class="empty">No sealed products match.</div>'; };
  if (!pid) return;
  if (evState.pid !== pid) evState = {pid, rates: {}, packs: null};
  const out = $("#evOut");
  out.innerHTML = '<div class="panel"><div class="skeleton" style="height:160px"></div></div>';
  const e = await boxEV(pid, evState.rates, evState.packs);
  const r = e.ratio, verdict = r == null ? ["Enter the pack count", "flat"] : r >= 1.1 ? ["Opening looks +EV", "up"] : r >= .9 ? ["About break-even", "flat"] : ["Better sealed, or buy singles", "down"];
  out.innerHTML = `<div class="stack"><div class="panel">
      <div class="prow" style="padding:0;border:0">${thumb(pid)}<div class="t"><div class="n">${esc(e.name)}</div><div class="m">${esc(e.set?.name || "")}</div></div>
        <a class="btn sm" href="${tcgUrl(pid)}" target="_blank" rel="noopener">TCGplayer ↗</a></div>
      <div class="ev-big">
        <div><div class="k">Sealed price</div><div class="v">${money(e.sealedPrice)}</div><div class="faint small">${e.packs && e.sealedPrice ? money(e.sealedPrice / e.packs) + "/pack" : ""}</div></div>
        <div><div class="k">EV opened</div><div class="v">${money(e.total)}</div><div class="faint small">${money(e.evPack)}/pack</div></div>
        <div><div class="k">EV ÷ price</div><div class="v ${verdict[1]}">${r == null ? "–" : r.toFixed(2) + "×"}</div><div class="faint small">${verdict[0]}</div></div>
      </div>
      <div class="form"><div class="field"><label for="evPacks">Packs inside</label><input class="input" id="evPacks" type="number" min="1" inputmode="numeric" value="${e.packs || ""}"></div></div>
      <p class="note">Uses average market prices by rarity and approximate Scarlet &amp; Violet pull rates (edit them below for other sets). It's an average over many boxes; most single boxes land under it, and selling cards costs fees and time. ${e.priced} priced cards in this set.</p>
    </div>
    <div class="panel"><h2 class="sec">By rarity</h2><div class="scroll-x"><table class="t">
      <thead><tr><th>Rarity</th><th class="num">Avg</th><th class="num">Per pack</th><th class="num">EV/pack</th></tr></thead>
      <tbody>${e.rows.map(x => `<tr><td>${esc(x.rarity)} <span class="faint small">(${x.cards})</span></td><td class="num">${money(x.avg)}</td>
        <td class="num"><input class="input mono" data-rarity="${esc(x.rarity)}" type="number" min="0" step="0.001" inputmode="decimal" value="${x.rate ?? ""}" placeholder="?" aria-label="${esc(x.rarity)} per pack"></td>
        <td class="num">${money(x.ev)}</td></tr>`).join("")}
        <tr><td>Reverse holos</td><td class="num">${money(e.revAvg)}</td><td class="num">${REVERSE_SLOTS}</td><td class="num">${money(e.revAvg * REVERSE_SLOTS)}</td></tr></tbody></table></div>
      <div class="actions" style="margin-top:10px"><button class="btn primary" id="evApply">Recalculate</button><span class="faint small">Per pack = cards of that rarity in an average pack (0.0116 ≈ 1 in 86).</span></div></div>
    <div class="panel"><h2 class="sec">Chase cards</h2><div class="list">${e.top.map(t => `<a class="prow" href="#/card/${t.id}/">${thumb(t.id, "sm")}
      <div class="t"><div class="n">${esc(t.name)}</div><div class="m">${esc(t.rarity)} · 1 in ${Math.round(1 / t.perPack).toLocaleString()} packs${e.packs ? ` · ${Math.min(99, (1 - Math.pow(1 - t.perPack, e.packs)) * 100).toFixed(0)}% per box` : ""}</div></div>
      <div class="p"><b>${money(t.price)}</b></div></a>`).join("") || '<div class="empty">No priced chase cards yet.</div>'}</div></div>
    <div class="panel"><h2 class="sec">Cheapest packs in ${esc(e.set?.name || "this set")}</h2>${packsTable(e)}</div></div>`;
  $("#evApply").onclick = () => {
    for (const i of out.querySelectorAll("[data-rarity]")) if (i.value !== "") evState.rates[i.dataset.rarity] = +i.value;
    evState.packs = +$("#evPacks").value || null;
    pageEV(view, pid);
  };
}

// ================================================================ collection
async function pageCollection(view) {
  view.innerHTML = '<div class="panel"><div class="skeleton" style="height:160px"></div></div>';
  await refreshMe();
  const rows = await Promise.all((ME.collection || []).map(async c => ({c, it: D.byPid.has(c.pid) ? await item(c.pid, c.sub).catch(() => null) : null})));
  let value = 0, cost = 0, pv = 0, pc = 0, year = 0, count = 0, unpriced = 0;
  for (const {c, it} of rows) {
    const each = c.value_override ?? (c.grade ? null : it?.now ?? null);
    c._each = each; c._value = each != null ? each * c.qty : null; c._cost = c.cost != null ? c.cost * c.qty : null;
    count += c.qty;
    if (c._value != null) value += c._value; else unpriced++;
    if (c._cost != null) cost += c._cost;
    if (c._value != null && c._cost != null) { pv += c._value; pc += c._cost; }
    const y = !c.grade && it?.forecast.ok ? it.forecast.points[3].price : each;
    year += (y || 0) * c.qty;
  }
  view.innerHTML = `<div class="stack">${collHead("mine")}
    <div class="stats">
      <div class="stat"><div class="k">Items</div><div class="v">${count}</div><div class="s">${unpriced ? unpriced + " without a value" : " "}</div></div>
      <div class="stat"><div class="k">Value now</div><div class="v">${money(value)}</div><div class="s">raw market prices</div></div>
      <div class="stat"><div class="k">Profit / loss</div><div class="v">${pc ? signed(pv - pc) : "–"}</div><div class="s">${cost ? "paid " + money(cost) : "add what you paid"}</div></div>
      <div class="stat"><div class="k">In 1 year</div><div class="v">${rows.length ? money(year) : "–"}</div><div class="s">rough estimate</div></div>
    </div>
    <div class="panel"><div class="head"><h2 class="sec">Everything</h2><div class="right"><button class="btn sm" id="csv">Export CSV</button></div></div>
    <div class="list">${rows.length ? rows.map(({c, it}) => {
      const pl = c._value != null && c._cost != null ? c._value - c._cost : null;
      return `<div><div class="prow">${thumb(c.pid)}<a class="t" href="#/card/${c.pid}/${encodeURIComponent(c.sub)}" style="text-decoration:none">
          <div class="n">${c.qty > 1 ? c.qty + "× " : ""}${esc(it?.name || "#" + c.pid)}</div>
          <div class="m">${esc(it?.set?.name || "")} · ${esc(c.grade || c.condition || "")}${c.sub !== "Normal" ? " · " + esc(c.sub) : ""}</div>
          <div class="m">${c.cost != null ? "paid " + money(c.cost) + " ea" : "paid ?"}${c.bought ? " · " + esc(c.bought) : ""}${c.note ? " · " + esc(c.note) : ""}</div></a>
        <div class="p"><b>${c._value != null ? money(c._value) : '<span class="faint">set value</span>'}</b><span>${pl != null ? signed(pl) : ""}</span>
          <button class="btn sm ghost" data-edit="${c.id}" style="margin-top:4px">Edit</button></div></div><div id="edit-${c.id}"></div></div>`;
    }).join("") : '<div class="empty">Nothing yet. Open any card and press “+ Collection”.</div>'}</div></div></div>`;
  $("#csv").onclick = () => {
    const lines = [["name", "set", "printing", "qty", "condition", "grade", "paid_each", "bought", "value_each", "value", "note", "tcgplayer"]];
    for (const {c, it} of rows) lines.push([it?.name || c.pid, it?.set?.name || "", c.sub, c.qty, c.condition || "", c.grade || "", c.cost ?? "", c.bought || "", c._each ?? "", c._value ?? "", c.note || "", tcgUrl(c.pid)]);
    const csv = lines.map(l => l.map(v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + csv], {type: "text/csv"}));
    a.download = "pokemon-collection.csv"; a.click();
  };
  view.onclick = async e => {
    const b = e.target.closest("[data-edit]");
    if (b) {
      const c = ME.collection.find(x => x.id === +b.dataset.edit), box = $("#edit-" + c.id);
      if (box.innerHTML) { box.innerHTML = ""; return; }
      const fld = (k, label, v, type = "text", extra = "") => `<div class="field"><label>${label}</label><input class="input" data-f="${k}" type="${type}" value="${esc(v ?? "")}" ${extra}></div>`;
      box.innerHTML = `<div style="padding:4px 0 14px"><div class="form">
        ${fld("qty", "Quantity", c.qty, "number", 'min="1"')}${fld("cost", "Paid each ($)", c.cost, "number", 'step="0.01"')}
        ${fld("condition", "Condition", c.condition)}${fld("grade", "Grade", c.grade, "text", 'placeholder="PSA 10"')}
        ${fld("value_override", "Value each ($)", c.value_override, "number", 'step="0.01" placeholder="market"')}${fld("bought", "Bought", c.bought, "date")}
        ${fld("note", "Note", c.note)}</div>
        <div class="actions" style="margin-top:10px"><button class="btn primary" data-save="${c.id}">Save</button><button class="btn" data-del="${c.id}">Remove</button>
        <span class="faint small">Leave “Value each” empty to use the raw market price.</span></div></div>`;
      return;
    }
    const s = e.target.closest("[data-save]"), d = e.target.closest("[data-del]");
    if (s) {
      const body = {action: "update", id: +s.dataset.save};
      for (const i of $("#edit-" + s.dataset.save).querySelectorAll("[data-f]")) body[i.dataset.f] = i.value;
      try { await api("/collection", body); toast("Saved"); pageCollection(view); } catch (err) { toast(err.message); }
    } else if (d) {
      if (d.dataset.sure !== "1") { d.dataset.sure = "1"; d.textContent = "Tap again to remove"; return; }
      try { await api("/collection", {action: "delete", id: +d.dataset.del}); toast("Removed"); pageCollection(view); } catch (err) { toast(err.message); }
    }
  };
}

const collHead = on => `<div class="head" style="margin:0"><h1 class="page" style="margin:0">Collection</h1><div class="right"><div class="seg">
  <a href="#/collection" class="${on === "mine" ? "on" : ""}">My cards</a><a href="#/collection/sets${store.get("setGid", null) ? "/" + store.get("setGid") : ""}" class="${on === "sets" ? "on" : ""}">Set tracker</a></div></div></div>`;

// ================================================================ set tracker
let setScope = store.get("setScope", "main");
async function pageSets(view, gid) {
  if (gid) store.set("setGid", gid);
  const sets = [...D.sets.values()].sort((a, b) => (b.published || "").localeCompare(a.published || ""));
  view.innerHTML = `<div class="stack">${collHead("sets")}
    <div class="panel"><p class="note" style="margin-top:0">Pick a set to see what you own, what's missing, and what the rest costs. Cards count as owned when they're in your collection.</p>
      <input class="input" id="setQ" type="search" placeholder="Search sets, e.g. “prismatic” or “151”" autocomplete="off" aria-label="Search sets">
      <div class="list" id="setRes"></div></div>
    <div id="setOut"></div></div>`;
  const showSets = v => { v = v.toLowerCase().trim();
    $("#setRes").innerHTML = (v ? sets.filter(x => (x.name + " " + x.abbr).toLowerCase().includes(v)) : gid ? [] : sets).slice(0, v ? 30 : 8)
      .map(x => `<a class="prow" href="#/collection/sets/${x.gid}"><div class="t"><div class="n">${esc(x.name)}</div><div class="m">${esc(x.abbr || "")}${x.published ? " · " + esc(x.published.slice(0, 4)) : ""}</div></div></a>`).join(""); };
  $("#setQ").oninput = () => showSets($("#setQ").value);
  showSets("");
  if (!gid) return;
  const out = $("#setOut");
  out.innerHTML = '<div class="panel"><div class="skeleton" style="height:160px"></div></div>';
  await refreshMe();
  const sf = await setFile(gid), set = D.sets.get(gid);
  const owned = new Set((ME.collection || []).map(c => c.pid));
  const priceOf = id => { const l = sf.latest[id] || {}; let best = null;   // cheapest printing that isn't a reverse holo
    for (const [sub, v] of Object.entries(l)) if (sub !== "Reverse Holofoil" && v[1] && (best == null || v[1] < best[1])) best = [sub, v[1]];
    return best || (l["Reverse Holofoil"] ? ["Reverse Holofoil", l["Reverse Holofoil"][1]] : [null, null]); };
  const numOf = n => { const m = /^(\d+)\s*\/\s*(\d+)/.exec(n || ""); return m ? [+m[1], +m[2]] : [null, null]; };
  let cards = sf.products.filter(p => !p[4] && p[2]).map(([id, name, number, rarity]) => {
    const [n, of] = numOf(number), [sub, price] = priceOf(id);
    return {id, name, number, rarity, n, of, sub, price, have: owned.has(id)};
  });
  const printed = cards.reduce((a, c) => c.of && (!a || c.of < a) ? c.of : a, null);
  const secret = cards.filter(c => printed && c.n > printed).length;
  if (setScope === "main" && printed) cards = cards.filter(c => !c.n || c.n <= printed);
  cards.sort((a, b) => (a.n ?? 1e9) - (b.n ?? 1e9) || a.number.localeCompare(b.number));
  const have = cards.filter(c => c.have), miss = cards.filter(c => !c.have).sort((a, b) => (a.price ?? 1e9) - (b.price ?? 1e9));
  const missCost = miss.reduce((a, c) => a + (c.price || 0), 0), unpriced = miss.filter(c => c.price == null).length;
  const pctDone = cards.length ? have.length / cards.length : 0;
  out.innerHTML = `<div class="stack"><div class="panel">
      <div class="head"><h2 class="sec">${esc(set?.name || "Set")}</h2><div class="right"><div class="seg" id="scopeSeg">
        <button data-s="main" class="${setScope === "main" ? "on" : ""}">Main set${printed ? " (" + printed + ")" : ""}</button><button data-s="all" class="${setScope === "all" ? "on" : ""}">Everything${secret ? " (+" + secret + ")" : ""}</button></div></div></div>
      <div class="progress"><i style="width:${(pctDone * 100).toFixed(1)}%"></i></div>
      <div class="stats" style="margin-top:12px">
        <div class="stat"><div class="k">Have</div><div class="v">${have.length}/${cards.length}</div><div class="s">${Math.round(pctDone * 100)}% done</div></div>
        <div class="stat"><div class="k">To finish</div><div class="v">${money(missCost)}</div><div class="s">${unpriced ? unpriced + " unpriced, " : ""}cheapest printings</div></div>
      </div>
      <p class="faint small" style="margin:10px 0 0">Reverse holos aren't counted separately. “Have it” adds a card to your collection (no price paid); edit it there.</p></div>
    <div class="panel"><h2 class="sec">Missing, cheapest first</h2><div class="list">${miss.map(c => `<div class="prow">${thumb(c.id, "sm")}
      <a class="t" href="#/card/${c.id}/${encodeURIComponent(c.sub || "")}" style="text-decoration:none"><div class="n">${esc(c.name)}</div><div class="m">#${esc(c.number)}${c.rarity ? " · " + esc(c.rarity) : ""}</div></a>
      <div class="p"><b>${money(c.price)}</b><button class="btn sm" data-have="${c.id}" data-sub="${esc(c.sub || "Normal")}" style="margin-top:4px">Have it</button></div></div>`).join("") || '<div class="empty">Complete! 🎉</div>'}</div></div>
    ${have.length ? `<div class="panel"><h2 class="sec">Have (${have.length})</h2><div class="list">${have.map(c => `<a class="prow" href="#/card/${c.id}/${encodeURIComponent(c.sub || "")}">${thumb(c.id, "sm")}
      <div class="t"><div class="n">${esc(c.name)}</div><div class="m">#${esc(c.number)}</div></div><div class="p"><b>${money(c.price)}</b></div></a>`).join("")}</div></div>` : ""}</div>`;
  $("#scopeSeg").onclick = e => { const b = e.target.closest("button"); if (!b) return; setScope = b.dataset.s; store.set("setScope", setScope); pageSets(view, gid); };
  out.onclick = async e => {
    const b = e.target.closest("[data-have]"); if (!b) return;
    b.disabled = true;
    try { await api("/collection", {action: "add", pid: +b.dataset.have, sub: b.dataset.sub, qty: 1}); toast("Added to collection"); pageSets(view, gid); }
    catch (err) { b.disabled = false; toast(err.message); }
  };
}

// ================================================================ restock
const ago = iso => { if (!iso) return "never"; const m = (Date.now() - Date.parse(iso)) / 6e4;
  return m < 1 ? "just now" : m < 60 ? Math.round(m) + " min ago" : m < 1440 ? Math.round(m / 60) + " h ago" : Math.round(m / 1440) + " d ago"; };
const TARGET_LINKS = [["Pokémon cards at Target", "https://www.target.com/s?searchTerm=pokemon+trading+cards&facetedValue=5zkty"],
  ["Elite Trainer Boxes", "https://www.target.com/s?searchTerm=pokemon+elite+trainer+box"],
  ["Delta Reign", "https://www.target.com/s?searchTerm=pokemon+delta+reign"]];
async function pageRestock(view) {
  view.innerHTML = '<div class="panel"><div class="skeleton" style="height:160px"></div></div>';
  const r = await api("/restock");
  const inStock = r.items.filter(i => i.available), run = r.lastRun;
  const shopRow = sh => { const res = run?.shops?.find(x => x.name === sh.name);
    return `<div class="prow"><div class="t"><div class="n">${esc(sh.name)}</div><div class="m">${esc(sh.url.replace(/^https:\/\//, ""))} · ${esc(sh.platform)}</div></div>
      <div class="p">${!res ? '<span class="faint">not checked yet</span>' : res.error ? `<span class="down">failing</span><br><span class="faint small">${esc(res.error)}</span>`
        : `<span class="up">working</span><br><span class="faint small">${res.items} watched · ${res.inStock} in stock</span>`}</div></div>`; };
  view.innerHTML = `<div class="stack"><h1 class="page">Restock</h1>
    <div class="stats">
      <div class="stat"><div class="k">In stock now</div><div class="v">${inStock.length}</div><div class="s">of ${r.items.length} watched</div></div>
      <div class="stat"><div class="k">Last check</div><div class="v" style="font-size:20px">${ago(run?.t)}</div><div class="s">${r.paused ? "paused" : "every 5 minutes"}</div></div>
      <div class="stat"><div class="k">Phone alerts</div><div class="v" style="font-size:20px">${r.ntfyTopicSet ? "On" : "Off"}</div><div class="s">${r.ntfyTopicSet ? "ntfy " + esc(r.ntfyTopicHint) : "add your ntfy topic below"}</div></div>
    </div>
    <div class="actions"><button class="btn primary" id="rsRun">Check now</button><button class="btn" id="rsTest">Send test alert</button>
      <button class="btn ghost" id="rsPause">${r.paused ? "Resume checks" : "Pause checks"}</button></div>
    <div class="panel"><h2 class="sec">In stock now</h2><div class="list">${inStock.map(i => `<a class="prow" href="${esc(i.url)}" target="_blank" rel="noopener">
        <div class="t"><div class="n">${esc(i.name)}</div><div class="m">${esc(i.shop)} · in stock since ${ago(i.last_change)}</div></div>
        <div class="p"><b>${i.price ? money(i.price) : ""}</b><span class="faint">Open ↗</span></div></a>`).join("")
      || '<div class="empty">Nothing sealed in stock at your shops right now. You\'ll get a push when that changes.</div>'}</div></div>
    <div class="panel"><h2 class="sec">Target</h2>
      <p class="note" style="margin-top:0">Target blocks automatic stock checks (it answers with a captcha), so these are quick links instead. On a product page, tap “Check other stores” to see stock near 72701.</p>
      <div class="linkbar">${TARGET_LINKS.map(([l, u]) => `<a href="${u}" target="_blank" rel="noopener">${esc(l)} ↗</a>`).join("")}</div></div>
    <div class="panel"><h2 class="sec">Recent activity</h2><div class="list">${r.events.slice(0, 30).map(e => `<a class="prow" href="${esc(e.url)}" target="_blank" rel="noopener">
        <div class="t"><div class="n">${esc(e.name)}</div><div class="m">${esc(e.shop)} · ${new Date(e.t).toLocaleString(undefined, {month: "short", day: "numeric", hour: "numeric", minute: "2-digit"})}</div></div>
        <div class="p"><span class="pill ${e.kind === "sold out" ? "down" : "up"}">${e.kind === "new" ? "New" : e.kind === "restock" ? "Restocked" : "Sold out"}</span></div></a>`).join("")
      || '<div class="empty">No restocks seen yet.</div>'}</div></div>
    <div class="panel"><h2 class="sec">Release reminders</h2>
      <p class="note" style="margin-top:0">A push on the morning of a release (Central time), so you remember to check Target and the shops.</p>
      <div class="list">${r.reminders.map((m, i) => `<div class="prow"><div class="t"><div class="n">${esc(m.text)}</div>
        <div class="m">${esc(m.date)} at ${esc(m.time)}${m.sent ? " · sent" : ""}</div></div><div class="p"><button class="btn sm ghost" data-rmdel="${i}">Remove</button></div></div>`).join("") || '<div class="empty">No reminders.</div>'}</div>
      <div class="form" style="margin-top:10px">
        <div class="field"><label for="rmDate">Date</label><input class="input" id="rmDate" type="date"></div>
        <div class="field"><label for="rmTime">Time</label><input class="input" id="rmTime" type="time" value="07:00"></div>
        <div class="field" style="grid-column:1/-1"><label for="rmText">Message</label><input class="input" id="rmText" placeholder="e.g. Ascended Heroes is out today"></div>
      </div><div class="actions" style="margin-top:10px"><button class="btn" id="rmAdd">Add reminder</button></div></div>
    <div class="panel"><h2 class="sec">Shops</h2><div class="list">${r.shops.map(shopRow).join("")}</div>
      <p class="note">Works with shops on Shopify or WooCommerce (most local card shops). Paste the shop's home page.</p>
      <div class="form"><div class="field"><label for="shName">Name</label><input class="input" id="shName" placeholder="My LCS"></div>
        <div class="field"><label for="shUrl">Website</label><input class="input" id="shUrl" placeholder="https://…" inputmode="url"></div>
        <div class="field"><label for="shPlat">Platform</label><select class="input" id="shPlat"><option value="shopify">Shopify</option><option value="woocommerce">WooCommerce</option></select></div></div>
      <div class="actions" style="margin-top:10px"><button class="btn" id="shAdd">Add shop</button>${r.shops.length ? `<select class="input" id="shDelSel" style="width:auto">${r.shops.map((x, i) => `<option value="${i}">${esc(x.name)}</option>`).join("")}</select><button class="btn ghost" id="shDel">Remove</button>` : ""}</div></div>
    <div class="panel"><h2 class="sec">Phone alerts</h2>
      <p class="note" style="margin-top:0">Alerts go through <a href="https://ntfy.sh" target="_blank" rel="noopener">ntfy</a>, the same app your old notifier used. Put your topic name here (it's in your old config.toml under [notify]).</p>
      <div class="form"><div class="field"><label for="ntTopic">ntfy topic</label><input class="input" id="ntTopic" autocomplete="off" autocapitalize="off" placeholder="${r.ntfyTopicSet ? "saved (" + esc(r.ntfyTopicHint) + "), type to replace" : "your-secret-topic"}"></div></div>
      <div class="actions" style="margin-top:10px"><button class="btn primary" id="ntSave">Save</button></div></div>
    <p class="faint small">Not checked automatically: Target, Walmart, GameStop and Pokémon Center all block automated stock checks.</p>
  </div>`;
  const save = async (body, msg) => { try { await api("/restock/settings", body); toast(msg); pageRestock(view); } catch (e) { toast(e.message); } };
  $("#rsRun").onclick = async e => { e.target.disabled = true; e.target.textContent = "Checking…";
    try { const s = await api("/restock/run", {}); toast(s.alerts ? `${s.alerts} alert${s.alerts > 1 ? "s" : ""} sent` : "Checked. Nothing new."); } catch (err) { toast(err.message); }
    pageRestock(view); };
  $("#rsTest").onclick = async () => { try { await api("/restock/test", {}); toast("Test alert sent. Check your phone."); } catch (e) { toast(e.message); } };
  $("#rsPause").onclick = () => save({paused: !r.paused}, r.paused ? "Checks resumed" : "Checks paused");
  $("#ntSave").onclick = () => { const v = $("#ntTopic").value.trim(); if (!v) return toast("Type your ntfy topic first"); save({ntfyTopic: v}, "Saved. Send a test alert to try it."); };
  $("#rmAdd").onclick = () => { const d = $("#rmDate").value; if (!d) return toast("Pick a date");
    save({reminders: [...r.reminders, {date: d, time: $("#rmTime").value || "07:00", text: $("#rmText").value.trim() || "Release day: check Target and the shops",
      url: "https://www.target.com/s?searchTerm=pokemon+trading+cards"}]}, "Reminder added"); };
  view.querySelectorAll("[data-rmdel]").forEach(b => b.onclick = () => save({reminders: r.reminders.filter((_, i) => i !== +b.dataset.rmdel)}, "Reminder removed"));
  $("#shAdd").onclick = () => { const u = $("#shUrl").value.trim(); if (!/^https:\/\//.test(u)) return toast("Paste the shop's https:// address");
    save({shops: [...r.shops, {name: $("#shName").value.trim() || new URL(u).hostname, url: u, platform: $("#shPlat").value}]}, "Shop added. Press Check now."); };
  if ($("#shDel")) $("#shDel").onclick = () => save({shops: r.shops.filter((_, i) => i !== +$("#shDelSel").value)}, "Shop removed");
}

// ================================================================ login + boot
function renderLogin(msg) {
  $("#root").innerHTML = `<div class="login"><form class="panel" id="loginForm">
    <div class="brand">${MARK}Card Market</div>
    <h1>Sign in</h1>
    <div class="field"><label for="pw">Password</label><input class="input" id="pw" type="password" autocomplete="current-password" required></div>
    <button class="btn primary" type="submit">Sign in</button>
    <div class="warn" id="loginMsg">${esc(msg || "")}</div></form></div>`;
  $("#loginForm").onsubmit = async e => {
    e.preventDefault();
    try { const r = await api("/login", {password: $("#pw").value}); token = r.token; store.set("token", token); boot(); }
    catch (err) { $("#loginMsg").textContent = err.message; }
  };
  $("#pw").focus();
}

async function boot() {
  if (!token) return renderLogin();
  $("#root").innerHTML = '<div class="login"><div class="faint">Loading prices…</div></div>';
  try { await loadData(); }
  catch (e) { $("#root").innerHTML = `<div class="login"><div class="panel"><b>Couldn't load prices.</b><p class="note">${esc(e.message)}</p><button class="btn" onclick="location.reload()">Try again</button></div></div>`; return; }
  getJSON("/data/movers.json").then(m => { D.movers = m; if (!location.hash || location.hash === "#/") route(); }).catch(() => {});
  renderShell();
  document.addEventListener("click", e => { if (e.target.id === "signout") { e.preventDefault(); token = null; store.set("token", null); renderLogin(); } });
  addEventListener("hashchange", route);
  addEventListener("resize", () => { clearTimeout(boot._r); boot._r = setTimeout(route, 250); });
  await refreshMe().catch(() => {});
  route();
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
boot();
