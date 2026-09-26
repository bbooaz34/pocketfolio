#!/usr/bin/env node
/**
 * Read eBay's own sold listings for every graded watchlist card
 * (TASK-ebay-direct.md §1). Runs on the owner's Mac, from a dedicated
 * logged-in browser profile — never from CI, which is signed out and is not
 * the owner's account.
 *
 *   node scripts/scrape-ebay-sold.mjs            # headless, the nightly run
 *   node scripts/scrape-ebay-sold.mjs --login    # headed: sign in once, then scrape
 *   node scripts/scrape-ebay-sold.mjs --dry-run  # read and print, write nothing
 *   node scripts/scrape-ebay-sold.mjs --headed   # the same, with the window visible
 *   node scripts/scrape-ebay-sold.mjs --card base1-4   # one card only
 *
 * One search per card and grade, page one only, most recent first:
 *   https://www.ebay.com/sch/i.html?_nkw=<psaTitle> PSA <g>&LH_Sold=1&LH_Complete=1&_sop=13
 *
 * The search string is the PSA label title, verbatim: sellers copy it from the
 * slab. A short name misses ("Togepi Japanese Neo Genesis" → 0 results), and
 * the label carries the edition, so a 1ST EDITION card is priced from 1st
 * Edition sales without any edition logic here. A card with no `psaTitle` is
 * not searched — a constructed name is how the wrong Togepi got priced.
 *
 * Writes data/sales/<cardId>.json, prices in pennies, keyed by listing url.
 * A re-scrape merges and never drops a sale it saw before: nine page-one reads
 * a day, merged, are the history.
 *
 * Safety — the profile of this job is part of the decision to run it at all:
 *   - sequential, a 4–8s random pause between queries, one page each;
 *   - a login wall or a bot check stops the run and writes nothing — it is
 *     never worked around;
 *   - zero items on every page exits non-zero and writes nothing: one empty
 *     day is an alert, not a price;
 *   - never the daily Chrome profile, never a form, never a click into a
 *     listing — the search page has everything.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data");
export const PROFILE_DIR = join(homedir(), ".pocketfolio", "chrome-profile");

/* ---------------- pure helpers (tested offline) ---------------- */

export function searchUrl(psaTitle, grade) {
  const u = new URL("https://www.ebay.com/sch/i.html");
  /* the label's words, verbatim — but not its punctuation. "GOLD, SILVER,
     TO A NEW WORLD... TOGEPI" returned nothing at all on 26.09 while the
     same words without the commas and dots are what sellers type. A hyphen
     goes too: to eBay "-HOLO" can read as "without holo", which would hide
     exactly the CHARIZARD-HOLO listings we want. */
  const words = String(psaTitle).replace(/[.,-]+/g, " ").replace(/\s+/g, " ").trim();
  u.searchParams.set("_nkw", `${words} PSA ${grade}`);
  u.searchParams.set("LH_Sold", "1");
  u.searchParams.set("LH_Complete", "1");
  u.searchParams.set("_sop", "13");
  return u.toString();
}

/** `PSA 1` must not match `PSA 10`, nor `PSA 1.5`. */
export function gradeRe(g) {
  const esc = String(g).replace(".", "\\.");
  /* PSA's condition words may sit between the brand and the number: "PSA MINT 9" */
  const cond = "(?:(?:GEM\\s*)?(?:MINT|MT)|NM[-\\s]?MT|NM|EX[-\\s]?MT|EX|VG[-\\s]?EX|VG|GOOD|GD|FAIR|FR|POOR|PR)?";
  return new RegExp(`PSA\\s*${cond}\\s*${esc}(\\b|\\.0)(?!\\d|\\.5)`, "i");
}

/* words on every PSA label, or too short to tell one card from another */
const STOP = new Set(["pokemon", "japanese", "english", "psa", "the", "and", "holo", "edition", "1st"]);

