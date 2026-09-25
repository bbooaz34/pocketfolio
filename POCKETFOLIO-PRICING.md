# Pocketfolio — price architecture

Companion to `POCKETFOLIO-REDESIGN.md`. This section **replaces** the live-API
model described there: `js/api.js` is no longer "do not touch", it is rewritten
against a daily snapshot. Everything else in the redesign doc stands.

---

## 1. Why

Today every user's browser calls the pricing provider directly. That means the
daily quota is split across all users, the key ships in client code, and any
provider hiccup leaves the app with no prices at all. Swapping providers does not
fix this — the architecture does.

**The model: prices are built once a day by CI and committed to the repo as static
JSON.** The app `fetch`es a file from GitHub Pages. No key in the client, no
per-user quota, works from cache offline, and if the provider dies the last good
snapshot is still there. This keeps the zero-backend promise: the job is
build-time, not a server.

---

## 2. Sources

| Role | Source | Notes |
|---|---|---|
| Primary | **PriceCharting** | Grade-level values from monitored eBay sales. API is 1 call/sec; Legendary tier exposes a full CSV regenerated every 24h — use the CSV for the catalog pull, the API only for add-time search. |
| Fallback | **Pokémon Price Tracker** | Existing key. 100 credits/day is plenty when only used to fill gaps PriceCharting missed. |
| Catalog / images | pokemontcg.io + TCGdex | Unchanged. |

PriceCharting's field names do not match their meaning for cards. Map them once,
in one place, and never inline:

```js
export const PC_GRADE_FIELD = {
  raw:    'loose-price',
  '7':    'cib-price',
  '8':    'new-price',
  '9':    'graded-price',
  '9.5':  'box-only-price',
  '10':   'manual-only-price',   // PSA 10
  bgs10:  'bgs-10-price',
  cgc10:  'condition-17-price',
  sgc10:  'condition-18-price',
};
// All values are integer pennies.
```

PriceCharting serves no price history. **Our history is the sequence of our own
snapshots** — which is the whole reason they are committed rather than cached.

`data/history/<cardId>.json` merges two kinds of point into one series, and they
are **not the same quantity**: a provider point is what a card sold for that
day, ours is the aggregate the app displayed. Ours therefore carry `o: 1`:

```json
{ "d": "2026-09-13", "v": 6341 }            // a sale that day
{ "d": "2026-09-23", "v": 4994, "o": 1 }    // what we showed that day
```

Anything comparing two points over time must compare like with like. Reading a
$63.41 sale against a $49.94 ninety-day average produced a 21% weekly fall that
never happened, and put the card at the top of "זזו השבוע" as the week's biggest
loser in a week it did not move.

---

## 3. Repo layout

```
data/
  snapshots/
    2026-09-19.json      ← one per day, immutable once written
    2026-09-18.json
    ...
  latest.json            ← copy of the newest snapshot (what the app loads first)
  index.json             ← { "dates": ["2026-09-19", ...], "oldest": "…", "count": n }
```

Snapshot shape:

```json
{
  "date": "2026-09-19",
  "builtAt": "2026-09-19T04:07:12Z",
  "source": "pricecharting",
  "cards": {
    "base1-4": {
      "pcId": "6910",
      "name": "Charizard",
      "set": "Base Set",
      "number": "4/102",
      "grades": { "raw": 34500, "9": 210000, "10": 1450000 },
      "salesVolume": 128,
      "confidence": "high"
    }
  }
}
```

`confidence`: `high` = PriceCharting hit with sales volume above a floor ·
`low` = hit with thin comps · `fallback` = PPT filled it · `none` = no data, the
card is not in `cards` at all.

**Retention.** Daily for 90 days, then keep the 1st of each month and delete the
rest. Cap the repo at roughly 18 months. A prune step in the same job.

Only cards that appear in at least one portfolio need pricing, but the app is
backendless — CI cannot know what users hold. So the job prices **the intersection
of the TCG catalog and a `data/watchlist.json`** committed to the repo (seeded
with the sets the app supports), and the client falls back to §4 for anything
missing.

---

## 4. Manual values and reconciliation

*(rewritten 19.09.26 — pinning removed)*

A card added today has no snapshot entry until tomorrow's build. The user types a
value; the next snapshot supersedes it **without the user deleting anything**.

