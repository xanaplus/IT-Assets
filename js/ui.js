// Shared UI helpers for Xana pages (browser global `XanaUI`).
// Single canonical implementation of the display helpers that were
// copy-pasted across index.html, assets/index.html, admin/index.html and
// summary/app.js. Pages alias what they need (e.g. `const { esc } = XanaUI`)
// so call sites stay unchanged.
//
// Deliberately NOT unified here: statusColor.
//   - summary/app.js uses exact-key STATUS_COLORS (dashboard semantics;
//     unknown statuses fall back to blue).
//   - assets/index.html and scanner-app/logic.js use substring matching
//     ("In Repair" and legacy "Under Repair"/"Broken" all read red).
// Merging those would silently recolor pills. Each keeps its own map;
// see also docs/decisions for why dashboard and register differ.
(function () {
  "use strict";

  var CURRENCY = "KES";

  // HTML-escape for interpolated asset data. Null-safe: null/undefined -> "".
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // Grouped money, e.g. "KES 4,233,750". Handles null (-> 0) and negatives
  // (-> "KES -5"). Superset of the older assets-page variant.
  function money(n, currency) {
    var cur = currency || CURRENCY;
    var v = n == null ? 0 : n;
    return cur + " " + (v < 0 ? "-" : "") + Math.round(Math.abs(v)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  // KPI-sized money: currency stays full-size and inherits the value color,
  // with the gap carried by .cur margin so the pair never wraps. Value is built by this file, hence HTML.
  function moneyKpi(n, currency) {
    var full = money(n, currency);
    var sp = full.indexOf(" ");
    if (sp < 0) return esc(full);
    return '<span class="cur">' + esc(full.slice(0, sp)) + "</span>" + esc(full.slice(sp + 1));
  }

  var CSV_DQ = String.fromCharCode(34);
  var CSV_TICK = String.fromCharCode(39);
  // Explicit list, not a character class: "[=+-@]" reads + to @ as a RANGE,
  // which swallows every digit and would prefix every number in the export.
  var CSV_RISKY = ["=", "+", "-", "@", String.fromCharCode(9), String.fromCharCode(13)];

  // CSV cell that cannot execute as a spreadsheet formula (=, +, -, @, tab).
  // Identical to scanner-app/logic.js csvCell (kept there too: logic.js is
  // Node-compatible and covered by unit tests; this copy serves pages).
  function csvCell(v) {
    var s = String(v == null ? "" : v);
    if (CSV_RISKY.indexOf(s.charAt(0)) > -1) s = CSV_TICK + s;
    return CSV_DQ + s.split(CSV_DQ).join(CSV_DQ + CSV_DQ) + CSV_DQ;
  }

  // ---- Theme ----------------------------------------------------------------
  // Until the user picks one with the toggle, follow the device setting (and
  // keep following it live). Each page's <head> runs the same resolution
  // inline before first paint; this owns the toggle and later changes.
  var THEME_KEY = "xana_theme";
  var darkQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  function storedTheme() {
    try {
      var t = localStorage.getItem(THEME_KEY);
      return t === "dark" || t === "light" ? t : null;
    } catch (e) { return null; }
  }
  function systemTheme() { return darkQuery && darkQuery.matches ? "dark" : "light"; }

  // <meta name="color-scheme"> mirrors the resolved theme so the canvas and
  // native UI paint in the right scheme before any stylesheet has loaded.
  function applyTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    var meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.content = t;
    var tog = document.getElementById("themeToggle");
    if (tog) tog.setAttribute("aria-checked", t === "dark");
  }

  function initTheme() {
    applyTheme(storedTheme() || systemTheme());
    if (darkQuery && darkQuery.addEventListener) {
      darkQuery.addEventListener("change", function () { if (!storedTheme()) applyTheme(systemTheme()); });
    }
    // Another tab flipped the theme: follow it.
    window.addEventListener("storage", function (e) {
      if (e.key === THEME_KEY || e.key === null) applyTheme(storedTheme() || systemTheme());
    });
    var tog = document.getElementById("themeToggle");
    if (tog && !tog.dataset.themeBound) {
      tog.dataset.themeBound = "1";
      tog.addEventListener("click", function () {
        // Flip what is on screen. Landing back on the device setting is
        // "undo my override": clear the key so the page follows the device
        // again, instead of silently pinning it. (Only checked here, at
        // toggle time — a stored choice the OS later matches is kept.)
        var next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
        applyTheme(next);
        try {
          if (next === systemTheme()) localStorage.removeItem(THEME_KEY);
          else localStorage.setItem(THEME_KEY, next);
        } catch (e) { /* private mode: still flips */ }
      });
    }
  }

  // ---- Modal dialogs ---------------------------------------------------------
  // Native <dialog> opened with showModal(): the browser supplies the inert
  // page, focus trap, Esc/back-gesture close and focus return to the invoker.
  // closedby="any" adds click-outside; Safari lacks it, so test the pointer
  // position there (not event.target: the dialog is also the target for its
  // own padding). Press and release must both land outside, so a text
  // selection dragged onto the backdrop doesn't dismiss. While data-busy is
  // set (work in flight) every user close path is refused.
  function lightDismissFallback(dlg) {
    if ("closedBy" in HTMLDialogElement.prototype) return;
    var outside = function (e) {
      var r = dlg.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    var pressedOutside = false;
    dlg.addEventListener("pointerdown", function (e) { pressedOutside = outside(e); });
    dlg.addEventListener("pointerup", function (e) {
      if (pressedOutside && outside(e) && !dlg.hasAttribute("data-busy")) dlg.close();
    });
  }

  // opts: { id, html, labelledBy | label, className, width }. Returns the
  // <dialog>; it removes itself from the DOM once closed (after the exit fade).
  function openModal(opts) {
    var old = document.getElementById(opts.id);
    if (old) old.remove();
    var dlg = document.createElement("dialog");
    dlg.id = opts.id;
    dlg.className = "xdlg" + (opts.className ? " " + opts.className : "");
    dlg.setAttribute("closedby", "any");
    if (opts.labelledBy) dlg.setAttribute("aria-labelledby", opts.labelledBy);
    else if (opts.label) dlg.setAttribute("aria-label", opts.label);
    if (opts.width) dlg.style.width = opts.width;
    dlg.innerHTML = opts.html;
    dlg.addEventListener("cancel", function (e) { if (dlg.hasAttribute("data-busy")) e.preventDefault(); });
    dlg.addEventListener("close", function () { setTimeout(function () { dlg.remove(); }, 200); });
    document.body.appendChild(dlg);
    lightDismissFallback(dlg);
    dlg.showModal();
    return dlg;
  }

  window.XanaUI = {
    CURRENCY: CURRENCY,
    initTheme: initTheme,
    openModal: openModal,
    esc: esc,
    money: money,
    moneyKpi: moneyKpi,
    csvCell: csvCell,
  };
})();
