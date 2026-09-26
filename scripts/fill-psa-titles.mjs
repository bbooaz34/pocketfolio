#!/usr/bin/env node
/**
 * Fill `psaTitle` in data/watchlist.json from each card's PSA cert page
 * (TASK-ebay-direct.md §0). Runs on the owner's Mac, in the same dedicated
 * browser profile as the eBay scraper — psacard.com has no open API and no
 * CORS, and it is not reachable from CI.
 *
 *   node scripts/fill-psa-titles.mjs            # fill every graded card that has a cert and no title
 *   node scripts/fill-psa-titles.mjs --dry-run  # print what would be written
 *
 * The title is PSA's own label text, read field by field from the cert page:
 * year, brand/title, card number, subject, variety — the order the slab
 * prints them. That reproduces the two titles copied by hand exactly
 * ("1999 POKEMON JAPANESE GOLD, SILVER, TO A NEW WORLD... TOGEPI"). It is
 * never built from our own card names.
 *
 * A title already in the watchlist is never overwritten. A page whose cert
 * number or grade disagrees with the watchlist is not used. A bot check stops
 * the run; it is not worked around.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PROFILE_DIR, gradedGrades } from "./scrape-ebay-sold.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WATCHLIST = join(ROOT, "data", "watchlist.json");

/* the same labels js/api.js reads */
const LABELS = [
  "Certification Number", "Cert Number", "Label Type",
  "Reverse Cert Number/Barcode", "Reverse Cert Number", "Year",
  "Brand/Title", "Brand", "Subject", "Category", "Card Number",
  "Variety/Pedigree", "Item Grade", "Autograph Grade", "Grade",
];

/** The cert page's visible text → its labelled fields. */
export function parseCertText(text) {
  const lines = String(text).split(/\n+/).map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
  const labelOf = (line) => {
    const low = line.toLowerCase();
    return LABELS.find((l) => low === l.toLowerCase() ||
      low.startsWith(l.toLowerCase() + " ") || low.startsWith(l.toLowerCase() + ":"));
  };
  const f = {};
  for (let i = 0; i < lines.length; i++) {
    const label = labelOf(lines[i]);
    if (!label || f[label] != null) continue;
    let value = lines[i].slice(label.length).replace(/^[:\s]+/, "").trim();
    if (!value && lines[i + 1] && !labelOf(lines[i + 1])) value = lines[i + 1];
    if (value) f[label] = value;
  }
  const gradeText = f["Item Grade"] || f["Grade"] || null;
  return {
    cert: (f["Certification Number"] || f["Cert Number"] || "").replace(/\D/g, "") || null,
    year: f["Year"] || null,
    brand: f["Brand/Title"] || f["Brand"] || null,
    cardNumber: f["Card Number"] || null,
    subject: f["Subject"] || null,
    variety: f["Variety/Pedigree"] || null,
    grade: gradeText ? (gradeText.match(/\b(10|[1-9])(?:\.5)?\b/) || [])[1] || null : null,
  };
}

/** The label title, as the slab prints it — the same rule as API.psaTitleOf. */
export function titleOf(info) {
  if (!info?.subject) return null;
  return [info.year, info.brand, info.cardNumber ? "#" + info.cardNumber : null, info.subject, info.variety]
    .filter(Boolean).join(" ").replace(/\s+/g, " ").trim() || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main(argv) {
  const dryRun = argv.includes("--dry-run");
  const doc = JSON.parse(readFileSync(WATCHLIST, "utf8"));
  const todo = doc.cards.filter((c) => gradedGrades(c).length && c.cert && !c.psaTitle);
  if (!todo.length) { console.log("every graded card with a cert already has a psaTitle"); return; }

  let chromium;
  try { ({ chromium } = await import("playwright")); }
  catch { console.error("playwright is not installed — run `npm install` in the repo first"); process.exit(1); }
  mkdirSync(PROFILE_DIR, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, { headless: !argv.includes("--headed") });
  const page = ctx.pages()[0] || await ctx.newPage();

  let filled = 0;
  try {
    for (let i = 0; i < todo.length; i++) {
      const card = todo[i];
      if (i > 0) await sleep(3000 + Math.random() * 3000);
      const url = `https://www.psacard.com/cert/${encodeURIComponent(card.cert)}`;
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
        await page.waitForTimeout(2000); // the fields render after load
      } catch (err) {
        console.log(`  ${card.id}: cert page did not load (${err.message.split("\n")[0]})`);
        continue;
      }
      /* Cloudflare's "Just a moment..." clears by itself in a real browser
         after a few seconds. Wait for it — never try to get past it. */
      const CHALLENGE = /just a moment|attention required|access denied|captcha/i;
      let title = await page.title().catch(() => "");
      for (let waited = 0; CHALLENGE.test(title) && waited < 45000; waited += 1500) {
        await page.waitForTimeout(1500);
        title = await page.title().catch(() => "");
      }
      if (!CHALLENGE.test(title)) await page.waitForTimeout(1500);
      if (CHALLENGE.test(title)) {
        console.error(`STOP: psacard.com is showing a bot check (${title}). Run again with --headed, or copy the titles by hand.`);
        break;
      }
      const info = parseCertText(await page.evaluate(() => document.body.innerText));
      const t = titleOf(info);
      if (!t) { console.log(`  ${card.id}: cert ${card.cert} — no subject on the page, left empty`); continue; }
      if (info.cert && info.cert !== String(card.cert)) {
        console.log(`  ${card.id}: page is cert ${info.cert}, watchlist says ${card.cert} — not used`);
        continue;
      }
      if (info.grade && !gradedGrades(card).includes(info.grade)) {
        console.log(`  ${card.id}: cert ${card.cert} is PSA ${info.grade}, watchlist grades ${gradedGrades(card)} — not used`);
        continue;
      }
      console.log(`  ${card.id}: ${t}`);
      card.psaTitle = t;
      filled++;
    }
  } finally {
    await ctx.close().catch(() => {});
  }
  if (!filled) { console.log("no titles filled"); return; }
  if (dryRun) { console.log(`dry run — ${filled} title(s) not written`); return; }
  writeFileSync(WATCHLIST, JSON.stringify(doc, null, 2) + "\n");
  console.log(`wrote ${filled} psaTitle(s) to data/watchlist.json`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