Each holding carries:

```js
{
  cardId: 'base1-4',
  grade: '10',
  manualValue: 145000,        // pennies, null if never set
  manualSetAt: '2026-09-19T11:02:00Z',
}
```

There is no `manualPinned`, and no way to make a typed number permanent. A number
that cannot be superseded is a number that goes stale in silence, which is the
one failure this whole model exists to prevent. A stored `manualPinned` from an
older build is ignored and dropped on load. A user who disagrees with the market
number types their own; it holds until the next snapshot covers that card, and
then it yields. If they disagree again, they type it again.

Resolution, in order:

1. a snapshot entry for `cardId` + `grade` **built after `manualSetAt`** →
   snapshot value. The manual value is kept on the record, not erased; it just
   stops being the displayed one.
2. a manual value newer than the snapshot → manual value, marked temporary.
3. a snapshot entry, no manual value ever set → snapshot value.
4. neither → estimate from raw × grade multiplier (existing logic).
5. nothing → the "no data" state.

The method must be visible on the card, because a number whose origin is invisible
is a number the user cannot trust. One line under the value, `.t-text4`,
`--ink-faint`:

| State | Line |
|---|---|
| 1, 3 | the method, named after the field the number actually came from |
| 2 | `מחיר שוק שהזנת · יוחלף בעדכון הבא` |
| 4 | `הערכה משער השוק הגולמי` |
| 5 | `אין נתוני מחיר לקלף הזה` |

The timestamp is **not** in this line: the date chip beside the value already
carries it, and `נכון ל:` here would be the same fact printed twice. For the same
reason there is no `עודכן אוטומטית` chip — the method line already says the
number came from a snapshot.

State 5 renders the value as `— —`. Never `$0`, and never a blank that reads as
zero: a card nobody has priced is not a card worth nothing. Such cards count in
the portfolio's card count, are excluded from the total, and the total's own
method line says how many: `{n} קלפים ללא מחיר`.

The method is named per `metrics[grade].priceField`, because calling a
filtered weighted price a median is exactly the overclaim this line exists to
prevent: `smartMarketPrice` → `מחיר eBay מסונן לדירוג N`, `marketPrice7Day` →
`מחיר eBay ב-7 ימים לדירוג N`, `medianPrice` → `חציון מכירות eBay לדירוג N`.

The number cannot carry its own caveats, so states 1 and 3 append them (see the
19.09 investigation in PRICING-ATTEMPTS.md — the provider's aggregates are not
bounded by the window we ask for):

| Condition | Appended |
|---|---|
| `priceField` is `smartMarketPrice` | `· ממוצע {daysUsed} יום` |
| the grade's spread is wider than 2× | `· מדגם מפוזר` |
| otherwise, `effective` is `medium`/`low` | `· מדגם דל` |
| `lastSaleDate` older than 7 days | `· מכירה אחרונה dd.MM` |
| else `dailyVolume7Day === 0` | `· לא נמכר השבוע` |

The window is not decoration. `smartMarketPrice` is a filtered weighted average
over a window the provider picks per grade — 90 days on Charmander PSA 9, 14 on
PSA 8, 30 on PSA 10 — and it returns both `method` and `daysUsed` saying so. On
a rising card a 90-day average lags structurally: that card sold at $63.41 on
13.09 while the figure read $49.94. Not a wrong number, an answer to a different
question, and the window is what says which question.

The spread and sample caveats are separate because they are different facts:
base1-4 at PSA 9 is three sales between $1,400 and $1,500, none of them recent —
thin, not scattered, and calling it scattered would be its own small overclaim.

The date replaces the vague flag for the same reason. "Did not sell this week"
is equally true of a card that last sold six weeks ago, and tells the owner
nothing; `מכירה אחרונה 11.08` is the same fact in a form they can act on.

A lifetime sales count is never printed beside a date. If it is ever shown it
reads `סה"כ מכירות מאז ומעולם`, never `מכירות אחרונות`.

The manual value is typed in the purchase-details sheet, behind the pencil on
card detail — beside the purchase price and purchase date, which is where the
user's own three numbers belong. Clearing that field is how they hand the card
back to the market price without waiting for a snapshot. Everything in the sheet
is optional: an empty field is "unknown", and `0` is a real answer.

---

## 5. The daily job

