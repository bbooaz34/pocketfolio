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
// a Japanese print: own @jp identity, language forwarded, no card number
CARDS.push({ id: "base1-9@jp", name: "TestMon 9", setName: "Base JP", number: "9", language: "japanese" });
/* a card whose name+number also exist in a reprint set of a different size —
   the live case was Base Set Charizard 4/102 binding to Base Set 2 4/130 */
CARDS.push({ id: "base1-10", name: "Reprinted", setName: "Base", number: "10", setTotal: 102 });
/* a card whose provider scan is wrong, so the watchlist pins a picture */
CARDS.push({ id: "base1-11", name: "Pinned", setName: "Base", number: "11", image: "https://example.test/pinned.jpg" });
/* an unnumbered promo: same name exists in another set, and with no x/y to
   compare, only the set name tells them apart (the live CoroCoro Togepi) */
CARDS.push({ id: "psa-999@jp", name: "Promo", setName: "CoroCoro Promotional Cards",
  setMatch: "corocoro", language: "japanese" });
/* two printings sharing BOTH the set and the number, so neither setMatch nor
   setTotal separates them and the number match would pick whichever the
   provider listed first — the live Ancient Mew / "Ancient Mew (Japanese
   Exclusive Print)" pair. Only nameExact says which one this is. */
CARDS.push({ id: "miscp-1", name: "Twinned", setName: "Misc Promos",
  setMatch: "misc", nameExact: "Twinned", number: "1" });
/* the same collision when the provider's exact name string is unknown: a
   special-edition variant shares set AND number, and only the words that name
   it can be ruled out — the live Charmander 044 / "(Pokemon Center
   Exclusive)" pair. */
