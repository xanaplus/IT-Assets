"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const P = require("../photo.js");

test("computeDownscale fits the longest side to max", () => {
  assert.deepStrictEqual(P.computeDownscale(4032, 3024), { width: 1280, height: 960 });
  assert.deepStrictEqual(P.computeDownscale(3024, 4032), { width: 960, height: 1280 });
});

test("computeDownscale never upscales small images", () => {
  assert.deepStrictEqual(P.computeDownscale(800, 600), { width: 800, height: 600 });
  assert.deepStrictEqual(P.computeDownscale(1280, 1280), { width: 1280, height: 1280 });
});

test("computeDownscale guards bad input", () => {
  assert.deepStrictEqual(P.computeDownscale(0, 100), { width: 0, height: 0 });
  assert.deepStrictEqual(P.computeDownscale(null, undefined), { width: 0, height: 0 });
});

test("storagePathFromImageUrl extracts the bucket path", () => {
  assert.strictEqual(
    P.storagePathFromImageUrl("https://irqrnyixizzorvfmtvag.supabase.co/storage/v1/object/public/asset-images/XL-12/asset.jpg"),
    "XL-12/asset.jpg",
  );
});

test("storagePathFromImageUrl strips query strings and decodes", () => {
  assert.strictEqual(
    P.storagePathFromImageUrl("https://x.supabase.co/storage/v1/object/public/asset-images/XL-1/a.jpg?v=123"),
    "XL-1/a.jpg",
  );
  assert.strictEqual(
    P.storagePathFromImageUrl("https://x.supabase.co/storage/v1/object/public/asset-images/XL-1/my%20photo.jpg"),
    "XL-1/my photo.jpg",
  );
});

test("storagePathFromImageUrl returns null for non-bucket URLs", () => {
  assert.strictEqual(P.storagePathFromImageUrl(""), null);
  assert.strictEqual(P.storagePathFromImageUrl(null), null);
  assert.strictEqual(P.storagePathFromImageUrl("https://example.com/pic.jpg"), null);
});

test("safePhotoName always ends in .jpg", () => {
  assert.strictEqual(P.safePhotoName("IMG_2026.HEIC"), "IMG_2026.jpg");
  assert.strictEqual(P.safePhotoName("asset.jpg"), "asset.jpg");
  assert.strictEqual(P.safePhotoName("noext"), "noext.jpg");
  assert.strictEqual(P.safePhotoName(""), "asset.jpg");
  assert.strictEqual(P.safePhotoName(null), "asset.jpg");
});

test("estimateDataUrlKb approximates base64 size", () => {
  // 1365 chars base64 ~= 1 KB
  assert.strictEqual(P.estimateDataUrlKb("a".repeat(1365)), 1);
  assert.strictEqual(P.estimateDataUrlKb(""), 0);
  assert.strictEqual(P.estimateDataUrlKb(null), 0);
});

test("cacheBustedUrl appends a version param", () => {
  assert.strictEqual(P.cacheBustedUrl("https://x/a.jpg", 42), "https://x/a.jpg?v=42");
  assert.strictEqual(P.cacheBustedUrl("https://x/a.jpg?tok=1", 42), "https://x/a.jpg?tok=1&v=42");
  assert.strictEqual(P.cacheBustedUrl("", 42), "");
});
