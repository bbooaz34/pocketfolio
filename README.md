# Pocketfolio

A tiny tracker for your **PSA-graded Pokémon TCG collection** that lives in your
browser. Log what you bought and what you paid, follow live market prices, and
watch your collection's value over time — no account, no server, no build step.

![status](https://img.shields.io/badge/status-MVP-blue)

## Features

- **Card search with live prices** from the free [Pokémon TCG API](https://docs.pokemontcg.io) (no key required) — card images, sets, rarities, and TCGplayer market prices
- **Graded positions** — every holding is a card *at a PSA grade* (PSA 1–10 or raw); the same card in two grades is two positions
- **Purchase tracking** — record quantity and what you paid per card; P/L is computed against it
- **Graded value** — each position's value comes from a rough per-grade multiplier on the card's raw TCGplayer market price (clearly labeled *est.*), or from a **manual value you set** (✎ button) based on real PSA sales, which always wins
- **PSA cert numbers** — store the cert with a position; it links straight to [PSA's certificate verification](https://www.psacard.com/cert/)
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
2. Choose the PSA grade, quantity, and optionally what you paid per card, its current graded value, and the PSA cert number.
3. Hit **Add card** — or use **"try a demo collection"** on the empty state.
4. Adding the same card + grade again merges the positions (quantities add up, paid price becomes the weighted average).
5. Use the ✎ button on a row to set the real per-card value (check recent PSA sales); leave it empty to fall back to the automatic estimate.

## Project layout

```
index.html        markup + app shell
css/styles.css    design tokens (light/dark) and layout
js/api.js         Pokémon TCG API client with caching + rate-limit handling
js/store.js       localStorage persistence: positions + daily value snapshots
js/charts.js      hand-rolled SVG charts (value-over-time line, allocation bar)
js/app.js         search, add/edit/remove flow, refresh, rendering
```

No dependencies, no framework, no build.

## API usage

| Endpoint | Used for |
|---|---|
| `GET /v2/cards?q=name:…` | card search in the add form |
| `GET /v2/cards?q=(id:… OR id:…)` | batch price refresh for your collection |

Responses are cached client-side and requests deduped. The API works without a
key; a free key from [dev.pokemontcg.io](https://dev.pokemontcg.io) raises the
rate limits — store it once via the browser console:
`localStorage.setItem("pocketfolio.tcgApiKey", "<your key>")`.

## Why estimated graded values?

There is no free, keyless API for graded-card sale prices — PSA's own API and
eBay's sold-listings API both require registered tokens, and services like
PriceCharting are paid. So the MVP pulls the **raw** TCGplayer market price
live and applies a rough per-grade multiplier (PSA 10 ×3.0, PSA 9 ×1.4,
PSA 8 ×1.0, …) as a starting point, with a per-position manual override for
real sale prices. Plugging in a keyed source (PSA API, eBay Finding API,
PriceCharting) is the natural next step.

## Limitations (it's an MVP)

- Graded values are estimates unless you set them manually
- USD only; PSA grading only (no BGS/CGC)
- The value-over-time chart needs you to open the app on at least two different days
- Collection is per-browser — clearing site data clears it