CARDS.push({ id: "svp-44", name: "Stamped", setName: "Promo Cards",
  setMatch: "promo", nameExclude: ["pokemon center"], number: "44" });

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
  force429After = Infinity, limitsSeen = [], jpLangSeen = false,
  dropEbayHistory = false;

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
  // the real raw-history shape (run #7): conditions-keyed arrays of {date, market}
  const histArr = (base) => Object.entries(makeHistory(base))
    .map(([date, market]) => ({ date: date + "T00:00:00.000Z", market, volume: 1 }));
  const rowFor = (c, filler, total) => ({
    id: filler ? `zz9-${filler}` : c.id,
    setId: "ppt-base-set",
    tcgPlayerId: `9000${c.number}${total === 130 ? "R" : ""}`,
    name: filler ? `Filler ${filler}` : c.name,
    number: filler ? `9${filler}` : c.number,
    cardNumber: `${String(filler ? 90 + filler : c.number).padStart(3, "0")}/${total ?? 102}`,
    prices: { market: 12.34 },
    imageCdnUrl400: `https://imagecdn.test/${c.id}_400.jpg`,
    priceHistory: { conditions: { "Near Mint": { history: histArr(10) } } },
    /* the real shapes, from the 19.09 probe: smartMarketPrice is an OBJECT,
       there is no smartMarketConfidence and no salesCount, the count field is
       `count`, and the spread is minPrice/maxPrice */
    ebay: {
      salesByGrade: {
        // healthy: smart price + weekly activity. averagePrice must never win.
        psa10: { count: 140, averagePrice: 999, medianPrice: 480, minPrice: 450, maxPrice: 520,
          marketPrice7Day: null, dailyVolume7Day: 2, marketTrend: "up",
          lastSaleDate: "2026-09-18T00:00:00.000Z",
          smartMarketPrice: { price: 500 + Number(c.number), confidence: "high", method: "30day_filtered_weighted", daysUsed: 30 } },
        // provider says high, but nothing sold this week → must cap to low
        psa9: { count: 32, averagePrice: 210, medianPrice: 200, minPrice: 150, maxPrice: 260,
          marketPrice7Day: null, dailyVolume7Day: 0, marketTrend: "down",
          lastSaleDate: "2026-07-30T00:00:00.000Z",
          smartMarketPrice: { price: 205, confidence: "high", method: "all_filtered_weighted", daysUsed: 353 } },
        // only a median, and a 4x spread → medium at best, priceField medianPrice
        psa8: { count: 11, averagePrice: 300, medianPrice: 290, minPrice: 100, maxPrice: 420,
          dailyVolume7Day: 0.5, marketTrend: "up" },
        // no 7-day volume field at all → cannot tell → medium at best
        psa7: { count: 5, medianPrice: 150, marketPrice7Day: 160,
          smartMarketPrice: { price: 158, confidence: "high", method: "7day", daysUsed: 7 } },
        // smart price below every observed sale (the live Togepi case) →
        // must fall back to the median
        psa6: { count: 4, medianPrice: 130, minPrice: 100, maxPrice: 200,
          dailyVolume7Day: 0.2, marketTrend: "up",
          smartMarketPrice: { price: 46.01, confidence: "low", method: "all_filtered_weighted", daysUsed: 90 } },
        // the provider flags its own smart price as an outlier
        psa5: { count: 9, medianPrice: 70, minPrice: 50, maxPrice: 90,
          dailyVolume7Day: 0.3, marketTrend: "up",
          smartMarketPrice: { price: 88, confidence: "high", method: "90day", daysUsed: 90 } },
      },
      smartPriceOutlierByGrade: { psa10: false, psa9: false, psa8: false, psa7: false, psa6: false, psa5: true },
      salesVelocity: { dailyAverage: 0.8, weeklyAverage: 5.6, monthlyTotal: 24 },
      // graded history: psaN → date → {average, count} (respects `days`)
      priceHistory: {
        psa10: Object.fromEntries(Object.entries(makeHistory(500))
          .map(([d, v]) => [d, { average: v, count: 1, sevenDayAverage: v }])),
      },
    },
  });
  // runs #6-#7 live: tcgPlayerId lookups answer total=1 with count=0 (with or
  // without limit) and still bill — reproduce it so the builder never relies
  // on them again
  if (url.searchParams.get("tcgPlayerId")) {
    byIdRequests++;
    return send([], 1);
  }
  const limit = Number(url.searchParams.get("limit") || 5);
  limitsSeen.push(limit);
  const search = url.searchParams.get("search") || "";
  if (url.searchParams.get("language") === "japanese" && search.startsWith("TestMon 9")) jpLangSeen = true;
  const match = CARDS.find((c) => search.startsWith(c.name)) || CARDS[0];
  /* "Reprinted" also exists in a 130-card reprint set, listed first — the
     live Base Set 2 trap. Only the set size tells the two apart. */
  let rows;
  if (match.id === "base1-10") {
    rows = [rowFor(match, 0, 130), rowFor(match, 0, 102)];
  } else if (match.id === "svp-44") {
    /* the variant is listed first and its name merely EXTENDS the one we
       want, so an exact-name guard could not be written without knowing the
       provider's string */
    const wrong = rowFor(match, 0);
    wrong.name = "Stamped - 044 (Pokemon Center Exclusive)";
    wrong.setName = "Promo Cards"; wrong.tcgPlayerId = "STAMPED";
    const right = rowFor(match, 0);
    right.name = "Stamped - 044";
    right.setName = "Promo Cards"; right.tcgPlayerId = "PLAIN";
    rows = [wrong, right];
  } else if (match.id === "miscp-1") {
    /* the other printing is listed first, same set and same number, and its
       name merely starts with the one we want */
    const wrong = rowFor(match, 0);
    wrong.name = "Twinned (Japanese Exclusive Print)";
    wrong.setName = "Misc Promos"; wrong.tcgPlayerId = "WRONGPRINT";
    const right = rowFor(match, 0);
    right.setName = "Misc Promos"; right.tcgPlayerId = "RIGHTPRINT";
    rows = [wrong, right];
  } else if (match.id === "psa-999@jp") {
    /* the wrong-set namesake is listed first and has no number to compare */
    const wrong = rowFor(match, 0); wrong.setName = "Gold, Silver, to a New World...";
    wrong.tcgPlayerId = "WRONGSET"; wrong.cardNumber = "";
    const right = rowFor(match, 0); right.setName = "CoroCoro Promotional Cards";
    right.tcgPlayerId = "RIGHTSET"; right.cardNumber = "";
    rows = [wrong, right];
  } else {
    rows = Array.from({ length: limit }, (_, i) => rowFor(match, i));
  }
  if (dropEbayHistory) for (const r of rows) delete r.ebay.priceHistory;
  send(rows, limit);
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
check("smart price (an object) beats the bare median", anyCard?.grades?.["10"] > 50000, `psa10 = ${anyCard?.grades?.["10"]}`);
check("confidence comes from the provider", anyCard?.confidence === "high", anyCard?.confidence);
check("per-grade metrics are kept", anyCard?.metrics?.["10"]?.dailyVolume7Day === 2);

/* ---- the 19.09 probe: price provenance and honest confidence ---- */
const M = anyCard?.metrics || {};
check("priceField recorded per grade", M["10"]?.priceField === "smartMarketPrice",
  Object.entries(M).map(([g, m]) => `${g}:${m.priceField}`).join(" "));
check("averagePrice never wins", anyCard.grades["10"] !== 99900 && anyCard.grades["9"] !== 21000,
  `psa10=${anyCard.grades["10"]} psa9=${anyCard.grades["9"]}`);
check("zero 7-day volume caps at low, whatever the provider says",
  M["9"]?.confidence === "high" && M["9"]?.effective === "low",
  `provider=${M["9"]?.confidence} effective=${M["9"]?.effective}`);
check("median-only grade: priceField medianPrice and never high",
  M["8"]?.priceField === "medianPrice" && M["8"]?.effective !== "high",
  `${M["8"]?.priceField} / ${M["8"]?.effective}`);
check("no dailyVolume7Day at all caps at medium",
  M["7"]?.dailyVolume7Day === null && M["7"]?.effective === "medium",
  `vol=${M["7"]?.dailyVolume7Day} effective=${M["7"]?.effective}`);