`.github/workflows/snapshot.yml`

```yaml
name: price snapshot
on:
  schedule: [{ cron: '0 20 * * *' }]  # 20:00 UTC — see "provider freshness" below
  workflow_dispatch:
permissions:
  contents: write
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: node scripts/build-snapshot.mjs
        env:
          PC_TOKEN:  ${{ secrets.PRICECHARTING_TOKEN }}
          PPT_TOKEN: ${{ secrets.PPT_TOKEN }}
      - run: node scripts/prune-snapshots.mjs
      - uses: stefanzweifel/git-auto-commit-action@v5
        with:
          commit_message: 'prices: snapshot ${{ github.run_id }}'
          file_pattern: 'data/**'
```

`build-snapshot.mjs` must:

- pull the PriceCharting CSV once (not N API calls) and index it by product id;
- fall back to PPT only for watchlist cards the CSV missed, serialized, capped at
  80 calls so the free tier is never exhausted;
- **never write a snapshot that is more than 40% smaller than yesterday's** — abort
  and fail the job instead. A half-empty snapshot is worse than a stale one;
- write `snapshots/<date>.json`, then `latest.json`, then rebuild `index.json`.

### Provider freshness, and why the job runs at 20:00 (measured 22-23.09.26)

The provider refreshes a card's market data **per card, on no fixed schedule**,
and our snapshot can only ever be as fresh as its last refresh. That fact is
stored per grade as `metrics[grade].marketUpdatedAt`, whole, not truncated to
the date — the hour is the measurement.

What 17 cards over two days showed:

- **Refreshes land at every hour of the clock** — 02, 07, 07, 07, 09, 11, 12,
  12, 15, 16, 16, 17, 18, 19, 20, 21, 22 UTC. There is no nightly batch to run
  after. An earlier reading of a single 18:38 timestamp suggested one; it was a
  coincidence, and a cron was moved on it before the full timestamps existed.
- **Later in the day is strictly better anyway.** On 23.09 five cards refreshed
  between 07:07 and 16:04. A 20:00 build has all five; the old 04:00 build would
  have carried the previous day's numbers for every one of them. That is the
  whole justification — 20:00 stays four hours clear of midnight UTC because
  GitHub runs cron late, sometimes by hours, and a delay that size must not push
  the run onto the next date.
- **Six of seventeen refreshed in 26 hours.** The rest sat still, and four cards
  are persistently stale: The Boss's Way 8 days, Bulbasaur 7, Charmander and
  Togepi 6.
- **It is not about how traded a card is.** Base Set Charizard, the most traded
  card on the list, went a day without a refresh while an anonymous Misty's
  Tears refreshed the same afternoon. The mechanism is unknown; only the lag is
  established.

The consequence for the UI is the rule in §4: a price is reported with the
window it averaged and the date it last sold, because on a card the provider
has not looked at for a week neither is implied by the number.

**One correction to the above, measured 25.09.26:** `marketUpdatedAt` is a
**card-level** timestamp, not a per-grade one. All 38 grade buckets on base1-4
carried the identical value down to the millisecond, equal to the card's
`ebay.lastScrapedDate`. The measurements above count cards, so they stand — but
the field never says anything about an individual grade.

### The provider samples eBay, it does not index it (measured 25.09.26)

A refresh is not coverage. On 25.09 the provider had scraped base1-4 that
morning (10:17) with a window running to 24.09 and 411 sales on file — and
across **all 38 grade buckets** it held exactly three dated sale points from
18.09 onward: psa7 $499.99 on 21.09, psa7 $1,111 on 24.09, and one ungraded on
21.09. Three sales in a week, on the most traded card in vintage Pokémon.
Three real PSA 1 sales the owner found on eBay the same weekend ($400, $332.89,
$380) appear in no bucket at all.

The clinching number is `psa10: count=1, lastSaleDate=2025-10-30` — one PSA 10
Base Set Charizard sale in the provider's entire history of the card. That is
not a description of the market; it is a description of what its crawler
happened to catch.

So: **`lastSaleDate` is the last sale the provider ingested, never the last
sale that happened**, and `count` is a sample size, not a volume. Two rules
follow, and both are already how we behave — they now have evidence behind
them rather than caution:

- Never present a provider price as "the market price". §4's labelling (window
  averaged + date last sold) is the minimum honest framing.
