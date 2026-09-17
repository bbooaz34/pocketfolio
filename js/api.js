/* Pocketfolio — card data client with provider failover.

   Primary:  Pokémon TCG API (pokemontcg.io) — no key required, TCGplayer USD
             prices. Docs: https://docs.pokemontcg.io
             Optional free key raises rate limits:
             localStorage.setItem("pocketfolio.tcgApiKey", "<key>")
   Fallback: TCGdex (tcgdex.net) — open-source, no key, CDN-backed; pricing
             from TCGplayer (USD) and Cardmarket (EUR) where available.
             Docs: https://tcgdex.dev

   Every function returns NORMALIZED cards:
   { provider, id, name, number, setName, rarity, image,
     price: { value, currency ("USD"|"EUR"), variant, updatedAt } | null } */

(function () {
  "use strict";

  const cache = new Map(); // url -> { at, data }
  const inflight = new Map();
  const CACHE_TTL_MS = 10 * 60 * 1000; // prices update ~daily

  // Remember which provider worked last so retries go there first.
  let preferred = "ptcgio";

  async function getJSON(url, headers, ttl = CACHE_TTL_MS) {
    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < ttl) return hit.data;
    if (inflight.has(url)) return inflight.get(url);

    const p = (async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      try {
        const res = await fetch(url, { headers, signal: ctrl.signal });
        if (res.status === 429) {
          const err = new Error("rate-limited");
          err.rateLimited = true;
          throw err;
        }
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        cache.set(url, { at: Date.now(), data });
        return data;
      } finally {
        clearTimeout(timer);
      }
    })();

    inflight.set(url, p);
    try {
      return await p;
    } finally {
      inflight.delete(url);
    }
  }

  function firstPositive(...vals) {
    for (const v of vals) if (typeof v === "number" && v > 0) return v;
    return null;
  }

  /* ---------------- pokemontcg.io ---------------- */

  const PTCGIO = "https://api.pokemontcg.io/v2";
  const PTCGIO_SELECT = "id,name,number,rarity,set,images,tcgplayer";
  const VARIANT_ORDER = [
    "holofoil", "1stEditionHolofoil", "unlimitedHolofoil",
    "normal", "1stEditionNormal", "unlimited", "reverseHolofoil",
  ];

  function ptcgioHeaders() {
    const h = { accept: "application/json" };
    try {
      const key = localStorage.getItem("pocketfolio.tcgApiKey");
      if (key) h["X-Api-Key"] = key;
    } catch { /* storage unavailable */ }
    return h;
  }

  function ptcgioNormalize(c) {
    let price = null;
    const tp = c.tcgplayer;
    if (tp && tp.prices) {
      const variants = [...VARIANT_ORDER.filter((v) => tp.prices[v]),
                        ...Object.keys(tp.prices).filter((v) => !VARIANT_ORDER.includes(v))];
      for (const v of variants) {
        const val = firstPositive(tp.prices[v]?.market, tp.prices[v]?.mid, tp.prices[v]?.low);
        if (val) { price = { value: val, currency: "USD", variant: v, updatedAt: tp.updatedAt || null }; break; }
      }
    }
    return {
      provider: "ptcgio",
      id: c.id,
      name: c.name,
      number: c.number || null,
      setName: c.set?.name || null,
      rarity: c.rarity || null,
      image: c.images?.small || null,
      price,
    };
  }

  async function ptcgioSearch(namePart) {
    const q = namePart
      .replace(/["\\]/g, "")
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `name:${t}*`)
      .join(" ");
    if (!q) return [];
    const url = PTCGIO + "/cards?" + new URLSearchParams({
      q, pageSize: "20", orderBy: "-set.releaseDate", select: PTCGIO_SELECT,
    });
    const data = await getJSON(url, ptcgioHeaders(), 30 * 60 * 1000);
    return (data.data || []).map(ptcgioNormalize);
  }

  async function ptcgioGetCard(id) {
    const url = PTCGIO + "/cards/" + encodeURIComponent(id) + "?" +
      new URLSearchParams({ select: PTCGIO_SELECT });
    const data = await getJSON(url, ptcgioHeaders());
    return data.data ? ptcgioNormalize(data.data) : null;
  }

  async function ptcgioGetCards(ids) {
    const q = "(" + ids.map((id) => `id:"${id.replace(/["\\]/g, "")}"`).join(" OR ") + ")";
    const url = PTCGIO + "/cards?" + new URLSearchParams({
      q, pageSize: "250", select: PTCGIO_SELECT,
    });
    const data = await getJSON(url, ptcgioHeaders());
    return (data.data || []).map(ptcgioNormalize);
  }

  /* ---------------- TCGdex ---------------- */

  const TCGDEX = "https://api.tcgdex.net/v2/en";

  /* TCGdex pricing shapes have evolved, so probe defensively: prefer any
     TCGplayer variant's market/mid/low (USD), else Cardmarket trend (EUR). */
  function tcgdexPrice(pricing) {
    if (!pricing || typeof pricing !== "object") return null;
    const tp = pricing.tcgplayer;
    if (tp && typeof tp === "object") {
      for (const [k, v] of Object.entries(tp)) {
        if (!v || typeof v !== "object") continue;
        const val = firstPositive(v.marketPrice, v.market, v.midPrice, v.mid, v.lowPrice, v.low);
        if (val) return { value: val, currency: "USD", variant: k, updatedAt: tp.updated || null };
      }
    }
    const cm = pricing.cardmarket;
    if (cm && typeof cm === "object") {
      const val = firstPositive(cm.trend, cm.trendPrice, cm.avg30, cm.avg7, cm.avg,
                                cm.averageSellPrice, cm.low, cm.lowPrice);
      if (val) return { value: val, currency: "EUR", variant: "Cardmarket", updatedAt: cm.updated || null };
    }
    return null;
  }

  function tcgdexNormalize(c) {
    return {
      provider: "tcgdex",
      id: c.id,
      name: c.name,
      number: c.localId != null ? String(c.localId) : null,
      setName: c.set?.name || null,
      rarity: c.rarity || null,
      image: c.image ? c.image + "/low.webp" : null,
      price: tcgdexPrice(c.pricing),
    };
  }

  async function tcgdexGetCard(id) {
    const data = await getJSON(TCGDEX + "/cards/" + encodeURIComponent(id), { accept: "application/json" });
    return data && data.id ? tcgdexNormalize(data) : null;
  }

  async function tcgdexSearch(namePart) {
    const url = TCGDEX + "/cards?" + new URLSearchParams({ name: namePart });
    const briefs = await getJSON(url, { accept: "application/json" }, 30 * 60 * 1000);
    if (!Array.isArray(briefs)) return [];
    // Briefs carry only id/name/image — fetch details so the dropdown can show
    // set, number, and price. Rank exact name matches first, then take 20.
    const wanted = namePart.trim().toLowerCase();
    const rank = (b) => {
      const n = (b.name || "").toLowerCase();
      return n === wanted ? 0 : n.startsWith(wanted) ? 1 : 2;
    };
    const picks = briefs.slice().sort((a, b) => rank(a) - rank(b)).slice(0, 20);
    const cards = await Promise.all(picks.map((b) => tcgdexGetCard(b.id).catch(() => null)));
    return cards.filter(Boolean);
  }

  /* ---------------- failover façade ---------------- */

  const providers = {
    ptcgio: { search: ptcgioSearch, getCard: ptcgioGetCard },
    tcgdex: { search: tcgdexSearch, getCard: tcgdexGetCard },
  };

  function order() {
    return preferred === "tcgdex" ? ["tcgdex", "ptcgio"] : ["ptcgio", "tcgdex"];
  }

  /* People type "charmander base set" — card name plus set/qualifier words.
     Card APIs only match the NAME, so: query with progressively fewer leading
     words as the name until something comes back, then use the leftover words
     as a best-effort filter over name + set + number + rarity (a leftover word
     that matches nothing at all, like the "set" in "Base", is ignored rather
     than wiping the results). */
  function filterByTerms(cards, terms) {
    const hay = (c) =>
      `${c.name} ${c.setName || ""} #${c.number || ""} ${c.rarity || ""}`.toLowerCase();
    const kept = terms
      .map((t) => t.toLowerCase())
      .filter((t) => t && cards.some((c) => hay(c).includes(t)));
    if (!kept.length) return cards;
    const out = cards.filter((c) => kept.every((t) => hay(c).includes(t)));
    return out.length ? out : cards;
  }

  async function providerSearch(name, query) {
    const tokens = query.trim().split(/\s+/).filter(Boolean).slice(0, 5);
    for (let k = tokens.length; k >= 1; k--) {
      const cards = await providers[name].search(tokens.slice(0, k).join(" "));
      if (cards.length) return filterByTerms(cards, tokens.slice(k));
    }
    return [];
  }

  /** Search cards, failing over between providers (also when one has no match). */
  async function searchCards(query) {
    let lastErr = null;
    for (const name of order()) {
      try {
        const cards = await providerSearch(name, query);
        if (cards.length) {
          preferred = name;
          return cards;
        }
      } catch (err) {
        lastErr = err;
      }
    }
    if (lastErr) throw lastErr;
    return [];
  }

  /** Fetch one card by (provider, id), failing over to the other provider —
      ids for classic sets (e.g. base1-4) match across both. */
  async function getCard(provider, id) {
    const first = providers[provider] ? provider : "ptcgio";
    const second = first === "ptcgio" ? "tcgdex" : "ptcgio";
    for (const name of [first, second]) {
      try {
        const card = await providers[name].getCard(id);
        if (card) return card;
      } catch (err) {
        if (err.rateLimited && name === second) throw err;
      }
    }
    return null;
  }

  /** Refresh a set of holdings' cards. `refs` is [{provider, id}].
      Returns normalized cards; cards that fail stay absent (caller keeps
      its cached copy). Uses one batch call per provider where possible. */
  async function getCards(refs) {
    const out = [];
    const byProvider = { ptcgio: [], tcgdex: [] };
    for (const r of refs) (byProvider[r.provider] || byProvider.ptcgio).push(r.id);

    if (byProvider.ptcgio.length) {
      try {
        out.push(...await ptcgioGetCards(byProvider.ptcgio));
      } catch {
        // batch failed — fall through to per-card with tcgdex failover
        const cards = await Promise.all(
          byProvider.ptcgio.map((id) => getCard("ptcgio", id).catch(() => null)));
        out.push(...cards.filter(Boolean));
      }
    }
    if (byProvider.tcgdex.length) {
      const cards = await Promise.all(
        byProvider.tcgdex.map((id) => getCard("tcgdex", id).catch(() => null)));
      out.push(...cards.filter(Boolean));
    }
    return out;
  }

  window.PocketfolioAPI = { searchCards, getCard, getCards };
})();
