#!/usr/bin/env node
/**
 * The manual price check: the owner reads eBay sold searches and TCGplayer
 * product pages in their own Chrome (e.g. with the Claude in Chrome
 * extension), and this turns what they read into data/.
 *
 *   node scripts/manual-check.mjs prompt              # print the prompt to paste
 *   node scripts/manual-check.mjs prompt <id> …       # only these cards (e.g. the ones an answer missed)
 *   node scripts/manual-check.mjs import answer.txt   # read the answer into data/
 *   node scripts/build-snapshot.mjs                   # then build, commit, push
 *
 * Why manual: eBay blocks an automated browser, even a visible, signed-in one
 * (PRICING-ATTEMPTS.md, 26–27.09), and the PPT subscription is cancelled. A
 * person reading nine pages in their own browser is neither.
 *
 * The answer format is strict so it can be read back without guessing:
 *
 *   ## base1-4 1
 *   Sep 20 · $400.00 · 1999 POKEMON BASE SET UNLIMITED #4 CHARIZARD-HOLO PSA 1
 *   Aug 28 · $400.00 · BO · 1999 POKEMON BASE SET UNLIMITED #4 CHARIZARD-HOLO PSA 1
 *   ## svp-044 raw
 *   Market $55.40
 *
 * Every graded row goes through the scraper's own filters (grade, label,
 * printing, lots, languages, Best Offer), so a padded page is safe to paste
 * whole. Sales merge into data/sales without ever dropping one; a raw reading
 * replaces data/market/<id>.json. The page itself is kept under
 * scripts/fixtures/ as the record of what was read.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { searchUrl, filterRows, mergeSales, gradedGrades, localIso } from "./scrape-ebay-sold.mjs";
import { valueGrade } from "./providers/ebay-sales.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data");

export const tcgplayerUrl = (id) => `https://www.tcgplayer.com/product/${encodeURIComponent(id)}`;

export function promptText(watchlist) {
  const out = [
    "For each section below, open the link(s) and report what the page shows, under the exact `## …` header I give.",
    "",
    "For eBay links: list every sold result on page one, one per line, as `Mon D · $price · title`, with `BO · ` before the title when the result says \"Best offer accepted\" (not for \"or Best Offer\"). If the page has a \"Results matching fewer words\" divider, stop at it. Don't click into listings or go past page one.",
    "For TCGplayer links: one line, `Market $price`, from the product's \"Market Price\".",
    "Wait about 5 seconds between links. If a site shows a security check, stop and tell me.",
    "",
  ];
  for (const card of watchlist) {
    const graded = gradedGrades(card);
    if (graded.length && card.psaTitle) {
      for (const g of graded) {
        out.push(`## ${card.id} ${g}   (${card.name} PSA ${g})`);
        for (const t of [card.psaTitle, ...[].concat(card.psaTitleAlt || [])]) out.push(searchUrl(t, g));
        out.push("");
      }
    } else if ([].concat(card.grades || []).includes("raw") && card.tcgPlayerId) {
      out.push(`## ${card.id} raw   (${card.name}, ungraded)`);
      out.push(tcgplayerUrl(card.tcgPlayerId));
      out.push("");
    }
  }
  return out.join("\n");
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** The answer text → { pages: {id: {grade, rows}}, market: {id: pennies} }. */
/* TextEdit saves a pasted answer as RTF: "·" arrives as \'b7, each line ends
   in a backslash, and the text sits inside font and colour groups. Enough of
   RTF to get the plain text back; `textutil -convert txt` does it properly. */
