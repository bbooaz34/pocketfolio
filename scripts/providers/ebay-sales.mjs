/**
 * Graded values from our own eBay sold-listing reads (TASK-ebay-direct.md §2).
 *
 * Reads data/sales/<cardId>.json, written by scripts/scrape-ebay-sold.mjs, and
 * answers in the shape the snapshot builder already consumes: `grades` in
 * pennies plus `metrics` per grade.
 *
 *   clean  = sales where !bo, newest first
 *   recent = clean within 90 days
 *   recent >= 3 → median of the newest five     high
 *   recent >= 1 → median of recent              medium
 *   clean  >= 1 → newest clean price            low, with its age
 *   else        → null  (Best Offer rows alone are not a price)
 *
 * Median, not mean and not the last one: Togepi PSA 1's clean sales are
 * $100 / $46 / $60 — a mean is dragged by the $100, the last alone is one
 * seller.
 *
 * The provider's fields (salesCount, daysUsed, smartMarketPrice …) are not
 * carried forward: they described someone else's sample. What is here is
 * counted from sales we saw ourselves.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const RECENT_DAYS = 90;
export const MEDIAN_OF = 5;
export const PRICE_FIELD = "ebay-median-5";

const DAY = 864e5;

export function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

const byNewest = (a, b) => b.d.localeCompare(a.d) || String(a.url).localeCompare(String(b.url));

/** One grade's sales → { value, metrics } or null. `today` is YYYY-MM-DD. */
export function valueGrade(sales, today) {
  const all = (sales || []).filter((s) => s && /^\d{4}-\d{2}-\d{2}$/.test(s.d) && s.p > 0);
  const clean = all.filter((s) => !s.bo).sort(byNewest);
  const nBO = all.length - clean.length;
  const now = Date.parse(today + "T00:00:00Z");
  const age = (s) => Math.round((now - Date.parse(s.d + "T00:00:00Z")) / DAY);
  const recent = clean.filter((s) => age(s) <= RECENT_DAYS);

  let used, confidence;
  if (recent.length >= 3) { used = recent.slice(0, MEDIAN_OF); confidence = "high"; }
  else if (recent.length >= 1) { used = recent; confidence = "medium"; }
  else if (clean.length >= 1) { used = [clean[0]]; confidence = "low"; }
  else return null;

  const prices = used.map((s) => s.p);
  const value = used.length === 1 ? used[0].p : median(prices);
  return {
    value,
    metrics: {
      priceField: PRICE_FIELD,
      source: "ebay",
      confidence,
      /* `effective` is what the app's caveats read; here it is the same fact */
      effective: confidence,
      n: recent.length,
      nBO,
      lastSale: clean[0].d,
      /* a low-confidence value is one old sale — say how old */
      ageDays: confidence === "low" ? age(clean[0]) : null,
      spread: { low: Math.min(...prices), high: Math.max(...prices) },
      /* the sales the number was computed from, so the app can list them and
         the value is checkable in one tap */
      used: used.map((s) => ({ d: s.d, p: s.p, url: s.url })),
    },
  };
}

/** A whole sales document → { grades, metrics } (grades with no clean sale are absent). */
export function valueSales(doc, today) {
  const grades = {};
  const metrics = {};
  for (const [g, sales] of Object.entries(doc?.grades || {})) {
    const r = valueGrade(sales, today);
    if (!r) continue;
    grades[g] = r.value;
    metrics[g] = r.metrics;
  }
  return { grades, metrics };
}

/** Read data/sales/<cardId>.json; null when missing, unreadable, or older than maxAgeMs. */
export function readSales(dataDir, cardId, { now = Date.now(), maxAgeMs = 48 * 3600e3 } = {}) {
  const file = join(dataDir, "sales", `${cardId}.json`);
  if (!existsSync(file)) return { doc: null, why: "missing" };
  let doc;
  try { doc = JSON.parse(readFileSync(file, "utf8")); } catch { return { doc: null, why: "unreadable" }; }
  const at = Date.parse(doc?.scrapedAt);
  if (!Number.isFinite(at)) return { doc: null, why: "no scrapedAt" };
  if (now - at > maxAgeMs) return { doc: null, why: `stale (${Math.round((now - at) / 3600e3)}h old)` };
  return { doc, why: null };
}
