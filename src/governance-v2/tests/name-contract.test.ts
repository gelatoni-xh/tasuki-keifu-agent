import assert from "node:assert/strict";
import test from "node:test";
import { normalizePersonDisplayNameJa } from "../rules.js";

test("kanji display names remove inter-name whitespace", () => {
  assert.equal(normalizePersonDisplayNameJa("山田 太郎"), "山田太郎");
  assert.equal(normalizePersonDisplayNameJa("鄭　文皓"), "鄭文皓");
  assert.equal(normalizePersonDisplayNameJa("  西田  壮志  "), "西田壮志");
});

test("katakana and other non-Han names retain normalized separators", () => {
  assert.equal(normalizePersonDisplayNameJa("ジョンソン　モゲニ"), "ジョンソン モゲニ");
  assert.equal(normalizePersonDisplayNameJa("John   Smith"), "John Smith");
  assert.equal(normalizePersonDisplayNameJa("DEJEN Tesufalemweldu"), "DEJEN Tesufalemweldu");
  assert.equal(normalizePersonDisplayNameJa("Александр Иванов"), "Александр Иванов");
});
