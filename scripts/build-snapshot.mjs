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
const PPT_CALL_CAP = 80;

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

function pptGrades(row) {
  // deep-scan for the psaN buckets (shape has drifted before)
  const find = (obj, depth = 0) => {
    if (!obj || typeof obj !== "object" || depth > 5) return null;
    if (Object.keys(obj).some((k) => /^psa[\s_-]?(10|[1-9])(\.5)?$/i.test(k))) return obj;
    for (const k of Object.keys(obj)) {
      const hit = find(obj[k], depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  const buckets = find(row);
  if (!buckets) return null;
  const grades = {};
  for (const [k, v] of Object.entries(buckets)) {
    const m = k.toLowerCase().match(/^psa[\s_-]?((10|[1-9])(\.5)?)$/);
    if (!m) continue;
    const price = typeof v === "number" ? v
      : v && typeof v === "object"
        ? [v.medianPrice, v.median, v.averagePrice, v.avgPrice, v.price].find((x) => typeof x === "number" && x > 0)
        : null;
    if (price > 0) grades[m[1]] = Math.round(price * 100); // dollars -> pennies
  }
  // raw market where present
  const raw = [row.prices?.market, row.price?.market, row.marketPrice]
    .find((x) => typeof x === "number" && x > 0);
  if (raw) grades.raw = Math.round(raw * 100);
  return Object.keys(grades).length ? grades : null;
}

async function priceWithPPT(cards, out) {
  let calls = 0;
  for (const card of cards) {
    if (out.has(card.id)) continue;
    if (calls >= PPT_CALL_CAP) { console.log("PPT call cap reached"); break; }
    const setId = card.id.includes("-") ? card.id.split("-")[0] : null;
    const params = new URLSearchParams({
      search: card.name, includeEbay: "true", limit: "5",
      ...(setId ? { setId } : {}),
    });
    calls++;
    let rows;
    try {
      const res = await fetch(PPT_BASE + "/api/v2/cards?" + params, {
        headers: { accept: "application/json", Authorization: "Bearer " + PPT_TOKEN },
      });
      if (!res.ok) { console.log(`  PPT HTTP ${res.status} for ${card.id}`); if (res.status === 429) break; continue; }
      const data = await res.json();
      rows = Array.isArray(data) ? data : (data.data ?? data.cards ?? []);
    } catch (err) {
      console.log(`  PPT error ${card.id}: ${err.message}`);
      continue;
    } finally {
      await sleep(1100);
    }
    const norm = (n) => String(n ?? "").split("/")[0].toLowerCase().replace(/[^a-z0-9]/g, "").replace(/^0+(?=.)/, "");
    const row = rows.find((r) =>
      norm(r.number ?? r.cardNumber ?? r.localId) === norm(card.number)) ||
      rows.find((r) => (r.name || "").toLowerCase() === card.name.toLowerCase());
    if (!row) continue;
    const grades = pptGrades(row);
    if (!grades) continue;
    out.set(card.id, {
      pcId: null,
      name: card.name,
      set: card.setName || null,
      number: card.number || null,
      grades,
      salesVolume: null,
      confidence: "fallback",
    });
  }
}

/* ---------------- write ---------------- */

const entries = PC_TOKEN ? await priceWithPC(watchlist) : new Map();
if (PPT_TOKEN) await priceWithPPT(watchlist, entries);

const cards = Object.fromEntries(entries);
const count = Object.keys(cards).length;
console.log(`priced ${count}/${watchlist.length} watchlist cards`);

// never write a snapshot >40% smaller than yesterday's — stale beats half-empty
mkdirSync(SNAPS, { recursive: true });
const prevDates = readdirSync(SNAPS).filter((f) => f.endsWith(".json")).sort();
const prevFile = prevDates.filter((f) => f < `${today}.json`).at(-1);
if (prevFile) {
  const prev = JSON.parse(readFileSync(join(SNAPS, prevFile), "utf8"));
  const prevCount = Object.keys(prev.cards || {}).length;
  if (prevCount > 0 && count < prevCount * 0.6) {
    console.error(`ABORT: ${count} cards vs ${prevCount} yesterday (>40% shrink)`);
    process.exit(1);
  }
}
if (count === 0) {
  console.error("ABORT: empty snapshot");
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

const dates = readdirSync(SNAPS).filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(".json", "")).sort().reverse();
writeFileSync(join(DATA, "index.json"),
  JSON.stringify({ dates, oldest: dates.at(-1), count: dates.length }, null, 1));

console.log(`wrote snapshots/${today}.json · latest.json · index.json (${dates.length} dates)`);
