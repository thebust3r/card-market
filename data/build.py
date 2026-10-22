#!/usr/bin/env python3
"""Daily data build for Card Market.

Pulls every Pokémon card and sealed product with today's TCGplayer prices
from TCGCSV (tcgcsv.com), merges them into the price history kept from
earlier runs, and writes the static JSON files the app reads:

    out/meta.json            when it ran, how much history there is
    out/sets.json            every set, newest first
    out/catalog.json         one row per product for search
    out/movers.json          biggest 7- and 30-day moves
    out/set/<groupId>.json   a set's products, rarities and price history

    python3 build.py --prev <last run's output> --out <dir>

On the first run (no previous output) it fills in about two years of history
from TCGCSV's daily price archive, which needs `7z` (p7zip) or `bsdtar`.
Only uses the Python standard library.
"""
import argparse
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

BASE = "https://tcgcsv.com/tcgplayer/3"          # category 3 = Pokémon
ARCHIVE = "https://tcgcsv.com/archive/tcgplayer/prices-{}.ppmd.7z"
ARCHIVE_START = dt.date(2024, 2, 8)
UA = "CardMarket/2.0 (personal price tracker; github actions)"
TCG_HISTORY = "https://infinite-api.tcgplayer.com/price/history/{}/detailed?range=month"
BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36"
DAILY_DAYS = 40         # keep every day this far back, then one point a week
PACKS_BY_NAME = [("booster box case", 216), ("booster box", 36), ("booster display", 36),
                 ("elite trainer box", 9), ("booster bundle", 6), ("build & battle", 4),
                 ("3 pack blister", 3), ("3-pack blister", 3), ("sleeved booster", 1), ("booster pack", 1)]


def log(*a):
    print(*a, flush=True)


def http_json(url, tries=4):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                data = json.loads(r.read())
            if data.get("success") is False:
                raise RuntimeError(f"{url}: {data.get('errors')}")
            return data
        except urllib.error.HTTPError as e:
            if e.code == 404 or i == tries - 1:
                raise
        except Exception:
            if i == tries - 1:
                raise
        time.sleep(2 ** i)


def data_date(now=None):
    """TCGCSV refreshes around 20:00 UTC and its archive file for day D holds
    that day's prices, so prices fetched at time T belong to (T - 20h)."""
    now = now or dt.datetime.now(dt.timezone.utc)
    return (now - dt.timedelta(hours=20)).date()


def _ext(p, key):
    for e in p.get("extendedData") or []:
        if e.get("name") == key:
            return e.get("value")
    return None


def packs_from_text(name, text):
    m = re.search(r"(\d+)\s+(?:[^.\d<]{0,60}?)booster packs", (text or "").lower())
    if m and 0 < int(m.group(1)) <= 500:
        return int(m.group(1))
    name = (name or "").lower()
    for key, n in PACKS_BY_NAME:
        if key in name:
            return n
    return None


def num(v):
    return round(float(v), 2) if isinstance(v, (int, float)) and v > 0 else None


# ---------------------------------------------------------------- fetch

def fetch_catalog():
    groups = http_json(f"{BASE}/groups")["results"]
    log(f"{len(groups)} sets")

    def one(g):
        gid = g["groupId"]
        prods = http_json(f"{BASE}/{gid}/products")["results"]
        try:
            prices = http_json(f"{BASE}/{gid}/prices")["results"]
        except urllib.error.HTTPError:
            prices = []
        return gid, prods, prices

    out = {}
    with ThreadPoolExecutor(6) as ex:
        for gid, prods, prices in ex.map(one, groups):
            out[gid] = (prods, prices)
    return groups, out


# ---------------------------------------------------------------- archive backfill

def extractor():
    for exe in ("7z", "7za", "7zz"):
        if shutil.which(exe):
            return ("7z", shutil.which(exe))
    if shutil.which("bsdtar"):
        return ("bsdtar", shutil.which("bsdtar"))
    return None


def backfill_dates(today, days=730):
    offsets = list(range(7, 57, 7)) + list(range(77, 366, 21)) + list(range(395, days + 1, 30))
    return [today - dt.timedelta(days=o) for o in offsets if today - dt.timedelta(days=o) >= ARCHIVE_START]


