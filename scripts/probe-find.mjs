#!/usr/bin/env node
/**
 * One-off probe: which PPT rows does a search actually return, and what is
 * the setId of the set we want?
 *
 *   PPT_TOKEN=... node scripts/probe-find.mjs "<search>" [limit] [setMatch]
 *
 * Charmander SVP 044 could not be reached by name or by set name, and every
 * fix for it was a guess about how PPT's search behaves. This asks instead:
 * no includes, so it costs rows only, and it prints name / setName / setId /
 * tcgPlayerId per row — which is exactly what the watchlist needs in order to
 * pin pptSetId and stop searching blind.
 */
const TOKEN = process.env.PPT_TOKEN || "";
const BASE = process.env.PPT_BASE || "https://www.pokemonpricetracker.com";
if (!TOKEN) { console.error("PPT_TOKEN required"); process.exit(1); }

const search = process.argv[2] || "Charmander";
const limit = process.argv[3] || "60";
const want = (process.argv[4] || "").toLowerCase();

const qs = new URLSearchParams({ search, limit: String(limit) });
const res = await fetch(`${BASE}/api/v2/cards?${qs}`, {
  headers: { accept: "application/json", Authorization: "Bearer " + TOKEN },
});
const body = await res.json().catch(() => null);
const rows = Array.isArray(body) ? body : (body?.data ?? []);
const spent = res.headers.get("x-api-calls-consumed");
console.log(`search="${search}" limit=${limit} · http ${res.status} · consumed ${spent}` +
  ` · ${rows.length} row(s) of ${body?.metadata?.total ?? "?"} · ` +
  `${res.headers.get("x-ratelimit-daily-remaining")} left\n`);

for (const r of rows) {
  const set = r.setName ?? r.set?.name ?? "?";
  const hit = want && `${r.name} ${set}`.toLowerCase().includes(want) ? " <<<" : "";
  console.log(`  ${String(r.name ?? "?").padEnd(46)} | ${String(set).padEnd(38)}` +
    ` | setId=${r.setId ?? r.set?.id ?? "?"} tcg=${r.tcgPlayerId ?? r.tcgplayerId ?? "?"}` +
    ` | #${r.cardNumber ?? r.number ?? ""}${hit}`);
}
if (want) {
  const hits = rows.filter((r) => `${r.name} ${r.setName ?? r.set?.name ?? ""}`.toLowerCase().includes(want));
  console.log(`\n${hits.length} row(s) matching "${want}"`);
}
