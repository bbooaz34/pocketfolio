#!/usr/bin/env node
/**
 * Snapshot retention (POCKETFOLIO-PRICING.md §3):
 *   - daily snapshots kept for 90 days;
 *   - older than that, only the 1st of each month survives;
 *   - hard cap ~18 months — anything older is deleted.
 * Rebuilds data/index.json afterwards.
 */

import { readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data");
const SNAPS = join(DATA, "snapshots");

const DAY = 24 * 3600 * 1000;
const now = Date.now();

const files = readdirSync(SNAPS).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
let removed = 0;

for (const f of files) {
  const date = f.replace(".json", "");
  const age = now - Date.parse(date + "T00:00:00Z");
  const isFirstOfMonth = date.endsWith("-01");
  const keep = age <= 90 * DAY || (isFirstOfMonth && age <= 548 * DAY);
  if (!keep) {
    unlinkSync(join(SNAPS, f));
    removed++;
  }
}

const dates = readdirSync(SNAPS).filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(".json", "")).sort().reverse();
writeFileSync(join(DATA, "index.json"),
  JSON.stringify({ dates, oldest: dates.at(-1) ?? null, count: dates.length }, null, 1));

console.log(`pruned ${removed} snapshots · ${dates.length} kept`);
