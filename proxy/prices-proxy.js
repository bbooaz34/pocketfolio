/* Pocketfolio graded-prices proxy — a Cloudflare Worker.
 *
 * The PokemonPriceTracker API doesn't allow calls from web pages (no CORS
 * headers), so the app can't reach it directly from GitHub Pages. This tiny
 * proxy, deployed on YOUR OWN free Cloudflare account, forwards the app's
 * requests and adds the CORS headers. Your API key travels only from your
 * browser through your worker to the API — no third party sees it.
 *
 * It also proxies PSA cert pages (/cert/<number> → psacard.com/cert/<number>),
 * which have no CORS headers either — with the worker set, the cert search no
 * longer depends on flaky public read-through proxies.
 *
 * Setup (~5 minutes, free, no credit card):
 *   1. Create an account at https://dash.cloudflare.com
 *   2. Workers & Pages → Create → Worker → name it (e.g. pocketfolio-prices)
 *      → Deploy
 *   3. Edit code → replace everything with this file → Deploy
 *   4. Copy the worker URL (https://pocketfolio-prices.<your-name>.workers.dev)
 *   5. In Pocketfolio: ⚙ → "Prices proxy URL…" → paste it
 */

const UPSTREAM = "https://www.pokemonpricetracker.com";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Accept, Content-Type",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405, headers: CORS });
    }
    const url = new URL(request.url);

    /* PSA cert page: /cert/12345678 → https://www.psacard.com/cert/12345678 */
    const cert = url.pathname.match(/^\/cert\/(\d{5,12})$/);
    if (cert) {
      const upstream = await fetch("https://www.psacard.com/cert/" + cert[1], {
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
          "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) " +
            "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile Safari/604.1",
        },
      });
      return new Response(await upstream.text(), {
        status: upstream.status,
        headers: { ...CORS, "Content-Type": "text/html; charset=utf-8" },
      });
    }

    /* TCG news: /news → first reachable RSS feed, cached half an hour.
       (PokeBeach's old /feed endpoint broke in a 2024 site move — their
       front-page news feed lives under the forums now.) */
    if (url.pathname === "/news") {
      const FEEDS = [
        "https://www.pokebeach.com/forums/forum/front-page-news.18/index.rss",
        "https://bleedingcool.com/games/tabletop/card-games/pokemon-tcg/feed/",
        "https://pokemondb.net/news/feed",
      ];
      for (const feed of FEEDS) {
        try {
          const upstream = await fetch(feed, {
            headers: {
              Accept: "application/rss+xml, application/xml, text/xml;q=0.9",
              "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) " +
                "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile Safari/604.1",
            },
            cf: { cacheTtl: 1800, cacheEverything: true },
          });
          if (!upstream.ok) continue;
          const body = await upstream.text();
          if (!body.includes("<item")) continue; // an error page, not a feed
          return new Response(body, {
            headers: {
              ...CORS,
              "Content-Type": "text/xml; charset=utf-8",
              "Cache-Control": "public, max-age=1800",
            },
          });
        } catch { /* try the next feed */ }
      }
      return new Response("no news feed reachable", { status: 502, headers: CORS });
    }

    if (!url.pathname.startsWith("/api/v2/")) {
      return new Response(JSON.stringify({ error: "only /api/v2/*, /cert/* and /news are proxied" }), {
        status: 403,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    const upstream = await fetch(UPSTREAM + url.pathname + url.search, {
      headers: {
        Accept: "application/json",
        Authorization: request.headers.get("Authorization") || "",
      },
    });
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: {
        ...CORS,
        "Content-Type": upstream.headers.get("Content-Type") || "application/json",
      },
    });
  },
};
