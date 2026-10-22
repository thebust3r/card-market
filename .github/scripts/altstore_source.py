"""Writes altstore-source.json so AltStore shows Card Market and its updates.
Run by the iPhone app build: python altstore_source.py <tag> <version> <build> <dist folder>"""
import json, os, sys, datetime

tag, version, build, dist = sys.argv[1:5]
repo = os.environ.get("GITHUB_REPOSITORY", "thebust3r/card-market")
raw = f"https://raw.githubusercontent.com/{repo}/main"
now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
ipa = f"CardMarket-{version}.ipa"
url = f"https://github.com/{repo}/releases/download/{tag}/{ipa}"
size = os.path.getsize(os.path.join(dist, ipa))
icon = f"{raw}/ios/CardMarket/Assets.xcassets/AppIcon.appiconset/icon-1024.png"
about = ("Pokémon card comps on the go: recent TCGplayer sales by condition on a graph, one-tap links to "
         "TCGplayer and eBay, price history with a rough forecast, box EV, and your collection.")
out = {"name": "Card Market", "identifier": "io.github.thebust3r.cardmarket.source", "subtitle": "Pokémon card comps",
       "description": "The Card Market iPhone app. New builds show up here by themselves.",
       "iconURL": icon, "website": f"https://github.com/{repo}", "tintColor": "#ffc928", "news": [],
       "apps": [{
           "name": "Card Market", "bundleIdentifier": "io.github.thebust3r.cardmarket", "developerName": "thebust3r",
           "subtitle": "Pokémon card comps", "localizedDescription": about, "iconURL": icon,
           "tintColor": "#ffc928", "category": "utilities",
           "versions": [{"version": version, "buildVersion": build, "date": now, "downloadURL": url, "size": size,
                         "minOSVersion": "15.0", "localizedDescription": f"Build {build}"}],
           # older AltStore versions read these instead
           "version": version, "versionDate": now, "downloadURL": url, "size": size,
           "appPermissions": {"entitlements": [], "privacy": {}},
       }]}
with open("altstore-source.json", "w") as f:
    json.dump(out, f, indent=2)
print(json.dumps(out, indent=2)[:600])
