# Pocketfolio

A tiny tracker for your **PSA-graded Pokémon TCG collection** that lives in your
browser. Log what you bought and what you paid, follow live market prices, and
watch your collection's value over time — no account, no server, no build step.

The UI is a **Hebrew, RTL, mobile-first app** (390px design width) built to the
Pocketfolio design system (Leumi Trade language): four bottom-nav views —
בית (home), אחזקות (holdings), שוק (market) and הגדרות (settings) — plus a
card-detail drill-down and an add flow, all routed by URL hash
(`#home`, `#holdings`, `#market`, `#settings`, `#card/<uid>`, `#add`).
The full brief lives in the design artifacts referenced by
`POCKETFOLIO-REDESIGN.md` (tokens, mockups, component specs).

![status](https://img.shields.io/badge/status-MVP-blue)

## Features

- **Card search with live prices** from the free [Pokémon TCG API](https://docs.pokemontcg.io) (no key required) — card images, sets, rarities, and TCGplayer market prices — with **automatic failover to [TCGdex](https://tcgdex.dev)** (also free and keyless) when it's down or rate-limited
- **Graded positions** — every holding is a card *at a PSA grade* (PSA 1–10 or raw); the same card in two grades is two positions
- **Purchase tracking** — record quantity and what you paid per card; P/L is computed against it
- **Real graded prices** — add a free API key from [PokemonPriceTracker](https://www.pokemonpricetracker.com/api) (100 lookups/day, no credit card) via the ⚙ button and each position's value becomes the **actual eBay sold-price median for its PSA grade**; responses are cached 12h per card to stay inside the free tier
- **Graceful fallbacks** — without a key (or for grades with no sales data) the value is estimated from the raw TCGplayer market price with a rough per-grade multiplier (labeled *est.*); a **manual value you set** (✎ button) always wins over both
- **PSA cert numbers** — store the cert with a position; it links straight to [PSA's certificate verification](https://www.psacard.com/cert/)
- **Search by cert number** — paste a PSA cert number (6–10 digits) into the search box and the app reads the slab's details (subject, grade, year, set, card number) from PSA's cert page, pre-fills the grade + cert, and matches the card in the price catalogs; if PSA can't be reached it falls back to a direct link. PSA has no CORS/open API, so the page is fetched directly and then through public read-through proxies (allorigins.win, r.jina.ai) — only the cert number is sent, and PSA's bot protection may still block automated reads
- **Dashboard KPIs** — collection value, cost basis, profit/loss, card count
- **Value-over-time chart** — a snapshot of your collection's value is saved once a day you open the app, so the chart grows with use
- **Allocation bar** showing how your value splits across positions
- **Local-only storage** — everything persists in `localStorage` and never leaves your browser
- **Dark mode** follows your OS setting

## Run it

It's a static site — serve the folder with any web server:

```sh
# Python
python3 -m http.server 8000

# or Node
npx serve .
```

Then open <http://localhost:8000>.

**Open it on your phone:** start the server on your computer, find your
computer's LAN IP (`ipconfig getifaddr en0` on macOS, `hostname -I` on Linux,
`ipconfig` on Windows), and browse to `http://<that-ip>:8000` from a phone on
the same Wi-Fi.

## Usage

1. Search for a card (e.g. "charizard"), pick the exact printing from the dropdown (set + number).
2. Choose the PSA grade, quantity, and optionally what you paid per card and the PSA cert number — the current value is fetched automatically (eBay sold median with an API key, estimate without).
3. Hit **Add card** — or use **"try a demo collection"** on the empty state.
4. Adding the same card + grade again merges the positions (quantities add up, paid price becomes the weighted average).
5. Use the ✎ button on a row to set the real per-card value (check recent PSA sales); leave it empty to fall back to the automatic estimate.

## Project layout

```
index.html        RTL app shell: views, bottom nav, inline SVG icon set
css/styles.css    design-system tokens (light), type scale, components
js/api.js         card/price API clients with caching + rate-limit handling
js/store.js       localStorage persistence: positions + daily value snapshots
js/charts.js      hand-rolled SVG trend chart (full + compact 96px mode)
js/app.js         hash router, view renderers, search/add/edit flows, i18n
```

No dependencies, no framework, no build.

## API usage

| Provider | Endpoint | Used for |
|---|---|---|
| pokemontcg.io | `GET /v2/cards?q=name:…` | card search in the add form |
| pokemontcg.io | `GET /v2/cards?q=(id:… OR id:…)` | batch price refresh |
| TCGdex (fallback) | `GET /v2/en/cards?name=…` + `GET /v2/en/cards/{id}` | search + prices when pokemontcg.io is unavailable |
| PokemonPriceTracker (optional key) | `GET /api/v2/cards?search=…&setId=…&includeEbay=true` | real eBay sold prices per PSA grade |

The client fails over automatically per request and remembers which provider
last worked. Responses are cached client-side and requests deduped.
pokemontcg.io works without a key; a free key from
[dev.pokemontcg.io](https://dev.pokemontcg.io) raises its rate limits — store
it once via the browser console:
`localStorage.setItem("pocketfolio.tcgApiKey", "<your key>")`.
TCGdex prices come from TCGplayer (USD) or, when that's missing, Cardmarket
(shown in €).

## Graded prices from eBay, read nightly on the Mac

Graded values in the daily snapshot come from eBay's own sold listings, read
once a night from a logged-in browser on the owner's Mac
(`TASK-ebay-direct.md`). Price providers only resell a sample of eBay. Raw
prices still come from the catalog.

The job, `scripts/nightly.sh`, does one search per graded card, page one only,
sorted by most recent. The search text is the card's `psaTitle`. It merges what
it finds into `data/sales/<cardId>.json`, builds the snapshot, and commits and
pushes `data/`. It never runs in GitHub Actions. The Action there keeps its
schedule and builds from whatever `data/sales` the Mac last pushed.

**One-time setup:**

```sh
# 1. dependencies (Playwright is only for the scraper; the app has none)
cd ~/path/to/pocketfolio && npm install

# 2. a DEDICATED browser profile, never your daily Chrome one
mkdir -p ~/.pocketfolio/chrome-profile

# 3. first run: a window opens, sign in to eBay, close the window.
#    The scrape then runs headless on the same profile.
node scripts/scrape-ebay-sold.mjs --login

# 4. the 04:00 launchd job
sed -e "s#REPO_PATH#$PWD#" -e "s#HOME_PATH#$HOME#" \
  scripts/launchd/com.pocketfolio.nightly.plist \
  > ~/Library/LaunchAgents/com.pocketfolio.nightly.plist
launchctl load ~/Library/LaunchAgents/com.pocketfolio.nightly.plist
```

That's it. The log is `~/.pocketfolio/nightly.log`. Run `bash scripts/nightly.sh`
to try it end to end. Put `PPT_TOKEN=...` in `~/.pocketfolio/env` if you want
the provider to fill grades our own sales don't cover while the subscription
lasts.

- **Every graded card needs `psaTitle`** in `data/watchlist.json`. That is the
  PSA label title, copied exactly from the cert page on psacard.com. A graded
  card without one is not searched and shows `— —`.
- If eBay shows a login wall, run `--login` again. If it shows a bot check, the
  job stops. That is on purpose: there is no workaround.
- If every page comes back empty, the job exits with an error and writes
  nothing. An empty day is an alert, not a price.
- If a push fails (no network), the commit stays and the next run pushes both.

## Graded prices proxy (required for eBay PSA prices)

The PokemonPriceTracker API doesn't allow calls from web pages (no CORS
headers), so the app can't reach it directly from GitHub Pages. The fix is a
tiny personal proxy on Cloudflare's free tier (~5 minutes, no credit card),
which forwards the app's requests with CORS enabled. Your API key travels
only from your browser through **your own** worker to the API.

1. Sign up at [dash.cloudflare.com](https://dash.cloudflare.com) (free).
2. **Workers & Pages → Create → Worker**, name it (e.g. `pocketfolio-prices`), **Deploy**.
3. **Edit code**, replace everything with [`proxy/prices-proxy.js`](proxy/prices-proxy.js), **Deploy**.
4. Copy the worker URL (`https://pocketfolio-prices.<your-name>.workers.dev`).
5. In the app: **⚙ → Prices proxy URL…** → paste it. Done — run **⚙ → Test PSA prices API** to confirm.

The worker only forwards `GET /api/v2/*` to pokemonpricetracker.com and
nothing else. Cloudflare's free tier allows 100k requests/day — far beyond
the API's own 100/day free budget.

## Where graded values come from

There is no free **keyless** API for graded-card sale prices — PSA's own API
exposes cert data but not prices, eBay's sold-listings API requires a
registered app, and services like PriceCharting are paid. The best free
option is [PokemonPriceTracker](https://www.pokemonpricetracker.com/api):
sign up, grab the free API key (100 credits/day), and paste it into the app
via ⚙ — values then come from eBay completed-sale medians per PSA grade.
Without a key, the app falls back to the raw TCGplayer market price times a
rough per-grade multiplier (PSA 10 ×3.0, PSA 9 ×1.4, PSA 8 ×1.0, …), and the
per-position ✎ manual value always wins.

## Limitations (it's an MVP)

- Graded values are estimates unless you set them manually
- USD only; PSA grading only (no BGS/CGC)
- The value-over-time chart needs you to open the app on at least two different days
- Collection is per-browser — clearing site data clears it
