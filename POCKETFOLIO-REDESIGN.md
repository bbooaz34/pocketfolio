# Pocketfolio — redesign brief for Claude Code

Redesign the live app at <https://bbooaz34.github.io/pocketfolio/> (repo `bbooaz34/pocketfolio`) to match the approved mobile mockup and its design system. This is a **visual and structural redesign, not a rewrite**: keep the data layer, the price logic and the zero-backend model exactly as they are.

## 1. Sources of truth (read in this order)

1. **Design system** — <https://claude.ai/artifact/NSsE7AcDFFrv5pAxJ53zE4>. Read `project/README.md` first, then `project/tokens.json`. Every colour, size, radius and shadow below comes from there. If this file and the design system disagree, the design system wins.
2. **Mockup canvas** — <https://claude.ai/artifact/WSMpjbKoXigwaYghfbML66>. Eight artboards, 390 × 844, RTL Hebrew. Each artboard is a self-contained `.dc.html` you can read for exact markup and inline values:
   - `Main.dc.html` — home (portfolio value, actions, graded cards, cross-world banner)
   - `HomeScroll.dc.html` — home continued (movers, news, budget)
   - `Collection.dc.html` — holdings list with world tabs
   - `CardDetail.dc.html` — drill-down for one holding
   - `AddCard.dc.html` — add form
   - `Settings.dc.html` — price source, API key, display toggles, export/import
   - `Empty.dc.html` — stale-data banner, empty portfolio
   - `System.dc.html` — token/component mapping board (reference only)
3. **This document** — the mapping between the two and the current code.

## 2. What must not change

The app is vanilla HTML/CSS/JS, four scripts, no bundler, no framework, no server. Keep it that way.

| File | Role | Redesign impact |
| --- | --- | --- |
| `js/store.js` | localStorage persistence (`getAll`, `upsert`, `remove`, `setValueOverride`, `recordSnapshot`, `getSnapshots`, `clearAll`) | **Do not touch.** |
| `js/api.js` | Pokémon TCG API + TCGdex search/pricing, Pokémon Price Tracker graded median, PSA cert lookup, caching and backoff | **Do not touch** the logic. You may add a `lastUpdated` read if the UI needs it. |
| `js/charts.js` | SVG trend line and allocation chart | Restyle only: colours from tokens, line width 2.2px, area fill `primary` at 7 %. Keep the drawing code. |
| `js/app.js` | rendering, formatters, search UI, cert flow, refresh | Rendering functions change; formatters (`fmtUSD`, `fmtPct`, `deltaClass`, `gradeLabel`) stay. Every `id` the JS queries must still exist in the new markup or be remapped in one place. |
| `css/styles.css` | current look | Rewrite. |
| `index.html` | single page | Restructure (see §4). |

Value hierarchy is unchanged: manual override → eBay sold median for the grade (PPT key) → estimate from raw market × grade multiplier. Surface it in Settings as the numbered list in `Settings.dc.html`.

## 3. Tokens — replace `:root` in `styles.css`

Rename the existing variables to the design-system names. There is **one theme (light)**; remove the `prefers-color-scheme: dark` block and the dark `data-theme`.

```css
:root {
  /* surfaces */
  --screen: #F8FAFC;          /* was --page */
  --surface: #FFFFFF;
  --surface-muted: #ECEFF3;   /* chips, dividers, zero pill, search fill */
  --border: #D8DFE7;          /* inputs only; cards never have a border */

  /* text */
  --ink: #1D1D20;             /* was --text-primary */
  --ink-muted: #595959;       /* was --text-secondary */
  --ink-secondary: #64748B;
  --ink-faint: #8C8C8C;       /* was --text-muted; timestamps, notes, 12px min */
  --navy: #070762;            /* wordmark only */

  /* graded world */
  --primary: #0066FF;         /* was --accent */
  --primary-dark: #093DB5;    /* text on primary-soft */
  --primary-soft: #E7F1FF;    /* PSA tag fill, selected pill */
  --primary-border: #DBEAFE;
  --primary-tint: #F3F8FF;
  --button-gradient: linear-gradient(135deg, #6EA6FD 0%, #126CF9 100%);

  /* singles & sealed world */
  --lime: #DBFF00;
  --lime-soft: #F4FFC2;
  --lime-ink: #4A5200;

  /* change */
  --positive-bg: #E6F9F3;  --positive-ink: #028862;   /* was --up */
  --negative-bg: #F8E9F0;  --negative-ink: #E8437F;   /* was --down — pink, not red */
  --error: #C60A15;                                     /* system errors only */

  /* shape */
  --radius-tag: 4px; --radius-sm: 8px; --radius-control: 12px;
  --radius-card: 16px; --radius-pill: 100px;
  --shadow-active: 3px 5px 16px rgba(186,202,221,0.35);   /* the only card shadow */
  --shadow-screen: 0 4px 20px rgba(0,0,0,0.15);           /* sheets and modals */

  /* space */
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-5: 20px;
}
```