def read_archive(day, tool):
    """{groupId: [price rows]} for Pokémon on `day`, or None if missing."""
    with tempfile.TemporaryDirectory() as tmp:
        arc = Path(tmp) / "a.7z"
        url = ARCHIVE.format(day.isoformat())
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
        try:
            with urllib.request.urlopen(req, timeout=180) as r, open(arc, "wb") as f:
                shutil.copyfileobj(r, f, 1 << 20)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            body = e.read(300).decode("utf-8", "replace").replace("\n", " ")
            log(f"  archive {day}: HTTP {e.code}: {body[:160]}")
            raise
        kind, path = tool
        if kind == "7z":
            cmd = [path, "x", "-y", f"-o{tmp}", str(arc), f"{day}/3/*", "-r"]
        else:
            cmd = [path, "-xf", str(arc), "-C", tmp, f"{day}/3"]
        subprocess.run(cmd, check=True, capture_output=True, timeout=900)
        out = {}
        for pf in (Path(tmp) / day.isoformat() / "3").glob("*/prices"):
            try:
                out[int(pf.parent.name)] = json.loads(pf.read_text(encoding="utf-8")).get("results", [])
            except (OSError, ValueError, json.JSONDecodeError):
                pass
        log(f"  archive {day}: {arc.stat().st_size / 1e6:.1f} MB, {len(out)} sets")
        return out


# ---------------------------------------------------------------- history

def add_point(hist, gid, rows, date):
    """hist: {gid: {pid: {sub: {date: [market, low, mid]}}}}"""
    g = hist.setdefault(gid, {})
    for r in rows:
        pid = r.get("productId")
        market = num(r.get("marketPrice")) or num(r.get("midPrice"))
        if not pid or market is None:
            continue
        sub = r.get("subTypeName") or "Normal"
        g.setdefault(pid, {}).setdefault(sub, {})[date] = [market, num(r.get("lowPrice")), num(r.get("midPrice"))]


def compact(points, today):
    """Keep every day for DAILY_DAYS, then the last point of each ISO week."""
    cut = (today - dt.timedelta(days=DAILY_DAYS)).isoformat()
    keep, weeks = {}, {}
    for d in sorted(points):
        if d >= cut:
            keep[d] = points[d]
        else:
            y, w, _ = dt.date.fromisoformat(d).isocalendar()
            weeks[(y, w)] = d
    for d in weeks.values():
        keep[d] = points[d]
    return keep


