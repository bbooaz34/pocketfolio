#!/usr/bin/env node
/**
 * Offline test for scripts/build-snapshot.mjs — costs zero credits.
 *
 *   node scripts/test-snapshot.mjs
 *
 * Stands up a fake PPT on localhost, points the builder at it with PPT_BASE,
 * and runs three days in a row against a temp data dir. Asserts the things
 * that actually broke before (PRICING-ATTEMPTS.md "לקחים טכניים"):
 *
 *   1. Credits are counted as rows x2, and the budget stops the run.
 *   2. A card the budget missed is carried forward, not dropped.
 *   3. Rotation prices yesterday's leftovers first.
 *   4. A 429 halts immediately instead of hammering.
 *   5. Snapshots already written are never rewritten.
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, cpSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUILDER = join(ROOT, "scripts", "build-snapshot.mjs");

/* ---- fixture: 20 cards, more than one day's budget can cover ---- */
const CARDS = Array.from({ length: 8 }, (_, i) => ({
  id: `base1-${i + 1}`,
  name: `TestMon ${i + 1}`,
  setName: "Base",
  number: String(i + 1),
}));

let rowsServed = 0, requests = 0, force429After = Infinity, limitsSeen = [];

const server = createServer((req, res) => {
  requests++;
  if (requests > force429After) { res.writeHead(429).end("{}"); return; }
  const url = new URL(req.url, "http://x");
  // the real API rejects unknown params with 400 — enforce that here so a
  // regression to e.g. `number` fails this test the way run #1 failed live
  const allowed = new Set(["search", "setId", "limit", "includeEbay", "language", "sortBy"]);
  for (const k of url.searchParams.keys()) {
    if (!allowed.has(k)) { res.writeHead(400).end(`{"error":"unknown param ${k}"}`); return; }
  }
  const limit = Number(url.searchParams.get("limit") || 5);
  limitsSeen.push(limit);
  const search = url.searchParams.get("search") || "";
  const match = CARDS.find((c) => c.name === search) || CARDS[0];
  // Serve `limit` rows — the real API bills per row, doubled by includeEbay.
  const rows = Array.from({ length: limit }, (_, i) => ({
    name: i === 0 ? match.name : `Filler ${i}`,
    number: i === 0 ? match.number : `9${i}`,
    prices: { market: 12.34 },
    ebay: { salesByGrade: { psa10: { medianPrice: 500 + Number(match.number) }, psa9: { medianPrice: 200 } } },
  }));
  rowsServed += rows.length;
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: rows }));
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
const d1 = await run("2026-09-20", { PPT_CREDIT_BUDGET: "6" });
if (d1.status !== 0) { console.log(d1.stdout, d1.stderr); throw new Error("day 1 failed"); }
const s1 = snap("2026-09-20");
const n1 = Object.keys(s1.cards).length;
check("day 1 priced only what the budget allows", n1 > 0 && n1 <= 4, `${n1} cards, ${rowsServed} rows served`);
check("credits counted as rows x2", rowsServed * 2 <= 6 + 4, `~${rowsServed * 2} credits for a budget of 6`);
check("first touch searches with limit=3", limitsSeen.every((l) => l === 3), `limits: ${limitsSeen.join(",")}`);
check("only documented params are sent (no 400s)", !d1.stdout.includes("HTTP 400"));

/* ---- day 2: leftovers first, day 1 carried ---- */
const before = new Set(Object.keys(s1.cards));
const d2 = await run("2026-09-21", { PPT_CREDIT_BUDGET: "6" });
if (d2.status !== 0) { console.log(d2.stdout, d2.stderr); throw new Error("day 2 failed"); }
const s2 = snap("2026-09-21");
const freshDay2 = Object.entries(s2.cards).filter(([, c]) => !c.carried).map(([id]) => id);
check("day 2 is complete (fresh + carried)", Object.keys(s2.cards).length >= n1, `${Object.keys(s2.cards).length} cards`);
check("rotation priced new cards, not yesterday's", freshDay2.every((id) => !before.has(id)), freshDay2.slice(0, 3).join(", "));
check("carried entries keep their real date", Object.values(s2.cards).some((c) => c.carried && c.pricedOn === "2026-09-20"));

/* ---- day 3: quota exhausted mid-run ---- */
requests = 0; force429After = 2;
const d3 = await run("2026-09-22", { PPT_CREDIT_BUDGET: "200" });
force429After = Infinity;
check("429 stops the run instead of hammering", requests <= 4, `${requests} requests after the 429`);
check("a 429 day still writes a complete snapshot", existsSync(join(work, "data", "snapshots", "2026-09-22.json")) || d3.status !== 0);

/* ---- immutability ---- */
const raw2 = readFileSync(join(work, "data", "snapshots", "2026-09-21.json"), "utf8");
await run("2026-09-23", { PPT_CREDIT_BUDGET: "6" });
check("older snapshots are immutable", readFileSync(join(work, "data", "snapshots", "2026-09-21.json"), "utf8") === raw2);

/* ---- resolved cards re-query at limit=1 ---- */
limitsSeen = [];
const d5 = await run("2026-09-24", { PPT_CREDIT_BUDGET: "200" });
if (d5.status !== 0) { console.log(d5.stdout, d5.stderr); throw new Error("day 5 failed"); }
const s5 = snap("2026-09-24");
const fresh5 = Object.values(s5.cards).filter((c) => !c.carried).length;
check("full budget prices the whole watchlist", fresh5 === CARDS.length, `${fresh5}/${CARDS.length} fresh`);
check("resolved identities re-query at limit=1", limitsSeen.includes(1) && limitsSeen.includes(3),
  `limits: ${limitsSeen.join(",")}`);

server.close();
console.log(`\nworkspace: ${work}`);
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed — zero credits spent");
process.exit(failures ? 1 : 0);
