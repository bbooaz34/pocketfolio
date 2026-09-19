#!/usr/bin/env node
/**
 * Pocketfolio daily price snapshot (POCKETFOLIO-PRICING.md §5).
 *
 * Prices every card in data/watchlist.json and writes:
 *   data/snapshots/<date>.json   (immutable once written)
 *   data/latest.json             (copy of the newest snapshot)
 *   data/index.json              ({ dates, oldest, count })
 *
 * Sources, in order:
 *   1. PriceCharting (PC_TOKEN) — the Legendary CSV when available, else the
 *      /api/product endpoint serialized at ~1.1s/call. Product ids resolved
 *      once are persisted in data/pc-map.json and never re-searched by name.
 *   2. Pokémon Price Tracker (PPT_TOKEN) — fills watchlist cards PriceCharting
 *      missed, serialized, capped at PPT_CALL_CAP calls.
 *
 * Safety: never writes a snapshot more than 40% smaller than yesterday's —
 * the job fails instead. All prices are integer pennies.
 *
 * Env: PC_TOKEN, PPT_TOKEN (at least one required),
 *      PC_BASE / PPT_BASE (test overrides), SNAPSHOT_DATE (test override).
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data");
const SNAPS = join(DATA, "snapshots");

const PC_TOKEN = process.env.PC_TOKEN || "";
const PPT_TOKEN = process.env.PPT_TOKEN || "";
const PC_BASE = process.env.PC_BASE || "https://www.pricecharting.com";
const PPT_BASE = process.env.PPT_BASE || "https://www.pokemonpricetracker.com";
/* PPT bills per RESPONSE ROW and per include (PRICING-ATTEMPTS.md §1) — the
   budget is counted in credits, not calls. The provider states the real charge
   in x-api-calls-consumed; our own estimate is only the fallback. The default
   fits the paid API tier; the free tier should set PPT_CREDIT_BUDGET=90. */
const PPT_CREDIT_BUDGET = Number(process.env.PPT_CREDIT_BUDGET || 18000);
const PPT_LIMIT_RESOLVED = 1;   // identity known from ppt-map — one row is the card
const PPT_LIMIT_FIRST = 3;      // first touch — room to match by number/name locally
/* The API tier serves 6 months of history; Free serves 3 days. Backfilling
   the chart from the provider beats waiting for our snapshots to accumulate. */
const PPT_HISTORY_DAYS = Number(process.env.PPT_HISTORY_DAYS || 180);
const HIST = join(DATA, "history");

if (!PC_TOKEN && !PPT_TOKEN) {
  console.error("need PC_TOKEN and/or PPT_TOKEN");
  process.exit(1);
}

/* PriceCharting field names do not match their meaning for cards
   (POCKETFOLIO-PRICING.md §2). Values are integer pennies. */
const PC_GRADE_FIELD = {
  raw: "loose-price",
  7: "cib-price",
  8: "new-price",
  9: "graded-price",
  9.5: "box-only-price",
  10: "manual-only-price", // PSA 10
  bgs10: "bgs-10-price",
  cgc10: "condition-17-price",
  sgc10: "condition-18-price",
};

const SALES_VOLUME_FLOOR = 10; // below this, confidence is "low"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = process.env.SNAPSHOT_DATE || new Date().toISOString().slice(0, 10);

const watchlist = JSON.parse(readFileSync(join(DATA, "watchlist.json"), "utf8")).cards;
const pcMapPath = join(DATA, "pc-map.json");
const pcMap = existsSync(pcMapPath) ? JSON.parse(readFileSync(pcMapPath, "utf8")) : {};
/* Resolved PPT identity per card, so later runs query precisely instead of
   searching by name (lesson 3 in PRICING-ATTEMPTS.md). */
const pptMapPath = join(DATA, "ppt-map.json");
const pptMap = existsSync(pptMapPath) ? JSON.parse(readFileSync(pptMapPath, "utf8")) : {};

/* ---------------- PriceCharting ---------------- */

function pcGrades(product) {
  const grades = {};
  for (const [grade, field] of Object.entries(PC_GRADE_FIELD)) {
    const v = Number(product[field]);
    if (Number.isFinite(v) && v > 0) grades[grade] = Math.round(v);
  }
  return grades;
}

