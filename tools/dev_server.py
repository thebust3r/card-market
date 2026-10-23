"""Local preview: serves site/, a data folder at /data, and an in-memory /api.

    python data/build.py --out out            # build the data once
    python tools/dev_server.py --data out     # then open http://localhost:8788

Comps are fetched from TCGplayer directly (or --tcg http://host:port for a mock).
Nothing is saved: watchlist and collection reset when the server stops.
"""
import argparse, json, mimetypes, pathlib, time, urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = pathlib.Path(__file__).resolve().parent.parent / "site"
STATE = {"watch": [], "collection": [], "recents": [], "showcase": []}
RESTOCK = {"items": [], "events": [], "lastRun": None, "paused": False, "reminders": [], "tz": "America/Chicago",
           "shops": [{"name": "Gear Gaming Fayetteville", "url": "https://fayetteville.geargamingstore.com", "platform": "shopify"},
                     {"name": "The Geek Realms", "url": "https://thegeekrealms.com", "platform": "woocommerce"}],
           "ntfyServer": "https://ntfy.sh", "ntfyTopicSet": False, "ntfyTopicHint": ""}
ARGS = None
UA = {"User-Agent": "Mozilla/5.0", "Accept": "application/json", "Content-Type": "application/json"}


def tcg(url, body=None):
    if ARGS.tcg:
        url = ARGS.tcg + "/" + url.split("/", 3)[3]
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body else None, headers=UA)
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)


