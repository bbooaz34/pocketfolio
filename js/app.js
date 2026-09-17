/* Pocketfolio — app wiring: card search, graded positions, refresh, rendering. */

(function () {
  "use strict";

  const API = window.PocketfolioAPI;
  const Store = window.PocketfolioStore;
  const Charts = window.PocketfolioCharts;

  const REFRESH_MS = 30 * 60 * 1000; // TCGplayer prices update daily

  /* Rough grade multipliers applied to the raw TCGplayer market price when a
     position has no manual value. Clearly labeled "est." in the UI — graded
     premiums vary wildly per card, so real sale prices always win. */
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

  let selectedCard = null; // full card object from the API
  let cards = new Map(); // cardId -> latest card data
  let refreshTimer = null;

  /* ---------- formatting ---------- */

  const usdFull = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });
  const usdCompact = new Intl.NumberFormat(undefined, {
    style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1,
  });

  const fmtUSD = (v, compact) => (compact ? usdCompact.format(v) : usdFull.format(v));
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

  /* Value of one card in a position: manual override wins, otherwise the raw
     market price times the grade multiplier (an estimate). */
  function valueEach(h) {
    if (h.value != null) return { each: h.value, est: false };
    const card = cards.get(h.cardId);
    const raw = card ? API.rawPrice(card) : null;
    if (raw) return { each: raw.price * (GRADE_MULT[h.grade] ?? 1), est: true };
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
    els.search.value = `${card.name} · ${card.set?.name || ""} #${card.number || "?"}`;
    closeResults();
    els.addBtn.disabled = false;
    els.qty.focus();
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
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "search-item";
      if (c.images?.small) {
        const img = document.createElement("img");
        img.className = "card-thumb";
        img.src = c.images.small;
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
      sub.textContent = [c.set?.name, c.number ? "#" + c.number : null, c.rarity]
        .filter(Boolean).join(" · ");
      col.append(name, sub);
      btn.appendChild(col);
      const raw = API.rawPrice(c);
      if (raw) {
        const price = document.createElement("span");
        price.className = "rank";
        price.textContent = fmtUSD(raw.price, false);
        btn.appendChild(price);
      }
      btn.addEventListener("click", () => selectCard(c));
      els.results.appendChild(btn);
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
      try {
        const list = await API.searchCards(q);
        if (seq === searchSeq) renderResults(list);
      } catch (err) {
        if (seq === searchSeq) {
          els.results.replaceChildren();
          const msg = document.createElement("div");
          msg.className = "search-empty";
          msg.textContent = err.rateLimited ? "Rate limited — wait a moment" : "Search failed — check your connection";
          els.results.appendChild(msg);
          els.results.hidden = false;
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
      name: selectedCard.name,
      setName: selectedCard.set?.name || null,
      number: selectedCard.number || null,
      image: selectedCard.images?.small || null,
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
      { id: "base1-4", name: "Charizard", grade: "9", qty: 1 },
      { id: "base1-2", name: "Blastoise", grade: "8", qty: 1 },
      { id: "base1-58", name: "Pikachu", grade: "10", qty: 2 },
    ];
    try {
      const rows = await API.getCards(demo.map((d) => d.id));
      for (const d of demo) {
        const card = rows.find((r) => r.id === d.id);
        if (!card) continue;
        const raw = API.rawPrice(card);
        // Seed cost at the estimated value so P/L starts at zero and moves live.
        const est = raw ? raw.price * (GRADE_MULT[d.grade] ?? 1) : null;
        Store.upsert({
          cardId: card.id,
          name: card.name,
          setName: card.set?.name || null,
          number: card.number || null,
          image: card.images?.small || null,
          grade: d.grade,
          qty: d.qty,
          cost: est != null ? Math.round(est * 100) / 100 : null,
          value: null,
          cert: null,
        });
      }
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
      const ids = [...new Set(holdings.map((h) => h.cardId))];
      const rows = await API.getCards(ids);
      for (const r of rows) cards.set(r.id, r);
      hideBanner();
      els.lastUpdated.textContent = "Updated " + new Intl.DateTimeFormat(undefined, {
        hour: "numeric", minute: "2-digit",
      }).format(new Date());
    } catch (err) {
      showBanner(
        (err.rateLimited
          ? "Pokémon TCG API rate limit reached — showing the last loaded prices. "
          : "Could not reach the Pokémon TCG API — showing the last loaded prices. ") +
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
    const estCount = valued.filter((p) => p.val.est).length;
    const unvalued = positions.length - valued.length;

    els.kpiTotal.textContent = fmtUSD(total, false);
    els.kpiTotalNote.textContent =
      unvalued > 0 ? `${unvalued} position${unvalued > 1 ? "s" : ""} missing a value — use ✎` :
      estCount > 0 ? `${estCount} of ${positions.length} estimated from raw price` :
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
        "First snapshot saved today — the chart appears once you've checked in on two different days. Prices refresh daily (TCGplayer).";
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
      if (h.image) {
        const img = document.createElement("img");
        img.className = "card-thumb";
        img.src = h.image;
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
      const card = cards.get(h.cardId);
      const raw = card ? API.rawPrice(card) : null;
      if (raw) {
        rawTd.textContent = fmtUSD(raw.price, false);
        const rsub = document.createElement("span");
        rsub.className = "sub";
        rsub.textContent = prettyVariant(raw.variant);
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
        valText.textContent = (p.val.est ? "~" : "") + fmtUSD(p.val.each, false);
        const vsub = document.createElement("span");
        vsub.className = "sub";
        vsub.textContent = p.val.est
          ? `est. ×${GRADE_MULT[h.grade] ?? 1} of raw`
          : "manual";
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

  function startAutoRefresh() {
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      if (!document.hidden) refresh();
    }, REFRESH_MS);
  }

  refresh();
  startAutoRefresh();
})();
