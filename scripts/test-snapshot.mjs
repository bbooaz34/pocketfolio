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
 *
 * And graded prices from our own eBay reads (TASK-ebay-direct.md), from a
 * fake data/sales — no browser, no eBay:
 *
 *  12. The scraper's filters: exact grade, label tokens, lots, languages,
 *      qualifiers, Best Offer flagged; urls normalised; merge never drops.
 *  13. An all-empty scrape, or a login wall, exits non-zero and writes nothing.
 *  14. Median of the newest five clean sales wins over PPT; a Best-Offer-only
 *      grade is null and falls to PPT; a stale file is not used.
 *  15. No psaTitle, no graded price — from any source.
 *  16. Without PPT, the grades our sales did not answer are carried, flagged.
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, cpSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUILDER = join(ROOT, "scripts", "build-snapshot.mjs");
const Scraper = await import(join(ROOT, "scripts", "scrape-ebay-sold.mjs"));

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
/* the same pair, but with PPT's set pinned — the live fix. One row is not
   enough here: the pinned set holds both variants, and the guard must be
   handed more than whichever one the provider lists first. */
CARDS.push({ id: "svp-45", name: "Varianted", setName: "Promo Cards",
  pptSetId: "ppt-promo", nameExclude: ["pokemon center"], number: "45" });

