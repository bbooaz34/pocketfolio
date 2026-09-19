/* Pocketfolio — app wiring: hash router, views, card search, graded positions.
   Redesign per POCKETFOLIO-REDESIGN.md: RTL Hebrew, views toggled by a hash
   router (#home, #holdings, #market, #settings, #card/<uid>, #add).
   Data layer (store.js, api.js) and the value hierarchy are unchanged:
   manual override → eBay sold median for the grade → raw market × multiplier. */

(function () {
  "use strict";

  const API = window.PocketfolioAPI;
  const Store = window.PocketfolioStore;
  const Charts = window.PocketfolioCharts;

  const REFRESH_MS = 30 * 60 * 1000; // market prices update ~daily

  /* Rough grade multipliers applied to the raw TCGplayer market price when a
     position has no manual value and no eBay sales median. */
  const GRADE_MULT = {
    "10": 3.0, "9": 1.4, "8": 1.0, "7": 0.85, "6": 0.7,
    "5": 0.6, "4": 0.5, "3": 0.45, "2": 0.4, "1": 0.35, raw: 1.0,
  };

  /* i18n — Hebrew is the default; an English pack can be added without
     touching markup (POCKETFOLIO-REDESIGN.md §4). */
  const T = {
    asOf: "נכון ל:",
    today: "היום",
    units: "יח׳",
    worth: "שווי:",
    lastPrice: "מחיר סינגל",
    changeDay: "תשואה יומית",
    changeBuy: "תשואה מקנייה",
    graded: (n) => `קלפים מדורגים (${n})`,
    fanLabel: (n) => `הקלפים המובילים בתיק, ${n} קלפים`,
    singles: (n) => `סינגלים (${n})`,
    srcEbay: "חציון מכירות eBay",
    srcEbayGrade: (g) => `חציון מכירות eBay לדירוג ${g}`,
    srcEst: "הערכה משער השוק הגולמי",
    srcManual: "שווי שהוזן ידנית",
    srcRaw: "שער השוק הגולמי",
    unavailable: "הנתונים אינם זמינים",
    sortDesc: "שווי ↓",
    sortAsc: "שווי ↑",
    active: "פעיל",
    backup: "גיבוי",
    estimated: "שווי משוער",
    rising: "עלייה",
    falling: "ירידה",
    notEnoughData: "אין מספיק נתונים עדיין",
    usedOf: (x, y) => `נוצלו ${x} מתוך ${y}`,
    trendNote: "הגרף נבנה משמירה יומית של השווי — חיזרו מחר לנקודה נוספת.",
    removeHolding: "הסרה מהתיק",
    save: "שמירה",
    cancel: "ביטול",
    manualValueLabel: "שווי ידני ליחידה (ריק = חזרה למחיר האוטומטי)",
    holdingValue: "שווי האחזקה",
    trend: "מגמה",
    costPerUnit: "עלות רכישה ליחידה",
    rawMarket: "מחיר סינגל",
    psaCert: "מספר תעודת PSA",
    certLooking: (c) => `מאתר תעודת PSA ‎#${c}…`,
    certMatch: "בחירת ההדפסה המדויקת תצרף מחיר שוק:",
    certNoMatch: (s) => `לא נמצאה הדפסה תואמת בקטלוג עבור ${s}.`,
    certJapanese: "שימו לב: התעודה היא של הדפסה יפנית, וההתאמות למטה הן הגרסאות האנגליות מהקטלוג — מחיר השוק שלהן שונה. בחרו בהוספת הסלאב בכל זאת: השווי יימשך אוטומטית ממכירות eBay של הגרסה היפנית (כשיש נתונים).",
    certAddAnyway: "➕ הוספת הסלאב לתיק",
    certNotThese: "לא אחד מאלה — הוספת הסלאב בכל זאת",
    certManualSub: "הדירוג והתעודה ימולאו — את השווי מגדירים ידנית",
    certFail: "לא ניתן לקרוא את דף התעודה של PSA כרגע.",
    certProxyHint: "אם ה-Worker האישי שלך הוקם לפני שנוסף נתיב התעודות — עדכנו אותו לקוד העדכני (proxy/prices-proxy.js).",
    certOpen: (c) => `פתיחת תעודה ‎#${c} באתר PSA`,
    searchFail: "שירותי הקלפים אינם זמינים כרגע — נסו שוב בעוד דקה",
    searchLimited: "חריגה ממכסת החיפושים — המתינו רגע ונסו שוב",
    noCards: "לא נמצאו קלפים",
    newsEmpty: "אין חדשות חדשות",
    rawMarketShort: "שוק גולמי",
    manualPinnedLine: "שווי שהזנת ידנית · נעוץ",
    manualPendingLine: "שווי שהזנת ידנית · יוחלף בעדכון הבא",
    autoUpdated: "עודכן אוטומטית",
    noPrice: "אין נתוני מחיר לקלף הזה",
    backToToday: "חזרה להיום",
    pastViewing: (d) => `צפייה בנתונים מ-${d}`,
    lastBuilt: (d, t) => `עודכן לאחרונה: ${d} בשעה ${t}`,
    snapshotHow: "המחירים נבנים פעם ביום ונשמרים באפליקציה. אין צורך בחשבון או במפתח.",
    noSnapshotYet: "אין עדכון עדיין",
  };

  const $ = (id) => document.getElementById(id);

  /* ---------- state ---------- */

  let cards = new Map();   // cardId -> latest normalized card
  let selectedCard = null;
  let gradeValue = "10";
  let qtyVal = 1;
  let currentUid = null;
  let holdingsTab = "all";
  let holdingsQuery = "";
  let sortDesc = true;
  let cdRange = "3ח";
  let lastUpdatedAt = null;
  let refreshTimer = null;

  /* snapshot pricing (POCKETFOLIO-PRICING.md): the app resolves values from
     the committed daily snapshot; picking a past date turns the home screen
     into a read-only view of that day. */
  let snapIndex = null;    // data/index.json
  let snapLatest = null;   // the newest snapshot
  let snapActive = null;   // the snapshot values resolve from
  let snapPrev = null;     // the one before snapActive (change blocks)
  let activeDate = null;   // null = latest; else "YYYY-MM-DD" (past, read-only)
  const snapMem = new Map();

  const todayISO = () => new Date().toISOString().slice(0, 10);
  const fmtDMY = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(2, 4)}`;
  const fmtDM = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;

  async function getSnap(date) {
    if (snapMem.has(date)) return snapMem.get(date);
    const s = await API.loadSnapshot(date);
    snapMem.set(date, s);
    return s;
  }
  async function prevSnapOf(date) {
    const i = snapIndex ? snapIndex.dates.indexOf(date) : -1;
    const pd = i >= 0 ? snapIndex.dates[i + 1] : null;
    if (!pd) return null;
    try { return await getSnap(pd); } catch { return null; }
  }

  /* ---------- settings (localStorage) ---------- */

  function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* ok */ } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch { /* ok */ } }

  const refreshOnOpen = () => lsGet("pocketfolio.refreshOnOpen") !== "0";
  const hideValues = () => lsGet("pocketfolio.hideValues") === "1";
  const budget = () => {
    const v = parseFloat(lsGet("pocketfolio.budget"));
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const monthKey = () => {
    const d = new Date();
    return "pocketfolio.spend." + d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
  };
  const monthSpend = () => {
    const v = parseFloat(lsGet(monthKey()));
    return Number.isFinite(v) && v > 0 ? v : 0;
  };

  /* ---------- formatters (unchanged contracts) ---------- */

  /* narrowSymbol: Hebrew locales otherwise render USD as "US$" — the design
     shows a bare "$" */
  const usdFull = new Intl.NumberFormat(undefined, {
    style: "currency", currency: "USD", currencyDisplay: "narrowSymbol",
  });
  const usdCompact = new Intl.NumberFormat(undefined, {
    style: "currency", currency: "USD", currencyDisplay: "narrowSymbol",
    notation: "compact", maximumFractionDigits: 1,
  });
  const eurFull = new Intl.NumberFormat(undefined, {
    style: "currency", currency: "EUR", currencyDisplay: "narrowSymbol",
  });

  const fmtUSD = (v, compact) => (compact ? usdCompact.format(v) : usdFull.format(v));
  const fmtMoney = (v, currency) => (currency === "EUR" ? eurFull.format(v) : usdFull.format(v));
  const fmtSigned = (v) => (v >= 0 ? "+" : "−") + usdFull.format(Math.abs(v));
  const fmtPct = (v) => (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(1) + "%";
  const deltaClass = (v) => (v > 0 ? "is-up" : v < 0 ? "is-down" : "is-flat");
  const gradeLabel = (g) => (g === "raw" ? "Raw" : "PSA " + g);
  const prettyVariant = (v) =>
    v.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()).replace(/^1st /i, "1st ");

  /* change pills carry the percentage without a sign; amounts stay ink */
  const pctAbs = (v) => Math.abs(v).toFixed(1) + "%";
  /* "הסתרת סכומים" masks amounts at display time; formatters stay pure */
  const show = (s) => (hideValues() ? "••••" : s);

  const fmtTime = (d) => new Intl.DateTimeFormat("he-IL", { hour: "numeric", minute: "2-digit" }).format(d);
  const fmtDateChip = (d) => {
    const p = (n) => String(n).padStart(2, "0");
    return `${T.today} ${p(d.getDate())}.${p(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)}`;
  };

  /* ---------- DOM helper ---------- */

  function h(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* ---------- value hierarchy (unchanged) ---------- */

  /* Resolution order (POCKETFOLIO-PRICING.md §4):
     pinned manual → snapshot built after the manual value was set → manual →
     raw × grade multiplier (snapshot raw, else catalog raw) → no data.
     Against a historic snapshot, a manual value counts only if it was already
     in force when that snapshot was built. */
  function valueEach(hh, snap = snapActive) {
    const entry = snap?.cards?.[hh.cardId] || null;
    const g = entry?.grades?.[hh.grade];
    const manualAt = hh.valueSetAt ? Date.parse(hh.valueSetAt) : 0;
    const builtAt = snap ? Date.parse(snap.builtAt) || 0 : 0;
    const historic = !!snap && !!snapLatest && snap.date !== snapLatest.date;
    const manual = hh.value != null && (!historic || manualAt <= builtAt);
    if (manual && hh.valuePinned) return { each: hh.value, src: "manual-pinned" };
    if (g != null && (!manual || builtAt > manualAt)) {
      return {
        each: g / 100, src: "snapshot", date: snap.date, builtAt: snap.builtAt,
        superseded: manual && builtAt > manualAt, confidence: entry.confidence,
      };
    }
    if (manual) return { each: hh.value, src: "manual-pending" };
    const rawP = entry?.grades?.raw;
    if (rawP != null) {
      if (hh.grade === "raw") return { each: rawP / 100, src: "raw" };
      return { each: (rawP / 100) * (GRADE_MULT[hh.grade] ?? 1), src: "est" };
    }
    const price = cards.get(hh.cardId)?.price;
    if (price) {
      if (hh.grade === "raw") return { each: price.value, src: "raw" };
      return { each: price.value * (GRADE_MULT[hh.grade] ?? 1), src: "est" };
    }
    return null;
  }

  function positions(snap = snapActive) {
    /* in a past view, holdings bought after the selected date are hidden */
    const cutoff = activeDate ? Date.parse(activeDate + "T23:59:59") : null;
    return Store.getAll()
      .filter((hh) => !cutoff || (hh.addedAt || 0) <= cutoff)
      .map((hh) => {
        const v = valueEach(hh, snap);
        return { h: hh, val: v, total: v ? v.each * hh.qty : 0 };
      })
      .sort((a, b) => (sortDesc ? b.total - a.total : a.total - b.total));
  }

  /* one line under a value — a number whose origin is invisible is a number
     the user cannot trust (POCKETFOLIO-PRICING.md §4) */
  function sourceLine(val, grade) {
    if (!val) return T.noPrice;
    if (val.src === "manual-pinned") return T.manualPinnedLine;
    if (val.src === "manual-pending") return T.manualPendingLine;
    if (val.src === "snapshot") {
      const d = fmtDM(val.date);
      return grade && grade !== "raw"
        ? `${T.asOf} ${d} · ${T.srcEbayGrade(grade)}`
        : `${T.asOf} ${d} · ${T.rawMarket}`;
    }
    if (val.src === "raw") return T.rawMarket;
    return T.srcEst;
  }

  /* portfolio change between the active snapshot and the one before it */
  function snapDelta(posList, snap, prev) {
    if (!snap || !prev) return null;
    let cur = 0, was = 0, any = false;
    for (const p of posList) {
      const b = valueEach(p.h, prev);
      if (p.val && b) { cur += p.val.each * p.h.qty; was += b.each * p.h.qty; any = true; }
    }
    if (!any || was <= 0) return null;
    return { amt: cur - was, pct: ((cur - was) / was) * 100 };
  }

  /* daily change: live value vs the last snapshot from an earlier day */
  function dailyDelta(liveVal, getter) {
    if (liveVal == null) return null;
    const snaps = Store.getSnapshots();
    const todayKey = new Date().toDateString();
    for (let i = snaps.length - 1; i >= 0; i--) {
      if (new Date(snaps[i].t).toDateString() === todayKey) continue;
      const prev = getter(snaps[i]);
      if (prev != null && prev > 0) {
        return { amt: liveVal - prev, pct: ((liveVal - prev) / prev) * 100 };
      }
    }
    return null;
  }

  /* ---------- banner ---------- */

  function showBanner(msg) {
    $("banner-msg").textContent = msg;
    $("banner").hidden = false;
  }
  function hideBanner() {
    $("banner").hidden = true;
  }

  /* ---------- change block / pill helpers ---------- */

  function setPillPair(pillEl, amtEl, delta) {
    if (!delta) {
      pillEl.className = "pill is-flat";
      pillEl.textContent = "0.0%";
      amtEl.textContent = show("‎$0");
      return;
    }
    pillEl.className = "pill " + deltaClass(delta.amt);
    pillEl.textContent = pctAbs(delta.pct);
    amtEl.textContent = show("‎" + usdFull.format(Math.abs(delta.amt)));
  }

  function changeBlock(label, delta) {
    const b = h("div", "change-block");
    b.appendChild(h("div", "label", label));
    const row = h("div", "row");
    if (delta === undefined) {
      row.appendChild(h("span", "t-text2 faint", T.unavailable));
    } else {
      const pill = h("span");
      const amt = h("span", "amount");
      setPillPair(pill, amt, delta);
      row.append(pill, amt);
    }
    b.appendChild(row);
    return b;
  }

  /* ---------- holding card component ---------- */

  function thumbEl(cardId, fallbackCls, imgCls) {
    const image = cards.get(cardId)?.image;
    if (image) {
      const img = h("img", imgCls);
      img.src = image;
      img.alt = "";
      img.loading = "lazy";
      return img;
    }
    return h("span", imgCls);
  }

  /* PSA brand strings are long ALL-CAPS ("1998 POKEMON JAPANESE HANADA CITY
     GYM DECK") — compact them for display: drop POKEMON, JAPANESE→JP,
     title-case. Catalog set names (mixed case) pass through unchanged. */
  function displaySet(s) {
    if (!s || /[a-z]/.test(s) || s.length <= 12) return s;
    return s.replace(/\bPOKEMON\b/g, " ").replace(/\bJAPANESE\b/g, "JP")
      .split(/\s+/).filter(Boolean)
      .map((w) => w === "JP" || /^\d/.test(w) ? w : w[0] + w.slice(1).toLowerCase())
      .join(" ");
  }

  function holdingCard(p) {
    const hh = p.h;
    const a = h("a", "holding-card");
    a.href = "#card/" + encodeURIComponent(hh.uid);

    /* text block at the start, thumbnail at the end (mockup: Collection) */
    const r1 = h("span", "r1");
    const txt = h("span", "txt");
    const nameline = h("span", "nameline");
    nameline.appendChild(h("span", "name", hh.name));
    nameline.appendChild(h("span", "tag " + (hh.grade === "raw" ? "tag--raw" : "tag--psa"), gradeLabel(hh.grade)));
    txt.appendChild(nameline);
    const setBits = [displaySet(hh.setName), hh.number].filter(Boolean).join(" ");
    if (setBits) txt.appendChild(h("span", "setnum num", setBits));
    r1.appendChild(txt);
    r1.appendChild(thumbEl(hh.cardId, null, "thumb"));
    a.appendChild(r1);

    const r2 = h("span", "r2");
    const worth = h("span", "worth");
    worth.appendChild(document.createTextNode(T.worth + " "));
    worth.appendChild(h("b", "num", p.val ? show(fmtUSD(p.total, false)) : "— —"));
    worth.appendChild(document.createTextNode(` · ${hh.qty} ${T.units}`));
    r2.appendChild(worth);
    const pill = h("span");
    const buyDelta = (hh.cost != null && p.val)
      ? { amt: (p.val.each - hh.cost) * hh.qty, pct: hh.cost ? ((p.val.each - hh.cost) / hh.cost) * 100 : 0 }
      : null;
    pill.className = "pill " + (buyDelta ? deltaClass(buyDelta.amt) : "is-flat");
    pill.textContent = buyDelta ? pctAbs(buyDelta.pct) : "0.0%";
    r2.appendChild(pill);
    a.appendChild(r2);

    /* the last-price row belongs to graded cards only (mockup: raw singles
       end at the value row) */
    if (hh.grade !== "raw") {
      const r3 = h("span", "r3");
      const raw = rawPriceOf(hh.cardId);
      r3.appendChild(h("span", "num", `${T.lastPrice} ${raw ? show(fmtMoney(raw.value, raw.currency)) : "— —"}`));
      r3.appendChild(h("span", null, T.changeBuy));
      a.appendChild(r3);
    }
    return a;
  }

  /* ---------- date carousel (POCKETFOLIO-PRICING.md §7) ---------- */

  let dateStripOpen = false;

  function renderDateStrip() {
    const host = $("date-strip");
    host.hidden = !dateStripOpen || !snapIndex || !snapIndex.dates.length;
    if (host.hidden) return;
    host.replaceChildren();
    const selected = activeDate || snapIndex.dates[0];
    for (const d of snapIndex.dates) {
      const b = h("button", "date-chip");
      b.type = "button";
      b.setAttribute("aria-pressed", String(d === selected));
      b.appendChild(h("span", "dw",
        new Intl.DateTimeFormat("he-IL", { weekday: "short" }).format(new Date(d + "T12:00:00")))); 
      b.appendChild(h("span", "dd num", String(parseInt(d.slice(8, 10), 10))));
      if (d === todayISO() && d !== selected) b.appendChild(h("span", "dot"));
      b.addEventListener("click", () => selectDate(d));
      host.appendChild(b);
    }
  }

  async function selectDate(date) {
    try {
      const latest = snapIndex?.dates?.[0];
      if (!date || date === latest) {
        activeDate = null;
        snapActive = snapLatest;
        snapPrev = latest ? await prevSnapOf(latest) : null;
      } else {
        snapActive = await getSnap(date);
        snapPrev = await prevSnapOf(date);
        activeDate = date;
      }
    } catch { return; }
    renderAll();
  }

  /* ---------- HOME ---------- */

  function renderHome(pos) {
    /* the date label is the snapshot indicator (§7); a historical date is
       blue, per the Leumi rule */
    const dc = $("date-chip");
    const shownDate = activeDate || snapLatest?.date || null;
    if (shownDate && shownDate !== todayISO()) {
      dc.textContent = fmtDMY(shownDate);
      dc.classList.add("chip--past");
    } else {
      dc.textContent = fmtDateChip(new Date());
      dc.classList.remove("chip--past");
    }
    renderDateStrip();

    /* past view: read-only — actions inert, a return strip under the header */
    $("past-strip").hidden = !activeDate;
    if (activeDate) $("past-strip-label").textContent = T.pastViewing(fmtDMY(activeDate));
    document.querySelectorAll("#round-actions .round-action")
      .forEach((el) => el.classList.toggle("inert", !!activeDate));

    const empty = !Store.getAll().length;
    $("dashboard").hidden = empty;
    $("empty-state").hidden = !empty;
    if (empty) {
      $("empty-asof").textContent =
        `${T.asOf} ${fmtDateChip(new Date()).replace(/^היום /, "")}, ${fmtTime(new Date())}`;
      return;
    }

    const valued = pos.filter((p) => p.val);
    const total = valued.reduce((s, p) => s + p.total, 0);
    const snapCount = valued.filter((p) => p.val.src === "snapshot").length;
    const manualOnly = valued.length && valued.every((p) => p.val.src.startsWith("manual"));

    $("kpi-total").textContent = valued.length ? show(fmtUSD(total, false)) : "— —";
    const when = snapActive ? fmtDM(snapActive.date)
      : fmtTime(lastUpdatedAt ? new Date(lastUpdatedAt) : new Date());
    const src = manualOnly ? T.srcManual : snapCount > 0 ? T.srcEbay : T.srcEst;
    $("kpi-total-note").textContent = `${T.asOf} ${when} · ${src}`;

    setPillPair($("kpi-day-pill"), $("kpi-day-amount"),
      valued.length
        ? (snapDelta(valued, snapActive, snapPrev) ?? dailyDelta(total, (s) => s.total))
        : null);

    const plPos = pos.filter((p) => p.h.cost != null && p.val);
    if (plPos.length) {
      const plCost = plPos.reduce((s, p) => s + p.h.cost * p.h.qty, 0);
      const plNow = plPos.reduce((s, p) => s + p.total, 0);
      setPillPair($("kpi-pl-pct"), $("kpi-pl"),
        { amt: plNow - plCost, pct: plCost ? ((plNow - plCost) / plCost) * 100 : 0 });
    } else {
      setPillPair($("kpi-pl-pct"), $("kpi-pl"), null);
    }

    const fan = $("card-fan");
    const top = [...pos].sort((a, b) => b.total - a.total).slice(0, 3);
    fan.hidden = !top.length;
    if (top.length) {
      const stack = fan.querySelector(".fan");
      stack.replaceChildren();
      for (const p of top) stack.appendChild(thumbEl(p.h.cardId, null, "fan-card"));
      const totalQty = pos.reduce((s, p) => s + p.h.qty, 0);
      const rest = totalQty - top.length;
      const chip = fan.querySelector(".fan-count");
      chip.hidden = rest <= 0;
      chip.textContent = rest > 0 ? `+${rest}` : "";
      fan.setAttribute("aria-label", T.fanLabel(totalQty));
    }

    const gradedPos = pos.filter((p) => p.h.grade !== "raw");
    $("home-graded-title").textContent = T.graded(gradedPos.length);
    const host = $("home-holdings");
    host.replaceChildren();
    for (const p of gradedPos.slice(0, 2)) host.appendChild(holdingCard(p));
  }

  /* ---------- HOLDINGS ---------- */

  function matchesQuery(hh) {
    if (!holdingsQuery) return true;
    const q = holdingsQuery.toLowerCase();
    return [hh.name, hh.setName, hh.number, hh.cert]
      .filter(Boolean).some((s) => String(s).toLowerCase().includes(q));
  }

  function renderHoldings(pos) {
    const host = $("holdings-body");
    host.replaceChildren();

    const all = pos.filter((p) => matchesQuery(p.h));
    const gradedPos = all.filter((p) => p.h.grade !== "raw");
    const rawPos = all.filter((p) => p.h.grade === "raw");

    if (!Store.getAll().length) {
      const c = h("div", "card t-text2 muted", "טרם בוצעה פעילות בתיק. ");
      const a = h("a", "t-text2-m", "הוספת קלף ראשון");
      a.href = "#add";
      c.appendChild(a);
      host.appendChild(c);
      return;
    }

    const showGraded = holdingsTab !== "raw";
    const showRaw = holdingsTab !== "graded";

    if (showGraded) {
      const head = h("div", "section-head");
      head.style.marginTop = "0";
      head.appendChild(h("h2", null, T.graded(gradedPos.length)));
      const sort = h("button", "sort-chip num", sortDesc ? T.sortDesc : T.sortAsc);
      sort.type = "button";
      sort.setAttribute("aria-label", "מיון לפי שווי");
      sort.addEventListener("click", () => { sortDesc = !sortDesc; renderAll(); });
      head.appendChild(sort);
      host.appendChild(head);
      for (const p of gradedPos) host.appendChild(holdingCard(p));
    }
    if (showRaw) {
      const head2 = h("div", "section-head");
      if (!showGraded) head2.style.marginTop = "0";
      head2.appendChild(h("h2", null, T.singles(rawPos.length)));
      host.appendChild(head2);
      for (const p of rawPos) host.appendChild(holdingCard(p));
    }
  }

  /* ---------- MARKET ---------- */

  /* ---------- news (brief §9: two article cards, no faked content) ---------- */

  let newsItems = null;      // in-memory for this session; API caches 30 min
  let newsLoading = false;
  let newsFailedAt = 0;      // failed fetches retry after a short cooldown
  let newsError = null;      // last failure, shown on the empty card

  function fmtAgo(t) {
    if (!t) return "";
    const m = Math.max(1, Math.round((Date.now() - t) / 60000));
    if (m < 60) return `לפני ${m} דק׳`;
    const hrs = Math.round(m / 60);
    if (hrs < 24) return `לפני ${hrs} שע׳`;
    const d = Math.round(hrs / 24);
    return d === 1 ? "אתמול" : `לפני ${d} ימים`;
  }

  /* items mentioning a held card come first, newest first within each group */
  function rankNews(items, pos) {
    const words = [...new Set(pos.map((p) => (p.h.name || "").toLowerCase().split(/\s+/)[0])
      .filter((w) => w.length > 3))];
    const hit = (n) => words.some((w) => (n.title + " " + n.text).toLowerCase().includes(w));
    const byTime = (a, b) => (b.at || 0) - (a.at || 0);
    return [...items.filter(hit).sort(byTime), ...items.filter((n) => !hit(n)).sort(byTime)];
  }

  function newsEmptyCard() {
    const c = h("div", "card article-card");
    const th = h("span", "a-thumb");
    th.setAttribute("aria-hidden", "true");
    c.appendChild(th);
    const body = h("div", "grow");
    body.style.alignSelf = "center";
    body.appendChild(h("div", "t-text2 muted", T.newsEmpty));
    if (newsError && API.hasGradedProxy()) {
      body.appendChild(h("div", "t-text4 faint mt8", String(newsError)));
    }
    c.appendChild(body);
    return c;
  }

  function renderNews(pos) {
    const host = $("news");
    if (newsItems && newsItems.length) {
      host.replaceChildren();
      for (const n of rankNews(newsItems, pos).slice(0, 2)) {
        const a = h("a", "card article-card");
        a.href = n.link; a.target = "_blank"; a.rel = "noopener";
        if (n.image) {
          const img = h("img", "a-thumb");
          img.src = n.image; img.alt = ""; img.loading = "lazy";
          /* news CDNs block hotlinking by Referer; a failed image degrades
             to the plain placeholder instead of a broken-image icon */
          img.referrerPolicy = "no-referrer";
          img.addEventListener("error", () => {
            const th = h("span", "a-thumb");
            th.setAttribute("aria-hidden", "true");
            img.replaceWith(th);
          });
          a.appendChild(img);
        } else {
          const th = h("span", "a-thumb");
          th.setAttribute("aria-hidden", "true");
          a.appendChild(th);
        }
        const txt = h("div", "grow a-body");
        txt.appendChild(h("div", "t-text2-m a-title", n.title));
        txt.appendChild(h("div", "t-text4 faint mt8",
          [n.source, fmtAgo(n.at)].filter(Boolean).join(" · ")));
        a.appendChild(txt);
        host.appendChild(a);
      }
      return;
    }
    host.replaceChildren(newsEmptyCard());
    if (newsItems || newsLoading || !API.hasGradedProxy()) return;
    if (Date.now() - newsFailedAt < 5 * 60 * 1000) return;
    newsLoading = true;
    API.fetchNews().then((items) => {
      newsItems = items && items.length ? items : null;
      if (!newsItems) { newsFailedAt = Date.now(); newsError = "הפיד חזר ריק"; }
      else newsError = null;
    }).catch((err) => {
      newsFailedAt = Date.now();
      newsError = err && err.message ? err.message : "שגיאת רשת";
    }).finally(() => {
      newsLoading = false;
      if (document.querySelector('[data-view="market"].active')) renderNews(positions());
    });
  }

  function renderMarket(pos) {
    renderNews(pos);
    $("last-updated").textContent =
      `${T.asOf} ${fmtTime(lastUpdatedAt ? new Date(lastUpdatedAt) : new Date())}`;

    const movers = $("movers");
    movers.replaceChildren();
    const valid = pos
      .filter((p) => p.h.cost != null && p.val && p.h.cost > 0)
      .map((p) => ({ p, pct: ((p.val.each - p.h.cost) / p.h.cost) * 100 }));
    if (!valid.length) {
      movers.appendChild(h("div", "card mover-card t-text2 muted", T.notEnoughData));
    } else {
      const best = valid.reduce((a, b) => (b.pct > a.pct ? b : a));
      const worst = valid.reduce((a, b) => (b.pct < a.pct ? b : a));
      const make = (label, item) => {
        const c = h("div", "card mover-card");
        c.appendChild(h("div", "t-text4 muted", label));
        c.appendChild(h("div", "t-text1-m mt8", item.p.h.name));
        const row = h("div", "m-row");
        row.appendChild(h("span", "t-text2 num", show(fmtUSD(item.p.val.each, false))));
        const pill = h("span", "pill " + deltaClass(item.pct), pctAbs(item.pct));
        row.appendChild(pill);
        c.appendChild(row);
        return c;
      };
      movers.appendChild(make(T.rising, best));
      if (worst.p !== best.p) movers.appendChild(make(T.falling, worst));
    }

    const withCost = pos.filter((p) => p.h.cost != null);
    const costTotal = withCost.reduce((s, p) => s + p.h.cost * p.h.qty, 0);
    $("kpi-cost").textContent = withCost.length ? show(fmtUSD(costTotal, false)) : "— —";

    const b = budget();
    $("budget-value").textContent = b ? show(fmtUSD(b, false)) : "";
    $("budget-set").hidden = !!b;
    $("budget-track").hidden = !b;
    $("budget-note").hidden = !b;
    if (b) {
      const spent = monthSpend();
      $("budget-bar").style.width = Math.min(100, (spent / b) * 100) + "%";
      $("budget-note").textContent = T.usedOf(show(fmtUSD(spent, false)), show(fmtUSD(b, false)));
    }
  }

  /* ---------- CARD DETAIL ---------- */

  const RANGES = [["1ח", 30], ["3ח", 90], ["שנה", 365], ["הכול", null]];

  function renderCardDetail() {
    const hh = Store.getAll().find((x) => x.uid === currentUid);
    if (!hh) { location.hash = "#holdings"; return; }
    const p = { h: hh, val: valueEach(hh) };
    p.total = p.val ? p.val.each * hh.qty : 0;

    $("cd-name").textContent = hh.name;
    $("cd-sub").textContent = [displaySet(hh.setName), hh.number, cards.get(hh.cardId)?.rarity]
      .filter(Boolean).join(" · ");

    const body = $("cd-body");
    body.replaceChildren();

    /* value card */
    const vc = h("section", "card");
    const head = h("div", "value-head");
    const txt = h("div", "grow");
    const lbl = h("div");
    lbl.style.display = "flex"; lbl.style.alignItems = "center"; lbl.style.gap = "8px";
    lbl.appendChild(h("span", "t-text2 muted", T.holdingValue));
    lbl.appendChild(h("span", "tag " + (hh.grade === "raw" ? "tag--raw" : "tag--psa"), gradeLabel(hh.grade)));
    txt.appendChild(lbl);
    const vl = h("div", "value-line");
    vl.appendChild(h("span", "t-value-lg num", p.val ? show(fmtUSD(p.total, false)) : "— —"));
    vl.appendChild(h("span", "t-text2 muted", `· ${hh.qty} ${T.units}`));
    txt.appendChild(vl);
    const srcRow = h("div", "t-text4 faint");
    srcRow.appendChild(document.createTextNode(sourceLine(p.val, hh.grade)));
    /* a snapshot that just superseded a manual value says so for 24h */
    if (p.val && p.val.src === "snapshot" && p.val.superseded &&
        Date.now() - Date.parse(p.val.builtAt) < 24 * 3600 * 1000) {
      const auto = h("span", "tag tag--psa", T.autoUpdated);
      auto.style.marginInlineStart = "6px";
      srcRow.appendChild(auto);
    }
    txt.appendChild(srcRow);
    const chipDate = snapActive?.date || todayISO();
    const chip = h("span", "chip sm num",
      chipDate === todayISO() ? fmtDateChip(new Date()) : fmtDMY(chipDate));
    chip.style.marginTop = "10px";
    txt.appendChild(chip);
    /* pin: the user insists on their own number (visible once one exists) */
    const pin = $("cd-pin");
    pin.hidden = hh.value == null;
    pin.setAttribute("aria-pressed", String(!!hh.valuePinned));
    head.appendChild(txt);
    head.appendChild(thumbEl(hh.cardId, null, "detail-figure"));
    vc.appendChild(head);

    const split = h("div", "change-split divider mt14");
    split.style.paddingTop = "14px";
    const daily = p.val ? dailyDelta(p.total, (s) => s.byUid?.[hh.uid]) : undefined;
    split.appendChild(changeBlock(T.changeDay, daily ?? null));
    split.appendChild(h("div", "vsep"));
    const buyDelta = (hh.cost != null && p.val)
      ? { amt: (p.val.each - hh.cost) * hh.qty, pct: hh.cost ? ((p.val.each - hh.cost) / hh.cost) * 100 : 0 }
      : undefined;
    split.appendChild(changeBlock(T.changeBuy, buyDelta));
    vc.appendChild(split);

    /* inline manual-value editor, opened by the header pencil */
    const edit = h("div", "inline-edit");
    edit.hidden = true;
    edit.id = "cd-edit-row";
    const wrap = h("div", "input-wrap");
    const inp = document.createElement("input");
    inp.type = "number"; inp.step = "any"; inp.min = "0";
    inp.id = "cd-value-input";
    inp.setAttribute("aria-label", T.manualValueLabel);
    inp.placeholder = T.manualValueLabel;
    if (hh.value != null) inp.value = hh.value;
    wrap.appendChild(inp);
    edit.appendChild(wrap);
    const saveB = h("button", "btn-outline", T.save);
    saveB.type = "button";
    saveB.addEventListener("click", () => {
      const v = parseFloat(inp.value);
      Store.setValueOverride(hh.uid, Number.isFinite(v) && v > 0 ? v : null);
      renderAll();
    });
    edit.appendChild(saveB);
    const cancelB = h("button", "text-btn", T.cancel);
    cancelB.type = "button";
    cancelB.addEventListener("click", () => { edit.hidden = true; });
    edit.appendChild(cancelB);
    vc.appendChild(edit);
    body.appendChild(vc);

    /* trend card */
    const tc = h("section", "card mt12");
    const th = h("div");
    th.style.display = "flex"; th.style.alignItems = "center"; th.style.justifyContent = "space-between";
    th.appendChild(h("span", "t-text2-m", T.trend));
    const pills = h("div");
    pills.style.display = "flex"; pills.style.gap = "2px";
    for (const [label] of RANGES) {
      const b = h("button", "range-pill", label);
      b.type = "button";
      b.setAttribute("aria-pressed", String(label === cdRange));
      b.addEventListener("click", () => { cdRange = label; renderCardDetail(); });
      pills.appendChild(b);
    }
    th.appendChild(pills);
    tc.appendChild(th);
    const chartHost = h("div", "trend-host mt10");
    tc.appendChild(chartHost);
    const days = (RANGES.find((r) => r[0] === cdRange) || [null, null])[1];
    const cutoff = days ? Date.now() - days * 864e5 : 0;
    /* the trend is our own snapshot series (§6) — snapshots are immutable,
       so they cache hard; local value-history remains the fallback */
    const localPts = Store.getSnapshots()
      .filter((s) => s.t >= cutoff && s.byUid && s.byUid[hh.uid] != null)
      .map((s) => ({ t: s.t, v: s.byUid[hh.uid] }));
    const draw = (points) => {
      chartHost.replaceChildren();
      if (points.length >= 2 && !hideValues()) {
        Charts.renderLineChart(chartHost, points, (v, compact) => fmtUSD(v, compact),
          { compact: true, label: `${T.trend} · ${hh.name}` });
      } else {
        chartHost.appendChild(h("div", "t-text4 faint", T.trendNote));
      }
    };
    draw(localPts);
    if (snapIndex && snapIndex.dates.length >= 2) {
      const uid = hh.uid;
      (async () => {
        const pts = [];
        for (const d of snapIndex.dates.slice(0, 30)) {
          const t = Date.parse(d + "T12:00:00");
          if (cutoff && t < cutoff) break;
          try {
            const v = valueEach(hh, await getSnap(d));
            if (v && (v.src === "snapshot" || v.src === "raw" || v.src === "est")) {
              pts.push({ t, v: v.each * hh.qty });
            }
          } catch { /* missing date file — skip */ }
        }
        pts.reverse();
        if (currentUid === uid && pts.length >= 2) draw(pts);
      })();
    }
    body.appendChild(tc);

    /* details card */
    const dc = h("section", "list-card kv-rows mt12");
    const kv = (k, vNode) => {
      const row = h("div", "kv-row");
      row.appendChild(h("span", "k", k));
      row.appendChild(vNode);
      dc.appendChild(row);
    };
    kv(T.costPerUnit, h("span", "v", hh.cost != null ? show(fmtUSD(hh.cost, false)) : "— —"));
    const raw = rawPriceOf(hh.cardId);
    kv(T.rawMarket, h("span", "v", raw ? show(fmtMoney(raw.value, raw.currency)) : "— —"));
    if (hh.cert) {
      const a = h("a", "v num", hh.cert);
      a.href = "https://www.psacard.com/cert/" + encodeURIComponent(hh.cert);
      a.target = "_blank"; a.rel = "noopener";
      kv(T.psaCert, a);
    } else {
      kv(T.psaCert, h("span", "v faint", "—"));
    }
    body.appendChild(dc);

    const rm = h("button", "danger-link", T.removeHolding);
    rm.type = "button";
    rm.addEventListener("click", () => {
      if (!window.confirm(`להסיר את ${hh.name} (${gradeLabel(hh.grade)}) מהתיק?`)) return;
      Store.remove(hh.uid);
      location.hash = "#holdings";
      renderAll();
    });
    body.appendChild(rm);
  }

  /* ---------- SETTINGS ---------- */

  function renderSettings() {
    /* no client key and no per-user quota — prices come from the daily
       snapshot (§8) */
    const ebayState = $("source-ebay-state");
    const estState = $("source-est-state");
    ebayState.replaceChildren();
    if (snapLatest) {
      ebayState.appendChild(h("span", "status-pill", T.active));
      estState.className = "t-text4 faint";
      estState.textContent = T.backup;
    } else {
      ebayState.appendChild(h("span", "t-text4 faint", T.noSnapshotYet));
      estState.replaceChildren(h("span", "status-pill", T.active));
      estState.className = "";
    }

    const upd = $("snapshot-updated");
    if (snapLatest) {
      const b = new Date(snapLatest.builtAt);
      upd.textContent = T.lastBuilt(fmtDM(snapLatest.date), fmtTime(b));
    } else {
      upd.textContent = T.noSnapshotYet;
    }

    $("proxy-input").value = lsGet("pocketfolio.pptProxy") || "";

    $("toggle-refresh").setAttribute("aria-pressed", String(refreshOnOpen()));
    $("toggle-hide").setAttribute("aria-pressed", String(hideValues()));
  }

  /* ---------- render everything ---------- */

  function renderAll() {
    const pos = positions();
    renderHome(pos);
    renderHoldings(pos);
    renderMarket(pos);
    renderSettings();
    if (activeView() === "card" && currentUid) renderCardDetail();
  }

  /* ---------- router ---------- */

  function activeView() {
    const raw = (location.hash || "#home").slice(1);
    if (raw.startsWith("card/")) return "card";
    return ["home", "holdings", "market", "settings", "add", "card"].includes(raw) ? raw : "home";
  }

  function route() {
    const raw = (location.hash || "#home").slice(1);
    let view = activeView();
    if (view === "card") {
      currentUid = decodeURIComponent(raw.slice(5));
      if (!Store.getAll().some((x) => x.uid === currentUid)) view = "holdings";
    }
    document.querySelectorAll("[data-view]").forEach((s) => {
      s.classList.toggle("active", s.dataset.view === view);
    });
    document.querySelectorAll(".bottom-nav a").forEach((a) => {
      const on = a.dataset.nav === view ||
        (a.dataset.nav === "holdings" && view === "card") ||
        (a.dataset.nav === "home" && view === "add");
      if (on) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    if (view === "card") renderCardDetail();
    /* the floating nav belongs to the four main screens (mockup: the add
       and card-detail boards carry no nav) */
    const nav = document.querySelector(".bottom-nav");
    nav.hidden = view === "add" || view === "card";
    window.scrollTo(0, 0); // also expands the nav via the scroll listener
  }

  /* ---------- card search (add view) ---------- */

  let searchTimer = null;
  let searchSeq = 0;

  function resultCard(c, onClick, opts) {
    const btn = h("button", "result-card" + ((opts && opts.selected) ? " selected" : ""));
    btn.type = "button";
    if (c.image) {
      const img = h("img", "thumb");
      img.src = c.image; img.alt = ""; img.loading = "lazy";
      btn.appendChild(img);
    } else {
      btn.appendChild(h("span", "thumb"));
    }
    const col = h("span", "grow");
    col.appendChild(h("span", "rc-name", c.name));
    const bits = [c.setName, c.number, c.rarity].filter(Boolean);
    if (c.price) bits.push(`${T.rawMarketShort} ${fmtMoney(c.price.value, c.price.currency)}`);
    col.appendChild(h("span", "rc-sub num", bits.join(" · ")));
    btn.appendChild(col);
    if (opts && opts.selected) {
      const check = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      check.setAttribute("viewBox", "0 0 24 24");
      check.setAttribute("width", "20"); check.setAttribute("height", "20");
      check.setAttribute("aria-hidden", "true");
      check.innerHTML = '<path d="M20 6L9 17l-5-5" fill="none" stroke="var(--primary)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>';
      btn.appendChild(check);
    }
    btn.addEventListener("click", onClick);
    return btn;
  }

  function closeResults() {
    const r = $("search-results");
    r.hidden = true;
    r.replaceChildren();
  }

  function resultsMessage(text) {
    const r = $("search-results");
    r.replaceChildren(h("div", "result-note", text));
    r.hidden = false;
  }

  function updateAddButton() {
    $("add-btn").disabled = !selectedCard;
  }

  /* raw (single) price: the snapshot's figure when it has one, else catalog */
  function rawPriceOf(cardId) {
    const p = snapActive?.cards?.[cardId]?.grades?.raw;
    if (p != null) return { value: p / 100, currency: "USD" };
    return cards.get(cardId)?.price || null;
  }

  function updateEstimate() {
    const card = $("est-card");
    if (!selectedCard) { card.hidden = true; return; }
    /* the snapshot's grade median beats any multiplier estimate */
    const snapG = snapLatest?.cards?.[selectedCard.id]?.grades?.[gradeValue];
    let each, note, currency = "USD";
    if (snapG != null) {
      each = snapG / 100;
      note = gradeValue === "raw"
        ? `מחושב לפי ${T.rawMarket}`
        : `מחושב לפי ${T.srcEbayGrade(gradeValue)}`;
    } else if (selectedCard.price) {
      const raw = selectedCard.price;
      currency = raw.currency;
      if (gradeValue === "raw") {
        each = raw.value;
        note = `מחושב לפי ${T.srcRaw}`;
      } else {
        const mult = GRADE_MULT[gradeValue] ?? 1;
        each = raw.value * mult;
        note = `מחושב לפי ${T.srcEst} · ×${mult} לדירוג ${gradeValue}`;
      }
    } else {
      card.hidden = true;
      return;
    }
    $("est-value").textContent = fmtMoney(each * qtyVal, currency);
    $("est-note").textContent = note;
    card.hidden = false;
  }

  function selectCard(card) {
    selectedCard = card;
    $("card-search").value = card.name;
    closeResults();
    const sel = $("selected-card");
    sel.replaceChildren(resultCard(card, () => { $("card-search").focus(); }, { selected: true }));
    updateAddButton();
    updateEstimate();
  }

  function setGrade(g) {
    gradeValue = g;
    document.querySelectorAll("#grade-pills .grade-pill").forEach((b) => {
      b.setAttribute("aria-pressed", String(b.dataset.grade === g));
    });
    updateEstimate();
  }

  function selectCertCard(card, info) {
    selectCard(card);
    if (info.grade && GRADE_MULT[info.grade] !== undefined) {
      setGrade(GRADE_MULT[info.grade] !== undefined && ["10", "9", "8", "7"].includes(info.grade) ? info.grade : gradeValue);
    }
    $("cert-input").value = info.cert;
  }

  async function certFlow(cert, seq) {
    resultsMessage(T.certLooking(cert));
    let info;
    try {
      info = await API.lookupCert(cert);
    } catch {
      if (seq !== searchSeq) return;
      const r = $("search-results");
      r.replaceChildren();
      const note = h("div", "result-note");
      note.appendChild(document.createTextNode(T.certFail + " "));
      const a = h("a", null, T.certOpen(cert));
      a.href = "https://www.psacard.com/cert/" + encodeURIComponent(cert);
      a.target = "_blank"; a.rel = "noopener";
      note.appendChild(a);
      if (API.hasGradedProxy()) {
        note.appendChild(h("div", "t-text4 faint mt8", T.certProxyHint));
      }
      r.appendChild(note);
      r.hidden = false;
      return;
    }
    if (seq !== searchSeq) return;

    const r = $("search-results");
    r.replaceChildren();
    const headB = h("div", "cert-head-block");
    headB.appendChild(h("div", "name num",
      `PSA ‎#${info.cert}` + (info.gradeText ? ` · ${info.gradeText}` : "")));
    const sub = [info.year, info.brand, info.subject, info.cardNumber ? "#" + info.cardNumber : null]
      .filter(Boolean).join(" · ");
    if (sub) headB.appendChild(h("div", "sub num", sub));
    r.appendChild(headB);
    r.hidden = false;

    /* prefill grade + cert as soon as the cert parses — not only after a
       printing is picked */
    if (info.grade && GRADES.some(([v]) => v === info.grade)) setGrade(info.grade);
    $("cert-input").value = info.cert;

    const loading = h("div", "result-note", T.certMatch);
    r.appendChild(loading);

    const japanese = /japanese/i.test(info.brand || "") || /japan/i.test(info.category || "");
    const manualCard = {
      provider: "manual",
      id: "psa-" + info.cert,
      name: API.certCardQuery(info) || "PSA ‎#" + info.cert,
      setName: [info.year, info.brand].filter(Boolean).join(" ") || null,
      number: info.cardNumber || null,
      rarity: null, image: null, price: null,
      jp: japanese, // eBay lookups go through the Japanese catalog
    };

    let matches = [];
    const q = API.certCardQuery(info);
    if (q) {
      try {
        matches = await API.searchCards(q, { number: info.cardNumber || undefined });
      } catch { /* catalogs unreachable — manual add still works */ }
    }
    if (seq !== searchSeq) return;
    loading.remove();

    if (matches.length) {
      if (japanese) r.appendChild(h("div", "result-note warn", T.certJapanese));
      r.appendChild(h("div", "result-note", T.certMatch));
      for (const c of matches.slice(0, 6)) {
        r.appendChild(resultCard(c, () => selectCertCard(c, info)));
      }
      const m = resultCard(manualCard, () => selectCertCard(manualCard, info));
      m.querySelector(".rc-name").textContent = T.certNotThese;
      m.querySelector(".rc-sub").textContent = T.certManualSub;
      r.appendChild(m);
    } else {
      if (q) r.appendChild(h("div", "result-note",
        T.certNoMatch(`${info.subject || ""}${info.cardNumber ? " #" + info.cardNumber : ""}`)));
      const m = resultCard(manualCard, () => selectCertCard(manualCard, info));
      m.querySelector(".rc-name").textContent = T.certAddAnyway;
      m.querySelector(".rc-sub").textContent = T.certManualSub;
      r.appendChild(m);
    }
  }

  $("card-search").addEventListener("input", () => {
    selectedCard = null;
    $("selected-card").replaceChildren();
    updateAddButton();
    updateEstimate();
    const q = $("card-search").value.trim();
    clearTimeout(searchTimer);
    if (q.length < 2) { closeResults(); return; }
    searchTimer = setTimeout(async () => {
      const seq = ++searchSeq;
      if (/^\d{6,10}$/.test(q)) { certFlow(q, seq); return; }
      try {
        const list = await API.searchCards(q);
        if (seq !== searchSeq) return;
        const r = $("search-results");
        r.replaceChildren();
        if (!list.length) r.appendChild(h("div", "result-note", T.noCards));
        for (const c of list) r.appendChild(resultCard(c, () => selectCard(c)));
        r.hidden = false;
      } catch (err) {
        if (seq === searchSeq) {
          resultsMessage(err.rateLimited ? T.searchLimited : T.searchFail);
        }
      }
    }, 350);
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") closeResults();
  });

  /* ---------- add form ---------- */

  const GRADES = [["10", "PSA 10"], ["9", "PSA 9"], ["8", "PSA 8"], ["7", "PSA 7"], ["raw", "גולמי"]];

  function buildGradePills() {
    const host = $("grade-pills");
    for (const [val, label] of GRADES) {
      const b = h("button", "grade-pill", label);
      b.type = "button";
      b.dataset.grade = val;
      b.setAttribute("aria-pressed", String(val === gradeValue));
      b.addEventListener("click", () => setGrade(val));
      host.appendChild(b);
    }
  }

  function setQty(n) {
    qtyVal = Math.min(99, Math.max(1, n));
    $("qty-input").value = qtyVal;
    updateEstimate();
  }

  $("qty-dec").addEventListener("click", () => setQty(qtyVal - 1));
  $("qty-inc").addEventListener("click", () => setQty(qtyVal + 1));

  function numOrNull(input) {
    const v = parseFloat(input.value);
    return Number.isFinite(v) && v > 0 ? v : null;
  }

  $("add-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (!selectedCard) return;
    const cost = numOrNull($("cost-input"));
    Store.upsert({
      cardId: selectedCard.id,
      provider: selectedCard.provider,
      name: selectedCard.name,
      setName: selectedCard.setName,
      number: selectedCard.number,
      image: selectedCard.image,
      grade: gradeValue,
      qty: qtyVal,
      cost,
      value: null, // the API fills the value (eBay median / estimate); ✎ overrides later
      cert: $("cert-input").value.trim().replace(/[^\w-]/g, "") || null,
    });
    cards.set(selectedCard.id, selectedCard);
    if (cost) lsSet(monthKey(), String(monthSpend() + cost * qtyVal));

    selectedCard = null;
    $("selected-card").replaceChildren();
    $("card-search").value = "";
    $("cost-input").value = "";
    $("cert-input").value = "";
    setQty(1);
    updateAddButton();
    $("est-card").hidden = true;
    location.hash = "#home";
    await refresh();
  });

  /* ---------- refresh: catalog + the daily snapshot ---------- */

  async function loadSnapshots() {
    try {
      snapLatest = await API.loadSnapshot();
      snapMem.set(snapLatest.date, snapLatest);
      try { snapIndex = await API.loadIndex(); } catch { /* index optional */ }
      if (!activeDate) {
        snapActive = snapLatest;
        snapPrev = await prevSnapOf(snapLatest.date);
      }
      lastUpdatedAt = Date.parse(snapLatest.builtAt) || Date.now();
      /* stale = built more than 48h ago (§6) */
      if (Date.now() - Date.parse(snapLatest.builtAt) > 48 * 3600 * 1000) {
        showBanner("מוצגים הערכים האחרונים שנשמרו.");
      } else {
        hideBanner();
      }
      return true;
    } catch {
      if (!snapLatest) {
        const cached = API.cachedLatestSnapshot();
        if (cached) {
          snapLatest = cached;
          snapMem.set(cached.date, cached);
          if (!activeDate) snapActive = cached;
          lastUpdatedAt = Date.parse(cached.builtAt) || null;
        }
      }
      if (snapLatest) showBanner("מוצגים הערכים האחרונים שנשמרו.");
      return false;
    }
  }

  async function refresh() {
    const holdings = Store.getAll();
    await loadSnapshots();
    if (!holdings.length) { renderAll(); return; }

    try {
      const seen = new Set();
      const refs = [];
      for (const hh of holdings) {
        if (seen.has(hh.cardId) || hh.provider === "manual") continue;
        seen.add(hh.cardId);
        refs.push({ provider: hh.provider || "ptcgio", id: hh.cardId });
      }
      const fresh = refs.length ? await API.getCards(refs) : [];
      for (const c of fresh) cards.set(c.id, c);
    } catch { /* catalog unreachable — persisted metadata still renders */ }

    /* record today's snapshot for the value-over-time data */
    const pos = positions();
    const valued = pos.filter((p) => p.val);
    const total = valued.reduce((s, p) => s + p.total, 0);
    if (total > 0) {
      const byUid = {};
      for (const p of valued) byUid[p.h.uid] = p.total;
      Store.recordSnapshot(Math.round(total * 100) / 100, byUid);
    }
    renderAll();
  }

  /* ---------- settings events ---------- */

  $("api-save-btn").addEventListener("click", () => {
    const proxy = $("proxy-input").value.trim();
    if (proxy) lsSet("pocketfolio.pptProxy", proxy.replace(/\/+$/, ""));
    else if (lsGet("pocketfolio.pptProxy")) lsDel("pocketfolio.pptProxy");
    renderSettings();
  });

  $("toggle-refresh").addEventListener("click", () => {
    lsSet("pocketfolio.refreshOnOpen", refreshOnOpen() ? "0" : "1");
    renderSettings();
  });

  $("toggle-hide").addEventListener("click", () => {
    lsSet("pocketfolio.hideValues", hideValues() ? "0" : "1");
    renderAll();
  });

  $("export-btn").addEventListener("click", () => {
    const data = {
      holdings: JSON.parse(lsGet("pocketfolio.tcg.holdings.v1") || "[]"),
      snapshots: JSON.parse(lsGet("pocketfolio.tcg.snapshots.v1") || "[]"),
      budget: lsGet("pocketfolio.budget") || null,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "pocketfolio-backup.json";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $("import-btn").addEventListener("click", () => $("import-file").click());
  $("import-file").addEventListener("change", async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.holdings)) throw new Error("bad file");
      lsSet("pocketfolio.tcg.holdings.v1", JSON.stringify(data.holdings));
      if (Array.isArray(data.snapshots)) lsSet("pocketfolio.tcg.snapshots.v1", JSON.stringify(data.snapshots));
      if (data.budget) lsSet("pocketfolio.budget", String(data.budget));
      location.reload();
    } catch {
      window.alert("קובץ הגיבוי אינו תקין.");
    }
  });

  $("clear-btn").addEventListener("click", () => {
    const ok = window.confirm("למחוק את כל נתוני הקלפים מהמכשיר?\n\nהפעולה מוחקת את כל האחזקות, היסטוריית השווי והמחירים השמורים. מפתח ה-API נשמר. לא ניתן לבטל.");
    if (!ok) return;
    Store.clearAll();
    lsDel("pocketfolio.gradedCache.v2");
    lsDel("pocketfolio.budget");
    cards.clear();
    graded.clear();
    hideBanner();
    renderAll();
    location.hash = "#home";
  });

  /* ---------- misc view events ---------- */

  $("holdings-filter").addEventListener("input", () => {
    holdingsQuery = $("holdings-filter").value.trim();
    renderHoldings(positions());
  });

  document.querySelectorAll(".tabs .tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      holdingsTab = tab.dataset.tab;
      document.querySelectorAll(".tabs .tab").forEach((t) =>
        t.setAttribute("aria-selected", String(t === tab)));
      renderHoldings(positions());
    });
  });

  $("budget-set").addEventListener("click", () => {
    const v = window.prompt("תקציב רכישה חודשי בדולרים:");
    if (v === null) return;
    const n = parseFloat(v);
    if (Number.isFinite(n) && n > 0) lsSet("pocketfolio.budget", String(n));
    renderMarket(positions());
  });

  $("cd-edit").addEventListener("click", () => {
    const row = $("cd-edit-row");
    if (row) {
      row.hidden = !row.hidden;
      if (!row.hidden) $("cd-value-input")?.focus();
    }
  });

  $("refresh-btn").addEventListener("click", () => refresh());

  /* TODO: portfolio switcher is rendered but inert — POCKETFOLIO-REDESIGN.md §10 */
  $("portfolio-switcher").addEventListener("click", () => {});

  /* date travel (POCKETFOLIO-PRICING.md §7) */
  $("date-change-btn").addEventListener("click", () => {
    dateStripOpen = !dateStripOpen;
    renderDateStrip();
  });
  $("past-strip-back").addEventListener("click", () => {
    if (snapIndex?.dates?.length) selectDate(snapIndex.dates[0]);
  });

  /* pin / unpin the manual value (POCKETFOLIO-PRICING.md §4) */
  $("cd-pin").addEventListener("click", () => {
    const hh = Store.getAll().find((x) => x.uid === currentUid);
    if (!hh || hh.value == null) return;
    Store.setValuePinned(hh.uid, !hh.valuePinned);
    renderAll();
  });

  /* ---------- init ---------- */

  /* Seed the in-memory card map from the metadata each holding already
     persists, so thumbnails, set lines and estimates render before the first
     refresh completes, when providers are unreachable, and for cert-only
     ("manual") slabs that no catalog can re-fetch. A live refresh overwrites
     these stubs with fresh cards. */
  for (const hh of Store.getAll()) {
    if (!cards.has(hh.cardId)) {
      cards.set(hh.cardId, {
        provider: hh.provider || "ptcgio", id: hh.cardId, name: hh.name,
        setName: hh.setName ?? null, number: hh.number ?? null,
        rarity: null, image: hh.image ?? null, price: null,
        /* a manual slab's set line carries the PSA brand, e.g.
           "1998 POKEMON JAPANESE HANADA CITY GYM DECK" */
        jp: /japanese/i.test(hh.setName || ""),
      });
    }
  }

  /* a home-screen shortcut captures the URL as saved — #add or #card/…
     included. A fresh launch always starts at home; the tab views stay
     valid as deep links. */
  if (location.hash === "#add" || location.hash.startsWith("#card/")) {
    history.replaceState(null, "", "#home");
  }

  window.addEventListener("hashchange", route);

  /* the floating nav collapses to a compact pill while scrolling */
  {
    const nav = document.querySelector(".bottom-nav");
    let compact = false;
    window.addEventListener("scroll", () => {
      const t = window.scrollY;
      if (t > 14 && !compact) { compact = true; nav.classList.add("compact"); }
      else if (t <= 2 && compact) { compact = false; nav.classList.remove("compact"); }
    }, { passive: true });
  }

  /* a cold offline start renders from the last snapshot this browser saw */
  {
    const cached = API.cachedLatestSnapshot();
    if (cached) {
      snapLatest = cached;
      snapActive = cached;
      snapMem.set(cached.date, cached);
      lastUpdatedAt = Date.parse(cached.builtAt) || null;
    }
  }

  buildGradePills();
  route();
  if (refreshOnOpen()) refresh();
  else { loadSnapshots().then(renderAll); renderAll(); }

  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (!document.hidden && refreshOnOpen()) refresh();
  }, REFRESH_MS);

  void fmtSigned; void fmtPct; void prettyVariant; // formatters kept per redesign brief
})();
