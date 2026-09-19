#!/usr/bin/env node
/**
 * One-off probe: what do PPT's eBay numbers actually mean?
 * (TASK-verify-ppt-ebay-data.md step 1 — run via the "probe ebay" workflow.)
 *
 *   PPT_TOKEN=... node scripts/probe-ebay.mjs [cardId]
 *
 * Asks the same card at days=7/30/180 and dumps the raw ebay object, so we can
 * answer: is salesCount windowed, is there a per-window figure, is ebay history
 * a dated series, and which price fields exist per grade.
 *
 * Queries the way the builder does (stored search + PPT's own setId): exact
 * tcgPlayerId lookups answer total=1 with count=0 on this API (runs #6-#7).
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data");
const TOKEN = process.env.PPT_TOKEN || "";
const BASE = process.env.PPT_BASE || "https://www.pokemonpricetracker.com";
if (!TOKEN) { console.error("PPT_TOKEN required"); process.exit(1); }

const mapPath = join(DATA, "ppt-map.json");
const map = existsSync(mapPath) ? JSON.parse(readFileSync(mapPath, "utf8")) : {};
const cardId = process.argv[2] || Object.keys(map)[0];
const known = map[cardId];
if (!known?.search) { console.error(`no ppt-map entry for ${cardId}`); process.exit(1); }

console.log(`probing ${cardId} · search="${known.search}" setId=${known.setId} tcgPlayerId=${known.tcgPlayerId}\n`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let credits = 0;

async function ask(params) {
  const qs = new URLSearchParams(params);
  const res = await fetch(`${BASE}/api/v2/cards?${qs}`, {
    headers: { accept: "application/json", Authorization: "Bearer " + TOKEN },
  });
  const body = await res.json().catch(() => null);
  const header = Number(res.headers.get("x-api-calls-consumed"));
  const stated = Number(body?.metadata?.apiCallsConsumed?.total);
  const spent = [header, stated].find(Number.isFinite) ?? 0;
  credits += spent;
  const rows = Array.isArray(body) ? body : (body?.data ?? []);
  await sleep(1100);
  return { ok: res.ok, status: res.status, rows, spent, meta: body?.metadata,
    remaining: res.headers.get("x-ratelimit-daily-remaining") };
}

/* PSA only — a response carries ~45 grading-company buckets (cgc/bgs/ace/tag…)
   and the noise buries the answers. */
const isPsa = (k) => /^psa(10|[1-9])(_5)?$/i.test(k);
const pick = (o) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => isPsa(k)));

const byWindow = {};
for (const days of [7, 30, 180]) {
  const r = await ask({
    search: known.search,
    ...(known.setId != null ? { setId: String(known.setId) } : {}),
    limit: "1", includeEbay: "true", includeHistory: "true", days: String(days),
  });
  console.log(`=== days=${days} · http ${r.status} · consumed ${r.spent} · ${r.rows.length} row(s) · ${r.remaining} left`);
  const row = r.rows[0];
  if (!row) { console.log("  (no row)\n"); continue; }
  byWindow[days] = row.ebay;

  console.log(`  ebay keys: ${Object.keys(row.ebay || {}).join(",")}`);
  console.log(`  totalSales=${row.ebay?.totalSales} salesVelocity=${JSON.stringify(row.ebay?.salesVelocity)}` +
    ` range=${String(row.ebay?.dateRangeStart).slice(0, 10)}..${String(row.ebay?.dateRangeEnd).slice(0, 10)}`);

  /* Q1/Q2/Q4: which fields exist per PSA grade, and do they move with the window */
  for (const [g, v] of Object.entries(pick(row.ebay?.salesByGrade))) {
    if (!v || typeof v !== "object") { console.log(`  ${g}: ${v}`); continue; }
    console.log(`  ${g}: ` + Object.entries(v)
      .map(([k, val]) => `${k}=${typeof val === "object" ? JSON.stringify(val) : val}`).join(" "));
  }

  /* Q3: is graded history a dated series, and does its span follow `days`? */
  const eh = pick(row.ebay?.priceHistory);
  const spans = Object.entries(eh).map(([g, series]) => {
    const dates = series && typeof series === "object" && !Array.isArray(series) ? Object.keys(series).sort() : [];
    return `${g}:${Array.isArray(series) ? `arr[${series.length}]` : dates.length}` +
      (dates.length ? `(${dates[0]}..${dates[dates.length - 1]})` : "");
  });
  console.log(`  history spans: ${spans.join(" ") || "(none)"}`);
  const firstG = Object.keys(eh)[0];
  if (firstG) {
    const s = eh[firstG];
    const d0 = Object.keys(s)[0];
    console.log(`  history sample ${firstG}[${d0}] = ${JSON.stringify(s[d0])}`);
  }
  console.log("");
}

/* Q1 verdict: does the count change between windows? */
const counts = (o) => Object.fromEntries(Object.entries(pick(o?.salesByGrade))
  .map(([g, v]) => [g, v?.salesCount ?? v?.count ?? null]));
const histLen = (o) => Object.fromEntries(Object.entries(pick(o?.priceHistory))
  .map(([g, s]) => [g, s && typeof s === "object" ? Object.keys(s).length : 0]));
console.log("=== Q1 salesCount per window (PSA)");
for (const d of [7, 30, 180]) console.log(`  days=${d}: ${JSON.stringify(counts(byWindow[d]))}`);
console.log(`  totalSales: ${[7, 30, 180].map((d) => `${d}=${byWindow[d]?.totalSales}`).join(" ")}`);
console.log(`  VERDICT: salesCount is ${
  JSON.stringify(counts(byWindow[7])) === JSON.stringify(counts(byWindow[180]))
    ? "LIFETIME/FIXED (identical at days=7 and days=180)" : "WINDOWED"}`);

console.log("=== Q3 graded-history length per window (PSA)");
for (const d of [7, 30, 180]) console.log(`  days=${d}: ${JSON.stringify(histLen(byWindow[d]))}`);
console.log(`  VERDICT: graded history ${
  JSON.stringify(histLen(byWindow[7])) === JSON.stringify(histLen(byWindow[180]))
    ? "IGNORES `days` (same length)" : "RESPECTS `days`"}`);

console.log("\n=== fixture: PSA slice of the ebay object (days=30)");
console.log(JSON.stringify({
  totalSales: byWindow[30]?.totalSales,
  salesVelocity: byWindow[30]?.salesVelocity,
  dateRangeStart: byWindow[30]?.dateRangeStart,
  dateRangeEnd: byWindow[30]?.dateRangeEnd,
  salesByGrade: pick(byWindow[30]?.salesByGrade),
  smartPriceOutlierByGrade: pick(byWindow[30]?.smartPriceOutlierByGrade),
  priceHistory_psa9_sample: Object.entries(pick(byWindow[30]?.priceHistory).psa9 || {}).slice(0, 3),
}, null, 1));
console.log(`\ntotal credits spent: ${credits}`);