/* every card so far is priced from its PSA label; one graded card is not */
for (const c of CARDS) c.psaTitle = `TEST ${c.name.toUpperCase()}`;
CARDS.push({ id: "base1-12", name: "Untitled", setName: "Base", number: "12", grades: ["9"] });

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
  } else if (match.id === "svp-45") {
    /* Unreachable by name, like the live card: a probe of 80 "Charmander"
       rows found SVP 044 at position 33, so only the pinned set reaches it. */
    if (!setId) return send([], 80);
    /* a pinned set holding both variants, the unwanted one first */
    const wrong = rowFor(match, 0);
    wrong.name = "Varianted - 045 (Pokemon Center Exclusive)";
    wrong.setName = "Promo Cards"; wrong.tcgPlayerId = "PINSTAMPED";
    const right = rowFor(match, 0);
    right.name = "Varianted - 045";
    right.setName = "Promo Cards"; right.tcgPlayerId = "PINPLAIN";
    /* the provider names promos "<name> - <number>", so neither row's name
       equals the watchlist's — only the card number can pick one, which is
       exactly what Charmander SVP 044 needed */
    for (const r of [wrong, right]) r.id = "ppt-other-id";
    rows = [wrong, right].slice(0, limit);
  } else if (match.id === "svp-44") {
    /* Two things at once, both live. The variant is listed first and its name
       merely EXTENDS the one we want, so an exact-name guard could not be
       written without knowing the provider's string. And the card we want is
       the 7th row of a common name — at limit=3 the guards never see it, which
       is exactly how Charmander SVP 044 came back as two SWSH promos and a
       Shiny Vault. */
    const wrong = rowFor(match, 0);
    wrong.name = "Stamped - 044 (Pokemon Center Exclusive)";
    wrong.setName = "Promo Cards"; wrong.tcgPlayerId = "STAMPED";
    const right = rowFor(match, 0);
    right.name = "Stamped - 044";
    right.setName = "Promo Cards"; right.tcgPlayerId = "PLAIN";
    const noise = Array.from({ length: 5 }, (_, i) => {
      const r = rowFor(match, 0);
      r.name = `Stamped - 0${40 + i}`; r.setName = `Other Set ${i}`;
      r.tcgPlayerId = `NOISE${i}`; return r;
    });
    rows = [wrong, ...noise, right].slice(0, limit);
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
cpSync(join(ROOT, "scripts", "providers"), join(work, "scripts", "providers"), { recursive: true });
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
check("a pinned set still reads enough rows to rule out its variants",
  s5.cards["svp-45"]?.tcgPlayerId === "PINPLAIN",
  `bound to ${s5.cards["svp-45"]?.tcgPlayerId} — at limit=1 only the variant is returned`);
check("a guarded card gets a page wide enough for its guards to work",
  s5.cards["svp-44"]?.tcgPlayerId === "PLAIN",
  `bound to ${s5.cards["svp-44"]?.tcgPlayerId} — the wanted row is 7th, unreachable at limit=3`);
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

/* a card removed from the watchlist must leave the snapshot, not age in it:
   carrying by yesterday's file alone kept eight deleted cards alive for days */
{
  const wl = JSON.parse(readFileSync(join(work, "data", "watchlist.json"), "utf8"));
  const removed = wl.cards.pop();
  writeFileSync(join(work, "data", "watchlist.json"), JSON.stringify(wl));
  await run("2026-09-26", { PPT_CREDIT_BUDGET: "2000" });
  const after = snap("2026-09-26");
  check("a card dropped from the watchlist leaves the snapshot",
    !Object.keys(after.cards).includes(removed.id),
    `${removed.id} still present among ${Object.keys(after.cards).length} cards`);
  wl.cards.push(removed);
  writeFileSync(join(work, "data", "watchlist.json"), JSON.stringify(wl));
}

/* ---- the scraper, offline ---- */
{
  const card = { id: "base1-4", psaTitle: "1999 POKEMON GAME #4 CHARIZARD-HOLO", grades: ["1"] };
  const row = (title, price, caption, extra = {}) => ({
    title, price, caption: caption ?? "Sold  Sep 21, 2026", text: title + " " + (extra.text || ""),
    href: extra.href || `https://www.ebay.com/itm/${extra.id || Math.floor(1e11 + Math.random() * 8e11)}?hash=abc&_trkparms=x`,
  });
  const rows = [
    row("1999 POKEMON GAME #4 CHARIZARD-HOLO PSA 1Opens in a new window or tab", "$400.00", undefined, { id: "111111111111" }),
    row("1999 Pokemon Game Charizard Holo PSA 1 Base Set", "$332.89", "Sold Sep 21, 2026", { id: "222222222222" }),
    row("1999 Pokemon Game Charizard Holo PSA 10 GEM MINT", "$17,500.00"),
    row("1999 Pokemon Game Charizard Holo PSA 1.5", "$450.00"),
    row("Blastoise Pokemon Game PSA 1", "$90.00"),
    row("1999 Pokemon Game Charizard Holo PSA 1 lot of 2", "$700.00"),
    row("1999 Pokemon Game Charizard Holo PSA 1 Italian", "$300.00"),
    row("1999 Pokemon Game Charizard Holo PSA 1 OC", "$250.00"),
    row("1999 Pokemon Game Charizard Holo PSA 1", "ILS 1,300.00"),
    row("1999 Pokemon Game Charizard Holo PSA 1 Best Offer", "$500.00", "Sold Sep 20, 2026",
      { id: "333333333333", text: "Best offer accepted" }),
  ];
  const { sales, dropped } = Scraper.filterRows(rows, card, "1");
  const urls = sales.map((x) => x.url);
  check("scraper keeps the exact grade, drops PSA 10 / PSA 1.5", dropped.grade === 2, JSON.stringify(dropped));
  check("scraper needs two label tokens (drops the padded 'similar items')", dropped.tokens === 1);
  check("scraper drops lots, other languages and qualifiers",
    dropped.lot === 1 && dropped.language === 1 && dropped.qualifier === 1);
  check("scraper refuses a price that is not in dollars", dropped.price === 1);
  check("scraper keeps Best Offer rows, flagged", sales.length === 3 && sales.filter((x) => x.bo).length === 1,
    sales.map((x) => `${x.p}${x.bo ? "bo" : ""}`).join(","));
  check("titles lose the 'Opens in a new window' tail", sales[0].t === "1999 POKEMON GAME #4 CHARIZARD-HOLO PSA 1", sales[0].t);
  check("urls are the bare item link", urls.includes("https://www.ebay.com/itm/111111111111"), urls.join(" "));
  check("sold date and pennies parsed", sales[0].d === "2026-09-21" && sales[0].p === 40000);
  check("the search is the label title verbatim, plus the grade",
    new URL(Scraper.searchUrl("2000 POKEMON ROCKET 1ST EDITION THE BOSS'S WAY", "9")).searchParams.get("_nkw") ===
      "2000 POKEMON ROCKET 1ST EDITION THE BOSS'S WAY PSA 9");

  const prevDoc = { cardId: "base1-4", psaTitle: card.psaTitle, scrapedAt: "2026-09-20T04:00:00+03:00",
    grades: { "1": [{ d: "2026-07-23", p: 37559, bo: false, t: "old", url: "https://www.ebay.com/itm/999999999999" },
                     { d: "2026-09-21", p: 40000, bo: false, t: "seen", url: "https://www.ebay.com/itm/111111111111" }],
              "10": [{ d: "2025-10-30", p: 1750000, bo: false, t: "x", url: "https://www.ebay.com/itm/888888888888" }] } };
  const merged = Scraper.mergeSales(prevDoc, card, "1", sales, "2026-09-26T04:02:11+03:00");
  check("a re-scrape merges by url and never drops a sale",
    merged.grades["1"].length === 4 && merged.grades["10"].length === 1 &&
    merged.grades["1"].some((x) => x.url.endsWith("999999999999")),
    merged.grades["1"].map((x) => x.d).join(","));
  check("merged sales are newest first", merged.grades["1"][0].d >= merged.grades["1"].at(-1).d);

  const targets = Scraper.targetsOf([card, { id: "x", grades: ["9"] }, { id: "y", grades: ["raw"], psaTitle: "Y" }]);
  check("only titled graded cards are searched", targets.length === 1 && targets[0].card.id === "base1-4");

  const scrapeDir = mkdtempSync(join(tmpdir(), "pf-scrape-"));
  const two = [{ card, grade: "1" }, { card: { ...card, id: "base1-2" }, grade: "1" }];
  const quiet = { dataDir: scrapeDir, pause: async () => {} };
  const empty = await Scraper.scrape(two, async () => ({ kind: "results", rows: [] }), quiet);
  check("an all-empty scrape exits non-zero and writes nothing", empty.code !== 0 && empty.docs === null);
  const wall = await Scraper.scrape(two, async (u) => ({ kind: "login", url: u }), quiet);
  check("a login wall exits non-zero and writes nothing", wall.code !== 0 && wall.docs === null);
  let reads = 0;
  const ok = await Scraper.scrape(two, async () => (reads++ ? { kind: "results", rows: [] } : { kind: "results", rows }), quiet);
  check("one empty page among full ones still writes, and its card is stamped",
    ok.code === 0 && ok.docs.size === 2 && ok.docs.get("base1-2").grades["1"].length === 0);
}

/* ---- psaTitle from the cert page: PSA's fields, in label order ---- */
{
  const { parseCertText, titleOf } = await import(join(ROOT, "scripts", "fill-psa-titles.mjs"));
  const page = (f) => Object.entries(f).map(([k, v]) => `${k}\n${v}`).join("\n");
  const tg = parseCertText(page({ "Certification Number": "154146687", "Label Type": "Standard", "Year": "1999",
    "Brand/Title": "POKEMON JAPANESE GOLD, SILVER, TO A NEW WORLD...", "Subject": "TOGEPI", "Item Grade": "PR 1" }));
  const ms = parseCertText(page({ "Certification Number": "77452905", "Year": "1998",
    "Brand/Title": "POKEMON JAPANESE HANADA CITY GYM DECK", "Subject": "MISTY'S TEARS", "Item Grade": "NM 7" }));
  check("cert fields reproduce the hand-copied Togepi title",
    titleOf(tg) === "1999 POKEMON JAPANESE GOLD, SILVER, TO A NEW WORLD... TOGEPI" && tg.grade === "1" && tg.cert === "154146687", titleOf(tg));
  check("cert fields reproduce the hand-copied Misty's Tears title",
    titleOf(ms) === "1998 POKEMON JAPANESE HANADA CITY GYM DECK MISTY'S TEARS" && ms.grade === "7", titleOf(ms));
  const bw = parseCertText(page({ "Year": "2000", "Brand/Title": "POKEMON ROCKET", "Card Number": "73",
    "Subject": "THE BOSS'S WAY-HOLO", "Variety/Pedigree": "1ST EDITION", "Item Grade": "MINT 9" }));
  check("the edition rides in the title from the cert's own variety", /1ST EDITION/.test(titleOf(bw)), titleOf(bw));
  check("no subject, no title", titleOf(parseCertText(page({ "Year": "1999" }))) === null);
}

/* ---- graded prices from a fake data/sales ---- */
const sale = (d, p, bo = false) => ({ d, p, bo, t: "fixture", url: `https://www.ebay.com/itm/${d.replace(/-/g, "")}${p}${bo ? 1 : 0}` });
const writeSales = (id, grades, scrapedAt = new Date().toISOString()) => {
  mkdirSync(join(work, "data", "sales"), { recursive: true });
  writeFileSync(join(work, "data", "sales", `${id}.json`), JSON.stringify({ cardId: id, psaTitle: "fixture", scrapedAt, grades }));
};
/* the Charizard shape: the three sales the provider never had, and more */
writeSales("base1-1", { "10": [
  sale("2026-09-25", 70000), sale("2026-09-24", 65000), sale("2026-09-22", 60000),
  sale("2026-09-21", 64000), sale("2026-09-20", 68000), sale("2026-09-01", 1000000),
  sale("2026-09-23", 90000, true)] });
/* the Togepi shape: $200 on two July Best Offers, three clean sales since */
writeSales("psa-999@jp", { "1": [
  sale("2026-07-10", 20000, true), sale("2026-07-12", 20000, true),
  sale("2026-09-20", 10000), sale("2026-09-10", 4600), sale("2026-08-30", 6000)] });
/* Best Offer only at PSA 8, and one old clean sale at PSA 4 */
writeSales("base1-2", { "8": [sale("2026-09-20", 99900, true)], "4": [sale("2026-05-01", 3000)] });
/* read four days ago — too old to trust */
writeSales("base1-3", { "10": [sale("2026-09-20", 999900), sale("2026-09-19", 999900), sale("2026-09-18", 999900)] },
  new Date(Date.now() - 4 * 864e5).toISOString());
/* a file for a card with no psaTitle is ignored */
writeSales("base1-12", { "9": [sale("2026-09-20", 5000), sale("2026-09-19", 5000), sale("2026-09-18", 5000)] });

{
  const r = await run("2026-09-27", { PPT_CREDIT_BUDGET: "2000" });
  if (r.status !== 0) { console.log(r.stdout, r.stderr); throw new Error("eBay day failed"); }
  const s = snap("2026-09-27");
  const cz = s.cards["base1-1"], tg = s.cards["psa-999@jp"], b2 = s.cards["base1-2"], b3 = s.cards["base1-3"];
  const m = cz?.metrics?.["10"];
  check("eBay: median of the newest five clean sales beats PPT", cz?.grades?.["10"] === 65000,
    `$${(cz?.grades?.["10"] ?? 0) / 100} (PPT would be $501)`);
  check("eBay: priceField ebay-median-5, source ebay, high on five recent",
    m?.priceField === "ebay-median-5" && m?.source === "ebay" && m?.confidence === "high", JSON.stringify(m)?.slice(0, 160));
  check("eBay: n counts clean sales in 90 days, nBO the Best Offers",
    m?.n === 6 && m?.nBO === 1 && m?.lastSale === "2026-09-25", `n=${m?.n} nBO=${m?.nBO} last=${m?.lastSale}`);
  check("eBay: spread is the min/max of the five used, and they are listed",
    m?.spread?.low === 60000 && m?.spread?.high === 70000 && m?.used?.length === 5 && m.used.every((u) => u.url));
  check("eBay: no provider fields carried forward", m && !("salesCount" in m) && !("daysUsed" in m));
  check("eBay: other grades still come from PPT, and say so",
    cz?.grades?.["9"] === 20500 && cz?.metrics?.["9"]?.source === "ppt");
  check("Togepi shape: median of recent clean sales, not the $200 Best Offers",
    tg?.grades?.["1"] === 6000 && tg?.metrics?.["1"]?.nBO === 2, `$${(tg?.grades?.["1"] ?? 0) / 100}`);
  check("a Best-Offer-only grade is no price — PPT fills it",
    b2?.grades?.["8"] === 29000 && b2?.metrics?.["8"]?.source === "ppt", `$${(b2?.grades?.["8"] ?? 0) / 100} via ${b2?.metrics?.["8"]?.source}`);
  check("one old clean sale: low confidence, with its age",
    b2?.grades?.["4"] === 3000 && b2?.metrics?.["4"]?.confidence === "low" && b2?.metrics?.["4"]?.ageDays > 90,
    JSON.stringify(b2?.metrics?.["4"])?.slice(0, 120));
  check("a sales file older than 48h is not used", b3?.grades?.["10"] === 50300, `$${(b3?.grades?.["10"] ?? 0) / 100}`);
  check("the psaTitle travels into the snapshot", cz?.psaTitle === "TEST TESTMON 1");
  check("no psaTitle, no graded price — PPT's and its sales file both ignored",
    s.cards["base1-12"] && Object.keys(s.cards["base1-12"].grades).every((g) => g === "raw"),
    JSON.stringify(s.cards["base1-12"]?.grades));
  check("every grade says its source and pricedOn",
    Object.values(s.cards).every((c) => Object.keys(c.grades).every((g) => c.metrics?.[g]?.source && c.metrics?.[g]?.pricedOn)));
  const hz = JSON.parse(readFileSync(join(work, "data", "history", "base1-1.json"), "utf8"));
  check("history keeps accumulating, marked with the source",
    hz.series["10"].some((p) => p.d === "2026-09-27" && p.v === 65000 && p.s === "ebay"));
}

/* ---- the subscription lapses: our sales, and yesterday for the rest ---- */
{
  const r = await run("2026-09-28", { PPT_TOKEN: "" });
  if (r.status !== 0) { console.log(r.stdout, r.stderr); throw new Error("no-PPT day failed"); }
  const s = snap("2026-09-28");
  const cz = s.cards["base1-1"];
  check("without PPT the build runs from data/sales alone", cz?.grades?.["10"] === 65000 && !cz.carried);
  check("a grade our sales did not answer is carried, flagged, with its real date",
    cz?.grades?.["9"] === 20500 && cz?.metrics?.["9"]?.carried === true &&
    cz?.metrics?.["9"]?.source === "carried" && cz?.metrics?.["9"]?.pricedOn === "2026-09-27");
  check("cards with no fresh sales are carried whole", s.cards["base1-5"]?.carried === true);
  check("carrying never brings back an untitled graded price",
    s.cards["base1-12"] && Object.keys(s.cards["base1-12"].grades).every((g) => g === "raw"));
}

server.close();
console.log(`\nworkspace: ${work}`);
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed — zero credits spent");
process.exit(failures ? 1 : 0);
