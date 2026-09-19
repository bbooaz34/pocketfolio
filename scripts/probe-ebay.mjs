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

  /* Q1/Q2: per-grade windowed vs lifetime figures */
  const buckets = row.ebay?.salesByGrade || {};
  console.log(`  ebay top-level keys: ${Object.keys(row.ebay || {}).join(",")}`);
  console.log(`  ebay.totalSales=${row.ebay?.totalSales} totalValue=${row.ebay?.totalValue}` +
    ` salesVelocity=${JSON.stringify(row.ebay?.salesVelocity)}` +
    ` dateRange=${row.ebay?.dateRangeStart}..${row.ebay?.dateRangeEnd}`);
  for (const [g, v] of Object.entries(buckets)) {
    if (!v || typeof v !== "object") { console.log(`  ${g}: ${v}`); continue; }
    console.log(`  ${g}: ` + Object.entries(v)
      .map(([k, val]) => `${k}=${typeof val === "object" ? JSON.stringify(val) : val}`).join(" "));
  }

  /* Q3: is graded history a dated series? */
  const eh = row.ebay?.priceHistory;
  if (eh && typeof eh === "object") {
    for (const [g, series] of Object.entries(eh)) {
      const dates = series && typeof series === "object" ? Object.keys(series) : [];
      console.log(`  history ${g}: ${Array.isArray(series) ? `array[${series.length}]` : `${dates.length} dated keys`}` +
        (dates.length ? ` ${dates[0]}..${dates[dates.length - 1]} · sample ${JSON.stringify(series[dates[0]])}` : ""));
    }
  } else {
    console.log(`  ebay.priceHistory: ${JSON.stringify(eh)}`);
  }
  console.log(`  raw priceHistory type: ${typeof row.priceHistory}` +
    ` keys=${row.priceHistory && typeof row.priceHistory === "object" ? Object.keys(row.priceHistory).join(",") : "-"}`);
  console.log("");
}

/* Q1 verdict: does anything change between windows? */
const counts = (o) => Object.fromEntries(Object.entries(o?.salesByGrade || {})
  .map(([g, v]) => [g, v?.salesCount ?? v?.count ?? null]));
console.log("=== salesCount per window");
for (const d of [7, 30, 180]) console.log(`  days=${d}: ${JSON.stringify(counts(byWindow[d]))}`);
console.log(`  totalSales: ${[7, 30, 180].map((d) => `${d}=${byWindow[d]?.totalSales}`).join(" ")}`);
const same = JSON.stringify(counts(byWindow[7])) === JSON.stringify(counts(byWindow[180]));
console.log(`  VERDICT: salesCount is ${same ? "LIFETIME (identical across windows)" : "WINDOWED"}`);

console.log("\n=== full ebay object (days=30), for the PRICING-ATTEMPTS.md fixture");
console.log(JSON.stringify(byWindow[30], null, 1));
console.log(`\ntotal credits spent: ${credits}`);