### Typography

Family: `"SimplerPro_Leumi_H", "Heebo", system-ui, sans-serif`. SimplerPro is a licensed face — do not fetch it; if the font files are added later they go in `fonts/` with an `@font-face`. Load Heebo 400/500/700 from Google Fonts as the fallback.

**Emphasis is Medium (500), not Bold.** Bold (700) is used in exactly two places: 12 px tags/chips and bottom-nav labels.

| Class | Size / line / weight | Use |
| --- | --- | --- |
| `.t-text0` | 42 / 46 / 500, letter-spacing −0.4px | portfolio value only |
| `.t-h3` | 20 / 22 / 500 | screen title |
| `.t-subtitle` | 18 / 24 / 500 | holding value, section header “קלפים מדורגים (3)” |
| `.t-text1-m` | 16 / 21 / 500 | card name, amounts in cards, buttons |
| `.t-text1` | 16 / 21 / 400 | settings rows, form text |
| `.t-text2-m` / `.t-text2` | 14 / 16 / 500 or 400 | labels: שווי, שער אחרון, nav |
| `.t-text4` | 12 / 21 / 400 | נכון ל:, account note, price source |
| `.t-chip` | 12 / 16 / 700 | PSA tag, Raw tag, status pill |

Numbers use the same family. Add `font-variant-numeric: tabular-nums` on any element that holds a figure.

## 4. Page structure

The mockup is **Hebrew, RTL**. Implement it that way: `<html lang="he" dir="rtl">`, all copy from §7, logical CSS properties (`margin-inline-start`, `padding-inline`, `inset-inline`) so a later LTR/English switch is a one-attribute change. Keep an `i18n` object with the Hebrew strings as the default so English can be added without touching markup.

Mobile-first, max content width 390 px behaves as the design; at ≥ 768 px centre the column at 480 px max and keep the bottom nav (do not invent a desktop layout).

The app stays a single `index.html`. Views are `<section data-view>` blocks toggled by a hash router (`#home`, `#holdings`, `#market`, `#settings`, `#card/<slot>`, `#add`). The bottom nav sets the hash. This replaces the current single scrolling dashboard.

### 4.1 Home (`Main.dc.html` + `HomeScroll.dc.html`)

Top to bottom, on `--screen`:

1. **Header** (`--surface`): title “התיק שלי” `.t-h3` with a `--primary` chevron (portfolio switcher — render it, wire it to nothing yet), search and settings icon buttons 44 × 44. Under it the note `.t-text4 --ink-faint`: “לתשומת ליבך, הנתונים נשמרים במכשיר שלך בלבד”.
2. **Date chip**: 30 px pill, `--surface-muted`, `--ink-muted`, “היום 17.09.26” (today's date, `dd.MM.yy`). A “שינוי תאריך” text button in `--primary` beside it (render, no behaviour yet). *Rule: the date lives here; the “נכון ל:” line shows time only.*
3. **Portfolio value card** — see §5.1. Binds `kpi-total`, `kpi-total-note`, `kpi-pl`, `kpi-pl-pct`.
4. **Round actions**: three 52 px circles with a `.t-text2` label under each — “הוספה” (`--primary`, plus), “מכירה” (`--primary`, minus), “עדכון מחירים” (`--primary-soft` fill, `--primary-border` 1px, refresh icon, calls `refresh()`). Centred, 22 px gap.
5. **Section header** `.t-subtitle` “קלפים מדורגים (N)” with “לכל האחזקות” link (`--primary`, `.t-text2-m`) → `#holdings`.
6. Two **Holding cards** (§5.2), the top two by value. Tapping opens `#card/<slot>`.
7. **Cross-world banner** (§5.5) — once per screen, no more.
8. **Movers**: two cards side by side, “הכי עולה” / “הכי יורדת”, name `.t-text1-m`, value, change pill.
9. **News** “חדשות על האחזקות שלי”: two article cards, 64 px thumbnail, title `.t-text2-m` two lines, source · time `.t-text4`. There is no news feed in the app: render the section with an empty state “אין חדשות חדשות” until a source exists. Do not fake articles.
10. **Budget card** “יתרות ותקרות”: cost basis (`kpi-cost`), monthly budget with a 6 px progress bar. Budget is a new value in `localStorage` (`pocketfolio.budget`, number, default null → hide the bar and show “הגדרת תקציב” link).
11. **Bottom nav** (§5.6).

### 4.2 Holdings (`Collection.dc.html`)

Header with title “האחזקות שלי”, search field 44 px (`--surface-muted` fill, `--radius-control`, placeholder “חיפוש לפי שם קלף, סט או מספר תעודה”), three underline tabs “הכול / מדורגים / גולמיים” (2 px `--primary` underline, `.t-text1-m` selected, `--ink-muted` otherwise). Body: “קלפים מדורגים (N)” with a sort pill “שווי ↓”, holding cards, then “סינגלים (N)”. Raw cards get the `Raw` tag in `--lime-soft`/`--lime-ink`. This view replaces `#holdings-table`; keep `holdings-body` as the container the JS fills.

### 4.3 Card detail (`CardDetail.dc.html`)

Header: back chevron (→ `#holdings`), name `.t-subtitle` + set · number `.t-text4`, and a **pencil icon button** (`--primary`, aria-label “עדכון שווי ידני”) that opens the manual value input inline. Body:

- **Holding value card**: label “שווי האחזקה” + PSA tag, value `30/500` + “· N יח׳”, “נכון ל: HH:MM · חציון מכירות eBay לדירוג 10”, date chip, and the **card image at the top-left corner, 82 × 114, `--radius-sm`, tinted shadow** — as a flex sibling of the text block, not absolutely positioned. Below a 1 px `--surface-muted` divider: two Change blocks (§5.3), “שינוי יומי” and “שינוי מקנייה”.
- **Trend card**: “מגמה” + range pills (1ח / 3ח / שנה / הכול), chart 96 px high from `charts.js` using snapshots.
- **Details card**: three rows — עלות רכישה ליחידה, שער השוק הגולמי, מספר תעודת PSA (link to `psacard.com/cert/<n>`).
- No bottom CTA bar.

### 4.4 Add (`AddCard.dc.html`)

Title “הוספת אחזקה”, close → back. Search field with `--primary` border, results list (selected result gets a `--primary` 1 px border; keep `renderResults`/`selectCard`), grade pills (“PSA 10 / 9 / 8 / 7 / גולמי”, 42 px, selected = `--primary` fill), “מחיר קנייה ליחידה” with `$` prefix, “כמות” stepper 48 px, “מספר תעודת PSA · לא חובה”, estimated value card, sticky CTA “הוספה לתיק” (50 px, `--button-gradient`, white `.t-text1-m`). Wire to the existing `add-form` submit.

### 4.5 Settings (`Settings.dc.html`)

Sections `.t-subtitle`: “מקור המחיר” (numbered list, “פעיל” pill on the live source), “מפתח API” (input on `--surface-muted`, “שאילתות היום 34 מתוך 100” with a 6 px `--primary` progress bar — use the existing PPT credit tracking if exposed, otherwise count calls per day in localStorage), “תצוגה” (refresh-on-open, hide values, currency USD), Export/Import outlined buttons (`--primary` 1 px), and the note “אין חשבון ואין שרת. התיק נשמר בדפדפן של המכשיר בלבד.” Move `menu-api-key`, `menu-proxy`, `menu-test-api`, `menu-clear` here; the topbar gear menu goes away.

### 4.6 Edge cases (`Empty.dc.html`)

- **Stale data banner** (replaces `#banner`): `--surface`, `--radius-sm`, 4 px `--error` bar on the inline-start edge, title `.t-text2-m` “הנתונים אינם מתעדכנים כרגע”, body “מוצגים הערכים האחרונים שנשמרו.” + link “בדיקת מפתח ה-API” → `#settings`.
- **Unavailable value**: “— —” in `--ink-faint`, zero pill 0.0 % grey, “הנתונים אינם זמינים”.
- **Empty portfolio** (replaces `#empty-state`): three stacked card silhouettes, “טרם בוצעה פעילות בתיק”, one paragraph, gradient CTA “הוספת קלף ראשון” → `#add`, text link “ייבוא תיק שמור” → `#settings`. Keep `demo-btn` as a tertiary text link if you keep the demo.

## 5. Components (exact specs)

All cards: `--surface`, `--radius-card`, `--shadow-active`, padding `--space-4`, **no border**.

### 5.1 Portfolio value card
Label `.t-text2 --ink-muted` “שווי התיק” → value `.t-text0` (decimals same size) → `.t-text4 --ink-faint` “נכון ל: HH:MM · חציון מכירות eBay” → divider → two Change blocks.

### 5.2 Holding card (`components/HoldingCard`)
Row 1: thumbnail 26 × 34 `--radius-tag` (card image, `object-fit: cover`; fall back to a flat tint), name `.t-text1-m`, tag (PSA n → `--primary-soft`/`--primary-dark`; Raw → `--lime-soft`/`--lime-ink`), set · number `.t-text4` pushed to the end.
Row 2: “שווי: **$1,847** · 1 יח׳” (`.t-text2` label, `.t-text1-m` amount) and the “שינוי מקנייה” pill on the opposite side.
Row 3 (optional): “שער אחרון $1,847” / “שינוי מקנייה” in `.t-text2 --ink-muted`.
The whole card is an `<a>`; nothing clickable inside it.

### 5.3 Change block (`components/ChangeBlock`)
Label `.t-text2 --ink-muted` → row of [pill, amount]. Pill 24 px, `--radius-pill`, `.t-text2-m`, **percentage without sign**: positive `--positive-bg/--positive-ink`, negative `--negative-bg/--negative-ink`, zero `--surface-muted/--ink-muted`. Amount `.t-text2-m` **always `--ink`**. **No arrows.** Zero is neither gain nor loss. Reuse `deltaClass`; change its three class names to `is-up`, `is-down`, `is-flat`.

### 5.4 Tags and chips
Tag 22 px, `--radius-tag`, `.t-chip`. Date chip 30 px pill. Range pills 30 px, selected `--primary-soft` + `--primary` text. Status pill “פעיל” 24 px `--positive-bg/--positive-ink`.

### 5.5 Cross-world banner
Card with a 6 × 40 px `--lime` bar at the inline-start, title `.t-text2-m` “רוצה להוסיף סינגלים או סילד לתיק?”, link `.t-text2-m --primary` “להוספת סינגל” → `#add`, chevron icon. Exactly one per screen.

### 5.6 Bottom nav
72 px, `--surface`, 1 px `--surface-muted` top border, four items: בית, אחזקות, שוק, הגדרות. Icons 22 px stroke 1.9. Active = filled icon + `.t-chip`-weight label in `--primary`; inactive = outline icon + `.t-text2` in `--ink-muted`. `aria-current="page"` on the active item.

### 5.7 Buttons
- Primary CTA: 50 px, `--radius-control`, `--button-gradient`, white `.t-text1-m`. Only one per screen.
- Outlined: 48 px, 1 px `--primary` border, `--primary` text.
- Round action: 52 px circle, label below.
- Icon button: 44 × 44 minimum hit area.
- States: `transition: 180ms ease` on background/colour/opacity/transform; hover `opacity .88`; active `transform: scale(.98)`; `:focus-visible` 2 px `--primary` outline, 2 px offset. Never remove the outline.

## 6. Icons

Stroke 1.9–2.2, round caps, 22 px. Draw them inline as SVG (no icon font, no library): home, cards, bar-chart, sliders (settings), search, plus, minus, refresh, chevron, pencil, alert-circle. One consistent set — do not mix in Lucide/Feather defaults.

## 7. Copy (use verbatim)

התיק שלי · לתשומת ליבך, הנתונים נשמרים במכשיר שלך בלבד · היום dd.MM.yy · שינוי תאריך · שווי התיק · נכון ל: · חציון מכירות eBay · שינוי יומי · שינוי מקנייה · הוספה · מכירה · עדכון מחירים · קלפים מדורגים (N) · סינגלים (N) · Raw · לכל האחזקות · רוצה להוסיף סינגלים או סילד לתיק? · להוספת סינגל · שווי: · יח׳ · שער אחרון · הכי עולה · הכי יורדת · חדשות על האחזקות שלי · יתרות ותקרות · עלות הרכישה · תקציב רכישה לחודש · האחזקות שלי · הכול · מדורגים · גולמיים · שווי האחזקה · מגמה · עלות רכישה ליחידה · שער השוק הגולמי · מספר תעודת PSA · עדכון שווי ידני · הוספת אחזקה · דירוג · מחיר קנייה ליחידה · כמות · לא חובה · שווי משוער · הוספה לתיק · הגדרות · מקור המחיר · שווי שהזנת ידנית · חציון מכירות eBay לדירוג · הערכה משער השוק הגולמי · פעיל · גיבוי · מפתח API · שאילתות היום · תצוגה · רענון מחירים בפתיחה · הסתרת סכומים · מטבע · ייצוא · ייבוא · אין חשבון ואין שרת. התיק נשמר בדפדפן של המכשיר בלבד. · הנתונים אינם מתעדכנים כרגע · מוצגים הערכים האחרונים שנשמרו. · בדיקת מפתח ה-API · הנתונים אינם זמינים · טרם בוצעה פעילות בתיק · הוספת קלף ראשון · ייבוא תיק שמור · בית · אחזקות · שוק · הגדרות

Terminology decisions already made: **“קלפים מדורגים”** not “אחזקות מדורגות”; **“סינגלים”** not “אחזקות גולמיות”; the raw tag is **“Raw”** in English.

## 8. Work plan

1. **Tokens & type** — new `:root`, fonts, type classes, remove dark mode. Ship. (Nothing else should look broken yet; it will just be recoloured.)
2. **Shell** — `dir="rtl"`, hash router, four views, bottom nav, header. Move existing blocks into their views without redesigning them. Ship.
3. **Components** — Change block, Holding card, tags/chips, buttons. Replace the holdings table and KPI tiles. Ship.
4. **Views** — Home order (§4.1), Holdings tabs, Card detail with the inline image, Add, Settings. Ship one view per commit.
5. **Edge cases** — banner, unavailable, empty. Restyle charts.
6. **Polish** — transitions, focus rings, tabular figures, `aria-current`, `aria-label` on every icon button, 44 px hit areas.

Small, reviewable commits; one view per commit in step 4.

## 9. Acceptance

- Every colour in `styles.css` is a token; no hex outside `:root`. No `#000`, no pure grey, no red for negative change.
- No text under 12 px; no 700 weight outside tags and nav labels.
- Cards have shadow, never border. Inputs have border, never shadow.
- Change pills carry no `+`/`−`/arrow; amount colour is always `--ink`.
- Exactly one gradient CTA and at most one lime banner per view.
- `store.js` and `api.js` diffs are empty (or `api.js` gains only a read-only getter).
- Keyboard: every action reachable by Tab, visible focus, `Esc` closes search results.
- Lighthouse a11y ≥ 95 on `#home` and `#card/<slot>`.
- Works with an empty localStorage, with a portfolio and no API key, and with the PPT key exhausted (banner state).

## 10. Open items (do not guess)

- Real card images: `api.js` already returns image URLs from the TCG API — use `images.small`; the mockup's tinted rectangles are placeholders.
- News source: none exists. Render the empty state.
- Portfolio switcher and “שינוי תאריך”: render the controls, leave them inert, add `// TODO` with a link to this brief.
- SimplerPro font files: not in the repo. Heebo until provided.
