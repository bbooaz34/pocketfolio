/* Pocketfolio — hand-rolled SVG charts (no chart library).
   Marks follow the house spec: 2px lines, hairline solid gridlines, area fills
   at ~10% opacity, 2px surface gaps between stacked segments, crosshair +
   tooltip on the line chart, per-segment tooltips on the allocation bar. */

(function () {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";

  function el(name, attrs, parent) {
    const node = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
    if (parent) parent.appendChild(node);
    return node;
  }

  /* ---------- tooltip (one shared element; content built with textContent) ---------- */

  const tip = () => document.getElementById("tooltip");

  function showTip(clientX, clientY, rows) {
    const t = tip();
    t.replaceChildren();
    for (const row of rows) {
      const div = document.createElement("div");
      div.className = row.cls || "tip-sub";
      if (row.keyColor) {
        const key = document.createElement("span");
        key.className = "tip-key";
        key.style.background = row.keyColor;
        div.appendChild(key);
      }
      div.appendChild(document.createTextNode(row.text));
      t.appendChild(div);
    }
    t.hidden = false;
    const pad = 12;
    const r = t.getBoundingClientRect();
    let x = clientX + pad;
    let y = clientY - r.height - pad;
    if (x + r.width > window.innerWidth - 8) x = clientX - r.width - pad;
    if (y < 8) y = clientY + pad;
    t.style.left = x + "px";
    t.style.top = y + "px";
  }

  function hideTip() {
    tip().hidden = true;
  }

  /* ---------- nice axis ticks ---------- */

  function niceTicks(min, max, count) {
    if (min === max) {
      const pad = Math.abs(min) * 0.05 || 1;
      min -= pad;
      max += pad;
    }
    const span = max - min;
    const step0 = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const norm = step0 / mag;
    const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
    const lo = Math.floor(min / step) * step;
    const ticks = [];
    for (let v = lo; v <= max + step * 0.5; v += step) {
      if (v >= min - step * 0.5) ticks.push(v);
    }
    return ticks;
  }

  /* ---------- line chart: portfolio value over 7 days ---------- */

  /** points: [{t: epoch ms, v: usd}] — single series, so no legend box.
      opts.compact renders the 96px axis-less trend used on the card detail. */
  function renderLineChart(host, points, fmtValue, opts) {
    host.replaceChildren();
    if (points.length < 2) return;
    const compact = !!(opts && opts.compact);

    const W = compact ? 326 : 620;
    const H = compact ? 96 : 230;
    const M = compact
      ? { top: 6, right: 4, bottom: 6, left: 4 }
      : { top: 12, right: 16, bottom: 26, left: 52 };
    const iw = W - M.left - M.right;
    const ih = H - M.top - M.bottom;

    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" });
    svg.setAttribute("aria-label", (opts && opts.label) || "מגמת שווי");

    const vs = points.map((p) => p.v);
    const vMin = Math.min(...vs);
    const vMax = Math.max(...vs);
    const ticks = niceTicks(vMin, vMax, 4);
    const yLo = Math.min(vMin, ticks[0]);
    const yHi = Math.max(vMax, ticks[ticks.length - 1]);
    const t0 = points[0].t;
    const t1 = points[points.length - 1].t;

    const x = (t) => M.left + ((t - t0) / (t1 - t0)) * iw;
    const y = (v) => M.top + (1 - (v - yLo) / (yHi - yLo || 1)) * ih;

    // gridlines + y tick labels (solid hairlines, recessive)
    if (!compact) for (const tv of ticks) {
      el("line", {
        x1: M.left, x2: W - M.right, y1: y(tv), y2: y(tv),
        stroke: "var(--surface-muted)", "stroke-width": 1,
      }, svg);
      const label = el("text", {
        x: M.left - 8, y: y(tv) + 3.5, "text-anchor": "end",
        fill: "var(--ink-faint)", "font-size": 10.5,
        style: "font-variant-numeric: tabular-nums",
      }, svg);
      label.textContent = fmtValue(tv, true);
    }

    // x tick labels: first point of each day, thinned to at most ~7 labels,
    // weekday names for short spans and month+day beyond a week
    const spanDays = (t1 - t0) / (24 * 3600 * 1000);
    const dayFmt = new Intl.DateTimeFormat(undefined,
      spanDays <= 8 ? { weekday: "short" } : { month: "short", day: "numeric" });
    const dayFirsts = [];
    const seen = new Set();
    for (const p of points) {
      const day = new Date(p.t).toDateString();
      if (seen.has(day)) continue;
      seen.add(day);
      dayFirsts.push(p);
    }
    const labelled = dayFirsts.length > 1 ? dayFirsts.slice(1) : dayFirsts; // skip a partial first day
    const step = Math.max(1, Math.ceil(labelled.length / 7));
    if (!compact) for (let i = 0; i < labelled.length; i += step) {
      const p = labelled[i];
      const label = el("text", {
        x: x(p.t), y: H - 8, "text-anchor": "middle",
        fill: "var(--ink-faint)", "font-size": 10.5,
      }, svg);
      label.textContent = dayFmt.format(new Date(p.t));
    }

    // area wash + line
    const lineD = points.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(2)},${y(p.v).toFixed(2)}`).join("");
    el("path", {
      d: `${lineD}L${x(t1).toFixed(2)},${(M.top + ih).toFixed(2)}L${x(t0).toFixed(2)},${(M.top + ih).toFixed(2)}Z`,
      fill: "var(--primary)", opacity: 0.07,
    }, svg);
    el("path", {
      d: lineD, fill: "none", stroke: "var(--primary)",
      "stroke-width": 2.2, "stroke-linejoin": "round", "stroke-linecap": "round",
    }, svg);

    // end marker: 8px dot with a 2px surface ring
    const last = points[points.length - 1];
    el("circle", { cx: x(last.t), cy: y(last.v), r: 6, fill: "var(--surface)" }, svg);
    el("circle", { cx: x(last.t), cy: y(last.v), r: 4, fill: "var(--primary)" }, svg);

    // hover layer: crosshair snaps to the nearest point; tooltip follows
    const crosshair = el("line", {
      y1: M.top, y2: M.top + ih, stroke: "var(--border)", "stroke-width": 1, visibility: "hidden",
    }, svg);
    const hoverOuter = el("circle", { r: 6, fill: "var(--surface)", visibility: "hidden" }, svg);
    const hoverDot = el("circle", { r: 4, fill: "var(--primary)", visibility: "hidden" }, svg);
    const overlay = el("rect", {
      x: M.left, y: M.top, width: iw, height: ih, fill: "transparent",
    }, svg);

    const tipFmt = new Intl.DateTimeFormat(undefined, {
      weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    });

    function onMove(ev) {
      const rect = svg.getBoundingClientRect();
      const px = ((ev.clientX - rect.left) / rect.width) * W;
      const t = t0 + ((px - M.left) / iw) * (t1 - t0);
      let best = 0, bestD = Infinity;
      for (let i = 0; i < points.length; i++) {
        const d = Math.abs(points[i].t - t);
        if (d < bestD) { bestD = d; best = i; }
      }
      const p = points[best];
      crosshair.setAttribute("x1", x(p.t));
      crosshair.setAttribute("x2", x(p.t));
      crosshair.setAttribute("visibility", "visible");
      hoverOuter.setAttribute("cx", x(p.t));
      hoverOuter.setAttribute("cy", y(p.v));
      hoverOuter.setAttribute("visibility", "visible");
      hoverDot.setAttribute("cx", x(p.t));
      hoverDot.setAttribute("cy", y(p.v));
      hoverDot.setAttribute("visibility", "visible");
      showTip(ev.clientX, ev.clientY, [
        { text: tipFmt.format(new Date(p.t)), cls: "tip-title" },
        { text: fmtValue(p.v, false), cls: "tip-value" },
      ]);
    }

    function onLeave() {
      crosshair.setAttribute("visibility", "hidden");
      hoverOuter.setAttribute("visibility", "hidden");
      hoverDot.setAttribute("visibility", "hidden");
      hideTip();
    }

    overlay.addEventListener("pointermove", onMove);
    overlay.addEventListener("pointerleave", onLeave);

    host.appendChild(svg);
  }

  /* ---------- allocation: horizontal 100% stacked bar + legend ---------- */

  /** items: [{label, symbol, value, color}] sorted by value desc, tail already
      folded into "Other". Gaps between segments are the surface showing through. */
  function renderAllocationBar(host, items, total, fmtValue) {
    host.replaceChildren();
    if (!total) return;

    const bar = document.createElement("div");
    bar.className = "alloc-bar";
    bar.style.cssText = "display:flex;gap:2px;height:20px;border-radius:6px;overflow:hidden;";
    bar.setAttribute("role", "img");
    bar.setAttribute("aria-label", "Portfolio allocation by value");

    const legend = document.createElement("div");
    legend.className = "alloc-legend";

    for (const it of items) {
      const pct = (it.value / total) * 100;

      const seg = document.createElement("div");
      seg.style.background = it.color;
      seg.style.flexGrow = String(it.value);
      seg.style.flexBasis = "0";
      seg.style.minWidth = "3px";
      seg.tabIndex = 0;
      const lift = (on) => { seg.style.filter = on ? "brightness(1.15)" : ""; };
      seg.addEventListener("pointermove", (ev) => {
        lift(true);
        showTip(ev.clientX, ev.clientY, [
          { text: fmtValue(it.value, false) + "  ·  " + pct.toFixed(1) + "%", cls: "tip-value" },
          { text: it.label, cls: "tip-sub", keyColor: it.color },
        ]);
      });
      seg.addEventListener("pointerleave", () => { lift(false); hideTip(); });
      seg.addEventListener("focus", () => {
        lift(true);
        const r = seg.getBoundingClientRect();
        showTip(r.left + r.width / 2, r.top, [
          { text: fmtValue(it.value, false) + "  ·  " + pct.toFixed(1) + "%", cls: "tip-value" },
          { text: it.label, cls: "tip-sub", keyColor: it.color },
        ]);
      });
      seg.addEventListener("blur", () => { lift(false); hideTip(); });
      bar.appendChild(seg);

      const row = document.createElement("div");
      row.className = "legend-row";
      const swatch = document.createElement("span");
      swatch.className = "legend-swatch";
      swatch.style.background = it.color;
      const name = document.createElement("span");
      name.textContent = it.label;
      const pctEl = document.createElement("span");
      pctEl.className = "pct";
      pctEl.textContent = pct.toFixed(1) + "%";
      row.append(swatch, name, pctEl);
      legend.appendChild(row);
    }

    host.append(bar, legend);
  }

  /* ---------- table sparkline (de-emphasis line, accent end dot) ---------- */

  function renderSparkline(values, w = 88, h = 26) {
    const svg = el("svg", { viewBox: `0 0 ${w} ${h}`, width: w, height: h, "aria-hidden": "true" });
    if (values.length < 2) return svg;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const pad = 3;
    const x = (i) => pad + (i / (values.length - 1)) * (w - pad * 2);
    const y = (v) => pad + (1 - (v - min) / (max - min || 1)) * (h - pad * 2);
    const d = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
    el("path", {
      d, fill: "none", stroke: "var(--ink-faint)",
      "stroke-width": 1.5, "stroke-linejoin": "round", "stroke-linecap": "round", opacity: 0.8,
    }, svg);
    const li = values.length - 1;
    el("circle", { cx: x(li), cy: y(values[li]), r: 3.5, fill: "var(--surface)" }, svg);
    el("circle", { cx: x(li), cy: y(values[li]), r: 2.2, fill: "var(--primary)" }, svg);
    return svg;
  }

  window.PocketfolioCharts = { renderLineChart, renderAllocationBar, renderSparkline };
})();
