/* Pocketfolio — app wiring: card search, graded positions, refresh, rendering. */

(function () {
  "use strict";

  const API = window.PocketfolioAPI;
  const Store = window.PocketfolioStore;
  const Charts = window.PocketfolioCharts;

  const REFRESH_MS = 30 * 60 * 1000; // market prices update ~daily

  /* Rough grade multipliers applied to the raw market price when a position
     has no manual value. Clearly labeled "est." in the UI — graded premiums
     vary wildly per card, so real sale prices always win. */
  const GRADE_MULT = {
    "10": 3.0, "9": 1.4, "8": 1.0, "7": 0.85, "6": 0.7,
    "5": 0.6, "4": 0.5, "3": 0.45, "2": 0.4, "1": 0.35, raw: 1.0,
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    form: $("add-form"),
    search: $("card-search"),
    results: $("search-results"),
    grade: $("grade-select"),
    qty: $("qty-input"),
    cost: $("cost-input"),
    value: $("value-input"),
    cert: $("cert-input"),
    addBtn: $("add-btn"),
    hint: $("form-hint"),
    banner: $("banner"),
    empty: $("empty-state"),
    demoBtn: $("demo-btn"),
    dashboard: $("dashboard"),
    lastUpdated: $("last-updated"),
    refreshBtn: $("refresh-btn"),
    kpiTotal: $("kpi-total"),
    kpiTotalNote: $("kpi-total-note"),
    kpiCost: $("kpi-cost"),
    kpiCostNote: $("kpi-cost-note"),
    kpiPl: $("kpi-pl"),
    kpiPlPct: $("kpi-pl-pct"),
    kpiCount: $("kpi-count"),
    kpiTop: $("kpi-top"),
    trendChart: $("trend-chart"),
    trendNote: $("trend-note"),
    allocChart: $("alloc-chart"),
    holdingsBody: $("holdings-body"),
  };

  let selectedCard = null; // normalized card from the API layer
  let cards = new Map(); // cardId -> latest normalized card
  let graded = new Map(); // cardId -> { "10": {price, count}, "9": … } from eBay sales
  let refreshTimer = null;

  /* ---------- formatting ---------- */

  const usdFull = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });
  const usdCompact = new Intl.NumberFormat(undefined, {
    style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1,
  });
  const eurFull = new Intl.NumberFormat(undefined, { style: "currency", currency: "EUR" });

  const fmtUSD = (v, compact) => (compact ? usdCompact.format(v) : usdFull.format(v));
  const fmtMoney = (v, currency) => (currency === "EUR" ? eurFull.format(v) : usdFull.format(v));
  const fmtSigned = (v) => (v >= 0 ? "+" : "−") + usdFull.format(Math.abs(v));
  const fmtPct = (v) => (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(1) + "%";
  const deltaClass = (v) => (v >= 0 ? "delta-up" : "delta-down");
  const slotColor = (slot) => (slot ? `var(--series-${slot})` : "var(--other)");
  const gradeLabel = (g) => (g === "raw" ? "Raw" : "PSA " + g);
  const prettyVariant = (v) =>
    v.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()).replace(/^1st /i, "1st ");

  function cardSub(c) {
    const bits = [];
    if (c.setName) bits.push(c.setName);
    if (c.number) bits.push("#" + c.number);
    return bits.join(" · ");
  }

  /* Value of one card in a position, best source first:
     1. a manual override you set,
     2. the eBay sold-price median for this card AT this grade (needs the free
        PokemonPriceTracker API key — see the gear button),
     3. the raw market price times a rough grade multiplier (an estimate). */
  function valueEach(h) {
    if (h.value != null) return { each: h.value, src: "manual" };
    if (h.grade !== "raw") {
      const g = graded.get(h.cardId)?.[h.grade];
      if (g) return { each: g.price, src: "ebay", count: g.count };
    }
    const price = cards.get(h.cardId)?.price;
    if (price) {
      if (h.grade === "raw") return { each: price.value, src: "raw" };
      return { each: price.value * (GRADE_MULT[h.grade] ?? 1), src: "est" };
    }
    return null;
  }

  /* ---------- banner ---------- */

  function showBanner(msg) {
    els.banner.textContent = msg;
    els.banner.hidden = false;
  }

  function hideBanner() {
    els.banner.hidden = true;
  }

  /* ---------- card search ---------- */

  let searchTimer = null;
  let searchSeq = 0;

  function clearSelection() {
    selectedCard = null;
    els.addBtn.disabled = true;
  }

  function closeResults() {
    els.results.hidden = true;
    els.results.replaceChildren();
  }

  function selectCard(card) {
    selectedCard = card;
    els.search.value = `${card.name} · ${card.setName || ""} #${card.number || "?"}`;
    closeResults();
    els.addBtn.disabled = false;
    els.qty.focus();
  }

  function buildResultItem(c, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "search-item";
    if (c.image) {
      const img = document.createElement("img");
      img.className = "card-thumb";
      img.src = c.image;
      img.alt = "";
      img.loading = "lazy";
      btn.appendChild(img);
    }
    const col = document.createElement("span");
    col.className = "search-col";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = c.name;
    const sub = document.createElement("span");
    sub.className = "sub";
    sub.textContent = [c.setName, c.number ? "#" + c.number : null, c.rarity]
      .filter(Boolean).join(" · ");
    col.append(name, sub);
    btn.appendChild(col);
    if (c.price) {
      const price = document.createElement("span");
      price.className = "rank";
      price.textContent = fmtMoney(c.price.value, c.price.currency);
      btn.appendChild(price);
    }
    btn.addEventListener("click", onClick);
    return btn;
  }

  function renderResults(list) {
    els.results.replaceChildren();
    if (!list.length) {
      const empty = document.createElement("div");
      empty.className = "search-empty";
      empty.textContent = "No cards found";
      els.results.appendChild(empty);
    }
    for (const c of list) {
      els.results.appendChild(buildResultItem(c, () => selectCard(c)));
    }
    els.results.hidden = false;
  }

  function resultsMessage(text) {
    const msg = document.createElement("div");
    msg.className = "search-empty";
    msg.textContent = text;
    els.results.replaceChildren(msg);
    els.results.hidden = false;
  }

  /* Selecting a printing for a slab also pre-fills the grade and cert. */
  function selectCertCard(card, info) {
    selectCard(card);
    if (info.grade && [...els.grade.options].some((o) => o.value === info.grade)) {
      els.grade.value = info.grade;
    }
    els.cert.value = info.cert;
  }

  function certSummary(info) {
    return [info.year, info.brand, info.subject, info.cardNumber ? "#" + info.cardNumber : null]
      .filter(Boolean).join(" · ");
  }

  async function certFlow(cert, seq) {
    resultsMessage(`Looking up PSA cert #${cert}…`);
    let info;
    try {
      info = await API.lookupCert(cert);
    } catch {
      if (seq !== searchSeq) return;
      els.results.replaceChildren();
      const msg = document.createElement("div");
      msg.className = "search-empty";
      msg.appendChild(document.createTextNode(
        "Couldn't read PSA's cert page from here (PSA blocks most automated lookups). "));
      const a = document.createElement("a");
      a.href = "https://www.psacard.com/cert/" + encodeURIComponent(cert);
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "Open cert #" + cert + " on psacard.com";
      msg.appendChild(a);
      msg.appendChild(document.createTextNode(
        " — then search the card by name and paste the cert into the cert field."));
      els.results.replaceChildren(msg);
      els.results.hidden = false;
      return;
    }
    if (seq !== searchSeq) return;

    els.results.replaceChildren();

    // slab summary header
    const head = document.createElement("div");
    head.className = "cert-head";
    const title = document.createElement("span");
    title.className = "name";
    title.textContent = `PSA #${info.cert}` + (info.gradeText ? ` · ${info.gradeText}` : "");
    const sub = document.createElement("span");
    sub.className = "sub";
    sub.textContent = certSummary(info) || "slab details parsed from psacard.com";
    head.append(title, sub);
    els.results.appendChild(head);

    // manual add (always available)
    const manualCard = {
      provider: "manual",
      id: "psa-" + info.cert,
      name: API.certCardQuery(info) || "PSA slab #" + info.cert,
      setName: [info.year, info.brand].filter(Boolean).join(" ") || null,
      number: info.cardNumber || null,
      rarity: null,
      image: null,
      price: null,
    };

    const loading = document.createElement("div");
    loading.className = "search-empty";
    loading.textContent = "Matching this printing in the price catalogs…";
    els.results.appendChild(loading);
    els.results.hidden = false;

    // match against the card catalogs, restricted to the slab's card number —
    // a "Charmander" from a different set is noise, so wrong numbers never show
    let matches = [];
    const q = API.certCardQuery(info);
    if (q) {
      try {
        matches = await API.searchCards(q, { number: info.cardNumber || undefined });
      } catch { /* catalogs unreachable — manual add still works */ }
    }
    if (seq !== searchSeq) return;
    loading.remove();

    const addManual = (label) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "search-item" + (matches.length ? "" : " cert-primary");
      const col = document.createElement("span");
      col.className = "search-col";
      const nm = document.createElement("span");
      nm.className = "name";
      nm.textContent = label;
      const msub = document.createElement("span");
      msub.className = "sub";
      msub.textContent = "grade and cert filled in — set its value with the ✎ button";
      col.append(nm, msub);
      btn.appendChild(col);
      btn.addEventListener("click", () => selectCertCard(manualCard, info));
      return btn;
    };

    if (matches.length) {
      const note = document.createElement("div");
      note.className = "search-empty";
      note.textContent = matches.length === 1
        ? "Tap to add it with live prices:"
        : "Tap the exact printing to add it with live prices:";
      els.results.appendChild(note);
      for (const c of matches.slice(0, 6)) {
        els.results.appendChild(buildResultItem(c, () => selectCertCard(c, info)));
      }
      els.results.appendChild(addManual("Not one of these — add the slab anyway"));
    } else {
      const note = document.createElement("div");
      note.className = "search-empty";
      note.textContent = q
        ? `No catalog printing matches ${info.subject || "this card"}${info.cardNumber ? " #" + info.cardNumber : ""}.`
        : "";
      if (note.textContent) els.results.appendChild(note);
      els.results.appendChild(addManual("➕ Add this slab to your collection"));
    }
    els.results.hidden = false;
  }

  els.search.addEventListener("input", () => {
    clearSelection();
    const q = els.search.value.trim();
    clearTimeout(searchTimer);
    if (q.length < 2) {
      closeResults();
      return;
    }
    searchTimer = setTimeout(async () => {
      const seq = ++searchSeq;
      if (/^\d{6,10}$/.test(q)) {
        certFlow(q, seq);
        return;
      }
      try {
        const list = await API.searchCards(q);
        if (seq === searchSeq) renderResults(list);
      } catch (err) {
        if (seq === searchSeq) {
          resultsMessage(err.rateLimited
            ? "Rate limited — wait a moment and type again"
            : "Both card services are unreachable right now — try again in a minute");
        }
      }
    }, 350);
  });

  document.addEventListener("click", (ev) => {
    if (!els.results.hidden && !els.results.contains(ev.target) && ev.target !== els.search) {
      closeResults();
    }
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") closeResults();
  });

  /* ---------- add position ---------- */

  function numOrNull(input) {
    const v = parseFloat(input.value);
    return Number.isFinite(v) && v > 0 ? v : null;
  }

  els.form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (!selectedCard) {
      els.hint.textContent = "Pick a card from the search results first.";
      els.hint.hidden = false;
      return;
    }
    const qty = Math.floor(parseFloat(els.qty.value));
    if (!(qty > 0)) return;

    Store.upsert({
      cardId: selectedCard.id,
      provider: selectedCard.provider,
      name: selectedCard.name,
      setName: selectedCard.setName,
      number: selectedCard.number,
      image: selectedCard.image,
      grade: els.grade.value,
      qty,
      cost: numOrNull(els.cost),
      value: numOrNull(els.value),
      cert: els.cert.value.trim().replace(/[^\w-]/g, "") || null,
    });
    cards.set(selectedCard.id, selectedCard); // render immediately with what we have

    els.form.reset();
    els.qty.value = "1";
    els.hint.hidden = true;
    clearSelection();
    await refresh();
  });

  els.demoBtn.addEventListener("click", async () => {
    els.demoBtn.disabled = true;
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
        // Seed cost at the estimated value so P/L starts at zero and moves live.
        const est = card.price ? card.price.value * (GRADE_MULT[d.grade] ?? 1) : null;
        Store.upsert({
          cardId: card.id,
          provider: card.provider,
          name: card.name,
          setName: card.setName,
          number: card.number,
          image: card.image,
          grade: d.grade,
          qty: d.qty,
          cost: est != null ? Math.round(est * 100) / 100 : null,
          value: null,
          cert: null,
        });
        cards.set(card.id, card);
        added++;
      }
      if (!added) throw new Error("Could not load demo cards — the card services may be down.");
      await refresh();
    } catch (err) {
      showBanner(err.message || "Could not load demo data.");
    } finally {
      els.demoBtn.disabled = false;
    }
  });

  /* ---------- refresh + render ---------- */

  async function refresh() {
    const holdings = Store.getAll();

    if (!holdings.length) {
      els.dashboard.hidden = true;
      els.empty.hidden = false;
      els.lastUpdated.textContent = "";
      return;
    }
    els.empty.hidden = true;

    // Hold the previous render at reduced opacity while data reloads.
    els.trendChart.classList.add("stale");
    els.allocChart.classList.add("stale");

    try {
      const seen = new Set();
      const refs = [];
      for (const h of holdings) {
        if (seen.has(h.cardId) || h.provider === "manual") continue;
        seen.add(h.cardId);
        refs.push({ provider: h.provider || "ptcgio", id: h.cardId });
      }
      const fresh = refs.length ? await API.getCards(refs) : [];
      for (const c of fresh) cards.set(c.id, c);

      if (fresh.length || !refs.length) {
        hideBanner();
        els.lastUpdated.textContent = "Updated " + new Intl.DateTimeFormat(undefined, {
          hour: "numeric", minute: "2-digit",
        }).format(new Date());
      } else {
        showBanner("Could not reach the card price services — showing the last loaded prices. It retries automatically.");
      }

      // eBay sold prices per grade (only with the free PokemonPriceTracker key)
      if (API.hasGradedKey()) {
        let keyRejected = false;
        await Promise.all(refs.map(async (r) => {
          const card = cards.get(r.id);
          if (!card) return;
          try {
            const g = await API.gradedFor(card);
            if (g) graded.set(r.id, g);
          } catch (err) {
            if (err.unauthorized) keyRejected = true;
            /* limit reached or endpoint change: estimates keep working */
          }
        }));
        if (keyRejected) {
          showBanner("Your graded-prices API key was rejected — update it via the ⚙ button (pokemonpricetracker.com).");
        }
      }
    } catch (err) {
      showBanner(
        (err.rateLimited
          ? "Card API rate limit reached — showing the last loaded prices. "
          : "Could not reach the card price services — showing the last loaded prices. ") +
        "It retries automatically."
      );
    } finally {
      els.trendChart.classList.remove("stale");
      els.allocChart.classList.remove("stale");
    }

    render(holdings);
  }

  function render(holdings) {
    els.dashboard.hidden = false;

    const positions = holdings
      .map((h) => {
        const v = valueEach(h);
        return { h, val: v, total: v ? v.each * h.qty : 0 };
      })
      .sort((a, b) => b.total - a.total);

    /* --- KPIs --- */
    const valued = positions.filter((p) => p.val);
    const total = valued.reduce((s, p) => s + p.total, 0);
    const estCount = valued.filter((p) => p.val.src === "est").length;
    const ebayCount = valued.filter((p) => p.val.src === "ebay").length;
    const unvalued = positions.length - valued.length;

    els.kpiTotal.textContent = fmtUSD(total, false);
    els.kpiTotalNote.textContent =
      unvalued > 0 ? `${unvalued} position${unvalued > 1 ? "s" : ""} missing a value — use ✎` :
      estCount > 0 ? `${estCount} of ${positions.length} estimated` + (API.hasGradedKey() ? "" : " — add an API key (⚙) for real PSA sale prices") :
      ebayCount > 0 ? `${ebayCount} of ${positions.length} from real eBay PSA sales` :
      "all values set manually";

    const withCost = positions.filter((p) => p.h.cost != null);
    const costTotal = withCost.reduce((s, p) => s + p.h.cost * p.h.qty, 0);
    els.kpiCost.textContent = withCost.length ? fmtUSD(costTotal, false) : "–";
    els.kpiCostNote.textContent =
      withCost.length && withCost.length < positions.length
        ? `${withCost.length} of ${positions.length} positions have a paid price`
        : withCost.length ? "" : "add what you paid to track P/L";

    const plPositions = positions.filter((p) => p.h.cost != null && p.val);
    if (plPositions.length) {
      const plCost = plPositions.reduce((s, p) => s + p.h.cost * p.h.qty, 0);
      const plNow = plPositions.reduce((s, p) => s + p.total, 0);
      const pl = plNow - plCost;
      els.kpiPl.textContent = fmtSigned(pl);
      els.kpiPl.className = "stat-value " + deltaClass(pl);
      els.kpiPlPct.textContent = fmtPct(plCost ? (pl / plCost) * 100 : 0) + " vs what you paid";
      els.kpiPlPct.className = "stat-delta " + deltaClass(pl);
    } else {
      els.kpiPl.textContent = "–";
      els.kpiPl.className = "stat-value";
      els.kpiPlPct.textContent = "add paid prices to track P/L";
      els.kpiPlPct.className = "stat-delta muted";
    }

    els.kpiCount.textContent = String(holdings.reduce((s, h) => s + h.qty, 0));
    els.kpiTop.textContent = positions.length && positions[0].val
      ? `top: ${positions[0].h.name} (${gradeLabel(positions[0].h.grade)})`
      : "";

    /* --- value-over-time chart (daily snapshots, grows with use) --- */
    if (total > 0) {
      const byUid = {};
      for (const p of valued) byUid[p.h.uid] = p.total;
      Store.recordSnapshot(Math.round(total * 100) / 100, byUid);
    }
    const snaps = Store.getSnapshots();
    if (snaps.length >= 2) {
      els.trendNote.hidden = true;
      Charts.renderLineChart(
        els.trendChart,
        snaps.map((s) => ({ t: s.t, v: s.total })),
        (v, compact) => fmtUSD(v, compact)
      );
    } else {
      els.trendChart.replaceChildren();
      els.trendNote.textContent =
        "First snapshot saved today — the chart appears once you've checked in on two different days. Prices refresh daily.";
      els.trendNote.hidden = false;
    }

    /* --- allocation --- */
    const slotted = positions.filter((p) => p.h.slot && p.val);
    const otherValue = positions.filter((p) => !p.h.slot && p.val).reduce((s, p) => s + p.total, 0);
    const allocItems = slotted.map((p) => ({
      label: `${p.h.name} · ${gradeLabel(p.h.grade)}`,
      value: p.total,
      color: slotColor(p.h.slot),
    }));
    if (otherValue > 0) allocItems.push({ label: "Other", value: otherValue, color: "var(--other)" });
    Charts.renderAllocationBar(els.allocChart, allocItems, total, (v) => fmtUSD(v, false));

    /* --- collection table --- */
    els.holdingsBody.replaceChildren();
    for (const p of positions) {
      const h = p.h;
      const tr = document.createElement("tr");

      const cardTd = document.createElement("td");
      const cell = document.createElement("div");
      cell.className = "asset-cell";
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = slotColor(h.slot);
      cell.appendChild(dot);
      const image = cards.get(h.cardId)?.image || h.image;
      if (image) {
        const img = document.createElement("img");
        img.className = "card-thumb";
        img.src = image;
        img.alt = "";
        img.loading = "lazy";
        cell.appendChild(img);
      }
      const col = document.createElement("span");
      col.className = "search-col";
      const nm = document.createElement("span");
      nm.className = "name";
      nm.textContent = h.name;
      const sub = document.createElement("span");
      sub.className = "sub";
      sub.textContent = cardSub(h);
      col.append(nm, sub);
      cell.appendChild(col);
      cardTd.appendChild(cell);

      const gradeTd = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = "grade-badge" + (h.grade === "10" ? " grade-gem" : "");
      badge.textContent = gradeLabel(h.grade);
      gradeTd.appendChild(badge);

      const rawTd = document.createElement("td");
      rawTd.className = "num";
      const price = cards.get(h.cardId)?.price;
      if (price) {
        rawTd.textContent = fmtMoney(price.value, price.currency);
        const rsub = document.createElement("span");
        rsub.className = "sub";
        rsub.textContent = prettyVariant(price.variant);
        rawTd.appendChild(rsub);
      } else {
        rawTd.textContent = "–";
      }

      const valTd = document.createElement("td");
      valTd.className = "num";
      const valWrap = document.createElement("span");
      valWrap.className = "val-wrap";
      const valText = document.createElement("span");
      if (p.val) {
        valText.textContent = (p.val.src === "est" ? "~" : "") + fmtUSD(p.val.each, false);
        const vsub = document.createElement("span");
        vsub.className = "sub";
        vsub.textContent =
          p.val.src === "ebay" ? "eBay sales median" + (p.val.count ? ` · ${p.val.count} sales` : "") :
          p.val.src === "est" ? `est. ×${GRADE_MULT[h.grade] ?? 1} of raw` :
          p.val.src === "raw" ? "raw market" :
          "manual";
        valText.appendChild(vsub);
      } else {
        valText.textContent = "–";
      }
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "row-edit";
      editBtn.title = "Set the current per-card value";
      editBtn.setAttribute("aria-label", "Set value for " + h.name);
      editBtn.textContent = "✎";
      editBtn.addEventListener("click", () => {
        const cur = h.value != null ? String(h.value) : "";
        const input = window.prompt(
          `Current value per card for ${h.name} (${gradeLabel(h.grade)}), in USD.\nLeave empty to go back to the automatic estimate.`,
          cur
        );
        if (input === null) return;
        const v = parseFloat(input);
        Store.setValueOverride(h.uid, Number.isFinite(v) && v > 0 ? v : null);
        render(Store.getAll());
      });
      valWrap.append(valText, editBtn);
      valTd.appendChild(valWrap);

      const qtyTd = document.createElement("td");
      qtyTd.className = "num";
      qtyTd.textContent = String(h.qty);

      const costTd = document.createElement("td");
      costTd.className = "num";
      costTd.textContent = h.cost != null ? fmtUSD(h.cost, false) : "–";

      const plTd = document.createElement("td");
      plTd.className = "num";
      if (h.cost != null && p.val) {
        const pl = (p.val.each - h.cost) * h.qty;
        plTd.textContent = fmtSigned(pl);
        plTd.classList.add(deltaClass(pl));
        const psub = document.createElement("span");
        psub.className = "sub";
        psub.textContent = fmtPct(h.cost ? ((p.val.each - h.cost) / h.cost) * 100 : 0);
        plTd.appendChild(psub);
      } else {
        plTd.textContent = "–";
      }

      const certTd = document.createElement("td");
      if (h.cert) {
        const a = document.createElement("a");
        a.href = "https://www.psacard.com/cert/" + encodeURIComponent(h.cert);
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = h.cert;
        certTd.appendChild(a);
      } else {
        certTd.textContent = "–";
        certTd.className = "muted";
      }

      const actTd = document.createElement("td");
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "row-remove";
      rm.title = "Remove " + h.name;
      rm.setAttribute("aria-label", "Remove " + h.name);
      rm.textContent = "×";
      rm.addEventListener("click", () => {
        Store.remove(h.uid);
        refresh();
      });
      actTd.appendChild(rm);

      tr.append(cardTd, gradeTd, rawTd, valTd, qtyTd, costTd, plTd, certTd, actTd);
      els.holdingsBody.appendChild(tr);
    }
  }

  els.refreshBtn.addEventListener("click", () => refresh());

  /* --- settings: free PokemonPriceTracker API key for real PSA sale prices --- */
  document.getElementById("settings-btn").addEventListener("click", () => {
    let current = "";
    try { current = localStorage.getItem("pocketfolio.pptApiKey") || ""; } catch { /* ok */ }
    const input = window.prompt(
      "API key for real PSA graded sale prices (eBay sold medians).\n" +
      "Get a free key (100 lookups/day, no credit card) at:\n" +
      "pokemonpricetracker.com → API\n\n" +
      "Paste your key below — leave empty to remove it.",
      current
    );
    if (input === null) return;
    try {
      const key = input.trim();
      if (key) localStorage.setItem("pocketfolio.pptApiKey", key);
      else {
        localStorage.removeItem("pocketfolio.pptApiKey");
        localStorage.removeItem("pocketfolio.gradedCache.v1");
        graded.clear();
      }
    } catch { /* storage unavailable */ }
    refresh();
  });

  function startAutoRefresh() {
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      if (!document.hidden) refresh();
    }, REFRESH_MS);
  }

  refresh();
  startAutoRefresh();
})();
