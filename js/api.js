/* Pocketfolio — CoinGecko public API client (no key required).
   Docs: https://docs.coingecko.com/reference/introduction */

(function () {
  "use strict";

  const BASE = "https://api.coingecko.com/api/v3";

  // The free tier is rate-limited (~5-15 req/min), so cache GETs briefly
  // and dedupe in-flight requests for the same URL.
  const cache = new Map(); // url -> { at, data }
  const inflight = new Map(); // url -> Promise
  const CACHE_TTL_MS = 60 * 1000;

  async function get(path, params, { ttl = CACHE_TTL_MS } = {}) {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const key = url.toString();

    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.data;
    if (inflight.has(key)) return inflight.get(key);

    const p = (async () => {
      const res = await fetch(key, { headers: { accept: "application/json" } });
      if (res.status === 429) {
        const err = new Error("CoinGecko rate limit reached — try again in a minute.");
        err.rateLimited = true;
        throw err;
      }
      if (!res.ok) throw new Error("CoinGecko request failed (" + res.status + ")");
      const data = await res.json();
      cache.set(key, { at: Date.now(), data });
      return data;
    })();

    inflight.set(key, p);
    try {
      return await p;
    } finally {
      inflight.delete(key);
    }
  }

  /** Search coins by name/symbol. Returns [{id, name, symbol, thumb, market_cap_rank}] */
  async function searchCoins(query) {
    const data = await get("/search", { query }, { ttl: 5 * 60 * 1000 });
    return (data.coins || []).slice(0, 8);
  }

  /** Live market data for a set of coin ids, including 7d hourly sparkline.
      Returns [{id, symbol, name, image, current_price, price_change_percentage_24h_in_currency,
                sparkline_in_7d: {price: [...]}, ...}] */
  async function getMarkets(ids) {
    if (!ids.length) return [];
    return get("/coins/markets", {
      vs_currency: "usd",
      ids: ids.join(","),
      sparkline: true,
      price_change_percentage: "24h,7d",
      per_page: Math.min(ids.length, 250),
    });
  }

  window.PocketfolioAPI = { searchCoins, getMarkets };
})();