def fl(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def comps(pid, rng):
    out = {"pid": pid, "range": rng, "history": [], "sales": []}
    try:
        res = tcg(f"https://infinite-api.tcgplayer.com/price/history/{pid}/detailed?range={rng}")["result"]
        out["history"] = [{
            "condition": it["condition"], "variant": it["variant"], "language": it["language"],
            "totalSold": fl(it.get("totalQuantitySold")) or 0,
            "buckets": sorted(({"date": b["bucketStartDate"], "market": fl(b["marketPrice"]), "low": fl(b["lowSalePrice"]),
                                "high": fl(b["highSalePrice"]), "sold": fl(b["quantitySold"]) or 0,
                                "orders": fl(b["transactionCount"]) or 0} for b in it["buckets"]), key=lambda b: b["date"]),
        } for it in res]
    except Exception as e:
        out["historyError"] = str(e)
    try:
        for page in range(2):
            body = {"conditions": [], "languages": [], "variants": [], "listingType": "All", "offset": page * 25, "limit": 25, "time": int(time.time() * 1000)}
            data = tcg(f"https://mpapi.tcgplayer.com/v2/product/{pid}/latestsales", body)
            for x in data.get("data", []):
                out["sales"].append({"date": x["orderDate"], "price": fl(x["purchasePrice"]), "ship": fl(x.get("shippingPrice")),
                                     "condition": x["condition"], "variant": x["variant"], "language": x["language"],
                                     "qty": x.get("quantity", 1), "title": x.get("title", ""), "type": x.get("listingType")})
            if len(data.get("data", [])) < 25 or not data.get("nextPage"):
                break
    except Exception as e:
        out["salesError"] = str(e)
    return out


class H(SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def translate_path(self, path):
        path = path.split("?")[0]
        if path.startswith("/data/"):
            return str(pathlib.Path(ARGS.data) / path[6:])
        return str(ROOT / (path.lstrip("/") or "index.html"))

    def send(self, obj, status=200):
        b = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path.startswith("/api/restock"):
            return self.send(RESTOCK)
        if self.path.startswith("/api/me"):
            return self.send(STATE)
        if self.path.startswith("/api/comps"):
            from urllib.parse import parse_qs, urlparse
            q = parse_qs(urlparse(self.path).query)
            return self.send(comps(int(q["pid"][0]), q.get("range", ["quarter"])[0]))
        if self.path.startswith("/api/"):
            return self.send({"error": "Not found"}, 404)
        return super().do_GET()

    def do_POST(self):
        b = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        p, now = self.path, time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        pid, sub = int(b.get("pid") or 0), b.get("sub") or "Normal"
        if p == "/api/restock/run":   # the real checker runs on Cloudflare; this just fakes a result
            RESTOCK["lastRun"] = {"t": now, "shops": [{"name": x["name"], "ok": True, "items": 3, "inStock": 1} for x in RESTOCK["shops"]], "alerts": 0}
            if not RESTOCK["items"]:
                RESTOCK["items"] = [{"url": "https://example.com/p/etb", "shop": "Gear Gaming Fayetteville", "name": "Pokémon Delta Reign Elite Trainer Box",
                                     "available": 1, "last_change": now, "price": 59.99}]
                RESTOCK["events"] = [{"t": now, "kind": "restock", "shop": "Gear Gaming Fayetteville", "name": "Pokémon Delta Reign Elite Trainer Box",
                                      "url": "https://example.com/p/etb", "price": 59.99}]
            return self.send(RESTOCK["lastRun"])
        if p == "/api/restock/test":
            return self.send({"ok": True})
        if p == "/api/restock/settings":
            for k in ("paused", "shops", "reminders"):
                if k in b:
                    RESTOCK[k] = b[k]
            if b.get("ntfyTopic"):
                RESTOCK["ntfyTopicSet"], RESTOCK["ntfyTopicHint"] = True, b["ntfyTopic"][:3] + "…"
            return self.send({"ok": True})
        if p == "/api/login":
            return self.send({"token": "dev"})
        if p == "/api/watch":
            STATE["watch"] = [w for w in STATE["watch"] if (w["pid"], w["sub"]) != (pid, sub)]
            if b.get("on") is not False:
                STATE["watch"].append({"pid": pid, "sub": sub, "added": now})
        elif p == "/api/recent":
            STATE["recents"] = [{"pid": pid, "sub": sub, "t": time.time() * 1000}] + [r for r in STATE["recents"] if (r["pid"], r["sub"]) != (pid, sub)][:39]
        elif p == "/api/recent/clear":
            STATE["recents"] = []
        elif p == "/api/collection":
            fields = ("qty", "condition", "grade", "cost", "bought", "value_override", "note")
            if b["action"] == "add":
                row = {"id": len(STATE["collection"]) + int(time.time()), "pid": pid, "sub": sub, "added": now, **{k: b.get(k) for k in fields}}
                row["qty"] = int(row["qty"] or 1)
                row["condition"] = row["condition"] or "Near Mint"
                STATE["collection"].insert(0, row)
                return self.send({"ok": True, "id": row["id"]})
            for row in STATE["collection"]:
                if row["id"] == b.get("id") and b["action"] == "update":
                    row.update({k: b.get(k) for k in fields})
            if b["action"] == "delete":
                STATE["collection"] = [r for r in STATE["collection"] if r["id"] != b.get("id")]
                STATE["showcase"] = [i for i in STATE["showcase"] if i != b.get("id")]
        elif p == "/api/showcase":
            if "order" in b:
                STATE["showcase"] = [int(i) for i in b["order"] if int(i) in STATE["showcase"]]
            elif b.get("on") is False:
                STATE["showcase"] = [i for i in STATE["showcase"] if i != int(b["id"])]
            elif int(b["id"]) not in STATE["showcase"]:
                STATE["showcase"].append(int(b["id"]))
        else:
            return self.send({"error": "Not found"}, 404)
        self.send({"ok": True})


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="out")
    ap.add_argument("--port", type=int, default=8788)
    ap.add_argument("--tcg", help="base URL of a mock TCGplayer server")
    ARGS = ap.parse_args()
    mimetypes.add_type("application/manifest+json", ".webmanifest")
    print(f"http://localhost:{ARGS.port}")
    ThreadingHTTPServer(("0.0.0.0", ARGS.port), H).serve_forever()
