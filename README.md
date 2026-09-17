# Pocketfolio

A tiny portfolio tracker that lives in your browser. Track your crypto holdings
with live market data — no account, no server, no build step.

![status](https://img.shields.io/badge/status-MVP-blue)

## Features

- **Live prices** from the free [CoinGecko API](https://docs.coingecko.com/reference/introduction) (no API key required)
- **Search any coin** by name or symbol and add how much you hold
- **Dashboard KPIs** — total value, 24h change, profit/loss vs your cost basis, best performer
- **7-day portfolio value chart** with crosshair + tooltip, computed from each coin's hourly history
- **Allocation bar** showing your portfolio split by value
- **Holdings table** with price, 24h change, 7-day sparkline, quantity, value, and per-position P/L
- **Local-only storage** — holdings persist in `localStorage` and never leave your browser
- **Dark mode** follows your OS setting
- Auto-refreshes every 2 minutes (respecting CoinGecko's free-tier rate limits), plus a manual refresh button

## Run it

It's a static site — serve the folder with any web server:

```sh
# Python
python3 -m http.server 8000

# or Node
npx serve .
```

Then open <http://localhost:8000>.

(Opening `index.html` directly from disk also works in most browsers, since the
CoinGecko API allows cross-origin requests.)

## Usage

1. Search for an asset (e.g. "bitcoin"), pick it from the dropdown.
2. Enter the quantity you hold and, optionally, your average buy price per unit — that unlocks profit/loss tracking.
3. Add more holdings, or hit **"try a demo portfolio"** on the empty state to see it populated.
4. Adding an asset you already hold merges the positions (quantities add up, cost basis becomes the weighted average).

## Project layout

```
index.html        markup + app shell
css/styles.css    design tokens (light/dark) and layout
js/api.js         CoinGecko client with caching + rate-limit handling
js/store.js       localStorage persistence for holdings
js/charts.js      hand-rolled SVG charts (trend line, allocation bar, sparklines)
js/app.js         search, add/remove flow, refresh loop, rendering
```

No dependencies, no framework, no build.

## API usage

All market data comes from CoinGecko's public endpoints:

| Endpoint | Used for |
|---|---|
| `GET /search` | coin search in the add-holding form |
| `GET /coins/markets` (with `sparkline=true`) | live prices, 24h change, and 7-day hourly history in one call |

Responses are cached for 60s client-side and requests are deduped, keeping the
app comfortably inside the free tier's rate limits.

## Limitations (it's an MVP)

- Crypto only (CoinGecko); stocks/ETFs would need a keyed API (e.g. Finnhub, Alpha Vantage)
- USD only
- Holdings are per-browser — clearing site data clears the portfolio
