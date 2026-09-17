/* Pocketfolio graded-prices proxy — a Cloudflare Worker.
 *
 * The PokemonPriceTracker API doesn't allow calls from web pages (no CORS
 * headers), so the app can't reach it directly from GitHub Pages. This tiny
 * proxy, deployed on YOUR OWN free Cloudflare account, forwards the app's
 * requests and adds the CORS headers. Your API key travels only from your
 * browser through your worker to the API — no third party sees it.
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
    if (!url.pathname.startsWith("/api/v2/")) {
      return new Response(JSON.stringify({ error: "only /api/v2/* is proxied" }), {
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
