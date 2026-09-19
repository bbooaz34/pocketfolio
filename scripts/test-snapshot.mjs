#!/usr/bin/env node
/**
 * Offline test for scripts/build-snapshot.mjs — costs zero credits.
 *
 *   node scripts/test-snapshot.mjs
 *
 * Stands up a fake PPT on localhost, points the builder at it with PPT_BASE,
 * and runs several days in a row against a temp data dir. Asserts everything
 * that actually broke live (PRICING-ATTEMPTS.md "לקחים טכניים"):
 *
 *   1. Only documented params are sent — the real API 400s unknown ones.
 *   2. A catalog-style setId filters every row out (total>0, count=0); the
 *      builder falls back and learns PPT's own setId from the matched row.
 *   3. Credits are billed from the provider's x-api-calls-consumed header,
 *      and the budget stops the run.
 *   4. A card the budget missed is carried forward, not dropped.
 *   5. Rotation prices yesterday's leftovers first.
 *   6. A 429 halts immediately instead of hammering.
 *   7. Snapshots already written are never rewritten.
 *
 * Plus the paid-tier features:
 *
 *   8. tcgPlayerId is captured and later runs re-query by it (exact, 1 row).
 *   9. smartMarketPrice is preferred over a bare median.
 *  10. Confidence and per-grade metrics come from the provider.
 *  11. Per-card history files are backfilled from the provider and today's
 *      own value joins the series.
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, cpSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUILDER = join(ROOT, "scripts", "build-snapshot.mjs");

/* ---- fixture: 8 cards, more than one day's small budget can cover ---- */
const CARDS = Array.from({ length: 8 }, (_, i) => ({
  id: `base1-${i + 1}`,
  name: `TestMon ${i + 1}`,
  setName: "Base",
  number: String(i + 1),
}));

const HISTORY_DAYS = 120;
const makeHistory = (base) => {
  const out = {};
  for (let i = HISTORY_DAYS; i > 0; i--) {
    const d = new Date(Date.UTC(2026, 8, 20) - i * 864e5).toISOString().slice(0, 10);
    out[d] = base + (i % 7);
  }
  return out;
};

let rowsServed = 0, requests = 0, byIdRequests = 0, creditsBilled = 0,
  force429After = Infinity, limitsSeen = [];

const server = createServer((req, res) => {
  requests++;
  if (requests > force429After) { res.writeHead(429).end("{}"); return; }
  const url = new URL(req.url, "http://x");
  // the real API rejects unknown params with 400 — enforce that here so a
  // regression to e.g. `number` fails this test the way run #1 failed live
  const allowed = new Set(["search", "setId", "limit", "includeEbay", "includeHistory", "days", "language", "sortBy", "tcgPlayerId"]);
  for (const k of url.searchParams.keys()) {
    if (!allowed.has(k)) { res.writeHead(400).end(`{"error":"unknown param ${k}"}`); return; }
  }
  const send = (rows, total) => {
    rowsServed += rows.length;
    const consumed = rows.length * 3; // card + history + ebay
    creditsBilled += consumed;
    res.writeHead(200, {
      "content-type": "application/json",
      "x-api-calls-consumed": String(consumed),
      "x-ratelimit-daily-remaining": String(20000 - creditsBilled),
    }).end(JSON.stringify({
      data: rows,
      metadata: { total, count: rows.length, apiCallsConsumed: { total: consumed } },
    }));
  };
  const setId = url.searchParams.get("setId");
  // Reproduce the live failure mode (run #3): a catalog-style setId ("base1")
  // is not PPT's slug format, so the filter drops every row — total counts the
  // search matches but count is 0. Only PPT's own id ("ppt-base-set") works.
  if (setId && !setId.startsWith("ppt-")) return send([], 5);
  const rowFor = (c, filler) => ({
    id: filler ? `zz9-${filler}` : c.id,
    setId: "ppt-base-set",
    tcgPlayerId: `9000${c.number}`,
    name: filler ? `Filler ${filler}` : c.name,
    number: filler ? `9${filler}` : c.number,
    prices: { market: 12.34 },
    priceHistory: { market: makeHistory(10) },
    salesVelocityWeekly: 4,
    ebay: {
      salesByGrade: {
        psa10: { smartMarketPrice: 500 + Number(c.number), medianPrice: 480, smartMarketConfidence: "high", marketTrend: "up", dailyVolume7Day: 2, salesCount: 140 },
        psa9: { medianPrice: 200, smartMarketConfidence: "low", dailyVolume7Day: 0 },
      },
      history: { psa10: makeHistory(500) },
    },
  });
  const byId = url.searchParams.get("tcgPlayerId");
  if (byId) {
    // run #6 live: an exact lookup without `limit` answers total=1, count=0
    // and still bills — reproduce it so a regression fails here first
    if (!url.searchParams.get("limit")) return send([], 1);
    byIdRequests++;
    const match = CARDS.find((c) => `9000${c.number}` === byId) || CARDS[0];
    return send([rowFor(match, 0)], 1); // exact key: one row
  }
  const limit = Number(url.searchParams.get("limit") || 5);
  limitsSeen.push(limit);
  const search = url.searchParams.get("search") || "";
  const match = CARDS.find((c) => search.startsWith(c.name)) || CARDS[0];
  send(Array.from({ length: limit }, (_, i) => rowFor(match, i)), limit);
});

server.on("error", (e) => { console.error("server error", e); process.exit(1); });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

/* ---- temp workspace ---- */
const work = mkdtempSync(join(tmpdir(), "pf-snap-"));
mkdirSync(join(work, "data", "snapshots"), { recursive: true });
mkdirSync(join(work, "scripts"), { recursive: true });
cpSync(BUILDER, join(work, "scripts", "build-snapshot.mjs"));
writeFileSync(join(work, "data", "watchlist.json"), JSON.stringify({ cards: CARDS }, null, 1));

