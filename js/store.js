/* Pocketfolio — holdings persistence (localStorage only; nothing leaves the browser).
   A holding: { id, symbol, name, image, qty, cost, slot }
   - cost is the average buy price per unit in USD, or null if untracked.
   - slot is the categorical color slot (1-7), assigned once when the asset is
     first added and kept for its lifetime: color follows the entity, never its rank. */

(function () {
  "use strict";

  const KEY = "pocketfolio.holdings.v1";
  const MAX_SLOTS = 7;

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list.filter((h) => h && h.id && h.qty > 0) : [];
    } catch {
      return [];
    }
  }

  function save(holdings) {
    try {
      localStorage.setItem(KEY, JSON.stringify(holdings));
    } catch {
      /* storage unavailable (private mode) — app still works for the session */
    }
  }

  let holdings = load();

  function getAll() {
    return holdings.slice();
  }

  function nextFreeSlot() {
    const used = new Set(holdings.map((h) => h.slot).filter(Boolean));
    for (let s = 1; s <= MAX_SLOTS; s++) if (!used.has(s)) return s;
    return null; // more than 7 assets: rendered as "Other" in the allocation chart
  }

  /** Add a holding, merging with an existing position in the same asset
      (quantities add up; cost basis becomes the weighted average). */
  function upsert({ id, symbol, name, image, qty, cost }) {
    const existing = holdings.find((h) => h.id === id);
    if (existing) {
      const totalQty = existing.qty + qty;
      if (existing.cost != null && cost != null) {
        existing.cost = (existing.cost * existing.qty + cost * qty) / totalQty;
      } else if (cost != null && existing.cost == null) {
        existing.cost = cost; // best effort: apply known cost to the merged position
      }
      existing.qty = totalQty;
    } else {
      holdings.push({ id, symbol, name, image, qty, cost: cost ?? null, slot: nextFreeSlot() });
    }
    save(holdings);
  }

  function remove(id) {
    holdings = holdings.filter((h) => h.id !== id);
    save(holdings);
  }

  window.PocketfolioStore = { getAll, upsert, remove };
})();