/** The words of a label title that name THIS card: its subject and set words. */
export function distinctiveTokens(psaTitle) {
  return [...new Set(String(psaTitle).toLowerCase()
    .replace(/'s\b/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !STOP.has(w)))];
}

const LOT = /\blot\b|bundle|set of|x\d/i;
const OTHER_LANG = /italian|french|german|spanish|japanese|portuguese|dutch|korean|chinese/i;
const QUALIFIER = /\b(OC|MK|MC|ST|PD)\b/;
/* Only an ACCEPTED offer hides the real price. "or Best Offer" on a sold row
   says the listing allowed offers, and its price is what it sold for — on
   26.09 the looser /best offer/ flagged 6 of Misty's Tears' 9 sales where
   eBay said "Best offer accepted" on 2. */
const BEST_OFFER = /best offer accepted/i;
/* Printings PSA names on the label. A listing that names one the card's own
   label does not is another card: "#46 CHARMANDER" (Unlimited) is a word-for-
   word subset of the 1st Edition and Shadowless labels, and eBay's exact
   matches returned $580 1st Edition sales for it on 26.09. The rule is only
   "not on our label", so a 1ST EDITION label keeps its own sales. */
const PRINTINGS = [
  ["1st edition", /\b(1st|first)\s*ed(ition|\.)?\b/i],
  ["shadowless", /\bshadowless\b/i],
  ["base set 2", /\bbase\s*(set\s*)?(ii|2)\b/i],
];
const YEARS = /\b(19[89]\d|20[0-3]\d)\b/g;

export function cleanTitle(t) {
  return String(t || "")
    .replace(/Opens in a new window or tab\s*$/i, "")
    .replace(/^\s*New Listing\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** "$400.00" → 40000. Anything not in US dollars, or a price range, is null. */
export function parsePrice(text) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (/\bto\b/i.test(s)) return null;                 // "$10.00 to $20.00"
  const m = s.match(/^(?:US\s*)?\$\s*([\d,]+(?:\.\d{1,2})?)$/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** "Sold  Sep 21, 2026" (or "Sold 21 Sep 2026") → "2026-09-21". */
export function parseSoldDate(caption) {
  const s = String(caption || "");
  let m = s.match(/([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/);
  let mon, day, year;
  if (m) [, mon, day, year] = m;
  else if ((m = s.match(/(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})/))) [, day, mon, year] = m;
  else return null;
  const mm = MONTHS[mon.toLowerCase()];
  if (!mm) return null;
  return `${year}-${String(mm).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** A listing is its item id; tracking parameters differ on every visit. */
export function normalizeUrl(href) {
  const m = String(href || "").match(/\/itm\/(?:[^/?#]+\/)?(\d{9,})/);
  return m ? `https://www.ebay.com/itm/${m[1]}` : null;
}

/**
 * Raw rows from the page → sales for one card at one grade, filtered in the
 * order that worked on 22.09. Returns { sales, dropped } — `dropped` counts
 * why rows were refused, for the log.
 */
export function filterRows(rows, card, grade) {
  const want = gradeRe(grade);
  const tokens = distinctiveTokens(card.psaTitle);
  const need = Math.min(2, tokens.length);
  const english = !card.language || card.language === "english";
  const notOurs = PRINTINGS.filter(([, re]) => !re.test(card.psaTitle)).map(([, re]) => re);
  /* a label's year names the print run: "2000 POKEMON GAME BASE II #4
     CHARIZARD-HOLO" is Base Set 2, not the 1999 card. A listing naming years,
     none of them ours, is another card. ("PSA 9 2026 CERT … 1999" keeps.) */
  const ourYear = (String(card.psaTitle).match(YEARS) || [])[0] || null;
  const dropped = { grade: 0, tokens: 0, printing: 0, lot: 0, language: 0, qualifier: 0, price: 0, date: 0, url: 0 };
  const sales = [];
  const seen = new Set();
  for (const r of rows) {
    const t = cleanTitle(r.title);
    if (!want.test(t)) { dropped.grade++; continue; }
    const low = t.toLowerCase();
    if (tokens.filter((w) => low.includes(w)).length < need) { dropped.tokens++; continue; }
    if (notOurs.some((re) => re.test(t))) { dropped.printing++; continue; }
    const years = t.match(YEARS);
    if (ourYear && years && !years.includes(ourYear)) { dropped.printing++; continue; }
    if (LOT.test(t)) { dropped.lot++; continue; }
    if (english && OTHER_LANG.test(t)) { dropped.language++; continue; }
    if (QUALIFIER.test(t)) { dropped.qualifier++; continue; }
    const p = parsePrice(r.price);
    if (!p) { dropped.price++; continue; }
    const d = parseSoldDate(r.caption);
    if (!d) { dropped.date++; continue; }
    const url = normalizeUrl(r.href);
    if (!url || seen.has(url)) { dropped.url++; continue; }
    seen.add(url);
    /* kept, and flagged: a Best Offer row is evidence of demand, not of
       price — the struck-through figure is the ask, not what was paid */
    sales.push({ d, p, bo: BEST_OFFER.test(r.text || ""), t, url });
  }
  return { sales, dropped };
}

/** Merge today's sales into the stored ones. Keyed by url; nothing is ever dropped. */
export function mergeSales(prev, card, grade, sales, scrapedAt) {
  const doc = prev && typeof prev === "object"
    ? { ...prev, grades: { ...(prev.grades || {}) } }
    : { cardId: card.id, grades: {} };
  doc.cardId = card.id;
  doc.psaTitle = card.psaTitle;
  doc.scrapedAt = scrapedAt;
  /* A sale seeded from a manual read has no listing url of its own (it links
     to the search). When a real read finds the same date and price, that
     listing replaces it — the same sale must not count twice. */
  const seen = new Set(sales.map((s) => `${s.d}|${s.p}`));
  const kept = (doc.grades[grade] || []).filter((s) => /\/itm\//.test(s.url) || !seen.has(`${s.d}|${s.p}`));
  const byUrl = new Map(kept.map((s) => [s.url, s]));
  for (const s of sales) {
    const old = byUrl.get(s.url);
    /* the first sighting keeps its date; a later read may only add the flag */
    byUrl.set(s.url, old ? { ...old, bo: old.bo || s.bo } : s);
  }
  doc.grades[grade] = [...byUrl.values()]
    .sort((a, b) => b.d.localeCompare(a.d) || a.url.localeCompare(b.url));
  return doc;
}

/** ISO timestamp in local time with its offset: 2026-09-26T04:02:11+03:00 */
export function localIso(date = new Date()) {
  const off = -date.getTimezoneOffset();
  const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  const local = new Date(date.getTime() + off * 60e3).toISOString().slice(0, 19);
  return `${local}${off >= 0 ? "+" : "-"}${pad(off / 60)}:${pad(off % 60)}`;
}

export function gradedGrades(card) {
  return [].concat(card.grades || []).map(String).filter((g) => g !== "raw");
}

/* ---------------- the browser run ---------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* the selectors that worked on 22.09, with the newer card layout beside them */
/* Only the exact matches. When few listings match every word, eBay pads the
   page under a "Results matching fewer words" divider — and a padded row can
   be the Unlimited print of a 1ST EDITION label. Everything after the
   divider is counted, not kept. */
function extract() {
  const q = (el, sel) => el.querySelector(sel);
  const rows = [];
  let fewer = 0, cut = false;
  for (const li of document.querySelectorAll("li.s-item, li.s-card, li.srp-river-answer")) {
    const isItem = li.matches("li.s-item, li.s-card");
    if (!isItem) {
      if (/REWRITE_START/.test(li.className) || /matching fewer words/i.test(li.textContent || "")) cut = true;
      continue;
    }
    if (cut) { fewer++; continue; }
    rows.push({
      title: (q(li, ".s-item__title, .s-card__title") || {}).textContent || "",
      price: (q(li, ".s-item__price, .s-card__price") || {}).textContent || "",
      caption: (q(li, ".s-item__caption, .s-card__caption, .s-item__title--tag") || {}).textContent || "",
      text: li.textContent || "",
      href: (q(li, "a.s-item__link, a.su-link, a[href*='/itm/']") || {}).href || "",
    });
  }
  return { rows, fewer };
}

/** What kind of page did we land on — results, a login wall, or a bot check. */
async function pageKind(page) {
  const url = page.url();
  if (/signin\.ebay\.|\/signin\//i.test(url)) return "login";
  if (/captcha|splashui/i.test(url)) return "blocked";
  const title = (await page.title().catch(() => "")) || "";
  if (/security measure|pardon our interruption|access denied/i.test(title)) return "blocked";
  if (await page.$("#signin-form, input#userid").catch(() => null)) return "login";
  return "results";
}

/** Watchlist → one search per titled card and held grade. */
export function targetsOf(watchlist, only = null) {
  const targets = [];
  for (const card of watchlist) {
    if (only && card.id !== only) continue;
    const grades = gradedGrades(card);
    if (!grades.length) continue;
    if (!card.psaTitle) {
      console.log(`  skip ${card.id}: no psaTitle — not searched, not priced`);
      continue;
    }
    for (const g of grades) targets.push({ card, grade: g });
  }
  return targets;
}

/**
 * The run itself, with the browser behind `read(url)`, which answers
 * { kind: "results"|"login"|"blocked"|"error", rows, url, error }.
 * Returns { code, docs }: code 0 with the merged documents to write, or a
 * non-zero code and nothing to write.
 */
export async function scrape(targets, read, { dataDir = DATA, pause = () => sleep(4000 + Math.random() * 4000), now = () => new Date() } = {}) {
  const results = [];
  let anyItems = false;
  for (let i = 0; i < targets.length; i++) {
    const { card, grade } = targets[i];
    if (i > 0) await pause();
    const page = await read(searchUrl(card.psaTitle, grade));
    if (page.kind === "login") {
      console.error(`ABORT: eBay shows a login wall (${page.url}). Sign in again with --login. Nothing written.`);
      return { code: 2, docs: null };
    }
    if (page.kind === "blocked") {
      console.error(`ABORT: eBay is blocking this profile (${page.url}). Stopping — not working around it. Nothing written.`);
      return { code: 3, docs: null };
    }
    if (page.kind !== "results") {
      console.log(`  ${card.id} PSA ${grade}: page did not load (${page.error || page.kind}) — left as it was`);
      continue;
    }
    const rows = page.rows || [];
    if (rows.length || page.fewer) anyItems = true;
    if (page.fewer) console.log(`  ${card.id} PSA ${grade}: ${page.fewer} "fewer words" row(s) not read`);
    if (!rows.length) console.log(`  ${card.id} PSA ${grade}: no exact matches at ${searchUrl(card.psaTitle, grade)}`);
    const { sales, dropped } = filterRows(rows, card, grade);
    const nBO = sales.filter((s) => s.bo).length;
    const why = Object.entries(dropped).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(", ");
    console.log(`  ${card.id} PSA ${grade}: ${rows.length} items → ${sales.length} kept` +
      (nBO ? ` (${nBO} best offer)` : "") + (why ? ` · dropped: ${why}` : ""));
    for (const s of sales) console.log(`      ${s.d}  $${(s.p / 100).toFixed(2)}${s.bo ? "  BO" : ""}  ${s.t.slice(0, 80)}`);
    results.push({ card, grade, sales });
  }
  if (!anyItems) {
    console.error("ABORT: zero items on every page — an empty day is an alert, not a price. Nothing written.");
    return { code: 1, docs: null };
  }
  const scrapedAt = localIso(now());
  const docs = new Map();
  for (const { card, grade, sales } of results) {
    const file = join(dataDir, "sales", `${card.id}.json`);
    const prev = docs.get(card.id) ||
      (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null);
    docs.set(card.id, mergeSales(prev, card, grade, sales, scrapedAt));
  }
  return { code: 0, docs };
}

export function writeDocs(docs, dataDir = DATA) {
  mkdirSync(join(dataDir, "sales"), { recursive: true });
  for (const [id, doc] of docs) {
    writeFileSync(join(dataDir, "sales", `${id}.json`), JSON.stringify(doc, null, 1) + "\n");
  }
}

async function main(argv) {
  const login = argv.includes("--login");
  const dryRun = argv.includes("--dry-run");
  const firstRun = !existsSync(PROFILE_DIR);
  const only = argv.includes("--card") ? argv[argv.indexOf("--card") + 1] : null;

  const watchlist = JSON.parse(readFileSync(join(DATA, "watchlist.json"), "utf8")).cards;
  const targets = targetsOf(watchlist, only);
  if (!targets.length) { console.error("no graded watchlist card has a psaTitle — nothing to read"); process.exit(1); }

  let chromium;
  try { ({ chromium } = await import("playwright")); }
  catch { console.error("playwright is not installed — run `npm install` in the repo first"); process.exit(1); }

  mkdirSync(PROFILE_DIR, { recursive: true });
  /* the first run, or --login: a visible window, so the owner signs in once.
     Signed-out sold searches hit a login wall since July — the login is the
     whole point of the dedicated profile. */
  if (login || firstRun) {
    const ctx = await chromium.launchPersistentContext(PROFILE_DIR, { headless: false });
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto("https://signin.ebay.com/");
    console.log("Sign in to eBay in the window that opened, then close the window.");
    await new Promise((r) => ctx.on("close", r));
  }

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, { headless: !argv.includes("--headed") });
  const page = ctx.pages()[0] || await ctx.newPage();
  let out;
  try {
    out = await scrape(targets, async (url) => {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      } catch (err) {
        return { kind: "error", error: err.message.split("\n")[0] };
      }
      const kind = await pageKind(page);
      const got = kind === "results" ? await page.evaluate(extract) : { rows: [], fewer: 0 };
      return { kind, url: page.url(), rows: got.rows, fewer: got.fewer };
    });
  } finally {
    await ctx.close().catch(() => {});
  }
  if (out.code) process.exit(out.code);
  if (dryRun) { console.log("dry run — nothing written"); return; }
  writeDocs(out.docs);
  console.log(`wrote ${out.docs.size} sales file(s)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