export function rtfToText(rtf) {
  if (!/^\s*\{\\rtf/.test(rtf)) return rtf;
  const cp1252 = { 0x80: "€", 0x91: "‘", 0x92: "’", 0x93: "“", 0x94: "”", 0x96: "–", 0x97: "—" };
  return rtf
    .replace(/\{\\(?:fonttbl|colortbl|\*|stylesheet|info)[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, "")
    .replace(/\\'([0-9a-f]{2})/gi, (_, h) => { const c = parseInt(h, 16); return cp1252[c] ?? String.fromCharCode(c); })
    .replace(/\\u(-?\d+)\??/g, (_, d) => String.fromCharCode((Number(d) + 65536) % 65536))
    .replace(/\\\r?\n/g, "\n")
    .replace(/\\(par|line)\b ?/g, "\n")
    .replace(/\\[a-z]+-?\d* ?/gi, "")
    .replace(/\\([{}\\])/g, "$1")
    .replace(/[{}]/g, "");
}

const normWords = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/* A section header → { id, grade } on the watchlist, or null. The prompt asks
   for "## <cardId> <grade>", but the extension may echo the search instead:
   "# 1999 POKEMON GAME #46 CHARMANDER PSA 9". That is the card's label plus a
   grade — unambiguous, so it is matched against every label form. */
export function resolveHeader(line, watchlist) {
  const h = line.replace(/^#+\s*/, "").replace(/[*`]/g, "").replace(/^\d+[.)]\s+/, "").trim();
  const byId = h.match(/^(\S+)\s+(raw|\d+(?:\.5)?)\b/i);
  if (byId && watchlist.some((c) => c.id === byId[1])) return { id: byId[1], grade: byId[2].toLowerCase() };
  const low = normWords(h);
  const g = [...h.matchAll(/PSA\s*(10|[1-9](?:\.5)?)(?![\d.])/gi)].map((m) => m[1]).at(-1);
  if (g) {
    const hits = watchlist.filter((c) => gradedGrades(c).includes(g) &&
      [c.psaTitle, ...[].concat(c.psaTitleAlt || [])].filter(Boolean).some((l) => low.includes(normWords(l))));
    if (hits.length === 1) return { id: hits[0].id, grade: g };
    const named = watchlist.filter((c) => gradedGrades(c).includes(g) && c.name &&
      normWords(c.name).split(" ").every((w) => low.split(" ").includes(w)));
    if (named.length === 1) return { id: named[0].id, grade: g };
    return null;
  }
  const raws = watchlist.filter((c) => !gradedGrades(c).length &&
    ((c.tcgPlayerId && h.includes(String(c.tcgPlayerId))) ||
     (c.name && normWords(c.name).split(" ").every((w) => low.split(" ").includes(w)))));
  return raws.length === 1 ? { id: raws[0].id, grade: "raw" } : null;
}

export function parseAnswer(text, readOn, watchlist = []) {
  const [yy, mm] = readOn.split("-").map(Number);
  const pages = {}, market = {}, unknown = [];
  let cur = null, n = 0;
  for (const raw of rtfToText(String(text)).split(/\r?\n/)) {
    const line = raw.replace(/^\s*[*•-]\s+/, "").trim();
    if (!line) continue;
    if (/^#/.test(line) || /^\*\*[^*]+\*\*$/.test(line)) {
      cur = resolveHeader(line, watchlist);
      if (!cur) { unknown.push(line); continue; }
      if (cur.grade !== "raw") pages[cur.id] ||= { grade: cur.grade, rows: [] };
      continue;
    }
    if (!cur) continue;
    if (cur.grade === "raw") {
      const m = line.match(/market[^$\d]*\$\s*([\d,]+(?:\.\d{1,2})?)/i);
      if (m) market[cur.id] = Math.round(Number(m[1].replace(/,/g, "")) * 100);
      continue;
    }
    /* the asked-for "Mon D · $price · [BO ·] title", or a markdown table row
       "| Sep 20 | $100.00 | Yes | title |", which is what the extension
       tends to answer with when it is not held to the format */
    let d, price, bo, title;
    if (line.startsWith("|")) {
      const cells = line.split("|").slice(1, -1).map((c) => c.trim());
      if (cells.length < 3 || /^:?-+:?$/.test(cells[0]) || !/\$/.test(cells[1])) continue;
      [d, price] = cells;
      const boCell = cells.length >= 4 ? cells[2] : "";
      bo = /^(yes|y|bo|✓|✔)$/i.test(boCell) || /best offer accepted/i.test(boCell);
      title = cells.length >= 4 ? cells.slice(3).join(" | ") : cells[2];
    } else {
      const parts = line.split(/\s+·\s+/);
      if (parts.length < 3) continue;
      const rest = parts.slice(2);
      [d, price] = parts;
      bo = rest[0]?.toUpperCase() === "BO";
      title = (bo ? rest.slice(1) : rest).join(" · ");
    }
    const dm = d.match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})$/);
    if (!dm || !MONTHS[dm[1].toLowerCase()]) continue;
    /* a sale from a later month than the read is last year's */
    const year = MONTHS[dm[1].toLowerCase()] > mm ? yy - 1 : yy;
    n++;
    pages[cur.id].rows.push({ title, price, caption: `Sold ${dm[1]} ${dm[2]}, ${year}`,
      text: title + (bo ? " Best offer accepted" : ""), href: `https://www.ebay.com/itm/7${String(n).padStart(11, "0")}` });
  }
  return { pages, market, unknown };
}

/* no item link is captured by a manual read: each sale links to a sold search
   for its own title, keyed by date and price so a sale read twice is one sale */
function seedUrl(s) {
  const u = new URL("https://www.ebay.com/sch/i.html");
  u.searchParams.set("_nkw", s.t);
  u.searchParams.set("LH_Sold", "1");
  u.searchParams.set("LH_Complete", "1");
  return `${u}#${s.d}-${s.p}`;
}

export function importAnswer(text, watchlist, { dataDir = DATA, readOn, now = new Date(), log = console.log } = {}) {
  const { pages, market, unknown } = parseAnswer(text, readOn, watchlist);
  for (const u of unknown) log(`  a section whose card could not be told — its rows were not read: ${u}`);
  const rowsRead = Object.values(pages).reduce((a, p) => a + p.rows.length, 0);
  if (!rowsRead && !Object.keys(market).length) {
    return { ok: false, why: "nothing read — no sale rows and no market price. The answer must keep the `## <cardId> <grade>` headers from the prompt, with one sale per line under each (or a table). An empty check is an alert, not a price." };
  }
  const at = localIso(now);
  mkdirSync(join(dataDir, "sales"), { recursive: true });
  mkdirSync(join(dataDir, "market"), { recursive: true });
  for (const [id, pg] of Object.entries(pages)) {
    const card = watchlist.find((c) => c.id === id);
    if (!card) { log(`  skip ${id}: not on the watchlist`); continue; }
    if (!card.psaTitle) { log(`  skip ${id}: no psaTitle — not priced`); continue; }
    const { sales, dropped } = filterRows(pg.rows, card, pg.grade);
    const file = join(dataDir, "sales", `${id}.json`);
    const prev = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
    const doc = mergeSales(prev, card, pg.grade, sales.map((s) => ({ ...s, url: seedUrl(s), seeded: readOn })), at);
    writeFileSync(file, JSON.stringify(doc, null, 1) + "\n");
    const v = valueGrade(doc.grades[pg.grade], readOn);
    const why = Object.entries(dropped).filter(([, k]) => k).map(([k, c]) => `${k} ${c}`).join(", ");
    log(`  ${card.name} PSA ${pg.grade}: ${pg.rows.length} rows → ${sales.length} kept${why ? ` (dropped ${why})` : ""}` +
      ` → ${v ? `$${(v.value / 100).toFixed(2)} (${v.metrics.confidence}, ${v.metrics.n} clean in 90d)` : "no price"}`);
  }
  for (const [id, pennies] of Object.entries(market)) {
    const card = watchlist.find((c) => c.id === id);
    if (!card) { log(`  skip ${id}: not on the watchlist`); continue; }
    const doc = { cardId: id, tcgPlayerId: card.tcgPlayerId ?? null,
      url: card.tcgPlayerId ? tcgplayerUrl(card.tcgPlayerId) : null, readAt: at, market: pennies };
    writeFileSync(join(dataDir, "market", `${id}.json`), JSON.stringify(doc, null, 1) + "\n");
    log(`  ${card.name} raw: TCGplayer market $${(pennies / 100).toFixed(2)}`);
  }
  if (Object.keys(pages).length) {
    const fx = join(ROOT, "scripts", "fixtures", `ebay-${readOn}.json`);
    if (dataDir === DATA && !existsSync(fx)) {
      writeFileSync(fx, JSON.stringify({ capturedOn: readOn, source: "owner's manual check (scripts/manual-check.mjs)", pages }, null, 1));
    }
  }
  /* a card the prompt asked about and the answer skipped is said out loud:
     silence there reads as "checked, nothing new" */
  const missing = watchlist.filter((c) => (gradedGrades(c).length && c.psaTitle && !pages[c.id]) ||
    (!gradedGrades(c).length && c.tcgPlayerId && market[c.id] == null)).map((c) => c.id);
  return { ok: true, graded: Object.keys(pages).length, raw: Object.keys(market).length, missing };
}

async function main(argv) {
  const watchlist = JSON.parse(readFileSync(join(DATA, "watchlist.json"), "utf8")).cards;
  const cmd = argv[0];
  if (cmd === "prompt") {
    const only = argv.slice(1);
    const unknown = only.filter((id) => !watchlist.some((c) => c.id === id));
    if (unknown.length) { console.error(`not on the watchlist: ${unknown.join(", ")}`); process.exit(1); }
    console.log(promptText(only.length ? watchlist.filter((c) => only.includes(c.id)) : watchlist));
    return;
  }
  if (cmd === "import" && argv[1]) {
    const readOn = localIso().slice(0, 10);
    const r = importAnswer(readFileSync(argv[1], "utf8"), watchlist, { readOn });
    if (!r.ok) { console.error(`ABORT: ${r.why}`); process.exit(1); }
    console.log(`\nread ${r.graded} graded card(s) and ${r.raw} raw price(s). Next:\n` +
      "  node scripts/build-snapshot.mjs && git add data scripts/fixtures && git commit -m 'prices: manual check' && git push");
    if (r.missing.length) {
      console.log(`\nnot in the answer (kept as they were): ${r.missing.join(", ")}` +
        `\nto read just those: node scripts/manual-check.mjs prompt ${r.missing.join(" ")} > prompt.txt`);
    }
    return;
  }
  console.error("usage: node scripts/manual-check.mjs prompt | import <answer.txt>");
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