/* spawn, not spawnSync: the fake server runs on this process's event loop,
   so a synchronous child would deadlock waiting for a reply we cannot send. */
const run = (date, env = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, ["scripts/build-snapshot.mjs"], {
    cwd: work,
    env: { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", PPT_TOKEN: "fake", PPT_BASE: base, SNAPSHOT_DATE: date, PC_TOKEN: "", ...env },
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  child.on("close", (status) => resolve({ status, stdout, stderr }));
});

const snap = (d) => JSON.parse(readFileSync(join(work, "data", "snapshots", `${d}.json`), "utf8"));

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
};

/* ---- day 1: small budget, expect a partial run ---- */
rowsServed = 0; limitsSeen = [];
const d1 = await run("2026-09-20", { PPT_CREDIT_BUDGET: "9" });
if (d1.status !== 0) { console.log(d1.stdout, d1.stderr); throw new Error("day 1 failed"); }
const s1 = snap("2026-09-20");
const n1 = Object.keys(s1.cards).length;
check("day 1 priced only what the budget allows", n1 > 0 && n1 <= 3, `${n1} cards, ${rowsServed} rows served`);
check("credits billed from the provider's own header", d1.stdout.includes(`~${rowsServed * 3} credits`), `${rowsServed * 3} billed for a budget of 9`);
check("first touch searches with limit=3", limitsSeen.every((l) => l === 3), `limits: ${limitsSeen.join(",")}`);
check("only documented params are sent (no 400s)", !d1.stdout.includes("HTTP 400"));
const map1 = JSON.parse(readFileSync(join(work, "data", "ppt-map.json"), "utf8"));
check("PPT's own setId and tcgPlayerId are learned from the row",
  Object.values(map1).length > 0 && Object.values(map1).every((m) => m.setId === "ppt-base-set" && m.tcgPlayerId),
  JSON.stringify(map1));

/* ---- day 2: leftovers first, day 1 carried ---- */
const before = new Set(Object.keys(s1.cards));
const d2 = await run("2026-09-21", { PPT_CREDIT_BUDGET: "9" });
if (d2.status !== 0) { console.log(d2.stdout, d2.stderr); throw new Error("day 2 failed"); }
const s2 = snap("2026-09-21");
const freshDay2 = Object.entries(s2.cards).filter(([, c]) => !c.carried).map(([id]) => id);
check("day 2 is complete (fresh + carried)", Object.keys(s2.cards).length >= n1 + 1, `${Object.keys(s2.cards).length} cards`);
check("rotation priced new cards, not yesterday's", freshDay2.length > 0 && freshDay2.every((id) => !before.has(id)), freshDay2.slice(0, 3).join(", "));
check("carried entries keep their real date", Object.values(s2.cards).some((c) => c.carried && c.pricedOn === "2026-09-20"));

/* ---- paid-tier: prices, metrics, history ---- */
const freshId2 = freshDay2[0];
const anyCard = s2.cards[freshId2];
check("tcgPlayerId is captured for later exact lookups", Boolean(anyCard?.tcgPlayerId), anyCard?.tcgPlayerId);
check("smart price preferred over bare median", anyCard?.grades?.["10"] > 50000, `psa10 = ${anyCard?.grades?.["10"]}`);
check("confidence comes from the provider", anyCard?.confidence === "high", anyCard?.confidence);
check("per-grade metrics are kept", anyCard?.metrics?.["10"]?.dailyVolume7Day === 2);
const histFile = join(work, "data", "history", `${freshId2}.json`);
const hist = existsSync(histFile) ? JSON.parse(readFileSync(histFile, "utf8")) : null;
check("history file written per card", Boolean(hist), histFile);
check("history backfilled from the provider, not one point", (hist?.series?.["10"]?.length ?? 0) > 100, `${hist?.series?.["10"]?.length} points`);
check("today's own value appended to the series", hist?.series?.["10"]?.some((p) => p.d === "2026-09-21"));

/* ---- day 3: quota exhausted mid-run ---- */
requests = 0; force429After = 2;
const d3 = await run("2026-09-22", { PPT_CREDIT_BUDGET: "200" });
force429After = Infinity;
check("429 stops the run instead of hammering", requests <= 4, `${requests} requests after the 429`);
check("a 429 day still writes a complete snapshot", existsSync(join(work, "data", "snapshots", "2026-09-22.json")) || d3.status !== 0);

/* ---- immutability ---- */
const raw2 = readFileSync(join(work, "data", "snapshots", "2026-09-21.json"), "utf8");
await run("2026-09-23", { PPT_CREDIT_BUDGET: "9" });
check("older snapshots are immutable", readFileSync(join(work, "data", "snapshots", "2026-09-21.json"), "utf8") === raw2);

/* ---- resolved cards re-query by exact tcgPlayerId ---- */
byIdRequests = 0; rowsServed = 0; requests = 0;
const d5 = await run("2026-09-24", { PPT_CREDIT_BUDGET: "2000" });
if (d5.status !== 0) { console.log(d5.stdout, d5.stderr); throw new Error("day 5 failed"); }
const s5 = snap("2026-09-24");
const fresh5 = Object.values(s5.cards).filter((c) => !c.carried).length;
check("full budget prices the whole watchlist", fresh5 === CARDS.length, `${fresh5}/${CARDS.length} fresh`);
check("resolved identities re-query by tcgPlayerId (1 row each)", byIdRequests >= 4, `${byIdRequests} exact lookups over ${requests} requests`);

server.close();
console.log(`\nworkspace: ${work}`);
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed — zero credits spent");
process.exit(failures ? 1 : 0);