- Never infer "no sales this week" from `dailyVolume7Day: 0`. It means the
  provider caught none, which on this evidence is the usual case.

A related gap: the aggregate and the dated series are not the same set. PSA 1
reports `count: 6` totalling $1,890.04 while the series holds five dated points
totalling $1,590.09 — a sixth sale of $299.95 exists in the aggregate with no
date anywhere. `smartMarketPrice` cannot be reconstructed from the series.

---

## 6. Client

```js
// js/api.js — rewritten
const BASE = 'data';
export async function loadSnapshot(date /* optional */) {
  const file = date ? `${BASE}/snapshots/${date}.json` : `${BASE}/latest.json`;
  const res = await fetch(file, { cache: 'no-cache' });
  if (!res.ok) throw new Error('snapshot unavailable');
  return res.json();
}
export async function loadIndex() {
  return (await fetch(`${BASE}/index.json`, { cache: 'no-cache' })).json();
}
```

Cache `latest.json` in localStorage under `pf:snapshot:<date>` so a cold offline
start still renders. The stale banner from the redesign doc keeps its design and
changes its trigger: **`builtAt` older than 48h**, copy unchanged
(`הנתונים אינם מתעדכנים כרגע` / `מוצגים הערכים האחרונים שנשמרו.`), and its link
now points at the repo's Actions page rather than at Settings.

The trend chart on card detail and the daily-change block both read from the
snapshot series, not from a provider: load the last N `index.json` dates, fetch
those snapshots, read one card out of each. Cache aggressively — snapshots are
immutable.

---

## 7. Date label and carousel (home)

The `היום dd.MM.yy` label above the value card becomes **the snapshot indicator**,
and `שינוי תאריך` next to it opens the history.

- Label reads the loaded snapshot's `date`. Today → `היום dd.MM.yy`. Any other →
  `dd.MM.yy` in `--primary`, per the Leumi rule that a historical date is blue.
- `שינוי תאריך` opens a **horizontal date carousel** below the header: day chips,
  RTL, newest on the right, scrolled to the selected one. Only dates present in
  `index.json` are chips; there are no gaps to skip because the job runs daily,
  but a missing date is simply absent from the strip rather than disabled.
- Chip: 56 × 64, `--radius-sm`, `--surface`. Weekday `.t-text4 --ink-faint` over
  day-of-month `.t-text1-m`. Selected: `--primary` fill, white text. Today's chip
  carries a 4px `--primary` dot when not selected.
- Picking a date re-resolves **every value on the screen** from that snapshot:
  portfolio total, both change blocks, every holding card. Change blocks compare
  that snapshot to the one before it, not to today.
- In a past snapshot the app is read-only: `הוספה`, `מכירה` and `עדכון מחירים`
  go `--ink-faint` and inert, and a `--surface-muted` strip sits under the header:
  `צפייה בנתונים מ-dd.MM.yy · חזרה להיום`. Editing a portfolio while looking at
  last month's prices is the kind of thing that produces a support ticket.
- Holdings bought after the selected date are hidden, not shown at zero.
- Manual values follow §4 against that snapshot's `builtAt` — so a past view shows
  the manual value that was actually in force then.

---

## 8. Settings changes

Remove `מפתח API` and `שאילתות היום 34 מתוך 100` entirely — there is no client key
and no per-user quota. In their place, under `מקור המחיר`:

```
עודכן לאחרונה: 19.09 בשעה 04:00
המחירים נבנים פעם ביום ונשמרים באפליקציה. אין צורך בחשבון או במפתח.
```

The numbered source list stays as designed, with `פעיל` on whichever source
produced the majority of the current snapshot.

---

## 9. Before building: validate the provider

`pricecharting-probe.mjs` (shipped alongside this doc) answers, against a real
token: does `q=` resolve actual holdings, is the graded ladder populated on modern
cards as well as vintage, does a nonexistent card error cleanly rather than
returning a wrong match, does the rate limit bite, and is `sales-volume` present.

```
node pricecharting-probe.mjs <API_TOKEN>
```

Two results would change the plan: if `q=` is noisy, the PriceCharting id must be
stored on the holding at add-time and never re-searched by name; if the graded
ladder is sparse on modern cards, PPT becomes the primary for graded and
PriceCharting is relegated to raw.
