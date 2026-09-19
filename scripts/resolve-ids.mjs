#!/usr/bin/env node
/**
 * Resolve every watchlist card to a PPT tcgPlayerId, once.
 *
 *   PPT_TOKEN=... node scripts/resolve-ids.mjs           # report only
 *   PPT_TOKEN=... node scripts/resolve-ids.mjs --write   # write the ids back
 *
 * Why this is a separate script: a tcgPlayerId is an exact key, so once a card
 * has one the daily builder never searches by name again — no ambiguity, no
 * wrong-card risk, a flat charge per card. Name resolution is the one step
 * that genuinely needs a human to look at the result, so it does not belong in
 * an unattended cron job.
 *
 * Search strategy carries the builder's lessons (PRICING-ATTEMPTS.md): the
 * catalog set id ("base1") is NOT PPT's setId format and filters every row
 * out, and `number` is not an accepted param — so search "name + set name",
 * then name alone, and match locally by card id, then number, then name.
 *
 * Anything below a confident match is left unwritten and listed for you to
 * confirm — quietly binding a holding to the wrong printing is worse than
 * leaving it unresolved.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data");
const TOKEN = process.env.PPT_TOKEN || "";
const BASE = process.env.PPT_BASE || "https://www.pokemonpricetracker.com";
const WRITE = process.argv.includes("--write");

if (!TOKEN) { console.error("PPT_TOKEN required"); process.exit(1); }

const wlPath = join(DATA, "watchlist.json");
const wl = JSON.parse(readFileSync(wlPath, "utf8"));
const mapPath = join(DATA, "ppt-map.json");
const map = existsSync(mapPath) ? JSON.parse(readFileSync(mapPath, "utf8")) : {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (n) => String(n ?? "").split("/")[0].toLowerCase().replace(/[^a-z0-9]/g, "").replace(/^0+(?=.)/, "");

let credits = 0, remaining = null;
const resolved = [], ambiguous = [], missing = [];

async function search(params) {
  const res = await fetch(`${BASE}/api/v2/cards?${new URLSearchParams(params)}`, {
    headers: { accept: "application/json", Authorization: "Bearer " + TOKEN },
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const rows = Array.isArray(data) ? data : (data.data ?? data.cards ?? data.results ?? []);
  const header = Number(res.headers.get("x-api-calls-consumed"));
  credits += Number.isFinite(header) ? header : rows.length;
  const left = Number(res.headers.get("x-ratelimit-daily-remaining"));
  if (Number.isFinite(left)) remaining = left;
  return Array.isArray(rows) ? rows : [];
}

outer: for (const card of wl.cards) {
  const knownId = card.tcgPlayerId || map[card.id]?.tcgPlayerId;
  if (knownId) { resolved.push({ card, id: knownId, why: "already known" }); continue; }

  /* no history/ebay here — identity only, at the cheapest possible charge */
  const attempts = [];
  if (card.setName) attempts.push({ search: `${card.name} ${card.setName}`, limit: "10" });
  attempts.push({ search: card.name, limit: "10" });

  let rows = [];
  for (const attempt of attempts) {
    if (card.language) attempt.language = card.language;
    try {
      rows = await search(attempt);
    } catch (err) {
      console.log(`${card.id}: ${err.message}`);
      if (err.status === 429) break outer;
      continue;
    } finally {
      await sleep(1100);
    }
    if (rows.length) break;
  }

  if (!rows.length) { missing.push(card); continue; }

  const byId = rows.filter((r) => (r.id ?? r.cardId) === card.id);
  const byNumber = rows.filter((r) => norm(r.number ?? r.cardNumber ?? r.localId) === norm(card.number));
  const byName = rows.filter((r) => (r.name || "").toLowerCase() === (card.name || "").toLowerCase());
  const pick = byId.length === 1 ? byId[0]
    : byNumber.length === 1 ? byNumber[0]
    : byNumber.length > 1 ? null
    : byName.length === 1 ? byName[0] : null;

  if (!pick) { ambiguous.push({ card, candidates: (byNumber.length ? byNumber : rows).slice(0, 5) }); continue; }

  const id = pick.tcgPlayerId ?? pick.tcgplayerId;
  if (!id) { ambiguous.push({ card, candidates: [pick] }); continue; }
  resolved.push({
    card, id: String(id), row: pick,
    why: byId.length === 1 ? "matched on card id" : byNumber.length === 1 ? "matched on card number" : "matched on name",
  });
}

/* ---- report ---- */
console.log(`\nresolved ${resolved.length} · ambiguous ${ambiguous.length} · not found ${missing.length}`);
console.log(`credits: ${credits}${remaining !== null ? ` · ${remaining} left today` : ""}\n`);

for (const r of resolved) console.log(`  ✓ ${r.card.id.padEnd(14)} ${String(r.id).padEnd(10)} ${r.card.name} — ${r.why}`);

if (ambiguous.length) {
  console.log("\nAMBIGUOUS — pick one and add it to data/watchlist.json as \"tcgPlayerId\":");
  for (const a of ambiguous) {
    console.log(`\n  ${a.card.id}  ${a.card.name} #${a.card.number}`);
    for (const c of a.candidates) {
      console.log(`     ${String(c.tcgPlayerId ?? c.tcgplayerId ?? "?").padEnd(10)} ${c.name} · ${c.setName ?? c.set?.name ?? c.set ?? "?"} #${c.number ?? c.cardNumber ?? "?"} · $${c.prices?.market ?? "?"}`);
    }
  }
}

if (missing.length) {
  console.log("\nNOT FOUND — check the name, or add \"language\": \"japanese\":");
  for (const c of missing) console.log(`  ${c.id}  ${c.name} #${c.number}`);
}

/* ---- write ---- */
if (!WRITE) { console.log("\n(dry run — pass --write to save)"); process.exit(0); }

for (const r of resolved) {
  const card = wl.cards.find((c) => c.id === r.card.id);
  if (card) card.tcgPlayerId = String(r.id);
  map[r.card.id] = {
    ...(map[r.card.id] || {}),
    tcgPlayerId: String(r.id),
    setId: r.row?.setId ?? r.row?.set?.id ?? map[r.card.id]?.setId ?? null,
    search: r.row?.name || r.card.name,
  };
}
writeFileSync(wlPath, JSON.stringify(wl, null, 1));
writeFileSync(mapPath, JSON.stringify(map, null, 1));
console.log(`\nwrote ${resolved.length} ids to watchlist.json and ppt-map.json`);