def change_over(series, days):
    """series: [(date, price)] oldest first -> relative change vs ~`days` ago."""
    if len(series) < 2:
        return None
    last = dt.date.fromisoformat(series[-1][0])
    target = last - dt.timedelta(days=days)
    tol = max(3, days // 3)
    best = None
    for d, p in series[:-1]:
        diff = abs((dt.date.fromisoformat(d) - target).days)
        if diff <= tol and (best is None or diff < best[0]):
            best = (diff, p)
    return round(series[-1][1] / best[1] - 1, 4) if best else None


def sold_last_30(pid):
    """{condition: copies sold} over the last ~30 days, from TCGplayer's own sales history."""
    req = urllib.request.Request(TCG_HISTORY.format(pid), headers={
        "User-Agent": BROWSER_UA, "Accept": "application/json", "Origin": "https://www.tcgplayer.com"})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.loads(r.read())
    out = {}
    for it in data.get("result") or []:
        n = sum(float(b.get("quantitySold") or 0) for b in it.get("buckets") or [])
        key = (it.get("variant") or "?", it.get("condition") or "?")
        out[key] = out.get(key, 0) + int(n)
    return out


def find_deals(cands, n=60):
    """cands: [pid, sub, gid, market, low]. Keep listings well under market that still sell."""
    cands.sort(key=lambda c: (c[3] - c[4]) * min(1, c[3] / 40), reverse=True)
    cands = cands[:240]
    volume, failed = {}, 0
    def one(pid):
        nonlocal failed
        try:
            volume[pid] = sold_last_30(pid)
        except Exception:
            failed += 1
        time.sleep(.2)
    with ThreadPoolExecutor(4) as ex:
        list(ex.map(one, sorted({c[0] for c in cands})))
    log(f"Deals: {len(cands)} candidates, sales volume for {len(volume)} ({failed} failed)")
    have_volume = len(volume) > len(cands) // 3
    out = []
    for pid, sub, gid, market, low in cands:
        v = volume.get(pid)
        if v and any(var == sub for var, _ in v):
            v = {k: n for k, n in v.items() if k[0] == sub}       # just this printing
        sold = sum(v.values()) if v else None
        nm = sum(n for (_, cond), n in v.items() if cond == "Near Mint") if v else None
        if have_volume and not nm:
            continue          # no Near Mint copy sold in a month: likely a played copy or a stale market price
        out.append({"pid": pid, "sub": sub, "gid": gid, "market": market, "low": low,
                    "off": round(1 - low / market, 3), "sold30": sold, "nm30": nm})
    out.sort(key=lambda d: d["off"] * (min(d["sold30"], 30) if d["sold30"] else 3), reverse=True)
    return out[:n], have_volume


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prev", help="previous run's output directory")
    ap.add_argument("--out", required=True)
    ap.add_argument("--backfill-days", type=int, default=730)
    a = ap.parse_args()
    out = Path(a.out)
    (out / "set").mkdir(parents=True, exist_ok=True)
    today = data_date()
    date = today.isoformat()

    # previous history
    hist, meta = {}, {}
    prev = Path(a.prev) if a.prev else None
    if prev and (prev / "meta.json").exists():
        meta = json.loads((prev / "meta.json").read_text())
        for f in (prev / "set").glob("*.json"):
            s = json.loads(f.read_text())
            g = hist.setdefault(int(s["gid"]), {})
            dates = s["dates"]
            for pid, subs in s["series"].items():
                for sub, cents in subs.items():
                    pts = {d: [c / 100, None, None] for d, c in zip(dates, cents) if c is not None}
                    lat = s["latest"].get(pid, {}).get(sub)
                    if lat and lat[0] in pts:
                        pts[lat[0]] = lat[1:]
                    g.setdefault(int(pid), {})[sub] = pts
        log(f"Loaded history for {len(hist)} sets from the last run")

    groups, cat = fetch_catalog()
    for gid, (_, prices) in cat.items():
        add_point(hist, gid, prices, date)

    # first run, or new archive dates wanted: fill in the past from the archive
    done = set(meta.get("archive_days", []))
    want = [d for d in backfill_dates(today, a.backfill_days) if d.isoformat() not in done]
    # TCGCSV took the archive offline in 2026 ("temporarily removed due to rising server
    # costs"). Look once a week whether it's back; the app fills older history from
    # TCGplayer's own sales history in the meantime.
    checked = meta.get("archive_checked")
    due = not checked or (today - dt.date.fromisoformat(checked)).days >= 7
    if want and not meta.get("archive_days") and due:
        tool = extractor()
        if not tool:
            log("! no 7z/bsdtar: skipping history backfill")
        else:
            log(f"Backfilling {len(want)} past dates from the archive…")
            for d in want:
                try:
                    rows = read_archive(d, tool)
                except urllib.error.HTTPError as e:
                    log(f"  archive {d}: HTTP {e.code}; not trying the other dates (checking again in a week)")
                    checked = date
                    break
                except Exception as e:
                    log(f"  archive {d}: failed ({e})")
                    continue
                done.add(d.isoformat())
                for gid, r in (rows or {}).items():
                    if gid in cat:
                        add_point(hist, gid, r, d.isoformat())

    # write per-set files and gather catalog / movers
    sets, catalog, moves7, moves30, deal_cands = [], [], [], [], []
    group_by_id = {g["groupId"]: g for g in groups}
    for g in sorted(groups, key=lambda g: g.get("publishedOn") or "", reverse=True):
        gid = g["groupId"]
        prods, _ = cat[gid]
        sets.append([gid, g["name"], g.get("abbreviation") or "", (g.get("publishedOn") or "")[:10],
                     int(bool(g.get("isSupplemental")))])
        products, compacted = [], {}
        ghist = hist.get(gid, {})
        for p in prods:
            pid = p["productId"]
            number, rarity = _ext(p, "Number"), _ext(p, "Rarity")
            sealed = int(not number and not rarity)
            packs = packs_from_text(p.get("name"), _ext(p, "CardText")) if sealed else None
            products.append([pid, p.get("name") or "", number or "", rarity or "", sealed, packs])
            subs = ghist.get(pid, {})
            best = None
            for sub, pts in subs.items():
                pts = compact(pts, today)
                subs[sub] = pts
                series = sorted((d, v[0]) for d, v in pts.items())
                compacted.setdefault(pid, {})[sub] = pts
                if series and series[-1][0] == date:
                    _, low, _ = pts[date]
                    # 20–50% under market; deeper "discounts" are nearly always damaged copies
                    if series[-1][1] >= 5 and low and series[-1][1] * .5 <= low <= series[-1][1] * .8:
                        deal_cands.append([pid, sub, gid, series[-1][1], low])
                if series and series[-1][0] >= (today - dt.timedelta(days=10)).isoformat():
                    now = series[-1][1]
                    c7, c30 = change_over(series, 7), change_over(series, 30)
                    if best is None or now > best[1]:
                        best = (sub, now, c7, c30)
                    if now >= 5:
                        if c7 is not None:
                            moves7.append([pid, sub, gid, round(now / (1 + c7), 2), now, c7])
                        if c30 is not None:
                            moves30.append([pid, sub, gid, round(now / (1 + c30), 2), now, c30])
            catalog.append([pid, p.get("name") or "", gid, sealed, number or "", rarity or "",
                            *(best if best else (None, None, None, None))])
        # one shared date list per set; each printing's prices in cents, aligned to it
        dates = sorted({d for subs in compacted.values() for pts in subs.values() for d in pts})
        series, latest = {}, {}
        for pid, subs in compacted.items():
            for sub, pts in subs.items():
                series.setdefault(str(pid), {})[sub] = [round(pts[d][0] * 100) if d in pts else None for d in dates]
                last = max(pts)
                latest.setdefault(str(pid), {})[sub] = [last, *pts[last]]
        (out / "set" / f"{gid}.json").write_text(json.dumps(
            {"gid": gid, "name": g["name"], "published": (g.get("publishedOn") or "")[:10],
             "products": products, "dates": dates, "series": series, "latest": latest}, separators=(",", ":")))

    def top(moves, n=40):
        moves.sort(key=lambda m: m[5])
        names = {c[0]: c[1] for c in catalog}
        fmt = lambda m: {"pid": m[0], "sub": m[1], "gid": m[2], "name": names.get(m[0], ""),
                         "then": m[3], "now": m[4], "change": m[5]}
        return {"up": [fmt(m) for m in reversed(moves[-n:]) if m[5] > 0],
                "down": [fmt(m) for m in moves[:n] if m[5] < 0]}

    deals, volume_ok = find_deals(deal_cands) if os.environ.get("CARD_MARKET_DEALS", "1") == "1" else ([], False)
    (out / "deals.json").write_text(json.dumps({"as_of": date, "volume": volume_ok, "deals": deals}, separators=(",", ":")))
    (out / "sets.json").write_text(json.dumps(sets, separators=(",", ":")))
    (out / "catalog.json").write_text(json.dumps(catalog, separators=(",", ":")))
    (out / "movers.json").write_text(json.dumps({"as_of": date, "d7": top(moves7), "d30": top(moves30)},
                                                separators=(",", ":")))
    all_dates = {d for g in hist.values() for p in g.values() for s in p.values() for d in s}
    meta = {"generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "as_of": date,
            "products": len(catalog), "sets": len(sets), "history_days": len(all_dates),
            "first_date": min(all_dates) if all_dates else None, "archive_days": sorted(done),
            "archive_checked": checked}
    (out / "meta.json").write_text(json.dumps(meta, indent=1))
    priced = sum(1 for c in catalog if c[7] is not None)
    log(f"Done: {len(catalog):,} products ({priced:,} priced) in {len(sets)} sets, "
        f"{len(all_dates)} days of history, {len(moves30):,} 30-day moves")
    if priced < 1000:
        sys.exit("Too few prices: TCGCSV may be down or changed; not publishing this run.")


if __name__ == "__main__":
    main()
