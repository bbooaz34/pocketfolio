/* Pocketfolio — Pokémon TCG API client (pokemontcg.io, no key required).
   Docs: https://docs.pokemontcg.io
   Card data + live TCGplayer market prices (raw/ungraded, updated daily).
   An optional API key (free at dev.pokemontcg.io) raises the rate limits:
   localStorage.setItem("pocketfolio.tcgApiKey", "<key>") */

(function () {
  "use strict";

  const BASE = "https://api.pokemontcg.io/v2";
  const SELECT = "id,name,number,rarity,set,images,tcgplayer";

  const cache = new Map(); // url -> { at, data }
  const inflight = new Map();
  const CACHE_TTL_MS = 10 * 60 * 1000; // TCGplayer prices update daily

  function headers() {
    const h = { accept: "application/json" };
    try {
      const key = localStorage.getItem("pocketfolio.tcgApiKey");
      if (key) h["X-Api-Key"] = key;
    } catch { /* storage unavailable */ }
    return h;
  }

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
      const res = await fetch(key, { headers: headers() });
      if (res.status === 429) {
        const err = new Error("Pokémon TCG API rate limit reached — try again in a minute.");
        err.rateLimited = true;
        throw err;
      }
      if (!res.ok) throw new Error("Pokémon TCG API request failed (" + res.status + ")");
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

  /** Search cards by name (each word matched as a prefix). Returns card objects. */
  async function searchCards(query) {
    const terms = query
      .replace(/["\\]/g, "")
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `name:${t}*`)
      .join(" ");
    if (!terms) return [];
    const data = await get("/cards", {
      q: terms,
      pageSize: 12,
      orderBy: "-set.releaseDate",
      select: SELECT,
    }, { ttl: 30 * 60 * 1000 });
    return data.data || [];
  }

  /** Fetch a batch of cards by id (one query; falls back to per-card fetches). */
  async function getCards(ids) {
    if (!ids.length) return [];
    const q = "(" + ids.map((id) => `id:"${id.replace(/["\\]/g, "")}"`).join(" OR ") + ")";
    try {
      const data = await get("/cards", { q, pageSize: 250, select: SELECT });
      if (Array.isArray(data.data) && data.data.length) return data.data;
    } catch (err) {
      if (err.rateLimited) throw err;
      /* fall through to per-card fetches */
    }
    const out = [];
    for (const id of ids) {
      try {
        const one = await get("/cards/" + encodeURIComponent(id), { select: SELECT });
        if (one.data) out.push(one.data);
      } catch (err) {
        if (err.rateLimited) throw err;
      }
    }
    return out;
  }

  /** Best available raw (ungraded) price for a card from TCGplayer, in USD.
      Returns {price, variant, updatedAt} or null if the card has no price data. */
  const VARIANT_ORDER = [
    "holofoil", "1stEditionHolofoil", "unlimitedHolofoil",
    "normal", "1stEditionNormal", "unlimited", "reverseHolofoil",
  ];

  function rawPrice(card) {
    const tp = card.tcgplayer;
    const prices = tp && tp.prices;
    if (!prices) return null;
    const variants = [...VARIANT_ORDER.filter((v) => prices[v]),
                      ...Object.keys(prices).filter((v) => !VARIANT_ORDER.includes(v))];
    for (const v of variants) {
      const p = prices[v];
      const price = p && (p.market ?? p.mid ?? p.low);
      if (typeof price === "number" && price > 0) {
        return { price, variant: v, updatedAt: tp.updatedAt || null };
      }
    }
    return null;
  }

  window.PocketfolioAPI = { searchCards, getCards, rawPrice };
})();
