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

A card added today has no snapshot entry until tomorrow's build. The user types a
value; the next snapshot supersedes it **without the user deleting anything**.

Each holding carries:

```js
{
  cardId: 'base1-4',
  grade: '10',
  manualValue: 145000,        // pennies, null if never set
  manualSetAt: '2026-09-19T11:02:00Z',
  manualPinned: false,        // true = user insists on their own number
}
```

Resolution, in order:

1. `manualPinned === true` → manual value. Always.
2. A snapshot entry for `cardId` + `grade` **built after `manualSetAt`** → snapshot
   value. The manual value is kept on the record, not erased; it just stops being
   the displayed one.
3. A manual value with no newer snapshot → manual value.
4. Neither → estimate from raw × grade multiplier (existing logic).
5. Nothing → the "no data" state.

The method must be visible on the card, because a number whose origin is invisible
is a number the user cannot trust. One line under the value, `.t-text4`,
`--ink-faint`:

| Case | Line |
|---|---|
| 2 | `נכון ל: 19.09 · ` + the method, named after the field the number actually came from |
| 2, just superseded a manual value | same line + a `--primary-soft` chip `עודכן אוטומטית` for 24h |
| 1 | `שווי שהזנת ידנית · נעוץ` + an unpin affordance |
| 3 | `שווי שהזנת ידנית · יוחלף בעדכון הבא` |
| 4 | `הערכה משער השוק הגולמי` |
| 5 | `אין נתוני מחיר לקלף הזה` |

The method is named per `metrics[grade].priceField`, because calling a
filtered weighted price a median is exactly the overclaim this line exists to
prevent: `smartMarketPrice` → `מחיר eBay מסונן לדירוג N`, `marketPrice7Day` →
`מחיר eBay ב-7 ימים לדירוג N`, `medianPrice` → `חציון מכירות eBay לדירוג N`.

Two caveats append to case 2, because the number cannot carry them itself
(see the 19.09 investigation in PRICING-ATTEMPTS.md — the provider's
aggregates are not bounded by the window we ask for):

| Condition | Appended |
|---|---|
| the grade's spread is wider than 2× | `· מדגם מפוזר` |
| otherwise, `effective` is `medium`/`low` | `· מדגם דל` |
| `dailyVolume7Day === 0` | `· לא נמכר השבוע` |

The first two are separate because they are different facts: base1-4 at PSA 9
is three sales between $1,400 and $1,500, none of them recent — thin, not
scattered, and calling it scattered would be its own small overclaim.

A lifetime sales count is never printed beside a date. If it is ever shown it
reads `סה"כ מכירות מאז ומעולם`, never `מכירות אחרונות`.

Pinning belongs on the card detail screen, next to the pencil the user already has
there — not in Settings. Default is unpinned: the common case is "I know roughly
what it's worth, fix it for me later".

---

## 5. The daily job

`.github/workflows/snapshot.yml`

```yaml
name: price snapshot
on:
  schedule: [{ cron: '0 4 * * *' }]   # 04:00 UTC
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
