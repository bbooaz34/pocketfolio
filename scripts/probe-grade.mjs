#!/usr/bin/env node
/**
 * One-off probe: everything PPT holds for ONE grade of ONE card.
 *
 *   PPT_TOKEN=... node scripts/probe-grade.mjs [cardId] [grade]
 *
 * Asked because three real PSA 1 Base Set Charizard sales (20-21 Sep 2026)
 * were missing from our snapshot while the provider claimed to have refreshed
 * the card that same day. One call, days=365, so we see the widest series the
 * provider will give us and can tell "never ingested" from "ingested but not
 * surfaced in lastSaleDate".
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = process.env.PPT_TOKEN || "";
const BASE = process.env.PPT_BASE || "https://www.pokemonpricetracker.com";
if (!TOKEN) { console.error("PPT_TOKEN required"); process.exit(1); }

const mapPath = join(ROOT, "data", "ppt-map.json");
const map = existsSync(mapPath) ? JSON.parse(readFileSync(mapPath, "utf8")) : {};
const cardId = process.argv[2] || Object.keys(map)[0];
const grade = (process.argv[3] || "psa1").toLowerCase();
const since = process.argv[4] || "";
const known = map[cardId];
if (!known?.search) { console.error(`no ppt-map entry for ${cardId}`); process.exit(1); }

const qs = new URLSearchParams({
  search: known.search,
  ...(known.setId != null ? { setId: String(known.setId) } : {}),
  limit: "1", includeEbay: "true", includeHistory: "true", days: "365",
});
const res = await fetch(`${BASE}/api/v2/cards?${qs}`, {
  headers: { accept: "application/json", Authorization: "Bearer " + TOKEN },
});
const body = await res.json().catch(() => null);
const rows = Array.isArray(body) ? body : (body?.data ?? []);
const row = rows[0];
console.log(`probing ${cardId} grade=${grade} · http ${res.status} · consumed ${res.headers.get("x-api-calls-consumed")} · ${res.headers.get("x-ratelimit-daily-remaining")} left`);
if (!row) { console.log(JSON.stringify(body).slice(0, 800)); process.exit(0); }

console.log(`row: ${row.name} | ${row.setName} | setId=${row.setId} | tcg=${row.tcgPlayerId} | #${row.number}`);
console.log(`lastMarketUpdate = ${row.lastMarketUpdate}`);
console.log(`row keys: ${Object.keys(row).join(",")}`);

const e = row.ebay || {};
console.log(`ebay keys: ${Object.keys(e).join(",")}`);
console.log(`totalSales=${e.totalSales} totalValue=${e.totalValue} gradesTracked=${JSON.stringify(e.gradesTracked)}`);
console.log(`range=${String(e.dateRangeStart).slice(0,10)}..${String(e.dateRangeEnd).slice(0,10)}`);
console.log(`ebay.updatedAt=${e.updatedAt} lastScrapedDate=${e.lastScrapedDate} lastEbayCheck=${e.lastEbayCheck}`);

console.log(`\n=== salesByGrade.${grade}`);
console.log(JSON.stringify(e.salesByGrade?.[grade], null, 1));

console.log(`\n=== smartPriceOutlierByGrade.${grade}`);
console.log(JSON.stringify(e.smartPriceOutlierByGrade?.[grade], null, 1));

const series = e.priceHistory?.[grade];
console.log(`\n=== priceHistory.${grade} (full, ${series ? (Array.isArray(series) ? series.length : Object.keys(series).length) : 0} points)`);
if (series && !Array.isArray(series)) {
  for (const d of Object.keys(series).sort()) console.log(`  ${d}  ${JSON.stringify(series[d])}`);
} else {
  console.log(JSON.stringify(series, null, 1));
}

/* Where did the recent sales land? Every bucket, not just PSA: if a sale the
   owner saw on eBay was filed under another grading company or another grade,
   this is where it shows. */
if (since) {
  console.log(`\n=== every bucket, dated points on/after ${since}`);
  for (const [g, s2] of Object.entries(e.priceHistory || {})) {
    if (!s2 || typeof s2 !== "object" || Array.isArray(s2)) continue;
    for (const d of Object.keys(s2).sort()) {
      if (d >= since) console.log(`  ${g.padEnd(10)} ${d}  ${JSON.stringify(s2[d])}`);
    }
  }
  console.log(`\n=== every bucket: count / lastSaleDate / lastMarketUpdate`);
  for (const [g, v] of Object.entries(e.salesByGrade || {})) {
    if (!v || typeof v !== "object") continue;
    console.log(`  ${g.padEnd(10)} count=${String(v.count).padStart(4)} last=${String(v.lastSaleDate).slice(0,10)}` +
      ` upd=${String(v.lastMarketUpdate).slice(0,16)} min=${v.minPrice} max=${v.maxPrice} vol7=${v.dailyVolume7Day} p7=${v.marketPrice7Day}`);
  }
}

/* Any per-sale list anywhere in the payload? Hunt for arrays of objects that
   look like individual sales (a price and a date on the same object). */
console.log(`\n=== hunt for individual-sale arrays`);
const seen = new Set();
(function walk(o, path, depth) {
  if (!o || typeof o !== "object" || depth > 6 || seen.has(o)) return;
  seen.add(o);
  if (Array.isArray(o)) {
    const s = o[0];
    if (s && typeof s === "object" && Object.keys(s).some(k => /date|sold|end/i.test(k))) {
      console.log(`  ${path} [${o.length}] sample=${JSON.stringify(s).slice(0, 300)}`);
    }
    o.slice(0, 3).forEach((v, i) => walk(v, `${path}[${i}]`, depth + 1));
    return;
  }
  for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`, depth + 1);
})(row, "row", 0);
console.log("  (end)");