async function pcApi(params) {
  const url = new URL(PC_BASE + "/api/product");
  url.searchParams.set("t", PC_TOKEN);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  if (!res.ok) throw new Error("PriceCharting HTTP " + res.status);
  const body = await res.json();
  if (body.status !== "success") throw new Error(body["error-message"] || "PriceCharting error");
  return body;
}

/** The Legendary tier regenerates a full CSV every 24h — one download beats
    N API calls. Returns a Map(pcId -> product-ish object) or null. */
async function pcCsv() {
  try {
    const url = new URL(PC_BASE + "/price-guide/download-custom");
    url.searchParams.set("t", PC_TOKEN);
    url.searchParams.set("category", "pokemon-cards");
    const res = await fetch(url);
    if (!res.ok) return null;
    const text = await res.text();
    if (!text.includes("id") || text.trimStart().startsWith("{") || text.trimStart().startsWith("<")) return null;
    const [head, ...lines] = text.split("\n").filter(Boolean);
    const cols = head.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    const idx = Object.fromEntries(cols.map((c, i) => [c, i]));
    const byId = new Map();
    for (const line of lines) {
      // naive CSV split is fine: PriceCharting quotes only name columns,
      // and we read numeric columns by index
      const cells = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)?.map((c) =>
        c.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"')) || [];
      const row = {};
      for (const c of cols) row[c] = cells[idx[c]];
      if (row.id) byId.set(String(row.id), row);
    }
    return byId.size ? byId : null;
  } catch {
    return null;
  }
}

async function priceWithPC(cards) {
  const out = new Map(); // cardId -> snapshot entry
  const csv = await pcCsv();
  if (csv) console.log(`PriceCharting CSV: ${csv.size} products`);

  for (const card of cards) {
    let pcId = pcMap[card.id] || null;
    let product = null;
    try {
      if (pcId && csv) product = csv.get(String(pcId)) || null;
      if (!product && pcId) {
        product = await pcApi({ id: pcId });
        await sleep(1100);
      }
      if (!product) {
        const q = card.pcQuery ||
          `${card.name} ${card.setName || ""} ${card.number || ""} pokemon`.replace(/\s+/g, " ").trim();
        product = await pcApi({ q });
        await sleep(1100);
        pcId = String(product.id);
        pcMap[card.id] = pcId; // resolved once, never re-searched by name
      }
    } catch (err) {
      console.log(`  PC miss ${card.id}: ${err.message}`);
      continue;
    }
    const grades = pcGrades(product);
    if (!Object.keys(grades).length) continue;
    const volume = Number(product["sales-volume"]);
    out.set(card.id, {
      pcId: String(pcId ?? product.id),
      name: card.name,
      set: card.setName || null,
      number: card.number || null,
      grades,
      salesVolume: Number.isFinite(volume) ? volume : null,
      confidence: Number.isFinite(volume) && volume >= SALES_VOLUME_FLOOR ? "high" : "low",
    });
  }
  return out;
}

/* ---------------- Pokémon Price Tracker fallback ---------------- */