check("spread carried through from minPrice/maxPrice",
  M["8"]?.spread?.low === 10000 && M["8"]?.spread?.high === 42000, JSON.stringify(M["8"]?.spread));
check("the window the smart price used is recorded", M["9"]?.daysUsed === 353, `${M["9"]?.daysUsed}`);
check("a smart price below every observed sale is rejected for the median",
  anyCard.grades["6"] === 13000 && M["6"]?.priceField === "medianPrice" &&
  M["6"]?.smartRejected === "outside-observed-range",
  `$${(anyCard.grades["6"] ?? 0) / 100} via ${M["6"]?.priceField} (${M["6"]?.smartRejected})`);
check("a provider-flagged outlier is rejected too",
  anyCard.grades["5"] === 7000 && M["5"]?.smartRejected === "flagged-outlier",
  `$${(anyCard.grades["5"] ?? 0) / 100} via ${M["5"]?.priceField} (${M["5"]?.smartRejected})`);
check("no grade with zero 7-day volume is stored as high",
  Object.values(s2.cards).every((c) => Object.values(c.metrics || {})
    .every((m) => !(m.dailyVolume7Day === 0 && m.effective === "high"))));
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

/* ---- resolved cards re-query via the stored search at limit=1 ---- */
byIdRequests = 0; rowsServed = 0; requests = 0; limitsSeen = [];
const d5 = await run("2026-09-24", { PPT_CREDIT_BUDGET: "2000" });
if (d5.status !== 0) { console.log(d5.stdout, d5.stderr); throw new Error("day 5 failed"); }
const s5 = snap("2026-09-24");
const fresh5 = Object.values(s5.cards).filter((c) => !c.carried).length;
check("full budget prices the whole watchlist", fresh5 === CARDS.length, `${fresh5}/${CARDS.length} fresh`);
check("resolved identities re-query via stored search at limit=1",
  limitsSeen.includes(1) && limitsSeen.includes(3), `limits: ${limitsSeen.join(",")}`);
check("no tcgPlayerId lookups (they answer count=0 and still bill)", byIdRequests === 0, `${byIdRequests} exact lookups`);
check("a Japanese print gets its own @jp snapshot entry", Boolean(s5.cards["base1-9@jp"]), Object.keys(s5.cards).join(","));
check("language=japanese forwarded for @jp cards", jpLangSeen);
/* the Base Set 2 trap: a same-name, same-number row from a 130-card set must
   lose to the 102-card one, and setTotal is the only thing that says so */
check("the provider's picture is stored when there is no override",
  String(s5.cards["base1-1"]?.image || "").includes("imagecdn"), s5.cards["base1-1"]?.image);
check("a watchlist image overrides the provider's",
  s5.cards["base1-11"]?.image === "https://example.test/pinned.jpg", s5.cards["base1-11"]?.image);
check("an unnumbered promo binds by set name, not by name alone",
  s5.cards["psa-999@jp"]?.tcgPlayerId === "RIGHTSET",
  `bound to ${s5.cards["psa-999@jp"]?.tcgPlayerId} (RIGHTSET = CoroCoro, WRONGSET = the namesake)`);
check("a special-edition variant is ruled out by nameExclude",
  s5.cards["svp-44"]?.tcgPlayerId === "PLAIN",
  `bound to ${s5.cards["svp-44"]?.tcgPlayerId} (PLAIN = the ordinary print, STAMPED = the Pokemon Center variant, listed first)`);
check("two printings in one set are told apart by nameExact, not by order",
  s5.cards["miscp-1"]?.tcgPlayerId === "RIGHTPRINT",
  `bound to ${s5.cards["miscp-1"]?.tcgPlayerId} (RIGHTPRINT = the plain name, WRONGPRINT = the other printing, listed first)`);
check("a row from a set of the wrong size cannot win on card number",
  s5.cards["base1-10"]?.tcgPlayerId === "900010",
  `bound to tcgPlayerId ${s5.cards["base1-10"]?.tcgPlayerId} (900010 = the /102 row, 900010R = the /130 reprint)`);

/* ---- ebay.priceHistory absent: build still succeeds, raw-only history ---- */
dropEbayHistory = true;
const d6 = await run("2026-09-25", { PPT_CREDIT_BUDGET: "2000" });
dropEbayHistory = false;
check("build succeeds with no graded history", d6.status === 0, d6.stderr.trim().split("\n").at(-1) || "");
const s6 = snap("2026-09-25");
check("prices still stored without graded history",
  Object.values(s6.cards).some((c) => !c.carried && c.grades?.["10"] > 0));
const h6 = JSON.parse(readFileSync(join(work, "data", "history",
  `${Object.keys(s6.cards).find((id) => !s6.cards[id].carried)}.json`), "utf8"));
check("today's raw series still grows when graded history is missing",
  (h6.series?.raw?.length ?? 0) > 100, `raw ${h6.series?.raw?.length} pts`);

server.close();
console.log(`\nworkspace: ${work}`);
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed — zero credits spent");
process.exit(failures ? 1 : 0);
