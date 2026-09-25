/* Pocketfolio — persistence (localStorage only; nothing leaves the browser).
   A holding is one graded position:
   { uid, cardId, name, setName, number, image, grade ("10".."1" | "raw"),
     qty, cost, value, cert, slot }
   - uid = cardId + ":" + grade — the same card in two grades is two positions.
   - cost is the average purchase price per card in USD, or null.
   - value is a manual per-card value override in USD (what graded copies
     actually sell for), or null to use the estimate from the raw price.
   - cert is a PSA certification number (display + verification link only).
   - slot is the categorical color slot (1-7), assigned once when the position
     is first added: color follows the entity, never its rank.

   Snapshots record collection value once per day so a history chart can grow:
   { day: "YYYY-MM-DD", t, total, byUid: {uid: value} } */

(function () {
  "use strict";

  const KEY = "pocketfolio.tcg.holdings.v1";
  const SNAP_KEY = "pocketfolio.tcg.snapshots.v1";
  const MAX_SLOTS = 7;
  const MAX_SNAPSHOTS = 365;

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      const val = raw ? JSON.parse(raw) : fallback;
      return Array.isArray(val) ? val : fallback;
    } catch {
      return fallback;
    }
  }

  function saveJSON(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch {
      /* storage unavailable (private mode) — app still works for the session */
    }
  }

  let holdings = loadJSON(KEY, []).filter((h) => h && h.uid && h.qty > 0);
  let snapshots = loadJSON(SNAP_KEY, []);

  /* migration for the snapshot-pricing model (POCKETFOLIO-PRICING.md §4).
     A manual market price is a stopgap, not an override: it carries when it
     was typed so the next snapshot built after that supersedes it on its own.
     Legacy values get an ancient manualSetAt so the first snapshot takes over.
     Pinning is gone — a number that cannot be superseded is a number that
     goes stale in silence, which is what this model exists to prevent — so a
     stored valuePinned is simply dropped. */
  let migrated = false;
  for (const hh of holdings) {
    if (hh.value !== undefined) {
      if (hh.manualValue === undefined) hh.manualValue = hh.value;
      delete hh.value;
      migrated = true;
    }
    if (hh.valueSetAt !== undefined) {
      if (hh.manualSetAt === undefined) hh.manualSetAt = hh.valueSetAt;
      delete hh.valueSetAt;
      migrated = true;
    }
    if (hh.valuePinned !== undefined) { delete hh.valuePinned; migrated = true; }
    if (hh.manualValue != null && !hh.manualSetAt) { hh.manualSetAt = "1970-01-01T00:00:00Z"; migrated = true; }
    if (hh.manualValue === undefined) { hh.manualValue = null; migrated = true; }
    /* a real "unknown": existing holdings are never given a guessed date */
    if (hh.purchaseDate === undefined) { hh.purchaseDate = null; migrated = true; }
    if (hh.addedAt === undefined) { hh.addedAt = 0; migrated = true; }
  }
  if (migrated) saveJSON(KEY, holdings);

  function getAll() {
    return holdings.slice();
  }

  function nextFreeSlot() {
    const used = new Set(holdings.map((h) => h.slot).filter(Boolean));
    for (let s = 1; s <= MAX_SLOTS; s++) if (!used.has(s)) return s;
    return null; // more than 7 positions: rendered as "Other" in the allocation chart
  }

  /** Add a position, merging with an existing one for the same card + grade
      (quantities add up; cost becomes the weighted average; a provided value
      override or cert replaces the stored one). */
  function upsert(pos) {
    const uid = pos.cardId + ":" + pos.grade;
    const existing = holdings.find((h) => h.uid === uid);
    if (existing) {
      const totalQty = existing.qty + pos.qty;
      if (existing.cost != null && pos.cost != null) {
        existing.cost = (existing.cost * existing.qty + pos.cost * pos.qty) / totalQty;
      } else if (pos.cost != null) {
        existing.cost = pos.cost;
      }
      existing.qty = totalQty;
      if (pos.manualValue != null) {
        existing.manualValue = pos.manualValue;
        existing.manualSetAt = new Date().toISOString();
      }
      if (pos.purchaseDate) existing.purchaseDate = pos.purchaseDate;
      if (pos.cert) existing.cert = pos.cert;
      if (pos.psaTitle) existing.psaTitle = pos.psaTitle;
      if (pos.jp) existing.jp = true;
    } else {
      holdings.push({
        uid,
        cardId: pos.cardId,
        provider: pos.provider || "ptcgio",
        name: pos.name,
        setName: pos.setName || null,
        number: pos.number || null,
        image: pos.image || null,
        grade: pos.grade,
        qty: pos.qty,
        cost: pos.cost ?? null,
        manualValue: pos.manualValue ?? null,
        manualSetAt: pos.manualValue != null ? new Date().toISOString() : null,
        purchaseDate: pos.purchaseDate || null,
        cert: pos.cert || null,
        /* the PSA label title, read from the cert page — the eBay search
           string for a graded price (TASK-ebay-direct.md §0) */
        psaTitle: pos.psaTitle || null,
        /* a Japanese print prices from the snapshot's "<cardId>@jp" entry */
        jp: !!pos.jp,
        slot: nextFreeSlot(),
        addedAt: Date.now(),
      });
    }
    saveJSON(KEY, holdings);
  }

  function remove(uid) {
    holdings = holdings.filter((h) => h.uid !== uid);
    saveJSON(KEY, holdings);
  }

  /** The purchase-details sheet writes all three fields at once. `undefined`
      leaves a field alone; `null` clears it — clearing the manual value is how
      the user returns to the market number without waiting for a snapshot.
      A cost of 0 is a real answer (the card was free), so only `null` is
      "unknown". */
  function setPurchase(uid, patch) {
    const h = holdings.find((x) => x.uid === uid);
    if (!h) return;
    if (patch.cost !== undefined) h.cost = patch.cost;
    if (patch.purchaseDate !== undefined) h.purchaseDate = patch.purchaseDate || null;
    if (patch.manualValue !== undefined) {
      h.manualValue = patch.manualValue;
      h.manualSetAt = patch.manualValue != null ? new Date().toISOString() : null;
    }
    saveJSON(KEY, holdings);
  }

  /** Record today's collection value (replaces an earlier snapshot from today). */
  function recordSnapshot(total, byUid) {
    const now = new Date();
    const day = now.getFullYear() + "-" +
      String(now.getMonth() + 1).padStart(2, "0") + "-" +
      String(now.getDate()).padStart(2, "0");
    snapshots = snapshots.filter((s) => s.day !== day);
    snapshots.push({ day, t: now.getTime(), total, byUid });
    snapshots.sort((a, b) => a.t - b.t);
    if (snapshots.length > MAX_SNAPSHOTS) snapshots = snapshots.slice(-MAX_SNAPSHOTS);
    saveJSON(SNAP_KEY, snapshots);
  }

  function getSnapshots() {
    return snapshots.slice();
  }

  /** Wipe all collection data (holdings + value-history snapshots). */
  function clearAll() {
    holdings = [];
    snapshots = [];
    try {
      localStorage.removeItem(KEY);
      localStorage.removeItem(SNAP_KEY);
    } catch { /* storage unavailable */ }
  }

  window.PocketfolioStore = { getAll, upsert, remove, setPurchase, recordSnapshot, getSnapshots, clearAll };
})();
