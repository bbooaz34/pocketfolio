/* Pocketfolio — app wiring: search, holdings, refresh loop, rendering. */

(function () {
  "use strict";

  const API = window.PocketfolioAPI;
  const Store = window.PocketfolioStore;
  const Charts = window.PocketfolioCharts;

  const REFRESH_MS = 120 * 1000; // stay well inside the free-tier rate limit

  const $ = (id) => document.getElementById(id);
  const els = {
    form: $("add-form"),
    search: $("coin-search"),
    results: $("search-results"),
    qty: $("qty-input"),
    cost: $("cost-input"),
    addBtn: $("add-btn"),
    hint: $("form-hint"),
    banner: $("banner"),
    empty: $("empty-state"),
    demoBtn: $("demo-btn"),
    dashboard: $("dashboard"),
    lastUpdated: $("last-updated"),
    refreshBtn: $("refresh-btn"),
    kpiTotal: $("kpi-total"),
    kpiTotalDelta: $("kpi-total-delta"),
    kpi24h: $("kpi-24h"),
    kpi24hPct: $("kpi-24h-pct"),
    kpiPl: $("kpi-pl"),
    kpiPlPct: $("kpi-pl-pct"),
    kpiCount: $("kpi-count"),
    kpiBest: $("kpi-best"),
    trendChart: $("trend-chart"),
    allocChart: $("alloc-chart"),
    holdingsBody: $("holdings-body"),
  };

  let selectedCoin = null; // {id, name, symbol, thumb}
  let markets = new Map(); // coin id -> market row
  let refreshTimer = null;

  /* ---------- formatting ---------- */

  const usdFull = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });
  const usdCompact = new Intl.NumberFormat(undefined, {
    style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1,
  });

  function fmtUSD(v, compact) {
    return compact ? usdCompact.format(v) : usdFull.format(v);
  }

  function fmtPrice(v) {
    if (v >= 1) return usdFull.format(v);
    return new Intl.NumberFormat(undefined, {
      style: "currency", currency: "USD", maximumSignificantDigits: 4,
    }).format(v);
  }

  function fmtQty(v) {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 8 }).format(v);
  }

  function fmtSigned(v, fmt) {
    return (v >= 0 ? "+" : "−") + fmt(Math.abs(v));
  }

  function fmtPct(v) {
    return (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(2) + "%";
  }

  function deltaClass(v) {
    return v >= 0 ? "delta-up" : "delta-down";
  }

  function slotColor(slot) {
    return slot ? `var(--series-${slot})` : "var(--other)";
  }

  /* ---------- banner ---------- */

  function showBanner(msg) {
    els.banner.textContent = msg;
    els.banner.hidden = false;
  }

  function hideBanner() {
    els.banner.hidden = true;
  }

  /* ---------- coin search ---------- */

  let searchTimer = null;
  let searchSeq = 0;

  function clearSelection() {
    selectedCoin = null;
    els.addBtn.disabled = true;
  }

  function closeResults() {
    els.results.hidden = true;
    els.results.replaceChildren();
  }

  function selectCoin(coin) {
    selectedCoin = coin;
    els.search.value = `${coin.name} (${coin.symbol.toUpperCase()})`;
    closeResults();
    els.addBtn.disabled = false;
    els.qty.focus();
  }

  function renderResults(coins) {
    els.results.replaceChildren();
    if (!coins.length) {
      const empty = document.createElement("div");
      empty.className = "search-empty";
      empty.textContent = "No coins found";
      els.results.appendChild(empty);
    }
    for (const c of coins) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "search-item";
      if (c.thumb) {
        const img = document.createElement("img");
        img.src = c.thumb;
        img.alt = "";
        btn.appendChild(img);
      }
      const name = document.createElement("span");
      name.textContent = c.name;
      const sym = document.createElement("span");
      sym.className = "sym";
      sym.textContent = c.symbol;
      btn.append(name, sym);
      if (c.market_cap_rank) {
        const rank = document.createElement("span");
        rank.className = "rank";
        rank.textContent = "#" + c.market_cap_rank;
        btn.appendChild(rank);
      }
      btn.addEventListener("click", () => selectCoin(c));
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
        const coins = await API.searchCoins(q);
        if (seq === searchSeq) renderResults(coins);
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

  /* ---------- add holding ---------- */

  els.form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (!selectedCoin) {
      els.hint.textContent = "Pick an asset from the search results first.";
      els.hint.hidden = false;
      return;
    }
    const qty = parseFloat(els.qty.value);
    if (!(qty > 0)) return;
    const costRaw = parseFloat(els.cost.value);
    const cost = Number.isFinite(costRaw) && costRaw > 0 ? costRaw : null;

    Store.upsert({
      id: selectedCoin.id,
      symbol: selectedCoin.symbol,
      name: selectedCoin.name,
      image: selectedCoin.thumb || null,
      qty,
      cost,
    });

    els.form.reset();
    els.hint.hidden = true;
    clearSelection();
    await refresh(true);
  });

  els.demoBtn.addEventListener("click", async () => {
    els.demoBtn.disabled = true;
    const demo = [
      { id: "bitcoin", symbol: "btc", name: "Bitcoin", qty: 0.1 },
      { id: "ethereum", symbol: "eth", name: "Ethereum", qty: 1.5 },
      { id: "solana", symbol: "sol", name: "Solana", qty: 20 },
    ];
    try {
      // Seed cost basis at the current price so P/L starts at zero and moves live.
      const rows = await API.getMarkets(demo.map((d) => d.id));
      for (const d of demo) {
        const row = rows.find((r) => r.id === d.id);
        Store.upsert({ ...d, image: row?.image || null, cost: row?.current_price ?? null });
      }
      await refresh(true);
    } catch (err) {
      showBanner(err.message || "Could not load demo data.");
    } finally {
      els.demoBtn.disabled = false;
    }
  });

  /* ---------- refresh + render ---------- */

  async function refresh(force) {
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
      const rows = await API.getMarkets(holdings.map((h) => h.id));
      markets = new Map(rows.map((r) => [r.id, r]));
      hideBanner();
      els.lastUpdated.textContent = "Updated " + new Intl.DateTimeFormat(undefined, {
        hour: "numeric", minute: "2-digit",
      }).format(new Date());
    } catch (err) {
      showBanner(
        (err.rateLimited
          ? "CoinGecko rate limit reached — showing the last loaded prices. "
          : "Could not reach CoinGecko — showing the last loaded prices. ") +
        "It retries automatically."
      );
    } finally {
      els.trendChart.classList.remove("stale");
      els.allocChart.classList.remove("stale");
    }

    render(holdings);
  }

  function render(holdings) {
    const priced = holdings
      .map((h) => {
        const m = markets.get(h.id);
        return m ? { h, m, value: h.qty * m.current_price } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.value - a.value);

    els.dashboard.hidden = false;

    if (!priced.length) return; // nothing fetched yet (e.g. first load offline)

    /* --- KPIs --- */
    const total = priced.reduce((s, p) => s + p.value, 0);

    let change24 = 0;
    for (const p of priced) {
      const pct = p.m.price_change_percentage_24h_in_currency;
      if (typeof pct === "number") change24 += p.value - p.value / (1 + pct / 100);
    }
    const change24Pct = total - change24 !== 0 ? (change24 / (total - change24)) * 100 : 0;

    els.kpiTotal.textContent = fmtUSD(total, false);
    els.kpiTotalDelta.textContent = fmtSigned(change24, (v) => fmtUSD(v, false)) + " today";
    els.kpiTotalDelta.className = "stat-delta " + deltaClass(change24);

    els.kpi24h.textContent = fmtSigned(change24, (v) => fmtUSD(v, false));
    els.kpi24h.className = "stat-value " + deltaClass(change24);
    els.kpi24hPct.textContent = fmtPct(change24Pct) + " vs yesterday";
    els.kpi24hPct.className = "stat-delta " + deltaClass(change24);

    const withCost = priced.filter((p) => p.h.cost != null);
    if (withCost.length) {
      const costTotal = withCost.reduce((s, p) => s + p.h.cost * p.h.qty, 0);
      const curTotal = withCost.reduce((s, p) => s + p.value, 0);
      const pl = curTotal - costTotal;
      els.kpiPl.textContent = fmtSigned(pl, (v) => fmtUSD(v, false));
      els.kpiPl.className = "stat-value " + deltaClass(pl);
      els.kpiPlPct.textContent = fmtPct(costTotal ? (pl / costTotal) * 100 : 0) + " vs cost basis";
      els.kpiPlPct.className = "stat-delta " + deltaClass(pl);
    } else {
      els.kpiPl.textContent = "–";
      els.kpiPl.className = "stat-value";
      els.kpiPlPct.textContent = "add buy prices to track P/L";
      els.kpiPlPct.className = "stat-delta muted";
    }

    els.kpiCount.textContent = String(priced.length);
    const best = priced.reduce((a, b) =>
      (b.m.price_change_percentage_24h_in_currency ?? -Infinity) >
      (a.m.price_change_percentage_24h_in_currency ?? -Infinity) ? b : a
    );
    const bestPct = best.m.price_change_percentage_24h_in_currency;
    els.kpiBest.textContent = typeof bestPct === "number"
      ? `best 24h: ${best.h.symbol.toUpperCase()} ${fmtPct(bestPct)}`
      : "";

    /* --- 7d portfolio trend (sum of qty x hourly sparkline price) --- */
    const sparks = priced
      .map((p) => ({ qty: p.h.qty, prices: p.m.sparkline_in_7d?.price || [] }))
      .filter((s) => s.prices.length > 1);
    if (sparks.length) {
      // Series are hourly and end "now"; align them from the end.
      const n = Math.min(...sparks.map((s) => s.prices.length));
      const now = Date.now();
      const stepMs = (7 * 24 * 3600 * 1000) / Math.max(n - 1, 1);
      const points = [];
      for (let i = 0; i < n; i++) {
        let v = 0;
        for (const s of sparks) v += s.qty * s.prices[s.prices.length - n + i];
        points.push({ t: now - (n - 1 - i) * stepMs, v });
      }
      Charts.renderLineChart(els.trendChart, points, (v, compact) => fmtUSD(v, compact));
    }

    /* --- allocation --- */
    const slotted = priced.filter((p) => p.h.slot);
    const otherValue = priced.filter((p) => !p.h.slot).reduce((s, p) => s + p.value, 0);
    const allocItems = slotted.map((p) => ({
      label: p.h.name,
      value: p.value,
      color: slotColor(p.h.slot),
    }));
    if (otherValue > 0) allocItems.push({ label: "Other", value: otherValue, color: "var(--other)" });
    Charts.renderAllocationBar(els.allocChart, allocItems, total, (v) => fmtUSD(v, false));

    /* --- holdings table --- */
    els.holdingsBody.replaceChildren();
    for (const p of priced) {
      const tr = document.createElement("tr");

      const assetTd = document.createElement("td");
      const cell = document.createElement("div");
      cell.className = "asset-cell";
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = slotColor(p.h.slot);
      cell.appendChild(dot);
      if (p.m.image) {
        const img = document.createElement("img");
        img.src = p.m.image;
        img.alt = "";
        img.loading = "lazy";
        cell.appendChild(img);
      }
      const nm = document.createElement("span");
      nm.className = "name";
      nm.textContent = p.m.name || p.h.name;
      const sym = document.createElement("span");
      sym.className = "sym";
      sym.textContent = p.h.symbol;
      cell.append(nm, sym);
      assetTd.appendChild(cell);

      const priceTd = document.createElement("td");
      priceTd.className = "num";
      priceTd.textContent = fmtPrice(p.m.current_price);

      const chgTd = document.createElement("td");
      chgTd.className = "num";
      const pct24 = p.m.price_change_percentage_24h_in_currency;
      if (typeof pct24 === "number") {
        chgTd.textContent = fmtPct(pct24);
        chgTd.classList.add(deltaClass(pct24));
      } else {
        chgTd.textContent = "–";
      }

      const sparkTd = document.createElement("td");
      sparkTd.className = "spark-cell";
      const prices = p.m.sparkline_in_7d?.price || [];
      if (prices.length > 1) sparkTd.appendChild(Charts.renderSparkline(prices));

      const qtyTd = document.createElement("td");
      qtyTd.className = "num";
      qtyTd.textContent = fmtQty(p.h.qty);
      if (p.h.cost != null) {
        const sub = document.createElement("span");
        sub.className = "sub";
        sub.textContent = "@ " + fmtPrice(p.h.cost);
        qtyTd.appendChild(sub);
      }

      const valTd = document.createElement("td");
      valTd.className = "num";
      valTd.textContent = fmtUSD(p.value, false);

      const plTd = document.createElement("td");
      plTd.className = "num";
      if (p.h.cost != null) {
        const pl = (p.m.current_price - p.h.cost) * p.h.qty;
        plTd.textContent = fmtSigned(pl, (v) => fmtUSD(v, false));
        plTd.classList.add(deltaClass(pl));
        const sub = document.createElement("span");
        sub.className = "sub";
        sub.textContent = fmtPct(p.h.cost ? ((p.m.current_price - p.h.cost) / p.h.cost) * 100 : 0);
        plTd.appendChild(sub);
      } else {
        plTd.textContent = "–";
      }

      const actTd = document.createElement("td");
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "row-remove";
      rm.title = "Remove " + p.h.name;
      rm.setAttribute("aria-label", "Remove " + p.h.name);
      rm.textContent = "×";
      rm.addEventListener("click", () => {
        Store.remove(p.h.id);
        refresh(true);
      });
      actTd.appendChild(rm);

      tr.append(assetTd, priceTd, chgTd, sparkTd, qtyTd, valTd, plTd, actTd);
      els.holdingsBody.appendChild(tr);
    }
  }

  els.refreshBtn.addEventListener("click", () => refresh(true));

  function startAutoRefresh() {
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      if (!document.hidden) refresh(false);
    }, REFRESH_MS);
  }

  refresh(true);
  startAutoRefresh();
})();
