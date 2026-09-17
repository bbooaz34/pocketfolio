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
    lastPrice: "שער אחרון",
    changeDay: "שינוי יומי",
    changeBuy: "שינוי מקנייה",
    graded: (n) => `קלפים מדורגים (${n})`,
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
    needsKey: "נדרש מפתח",
    estimated: "שווי משוער",
    rising: "הכי עולה",
    falling: "הכי יורדת",
    notEnoughData: "אין מספיק נתונים עדיין",
    usedOf: (x, y) => `נוצלו ${x} מתוך ${y}`,
    queriesOf: (n, m) => `${n} מתוך ${m}`,
    trendNote: "הגרף נבנה משמירה יומית של השווי — חיזרו מחר לנקודה נוספת.",
    removeHolding: "הסרה מהתיק",
    save: "שמירה",
    cancel: "ביטול",
    manualValueLabel: "שווי ידני ליחידה (ריק = חזרה למחיר האוטומטי)",
    holdingValue: "שווי האחזקה",
    trend: "מגמה",
    costPerUnit: "עלות רכישה ליחידה",
    rawMarket: "שער השוק הגולמי",
    psaCert: "מספר תעודת PSA",
    certLooking: (c) => `מאתר תעודת PSA ‎#${c}…`,
    certMatch: "בחירת ההדפסה המדויקת תצרף מחיר שוק:",
    certNoMatch: (s) => `לא נמצאה הדפסה תואמת בקטלוג עבור ${s}.`,
    certAddAnyway: "➕ הוספת הסלאב לתיק",
    certNotThese: "לא אחד מאלה — הוספת הסלאב בכל זאת",
    certManualSub: "הדירוג והתעודה ימולאו — את השווי מגדירים ידנית",
    certFail: "לא ניתן לקרוא את דף התעודה של PSA כרגע.",
    certOpen: (c) => `פתיחת תעודה ‎#${c} באתר PSA`,
    searchFail: "שירותי הקלפים אינם זמינים כרגע — נסו שוב בעוד דקה",
    searchLimited: "חריגה ממכסת החיפושים — המתינו רגע ונסו שוב",
    noCards: "לא נמצאו קלפים",
    rawMarketShort: "שוק גולמי",
  };

  const $ = (id) => document.getElementById(id);

  /* ---------- state ---------- */

  let cards = new Map();   // cardId -> latest normalized card
  let graded = new Map();  // cardId -> { "10": {price, count}, … }
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

  const usdFull = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });
  const usdCompact = new Intl.NumberFormat(undefined, {
    style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1,
  });
  const eurFull = new Intl.NumberFormat(undefined, { style: "currency", currency: "EUR" });

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

  function valueEach(hh) {
    if (hh.value != null) return { each: hh.value, src: "manual" };
    if (hh.grade !== "raw") {
      const g = graded.get(hh.cardId)?.[hh.grade];
      if (g) return { each: g.price, src: "ebay", count: g.count };
    }
    const price = cards.get(hh.cardId)?.price;
    if (price) {
      if (hh.grade === "raw") return { each: price.value, src: "raw" };
      return { each: price.value * (GRADE_MULT[hh.grade] ?? 1), src: "est" };
    }
    return null;
  }

  function positions() {
    return Store.getAll()
      .map((hh) => {
        const v = valueEach(hh);
        return { h: hh, val: v, total: v ? v.each * hh.qty : 0 };
      })
      .sort((a, b) => (sortDesc ? b.total - a.total : a.total - b.total));
  }

  function sourceLabel(src, grade) {
    if (src === "manual") return T.srcManual;
    if (src === "ebay") return grade ? T.srcEbayGrade(grade) : T.srcEbay;
    if (src === "raw") return T.srcRaw;
    return T.srcEst;
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

  function holdingCard(p) {
    const hh = p.h;
    const a = h("a", "holding-card");
    a.href = "#card/" + encodeURIComponent(hh.uid);

    const r1 = h("span", "r1");
    r1.appendChild(thumbEl(hh.cardId, null, "thumb"));
    r1.appendChild(h("span", "name", hh.name));
    const tag = h("span", "tag " + (hh.grade === "raw" ? "tag--raw" : "tag--psa"), gradeLabel(hh.grade));
    r1.appendChild(tag);
    const setBits = [hh.setName, hh.number].filter(Boolean).join(" · ");
    if (setBits) r1.appendChild(h("span", "setnum num", setBits));
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

    const r3 = h("span", "r3");
    const raw = cards.get(hh.cardId)?.price;
    r3.appendChild(h("span", "num", `${T.lastPrice} ${raw ? show(fmtMoney(raw.value, raw.currency)) : "— —"}`));
    r3.appendChild(h("span", null, T.changeBuy));
    a.appendChild(r3);
    return a;
  }

  /* ---------- HOME ---------- */

  function renderHome(pos) {
    $("date-chip").textContent = fmtDateChip(new Date());
    const empty = !Store.getAll().length;
    $("dashboard").hidden = empty;
    $("empty-state").hidden = !empty;
    if (empty) return;

    const valued = pos.filter((p) => p.val);
    const total = valued.reduce((s, p) => s + p.total, 0);
    const ebayCount = valued.filter((p) => p.val.src === "ebay").length;
    const manualOnly = valued.length && valued.every((p) => p.val.src === "manual");

    $("kpi-total").textContent = valued.length ? show(fmtUSD(total, false)) : "— —";
    const time = fmtTime(lastUpdatedAt ? new Date(lastUpdatedAt) : new Date());
    const src = manualOnly ? T.srcManual : ebayCount > 0 ? T.srcEbay : T.srcEst;
    $("kpi-total-note").textContent = `${T.asOf} ${time} · ${src}`;

    setPillPair($("kpi-day-pill"), $("kpi-day-amount"),
      valued.length ? dailyDelta(total, (s) => s.total) : null);

    const plPos = pos.filter((p) => p.h.cost != null && p.val);
    if (plPos.length) {
      const plCost = plPos.reduce((s, p) => s + p.h.cost * p.h.qty, 0);
      const plNow = plPos.reduce((s, p) => s + p.total, 0);
      setPillPair($("kpi-pl-pct"), $("kpi-pl"),
        { amt: plNow - plCost, pct: plCost ? ((plNow - plCost) / plCost) * 100 : 0 });
    } else {
      setPillPair($("kpi-pl-pct"), $("kpi-pl"), null);
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
      const sort = h("button", "chip num", sortDesc ? T.sortDesc : T.sortAsc);
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

  function renderMarket(pos) {
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
    $("cd-sub").textContent = [hh.setName, hh.number, cards.get(hh.cardId)?.rarity]
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
    const time = fmtTime(lastUpdatedAt ? new Date(lastUpdatedAt) : new Date());
    txt.appendChild(h("div", "t-text4 faint", p.val
      ? `${T.asOf} ${time} · ${sourceLabel(p.val.src, hh.grade !== "raw" ? hh.grade : null)}`
      : T.unavailable));
    const chip = h("span", "chip num", fmtDateChip(new Date()));
    chip.style.marginTop = "10px";
    txt.appendChild(chip);
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
    const points = Store.getSnapshots()
      .filter((s) => s.t >= cutoff && s.byUid && s.byUid[hh.uid] != null)
      .map((s) => ({ t: s.t, v: s.byUid[hh.uid] }));
    if (points.length >= 2 && !hideValues()) {
      Charts.renderLineChart(chartHost, points, (v, compact) => fmtUSD(v, compact),
        { compact: true, label: `${T.trend} · ${hh.name}` });
    } else {
      chartHost.appendChild(h("div", "t-text4 faint", T.trendNote));
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
    const raw = cards.get(hh.cardId)?.price;
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
    const keySet = API.hasGradedKey();
    const ebayState = $("source-ebay-state");
    const estState = $("source-est-state");
    ebayState.replaceChildren();
    if (keySet) {
      ebayState.appendChild(h("span", "status-pill", T.active));
      estState.className = "t-text4 faint";
      estState.textContent = T.backup;
    } else {
      ebayState.appendChild(h("span", "t-text4 faint", T.needsKey));
      estState.replaceChildren(h("span", "status-pill", T.active));
      estState.className = "";
    }

    const keyInput = $("api-key-input");
    const storedKey = lsGet("pocketfolio.pptApiKey") || "";
    keyInput.placeholder = storedKey
      ? "מוגדר · ••••" + storedKey.slice(-4)
      : "הדבקת מפתח מ-pokemonpricetracker.com";
    $("proxy-input").value = lsGet("pocketfolio.pptProxy") || "";

    const n = (typeof API.gradedCallsToday === "function") ? API.gradedCallsToday() : 0;
    $("quota-label").textContent = T.queriesOf(n, 100);
    $("quota-bar").style.width = Math.min(100, n) + "%";

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
    window.scrollTo(0, 0);
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

  function updateEstimate() {
    const card = $("est-card");
    if (!selectedCard || !selectedCard.price) { card.hidden = true; return; }
    const raw = selectedCard.price;
    let each, note;
    if (gradeValue === "raw") {
      each = raw.value;
      note = T.srcRaw;
    } else {
      const mult = GRADE_MULT[gradeValue] ?? 1;
      each = raw.value * mult;
      note = `${T.srcEst} · ×${mult} לדירוג ${gradeValue}`;
    }
    $("est-value").textContent = fmtMoney(each * qtyVal, raw.currency);
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

    const loading = h("div", "result-note", T.certMatch);
    r.appendChild(loading);

    const manualCard = {
      provider: "manual",
      id: "psa-" + info.cert,
      name: API.certCardQuery(info) || "PSA ‎#" + info.cert,
      setName: [info.year, info.brand].filter(Boolean).join(" ") || null,
      number: info.cardNumber || null,
      rarity: null, image: null, price: null,
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

  /* ---------- demo ---------- */

  $("demo-btn").addEventListener("click", async () => {
    $("demo-btn").disabled = true;
    const demo = [
      { id: "base1-4", grade: "9", qty: 1 },
      { id: "base1-2", grade: "8", qty: 1 },
      { id: "base1-58", grade: "10", qty: 2 },
    ];
    try {
      let added = 0;
      for (const d of demo) {
        const card = await API.getCard("ptcgio", d.id);
        if (!card) continue;
        const est = card.price ? card.price.value * (GRADE_MULT[d.grade] ?? 1) : null;
        Store.upsert({
          cardId: card.id, provider: card.provider, name: card.name,
          setName: card.setName, number: card.number, image: card.image,
          grade: d.grade, qty: d.qty,
          cost: est != null ? Math.round(est * 100) / 100 : null,
          value: null, cert: null,
        });
        cards.set(card.id, card);
        added++;
      }
      if (!added) throw new Error("שירותי הקלפים אינם זמינים כרגע.");
      await refresh();
    } catch (err) {
      showBanner(err.message || "טעינת תיק ההדגמה נכשלה.");
      renderAll();
    } finally {
      $("demo-btn").disabled = false;
    }
  });

  /* ---------- refresh (data pipeline unchanged) ---------- */

  async function refresh() {
    const holdings = Store.getAll();
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

      if (fresh.length || !refs.length) {
        hideBanner();
        lastUpdatedAt = Date.now();
      } else {
        showBanner("מוצגים הערכים האחרונים שנשמרו.");
      }

      if (API.hasGradedKey()) {
        let keyRejected = false;
        let attempted = 0;
        await Promise.all(refs.map(async (r) => {
          const card = cards.get(r.id);
          if (!card) return;
          attempted++;
          try {
            const g = await API.gradedFor(card);
            if (g) graded.set(r.id, g);
          } catch (err) {
            if (err.unauthorized) keyRejected = true;
          }
        }));
        const backoff = API.gradedBackoffUntil();
        if (keyRejected) {
          showBanner("מפתח ה-API נדחה.");
        } else if (backoff && graded.size === 0) {
          showBanner(`חריגה ממכסת ה-API — ניסיון נוסף ב-${fmtTime(new Date(backoff))}.`);
        }
      }
    } catch {
      showBanner("מוצגים הערכים האחרונים שנשמרו.");
    }

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
    const key = $("api-key-input").value.trim();
    const proxy = $("proxy-input").value.trim();
    if (key) lsSet("pocketfolio.pptApiKey", key);
    if (proxy) lsSet("pocketfolio.pptProxy", proxy.replace(/\/+$/, ""));
    else if ($("proxy-input").value === "" && lsGet("pocketfolio.pptProxy")) lsDel("pocketfolio.pptProxy");
    $("api-key-input").value = "";
    lsDel("pocketfolio.gradedCache.v2");
    graded.clear();
    renderSettings();
    refresh();
  });

  $("test-api-btn").addEventListener("click", async () => {
    if (!API.hasGradedKey()) {
      window.alert("אין עדיין מפתח API.\n\nמפתח חינמי (100 שאילתות ביום) ב-pokemonpricetracker.com → API.");
      return;
    }
    const hh = Store.getAll().find((x) => (x.provider || "ptcgio") !== "manual" && cards.get(x.cardId));
    if (!hh) {
      window.alert("הוסיפו קלף לתיק ואז הריצו את הבדיקה — היא נעשית עם קלף אמיתי מהתיק.");
      return;
    }
    const card = cards.get(hh.cardId);
    const r = await API.gradedTest(card);
    if (r.ok) {
      const lines = Object.entries(r.grades)
        .map(([g, v]) => `PSA ${g}: $${v.price}${v.count ? ` (${v.count} מכירות)` : ""}`).join("\n");
      window.alert(`✓ ה-API עובד! חציוני מכירות eBay עבור ${card.name} #${card.number || "?"}:\n\n${lines}`);
    } else if (r.reason === "unauthorized") {
      window.alert("✗ המפתח נדחה (401/403). בדקו אותו ב-pokemonpricetracker.com והזינו מחדש.");
    } else if (r.reason === "rate-limited") {
      window.alert("⚠ חריגה ממכסה (429) — אבל זה סימן טוב: ה-Proxy והמפתח עובדים. המכסה מתאפסת יומית.");
    } else if (r.reason === "network") {
      window.alert(API.hasGradedProxy()
        ? `✗ לא ניתן להגיע ל-API דרך ה-Proxy.\n\nשגיאה: ${r.message}\n\nבדקו שה-Worker פעיל ושהכתובת נכונה.`
        : "✗ ה-API חוסם קריאות מדפדפן (CORS) ולכן דרוש Proxy אישי חינמי (~5 דקות הקמה).\n\nההוראות המלאות בסעיף Graded prices proxy ב-README של המאגר.");
    } else {
      window.alert(`✗ ה-API זמין והמפתח תקין, אבל לא נמצאו נתוני מכירות עבור ${card.name} #${card.number || "?"}.`);
    }
    refresh();
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

  /* TODO: portfolio switcher and date travel are rendered but inert —
     see POCKETFOLIO-REDESIGN.md §10 */
  $("portfolio-switcher").addEventListener("click", () => {});
  $("date-change-btn").addEventListener("click", () => {});

  /* ---------- init ---------- */

  window.addEventListener("hashchange", route);

  buildGradePills();
  route();
  if (refreshOnOpen()) refresh();
  else renderAll();

  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (!document.hidden && refreshOnOpen()) refresh();
  }, REFRESH_MS);

  void fmtSigned; void fmtPct; void prettyVariant; // formatters kept per redesign brief
})();
