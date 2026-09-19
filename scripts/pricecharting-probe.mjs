#!/usr/bin/env node
/**
 * PriceCharting probe for Pocketfolio.
 *
 *   node pricecharting-probe.mjs <API_TOKEN>
 *
 * Answers, with real data, the questions we need before committing:
 *   1. Does full-text search (q=) resolve real holdings to the right product?
 *   2. Is the grade ladder populated, and does the odd field naming hold?
 *      loose-price = raw · new-price = 8/8.5 · graded-price = 9
 *      manual-only-price = PSA 10 · box-only-price = 9.5 · cib-price = 7/7.5
 *      condition-17 = CGC 10 · condition-18 = SGC 10 · bgs-10 = BGS 10
 *   3. How does it behave on a card that does not exist (error shape)?
 *   4. Latency, and does the 1-call-per-second limit actually bite?
 *   5. Is sales-volume present (a proxy for how thin the comp pool is)?
 *
 * No dependencies. Node 18+.
 */

const TOKEN = process.argv[2];
if (!TOKEN) { console.error('usage: node pricecharting-probe.mjs <API_TOKEN>'); process.exit(1); }

const BASE = 'https://www.pricecharting.com/api';

// Representative of a real portfolio: vintage holo, modern chase, sealed-era
// staple, a Japanese card, and a deliberate miss.
const QUERIES = [
  'charizard base set 4/102 pokemon',
  'pikachu illustrator pokemon',
  'umbreon vmax alt art evolving skies pokemon',
  'lugia neo genesis 9/111 pokemon',
  'charizard upc 2022 pokemon',
  'mewtwo ex 151 pokemon',
  'zzzz not a real card 999/999',
];

// PriceCharting's card grade ladder, in the order we show it.
const LADDER = [
  ['raw',      'loose-price'],
  ['PSA 7',    'cib-price'],
  ['PSA 8',    'new-price'],
  ['PSA 9',    'graded-price'],
  ['PSA 9.5',  'box-only-price'],
  ['PSA 10',   'manual-only-price'],
  ['BGS 10',   'bgs-10-price'],
  ['CGC 10',   'condition-17-price'],
  ['SGC 10',   'condition-18-price'],
];

const money = (pennies) =>
  (pennies === undefined || pennies === null || pennies === '') ? '—'
  : '$' + (Number(pennies) / 100).toFixed(2);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function get(path, params) {
  const url = new URL(BASE + path);
  url.searchParams.set('t', TOKEN);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const t0 = Date.now();
  const res = await fetch(url);
  const ms = Date.now() - t0;
  let body;
  try { body = await res.json(); } catch { body = { status: 'error', 'error-message': 'non-JSON response' }; }
  return { http: res.status, ms, body };
}

async function probeQueries() {
  console.log('\n=== 1. LOOKUP + GRADE LADDER ===\n');
  const timings = [];
  for (const q of QUERIES) {
    const { http, ms, body } = await get('/product', { q });
    timings.push(ms);
    if (body.status !== 'success') {
      console.log(`✗ "${q}"\n   HTTP ${http} · ${ms}ms · ${body['error-message'] ?? 'no message'}\n`);
      await sleep(1100);
      continue;
    }
    const filled = LADDER.filter(([, k]) => body[k]).length;
    console.log(`✓ "${q}"  →  ${body['product-name']} · ${body['console-name']} · id ${body.id}  (${ms}ms)`);
    console.log('   ' + LADDER.map(([label, k]) => `${label} ${money(body[k])}`).join(' · '));
    console.log(`   grades populated: ${filled}/${LADDER.length} · sales-volume: ${body['sales-volume'] ?? '—'} · release ${body['release-date'] ?? '—'}\n`);
    await sleep(1100); // respect 1 req/sec
  }
  timings.sort((a, b) => a - b);
  console.log(`latency: min ${timings[0]}ms · median ${timings[Math.floor(timings.length / 2)]}ms · max ${timings.at(-1)}ms`);
}

async function probeAmbiguity() {
  console.log('\n=== 2. AMBIGUITY (does /products return a sane candidate list?) ===\n');
  const { body } = await get('/products', { q: 'charizard' });
  if (body.status !== 'success') { console.log('✗ ' + body['error-message']); return; }
  console.log(`${body.products.length} candidates for a bare "charizard":`);
  for (const p of body.products.slice(0, 10)) console.log(`   ${p.id}  ${p['product-name']}  ·  ${p['console-name']}`);
  console.log('\n→ If this list is noisy, the app must store the PriceCharting id on the holding');
  console.log('  at add-time and never re-search by name afterwards.');
  await sleep(1100);
}

async function probeRateLimit() {
  console.log('\n=== 3. RATE LIMIT (5 calls, no delay — expect throttling) ===\n');
  const ids = ['6910', '6910', '6910', '6910', '6910'];
  const results = await Promise.all(ids.map(id => get('/product', { id })));
  results.forEach((r, i) => console.log(`   call ${i + 1}: HTTP ${r.http} · ${r.ms}ms · ${r.body.status}${r.body['error-message'] ? ' · ' + r.body['error-message'] : ''}`));
  console.log('\n→ Any non-200 here means the snapshot job MUST serialize with ~1.1s between calls.');
  console.log('  For a catalog-wide pull, use the Legendary CSV download instead (1 file/day).');
}

async function probeStability() {
  console.log('\n=== 4. STABILITY (same query twice — is the id stable?) ===\n');
  const a = await get('/product', { q: 'charizard base set 4/102 pokemon' });
  await sleep(1100);
  const b = await get('/product', { q: 'charizard base set 4/102 pokemon' });
  const same = a.body.id === b.body.id;
  console.log(`   ${same ? '✓' : '✗'} id ${a.body.id} vs ${b.body.id}`);
  console.log(`   PSA 10: ${money(a.body['manual-only-price'])} vs ${money(b.body['manual-only-price'])}`);
}

await probeQueries();
await probeAmbiguity();
await probeRateLimit();
await probeStability();

console.log(`
=== WHAT TO LOOK FOR ===
· Every real card resolved to the right product        → search is usable at add-time
· PSA 10 / 9 populated on most cards                   → the graded ladder is real, not sparse
· Modern chase cards populated                         → coverage is not vintage-only
· The fake card returned a clean error, not a wrong hit → we can detect "no data"
· sales-volume present                                 → we can warn on thin comps
`);
