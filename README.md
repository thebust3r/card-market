# Card Market

Pokémon card comps, prices and collection, on the web and as an iPhone app. Both are the same site,
so they always match.

- **Comps**: search any card or sealed product. You get TCGplayer's latest sales on a graph, colored by
  condition, the median for each condition, the last 15 sales, and one-tap links to TCGplayer,
  eBay sold, eBay PSA 10 and PriceCharting.
- **Price history and estimate**: the market price over time, with a rough 1/3/6/12-month range and a
  check of how the estimate would have done last month. It's a trend guess, not financial advice.
- **Market**: your watchlist plus the biggest 7-day and 30-day moves across every product worth $5 or more.
- **Box EV**: what the cards in a booster box, ETB or bundle are worth on average against its sealed
  price. You can edit the pull rates.
- **Sell speed, sell helper and grading calculator** on every card: how many sold in the last 30 days,
  what you keep after TCGplayer, eBay or PayPal fees, and whether grading pays off.
- **Deals**: daily list of listings well under market price for things that still sell.
- **Cheapest packs**: cost per pack across every sealed product in a set, next to Box EV.
- **Restock**: checks your local card shops (Shopify or WooCommerce) every 5 minutes and pushes to your
  phone through ntfy when sealed Pokémon product comes back or shows up, plus release-day reminders.
  Target, Walmart, GameStop and Pokémon Center block automated checks, so Target gets quick links instead.
- **Collection**: what you own, what you paid, what it's worth now, CSV export, and a set tracker
  (what's missing from a set and what it costs to finish).

Search works offline with bad signal at a show. Comps need a connection.

## How it fits together

| Piece | Where | What it does |
|---|---|---|
| `data/build.py` | GitHub Actions, daily | Pulls every Pokémon price from [TCGCSV](https://tcgcsv.com) (a daily copy of TCGplayer's prices), adds the day to the history, and writes static JSON. The first run fills in about 2 years from TCGCSV's archive. |
| `site/` | Cloudflare Pages | The app. Search, charts, forecasts and EV all run in the browser from that JSON. |
| `functions/api/` | Cloudflare Pages Functions + D1 | Sign-in, the live TCGplayer sales lookup (cached 10 minutes), and your watchlist, recent lookups and collection. |
| `ios/` | GitHub Actions, macOS | A full-screen iPhone app that opens the site. AltStore installs it and shows updates. |

All of it fits in the free tiers of GitHub and Cloudflare.

## Setup (once)

1. **Cloudflare**: make a free account at <https://dash.cloudflare.com>. Under *My Profile → API Tokens*,
   create a token with **Account · Cloudflare Pages · Edit**, **Account · D1 · Edit** and
   **Account · Workers Scripts · Edit** (the last one runs the 5-minute restock checker). Copy the token
   and your **Account ID** (it's on the right side of the dashboard home page).
2. **GitHub secrets**: in this repo, open *Settings → Secrets and variables → Actions* and add:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
   - `APP_PASSWORD`: the password you'll type to sign in. Without it, anyone with the link can use the site.
3. **Deploy**: open *Actions → Deploy → Run workflow*. The first run takes about 15 minutes because it
   backfills the price history. After that it runs every day at 21:40 UTC by itself, and any push to `main`
   redeploys. The run summary shows your site address (normally `https://card-market.pages.dev`).
4. **iPhone app**: *Actions → iPhone app → Run workflow*. It builds the app, makes a release, and updates
   `altstore-source.json`.

The repo should be public so AltStore can read the source and download the app. Your watchlist and
collection live in Cloudflare behind your password, not in the repo.

## On your phone

**Home-screen version (no sideload slot needed):** open the site in Safari, tap Share → *Add to Home Screen*.

**AltStore version:** in AltStore, open *Browse → Sources → +* and add

```
https://raw.githubusercontent.com/thebust3r/card-market/main/altstore-source.json
```

then install **Card Market**. A free Apple ID allows 3 sideloaded apps at a time (AltStore counts as one),
so you may need to remove one first. The app loads the live site, so new features appear without
reinstalling. AltStore only needs to update it when the app itself changes, and it will tell you.

If your Cloudflare address isn't `card-market.pages.dev`, the iPhone build finds the right one by itself.
To use your own domain, set an Actions **variable** `SITE_URL` (e.g. `https://cards.example.com`).

## Where the numbers come from

- **Prices and history**: TCGplayer market prices via TCGCSV, once a day. No key needed.
- **Recent sales**: TCGplayer's own sales history and latest-sales feeds, the same ones its product pages
  use, fetched live from Cloudflare when you open a card. These aren't an official API, so if TCGplayer
  changes them the comps section says so while the rest keeps working. *Actions → Deploy* prints a
  check of both feeds at the end of every run.
- **Box EV**: average market price of each rarity in the set × approximate Scarlet & Violet pull rates.
  Older sets have different rates, so edit them on the page.

A TCGplayer API key isn't needed. If you ever add one, don't commit it: put it in the repo secrets.

## Try it on your computer

```
python data/build.py --out out           # about 10 minutes the first time
python tools/dev_server.py --data out    # then open http://localhost:8788
```

The local server keeps the watchlist and collection in memory only.