function pptBuckets(row) {
  // deep-scan for the psaN buckets (the shape has drifted before)
  const find = (obj, depth = 0) => {
    if (!obj || typeof obj !== "object" || depth > 5) return null;
    if (Object.keys(obj).some((k) => /^psa[\s_-]?(10|[1-9])(\.5)?$/i.test(k))) return obj;
    for (const k of Object.keys(obj)) {
      const hit = find(obj[k], depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  return find(row);
}

const pennies = (n) => (typeof n === "number" && n > 0 ? Math.round(n * 100) : null);

const RANK = { low: 0, medium: 1, high: 2 };
const capAt = (c, limit) => (RANK[c] > RANK[limit] ? limit : c);

/* What a grade's number is worth trusting. The provider's own confidence
   grades the CALCULATION, not its recency — psa4 on base1-4 is "high" with a
   90-day window and nothing sold for 25 days — so recency caps it after the
   fact (PRICING-ATTEMPTS.md, the 19.09 investigation). */
function effectiveConfidence(bucket, priceField, stated) {
  const vol = typeof bucket?.dailyVolume7Day === "number" ? bucket.dailyVolume7Day : null;
  let c = RANK[stated] !== undefined ? stated
    : vol != null ? (vol * 7 >= SALES_VOLUME_FLOOR ? "high" : "low")
    : "low";
  if (vol === 0) c = capAt(c, "low");                 // nothing sold this week
  else if (vol == null) c = capAt(c, "medium");       // we cannot tell
  /* only an unbounded-window median to go on */
  if (priceField === "medianPrice" || priceField === "median") c = capAt(c, "medium");
  return c;
}

function pptGrades(row) {
  const buckets = pptBuckets(row);
  const grades = {};
  const metrics = {};
  for (const [k, v] of Object.entries(buckets || {})) {
    const m = k.toLowerCase().match(/^psa[\s_-]?((10|[1-9])(\.5)?)$/);
    if (!m) continue;
    const g = m[1];
    if (typeof v === "number") {
      const p = pennies(v);
      if (!p) continue;
      grades[g] = p;
      metrics[g] = { confidence: null, effective: "low", trend: null, dailyVolume7Day: null,
        salesCount: null, priceField: "value", daysUsed: null, lastSaleDate: null, spread: null };
      continue;
    }
    if (!v || typeof v !== "object") continue;
    /* smartMarketPrice is an OBJECT {price, confidence, method, daysUsed} — a
       `typeof === "number"` test drops it silently, which is how every stored
       price came to be medianPrice. Never `averagePrice`: a mean over a window
       we do not control, on a 4x spread, is not a current value. */
    const smart = v.smartMarketPrice && typeof v.smartMarketPrice === "object"
      ? v.smartMarketPrice
      : (typeof v.smartMarketPrice === "number" ? { price: v.smartMarketPrice } : null);
    const hit = [
      ["smartMarketPrice", smart?.price],
      ["marketPrice7Day", v.marketPrice7Day],
      ["medianPrice", v.medianPrice],
      ["median", v.median],
    ].find(([, x]) => typeof x === "number" && x > 0);
    if (!hit) continue;
    const [priceField, price] = hit;
    grades[g] = pennies(price);
    const daily = [v.dailyVolume7Day, v.dailyVolume].find((x) => typeof x === "number");
    const stated = String(smart?.confidence ?? v.smartMarketConfidence ?? "").toLowerCase();
    const lo = pennies(v.minPrice), hi = pennies(v.maxPrice);
    metrics[g] = {
      confidence: RANK[stated] !== undefined ? stated : null, // provider's, about the calculation
      effective: effectiveConfidence(v, priceField, RANK[stated] !== undefined ? stated : null),
      trend: v.marketTrend ?? null,
      dailyVolume7Day: Number.isFinite(daily) ? daily : null,
      /* the provider's `count` over ITS OWN window, not ours — never present
         this as recent activity */
      salesCount: Number.isFinite(v.salesCount) ? v.salesCount
        : Number.isFinite(v.count) ? v.count : null,
      priceField,
      daysUsed: Number.isFinite(smart?.daysUsed) ? smart.daysUsed : null,
      lastSaleDate: typeof v.lastSaleDate === "string" ? v.lastSaleDate.slice(0, 10) : null,
      spread: lo && hi ? { low: lo, high: hi } : null,
    };
  }
  const raw = [row.prices?.market, row.price?.market, row.marketPrice]
    .find((x) => typeof x === "number" && x > 0);
  if (raw) grades.raw = pennies(raw);
  if (!Object.keys(grades).length) return null;
  /* ebay.salesVelocity is {dailyAverage, weeklyAverage, monthlyTotal} */
  const velocity = [row.salesVelocityWeekly, row.ebay?.salesVelocityWeekly,
    row.ebay?.salesVelocity?.weeklyAverage].find((x) => typeof x === "number");
  return { grades, metrics, velocity: Number.isFinite(velocity) ? velocity : null };
}

/* Card-level summary: the best any of its grades can honestly claim. Each
   grade's own `effective` is what the app shows — a card can trade briskly at
   PSA 10 while nothing has moved at PSA 7 for a month. */
function gradeConfidence(metrics, velocity) {
  const vals = Object.values(metrics || {});
  const eff = vals.map((m) => m.effective).filter((c) => RANK[c] !== undefined);
  if (eff.length) return eff.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "low");
  if (!Number.isFinite(velocity)) return "low";
  return velocity >= SALES_VOLUME_FLOOR ? "high" : "low";
}

/* priceHistory arrives in several shapes; normalise to [{d, v}] in pennies. */
function pptSeries(node) {
  const out = [];
  const push = (d, v) => {
    const date = String(d || "").slice(0, 10);
    /* graded dates arrive as {average, count, sevenDayAverage, …} (run #8) */
    const p = pennies(typeof v === "number" ? v
      : v?.market ?? v?.price ?? v?.medianPrice ?? v?.median ?? v?.smartMarketPrice ?? v?.value
        ?? v?.average ?? v?.sevenDayAverage);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && p) out.push({ d: date, v: p });
  };
  if (Array.isArray(node)) for (const e of node) push(e?.date ?? e?.d ?? e?.t, e?.value ?? e?.v ?? e?.market ?? e?.price ?? e?.median ?? e?.medianPrice ?? e);
  else if (node && typeof node === "object") for (const [d, v] of Object.entries(node)) push(d, v);
  out.sort((a, b) => a.d.localeCompare(b.d));
  return out.length ? out : null;
}

const PSA_KEY = /^psa[\s_-]?((10|[1-9])(\.5)?)$/;

/* Real shapes, from run #7's diagnostics:
   raw    — row.priceHistory.conditions["Near Mint"|...].history[{date, market}]
   graded — row.ebay.priceHistory (exact inner shape tolerated broadly below) */
function pptHistory(row) {
  const series = {};
  const conditions = row.priceHistory?.conditions;
  if (conditions && typeof conditions === "object") {
    const prefer = ["Near Mint", "Lightly Played", "Moderately Played", "Heavily Played", "Damaged"];
    const key = prefer.find((k) => conditions[k]?.history?.length) ||
      Object.keys(conditions).find((k) => conditions[k]?.history?.length);
    const s = key ? pptSeries(conditions[key].history) : null;
    if (s) series.raw = s;
  } else {
    const raw = pptSeries(row.priceHistory?.market ?? row.priceHistory ?? row.history);
    if (raw) series.raw = raw;
  }
  const graded = row.ebay?.priceHistory ?? row.ebay?.history ?? row.ebayHistory ?? row.priceHistory?.ebay;
  if (Array.isArray(graded)) {
    // array of {date, psa10: …} or {date, grade, price}
    const byGrade = {};
    for (const e of graded) {
      const d = String(e?.date ?? e?.d ?? "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
      if (e.grade != null) {
        const m = String(e.grade).toLowerCase().match(/(10|[1-9])(\.5)?/);
        const p = pennies(e.price ?? e.median ?? e.medianPrice ?? e.market ?? e.value);
        if (m && p) (byGrade[m[0]] ||= []).push({ d, v: p });
      } else {
        for (const [k, v] of Object.entries(e)) {
          const m = k.toLowerCase().match(PSA_KEY);
          const p = pennies(typeof v === "number" ? v : v?.medianPrice ?? v?.median ?? v?.price);
          if (m && p) (byGrade[m[1]] ||= []).push({ d, v: p });
        }
      }
    }
    for (const [g, pts] of Object.entries(byGrade)) {
      pts.sort((a, b) => a.d.localeCompare(b.d));
      series[g] = pts;
    }
  } else if (graded && typeof graded === "object") {
    // psaN keys at the top level, or nested one level down (byGrade/…)
    const scan = (node) => {
      for (const [k, v] of Object.entries(node || {})) {
        const m = k.toLowerCase().match(PSA_KEY);
        if (!m) continue;
        const s = pptSeries(v?.history ?? v);
        if (s) series[m[1]] = s;
      }
    };
    scan(graded);
    if (!Object.keys(series).some((k) => k !== "raw")) {
      for (const nest of [graded.byGrade, graded.salesByGrade, graded.grades, graded.conditions]) scan(nest);
    }
  }
  return Object.keys(series).length ? series : null;
}

/* Cards the budget cannot cover today are not dropped — they go first
   tomorrow. Order: never-priced, then oldest price, then the rest. */
function rotate(cards, prev) {
  const seen = prev?.cards ?? {};
  return [...cards].sort((a, b) => {
    const sa = seen[a.id] ? 1 : 0, sb = seen[b.id] ? 1 : 0;
    if (sa !== sb) return sa - sb;
    return (pptMap[a.id]?.lastPriced ?? "").localeCompare(pptMap[b.id]?.lastPriced ?? "");
  });
}

/* Attempt ladder, ordered by precision. Two hard-won rules (runs #1-#4):
   `number` is not an accepted param (400), and PPT's setId is its own format —
   NOT the catalog id ("base1"), which filters every row out (total>0, count=0).
   1. tcgPlayerId (watchlist or learned) — an exact key, one row, no matching.
   2. A stored search + the setId PPT itself put on a previous hit.
   3. A sibling card of the same catalog set may have learned that setId.
   4. "name + set name" search (search spans name/set/number/rarity).
   5. Name alone — matched locally by card id, then number, then exact name. */
function pptAttempts(card) {
  const known = pptMap[card.id];
  const attempts = [];
  /* No tcgPlayerId attempt: runs #6-#7 showed exact lookups answer total=1
     with count=0 EVERY time (with or without limit) and still bill 3 credits.
     The stored search + learned setId below costs the same and works; the id
     stays in ppt-map as metadata. The ladder never shrinks to one attempt. */
  if (known?.search) {
    attempts.push({
      search: known.search,
      ...(known.setId != null ? { setId: String(known.setId) } : {}),
      limit: String(known.setId != null ? PPT_LIMIT_RESOLVED : PPT_LIMIT_FIRST),
    });
  }
  const catalogSetId = card.id.includes("-") ? card.id.split("-")[0] : null;
  const sibling = siblingSetId(catalogSetId);
  if (sibling != null) attempts.push({ search: card.name, setId: String(sibling), limit: String(PPT_LIMIT_FIRST) });
  if (card.setName) attempts.push({ search: `${card.name} ${card.setName}`, limit: String(PPT_LIMIT_FIRST) });
  attempts.push({ search: card.name, limit: String(PPT_LIMIT_FIRST) });
  return attempts;
}

/* The PPT setId most often learned for cards of this catalog set.
   "psa" is not a set: a cert-only slab's id is psa-<cert>, and every such
   slab would otherwise inherit an unrelated card's setId and filter itself
   out of every result. */
function siblingSetId(catalogSetId) {
  if (!catalogSetId || catalogSetId === "psa") return null;
  const counts = new Map();
  for (const [id, m] of Object.entries(pptMap)) {
    if (id.startsWith(catalogSetId + "-") && m.setId != null) {
      counts.set(m.setId, (counts.get(m.setId) || 0) + 1);
    }
  }
  let best = null, n = 0;
  for (const [s, c] of counts) if (c > n) { best = s; n = c; }
  return best;
}

async function priceWithPPT(cards, out, prev) {
  let credits = 0, remaining = null, resolvedToday = 0, histNoseen = 0;
  const histories = new Map();
  const norm = (n) => String(n ?? "").split("/")[0].toLowerCase().replace(/[^a-z0-9]/g, "").replace(/^0+(?=.)/, "");
  outer: for (const card of rotate(cards, prev)) {
    if (out.has(card.id)) continue;
    if (credits >= PPT_CREDIT_BUDGET) {
      console.log(`PPT credit budget spent (${credits}) — remaining cards roll to tomorrow`);
      break;
    }
    for (const attempt of pptAttempts(card)) {
      if (credits >= PPT_CREDIT_BUDGET) {
        console.log(`PPT credit budget spent (${credits}) — remaining cards roll to tomorrow`);
        break outer;
      }
      const params = new URLSearchParams(attempt);
      params.set("includeEbay", "true");
      params.set("includeHistory", "true");
      params.set("days", String(PPT_HISTORY_DAYS));
      if (card.language) params.set("language", card.language);
      let rows;
      try {
        const res = await fetch(PPT_BASE + "/api/v2/cards?" + params, {
          headers: { accept: "application/json", Authorization: "Bearer " + PPT_TOKEN },
        });
        if (!res.ok) {
          console.log(`  PPT HTTP ${res.status} for ${card.id}`);
          if (res.status === 429) { console.log("  quota or rate limit hit — stopping"); break outer; }
          continue;
        }
        const data = await res.json();
        rows = Array.isArray(data) ? data : (data.data ?? data.cards ?? data.results ?? []);
        if (!Array.isArray(rows)) rows = [];
        /* Bill from what the provider says it charged, not from our own guess. */
        const header = Number(res.headers.get("x-api-calls-consumed"));
        const stated = Number(data?.metadata?.apiCallsConsumed?.total);
        credits += [header, stated].find(Number.isFinite) ?? rows.length * 3;
        const left = Number(res.headers.get("x-ratelimit-daily-remaining"));
        if (Number.isFinite(left)) remaining = left;
        if (!rows.length) {
          const total = data?.metadata?.total;
          console.log(`  PPT 0 rows for ${card.id} [${params}]` +
            (total != null ? ` (total=${total})` : `: ${JSON.stringify(data).slice(0, 200)}`));
          continue;
        }
      } catch (err) {
        console.log(`  PPT error ${card.id}: ${err.message}`);
        continue;
      } finally {
        await sleep(1100);
      }
      /* strongest match first: an exact-id lookup is its own answer, and PPT
         rows carry catalog-style card ids */
      const row = attempt.tcgPlayerId ? rows[0] :
        rows.find((r) => (r.id ?? r.cardId) === card.id) ||
        (card.number != null &&
          rows.find((r) => norm(r.number ?? r.cardNumber ?? r.localId) === norm(card.number))) ||
        rows.find((r) => (r.name || "").toLowerCase() === card.name.toLowerCase());
      if (!row) { console.log(`  PPT no matching row for ${card.id} [${params}]`); continue; }
      const priced = pptGrades(row);
      if (!priced) { console.log(`  PPT no grade buckets for ${card.id}`); continue; }
      const known = pptMap[card.id];
      const resolvedId = row.tcgPlayerId ?? row.tcgplayerId ?? attempt.tcgPlayerId ?? null;
      if (resolvedId && !known?.tcgPlayerId) resolvedToday++;
      pptMap[card.id] = {
        tcgPlayerId: resolvedId ? String(resolvedId) : null,
        setId: row.setId ?? row.set?.id ?? known?.setId ?? null, // PPT's own format, learned from the row
        search: row.name || card.name,
        lastPriced: today,
      };
      /* which row we actually bound to — the only way to catch a card that
         matched a different printing of the same name */
      console.log(`  ${card.id} <- "${row.name}" · ${row.setName ?? row.set?.name ?? "?"}` +
        ` #${row.cardNumber ?? row.number ?? "-"} · setId=${row.setId ?? "-"} tcg=${row.tcgPlayerId ?? "-"}`);
      const hist = pptHistory(row);
      if (hist) histories.set(card.id, hist);
      const gradedParsed = hist && Object.keys(hist).some((k) => k !== "raw");
      if (histNoseen < 2 && (!hist || (!gradedParsed && row.ebay?.priceHistory))) {
        /* the history shape is undocumented — say what the row actually holds
           so the parser can be adapted without guessing */
        histNoseen++;
        const keys = (o) => (o && typeof o === "object" ? Object.keys(o).join(",") : String(o));
        console.log(`  PPT no history for ${card.id} · row keys: ${keys(row)}` +
          (row.ebay ? ` · ebay keys: ${keys(row.ebay)}` : "") +
          (row.priceHistory ? ` · priceHistory: ${JSON.stringify(row.priceHistory).slice(0, 200)}` : "") +
          (row.ebay?.priceHistory ? ` · ebay.priceHistory: ${JSON.stringify(row.ebay.priceHistory).slice(0, 250)}` : ""));
      }
      out.set(card.id, {
        pcId: null,
        tcgPlayerId: resolvedId ? String(resolvedId) : null,
        name: card.name,
        set: card.setName || null,
        number: card.number || null,
        grades: priced.grades,
        metrics: priced.metrics,
        salesVelocityWeekly: priced.velocity,
        salesVolume: null,
        confidence: gradeConfidence(priced.metrics, priced.velocity),
      });
      break; // priced — next card
    }
  }
  writeHistories(histories);
  console.log(`PPT: ~${credits} credits spent` +
    (remaining !== null ? ` · ${remaining} left today` : "") +
    (resolvedToday ? ` · resolved ${resolvedToday} new tcgPlayerId(s)` : ""));
}

/* One file per card: the card-detail chart becomes a single request instead of
   walking 30 snapshot files. Provider history is merged under our own — ours
   wins on a shared date, because it is what the app showed that day. */
function writeHistories(fresh) {
  if (!fresh.size) return;
  mkdirSync(HIST, { recursive: true });
  for (const [cardId, series] of fresh) {
    const file = join(HIST, `${cardId}.json`);
    const prev = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { cardId, series: {} };
    for (const [grade, points] of Object.entries(series)) {
      const byDate = new Map((points || []).map((p) => [p.d, p.v]));
      for (const p of prev.series?.[grade] || []) byDate.set(p.d, p.v); // ours wins
      prev.series[grade] = [...byDate.entries()]
        .map(([d, v]) => ({ d, v }))
        .sort((a, b) => a.d.localeCompare(b.d));
    }
    prev.cardId = cardId;
    prev.updatedAt = today;
    writeFileSync(file, JSON.stringify(prev));
  }
  console.log(`history: wrote ${fresh.size} card series`);
}

/* ---------------- write ---------------- */

mkdirSync(SNAPS, { recursive: true });
const prevDates = readdirSync(SNAPS).filter((f) => f.endsWith(".json")).sort();
const prevFile = prevDates.filter((f) => f < `${today}.json`).at(-1);
const prev = prevFile ? JSON.parse(readFileSync(join(SNAPS, prevFile), "utf8")) : null;

const entries = PC_TOKEN ? await priceWithPC(watchlist) : new Map();
if (PPT_TOKEN) await priceWithPPT(watchlist, entries, prev);

const fresh = entries.size;

/* A card the budget did not reach today keeps yesterday's price, flagged so the
   app can show its real age. Every snapshot stays complete; only `pricedOn`
   tells you how old a given number is. */
let carried = 0;
if (prev) {
  for (const [id, entry] of Object.entries(prev.cards || {})) {
    if (entries.has(id)) continue;
    entries.set(id, { ...entry, carried: true, pricedOn: entry.pricedOn || prev.date });
    carried++;
  }
}
for (const [, e] of entries) if (!e.pricedOn) e.pricedOn = today;

const cards = Object.fromEntries(entries);
const count = Object.keys(cards).length;
console.log(`priced ${fresh} fresh + ${carried} carried = ${count}/${watchlist.length} watchlist cards`);

if (fresh === 0) {
  console.error("ABORT: nothing priced today — not writing a snapshot of carried values only");
  process.exit(1);
}

const snapshot = {
  date: today,
  builtAt: new Date().toISOString(),
  source: PC_TOKEN && entries.size ? "pricecharting" : "ppt",
  cards,
};

writeFileSync(join(SNAPS, `${today}.json`), JSON.stringify(snapshot, null, 1));
writeFileSync(join(DATA, "latest.json"), JSON.stringify(snapshot, null, 1));
writeFileSync(pcMapPath, JSON.stringify(pcMap, null, 1));
writeFileSync(pptMapPath, JSON.stringify(pptMap, null, 1));

/* Today's own numbers join each card's series, so the chart keeps growing even
   if a future provider serves no history at all. */
mkdirSync(HIST, { recursive: true });
for (const [cardId, entry] of entries) {
  if (entry.carried) continue;
  const file = join(HIST, `${cardId}.json`);
  const doc = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { cardId, series: {} };
  for (const [grade, value] of Object.entries(entry.grades || {})) {
    const arr = (doc.series[grade] ||= []);
    const i = arr.findIndex((p) => p.d === today);
    if (i >= 0) arr[i] = { d: today, v: value };
    else arr.push({ d: today, v: value });
    arr.sort((a, b) => a.d.localeCompare(b.d));
  }
  doc.updatedAt = today;
  writeFileSync(file, JSON.stringify(doc));
}

const dates = readdirSync(SNAPS).filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(".json", "")).sort().reverse();
writeFileSync(join(DATA, "index.json"),
  JSON.stringify({ dates, oldest: dates.at(-1), count: dates.length }, null, 1));

console.log(`wrote snapshots/${today}.json · latest.json · index.json (${dates.length} dates)`);
