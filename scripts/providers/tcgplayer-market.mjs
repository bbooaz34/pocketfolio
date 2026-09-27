/**
 * Raw (ungraded) prices from TCGplayer's own "Market Price", read by the owner
 * from the product page during the manual check and stored as
 * data/market/<cardId>.json:
 *
 *   { "cardId": "svp-044", "tcgPlayerId": "512035",
 *     "url": "https://www.tcgplayer.com/product/512035",
 *     "readAt": "2026-09-27T18:02:00+03:00", "market": 5540 }
 *
 * `market` is in pennies, like everything else. This is the number PPT used to
 * resell. TCGplayer is where raw cards actually trade, so it is not a sample of
 * someone else's market. Like data/sales, a reading is fresh for 48h and is
 * carried, flagged, after that.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export function readMarket(dataDir, cardId, { now = Date.now(), maxAgeMs = 48 * 3600e3 } = {}) {
  const file = join(dataDir, "market", `${cardId}.json`);
  if (!existsSync(file)) return { doc: null, why: "missing" };
  let doc;
  try { doc = JSON.parse(readFileSync(file, "utf8")); } catch { return { doc: null, why: "unreadable" }; }
  const at = Date.parse(doc?.readAt);
  if (!Number.isFinite(at)) return { doc: null, why: "no readAt" };
  if (!(Number.isInteger(doc.market) && doc.market > 0)) return { doc: null, why: "no market price" };
  if (now - at > maxAgeMs) return { doc: null, why: `stale (${Math.round((now - at) / 3600e3)}h old)` };
  return { doc, why: null };
}
