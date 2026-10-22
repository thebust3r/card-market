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
            # The archive sits behind a stricter CDN rule than the API; say why, then try curl once.
            body = e.read(300).decode("utf-8", "replace").replace("\n", " ")
            log(f"  archive {day}: HTTP {e.code} (server {e.headers.get('Server')}, cf-ray {e.headers.get('CF-RAY')}): {body[:200]}")
            if not shutil.which("curl"):
                raise
            r = subprocess.run(["curl", "-fsSL", "--retry", "2", "-A", UA, "-o", str(arc), "-w", "%{http_code}", url],
                               capture_output=True, text=True, timeout=300)
            if r.returncode != 0:
                raise RuntimeError(f"curl also failed: HTTP {r.stdout.strip()} {r.stderr.strip()[:120]}")
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
    if want and not meta.get("archive_days"):
        tool = extractor()
        if not tool:
            log("! no 7z/bsdtar: skipping history backfill")
        else:
            log(f"Backfilling {len(want)} past dates from the archive…")
            for d in want:
                try:
                    rows = read_archive(d, tool)
                except Exception as e:
                    log(f"  archive {d}: failed ({e})")
                    continue
                done.add(d.isoformat())
                for gid, r in (rows or {}).items():
                    if gid in cat:
                        add_point(hist, gid, r, d.isoformat())

    # write per-set files and gather catalog / movers
    sets, catalog, moves7, moves30 = [], [], [], []
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

    (out / "sets.json").write_text(json.dumps(sets, separators=(",", ":")))
    (out / "catalog.json").write_text(json.dumps(catalog, separators=(",", ":")))
    (out / "movers.json").write_text(json.dumps({"as_of": date, "d7": top(moves7), "d30": top(moves30)},
                                                separators=(",", ":")))
    all_dates = {d for g in hist.values() for p in g.values() for s in p.values() for d in s}
    meta = {"generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "as_of": date,
            "products": len(catalog), "sets": len(sets), "history_days": len(all_dates),
            "first_date": min(all_dates) if all_dates else None, "archive_days": sorted(done)}
    (out / "meta.json").write_text(json.dumps(meta, indent=1))
    priced = sum(1 for c in catalog if c[7] is not None)
    log(f"Done: {len(catalog):,} products ({priced:,} priced) in {len(sets)} sets, "
        f"{len(all_dates)} days of history, {len(moves30):,} 30-day moves")
    if priced < 1000:
        sys.exit("Too few prices: TCGCSV may be down or changed; not publishing this run.")


if __name__ == "__main__":
    main()
