"""Tries Target's stock endpoints from wherever it runs and prints what comes back.
Used to see why restock checks fail: python probe_target.py [zip]"""
import json, re, sys, urllib.parse, urllib.request

ZIP = sys.argv[1] if len(sys.argv) > 1 else "72701"
KEY = "9f36aeafbe60771e321a7cc95a78140772ab3e96"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
H = {"User-Agent": UA, "Accept": "application/json", "Accept-Language": "en-US,en;q=0.9",
     "Origin": "https://www.target.com", "Referer": "https://www.target.com/"}


def get(url, headers=H):
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:
        return -1, repr(e)


def show(name, url, headers=H):
    st, body = get(url, headers)
    print(f"\n=== {name}: HTTP {st}\n{url[:160]}\n{body[:700]}")
    return st, body


key = KEY
st, html = show("product page (find current api key)", "https://www.target.com/s?searchTerm=pokemon+elite+trainer+box",
                {"User-Agent": UA, "Accept": "text/html"})
m = re.search(r'apiKey\\?"\s*:\s*\\?"([0-9a-f]{40})', html) or re.search(r'"key"\s*:\s*"([0-9a-f]{40})"', html)
if m:
    print("FOUND page key:", m.group(1), "(same as ours)" if m.group(1) == KEY else "(DIFFERENT from ours)")
    key = m.group(1)

q = urllib.parse.urlencode({"key": key, "channel": "WEB", "count": 24, "offset": 0, "keyword": "pokemon elite trainer box",
                            "page": "/s/pokemon elite trainer box", "visitor_id": "0", "platform": "desktop",
                            "default_purchasability_filter": "true", "pricing_store_id": "1309"})
st, body = show("search plp_search_v2", f"https://redsky.target.com/redsky_aggregations/v1/web/plp_search_v2?{q}")
tcins = re.findall(r'"tcin"\s*:\s*"(\d+)"', body)[:3] or ["91619960"]
print("TCINs:", tcins)
t = tcins[0]

show("fiats_v1 (old notifier)", "https://redsky.target.com/redsky_aggregations/v1/web/fiats_v1?" + urllib.parse.urlencode({
    "key": key, "tcin": t, "nearby": ZIP, "radius": 25, "limit": 20,
    "include_only_available_stores": "true", "requested_quantity": 1}))
show("fiats_v1 minimal", "https://redsky.target.com/redsky_aggregations/v1/web/fiats_v1?" + urllib.parse.urlencode({
    "key": key, "tcin": t, "nearby": ZIP, "radius": 25, "limit": 20}))
st, body = show("nearby_stores_v1", "https://redsky.target.com/redsky_aggregations/v1/web/nearby_stores_v1?" + urllib.parse.urlencode({
    "limit": 5, "within": 25, "place": ZIP, "key": key}))
stores = re.findall(r'"store_id"\s*:\s*"?(\d+)', body)[:3] or ["1309"]
print("stores:", stores)
show("pdp_fulfillment_v1", "https://redsky.target.com/redsky_aggregations/v1/web/pdp_fulfillment_v1?" + urllib.parse.urlencode({
    "key": key, "tcin": t, "store_id": stores[0], "zip": ZIP, "state": "AR", "required_store_id": stores[0],
    "has_required_store_id": "true", "scheduled_delivery_store_id": stores[0], "channel": "WEB", "page": f"/p/A-{t}"}))
show("product_fulfillment_v1", "https://redsky.target.com/redsky_aggregations/v1/web/product_fulfillment_v1?" + urllib.parse.urlencode({
    "key": key, "tcin": t, "store_id": stores[0], "zip": ZIP, "state": "AR", "required_store_id": stores[0],
    "channel": "WEB", "page": f"/p/A-{t}"}))
show("fiats_v1 no browser headers", "https://redsky.target.com/redsky_aggregations/v1/web/fiats_v1?" + urllib.parse.urlencode({
    "key": key, "tcin": t, "nearby": ZIP, "radius": 25, "limit": 20}), {"User-Agent": "Python-urllib/3"})
