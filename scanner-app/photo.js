// Xana asset photos - pure helpers (no DOM, no network). Loaded by the app as
// a global `XanaPhoto` and by tests via require(). Mirrors the inline logic in
// assets/index.html (compressImageToDataUrl) and js/supabase-client.js
// (deleteAssetImage) so the math stays covered by `npm test`.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.XanaPhoto = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Fit (width x height) inside max on the longest side. Never upscales.
  function computeDownscale(width, height, max) {
    var m = max === undefined ? 1280 : max;
    var w = Number(width) || 0;
    var h = Number(height) || 0;
    if (w <= 0 || h <= 0) return { width: 0, height: 0 };
    var s = Math.min(1, m / Math.max(w, h));
    return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
  }

  // "https://xxx.supabase.co/storage/v1/object/public/asset-images/XL-1/a.jpg?x"
  // -> "XL-1/a.jpg". Returns null when the URL is not a bucket URL.
  function storagePathFromImageUrl(imageUrl) {
    var m = String(imageUrl || "").match(/\/asset-images\/(.+?)([?#].*)?$/);
    if (!m) return null;
    try {
      return decodeURIComponent(m[1]);
    } catch (_) {
      return m[1];
    }
  }

  // Photos are always re-encoded to JPEG by the uploader, so the stored name
  // always ends in .jpg regardless of what the phone called the file.
  function safePhotoName(name) {
    return String(name || "asset").replace(/\.\w+$/, "") + ".jpg";
  }

  // Approximate KB of a base64 data URL (what the add-sheet label shows).
  function estimateDataUrlKb(dataUrl) {
    return Math.round((String(dataUrl || "").length * 3) / 4 / 1024);
  }

  // Same storage path on re-upload: bust the browser cache for one view.
  function cacheBustedUrl(url, v) {
    var stamp = v === undefined ? Date.now() : v;
    var u = String(url || "");
    if (!u) return u;
    return u + (u.indexOf("?") === -1 ? "?" : "&") + "v=" + stamp;
  }

  return {
    computeDownscale: computeDownscale,
    storagePathFromImageUrl: storagePathFromImageUrl,
    safePhotoName: safePhotoName,
    estimateDataUrlKb: estimateDataUrlKb,
    cacheBustedUrl: cacheBustedUrl,
  };
});
