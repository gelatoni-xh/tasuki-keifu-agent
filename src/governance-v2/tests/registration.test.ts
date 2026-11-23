import assert from "node:assert/strict";
import test from "node:test";
import { canonicalAssociation, decideAssociation, japanRaceDate } from "../registration.js";
import { batchInputSchema, emptyMetrics, type Context, type Resolution } from "../contracts.js";
import { verifyFacts } from "../agents.js";

test("all 47 prefectures have one spelling; Hokkaido and gakuren retain their labels", () => {
  const names = "北海道 青森県 岩手県 宮城県 秋田県 山形県 福島県 茨城県 栃木県 群馬県 埼玉県 千葉県 東京都 神奈川県 新潟県 富山県 石川県 福井県 山梨県 長野県 岐阜県 静岡県 愛知県 三重県 滋賀県 京都府 大阪府 兵庫県 奈良県 和歌山県 鳥取県 島根県 岡山県 広島県 山口県 徳島県 香川県 愛媛県 高知県 福岡県 佐賀県 長崎県 熊本県 大分県 宮崎県 鹿児島県 沖縄県".split(" ");
  assert.equal(names.length, 47);
  for (const name of names) {
    const expected = name === "北海道" ? name : name.slice(0, -1);
    assert.equal(canonicalAssociation(`　${name}　`), expected);
    assert.equal(canonicalAssociation(expected), expected);
  }
  assert.equal(canonicalAssociation("学連"), "学連");
  for (const bad of ["北海", "東京府", "東京都県", "不明県", ""]) assert.equal(canonicalAssociation(bad), undefined);
});

test("association dates use the Japanese race day, not the UTC day or ingestion time", () => {
  assert.equal(japanRaceDate("2026-10-16T23:30:00Z"), "2026-10-17");
  assert.equal(japanRaceDate(null), undefined);
});

test("latest documented value wins in either import order; missing/same-day contradictions stay unresolved", () => {
  const evidence = [{ value: "東京都", asOf: "2025-10-18" }];
  const decide = (value: string, date?: string, reliability = 4) => decideAssociation("東京", value, date, evidence, reliability).action;
  assert.equal(decide("大阪", "2024-10-19"), "keep");
  assert.equal(decide("大阪", "2026-10-17"), "write");
  assert.equal(decide("大阪", "2025-10-18"), "unresolved");
  assert.equal(decide("東京", "2026-10-17"), "write"); // advance evidence even when unchanged
  assert.equal(decide("東京", "2025-10-18"), "keep");
  assert.equal(decide("大阪"), "unresolved");
  assert.equal(decide("大阪", "2026-02-30"), "unresolved");
  assert.equal(decide("大阪", "2026-10-17", 2), "unresolved");
  assert.equal(decideAssociation("東京", "大阪", "2026-10-17", [], 4).action, "unresolved");
  assert.equal(decideAssociation("東京", "東京", "2026-10-17", [], 4).action, "write");
  assert.equal(decideAssociation(null, "東京", undefined, [], 4).action, "unresolved");
});

test("fact graph canonicalizes and dates writes and does not apply ambiguous duplicate rows", () => {
  const input = batchInputSchema.parse({ unitType: "leg", unitKey: "1", sequence: 0, sourceId: "s", raceSlug: "r", organizations: [],
    rows: [{ key: "a", name: "選手", registeredPrefecture: "東京都" }] });
  const ctx: Context = { raceId: "r", raceDate: "2026-10-16", associationSourceDate: "2026-10-17", editionId: "e",
    source: { id: "s", reliability: 4 }, sources: [], organizations: [], people: [{ id: "p", slug: "p", displayNameJa: "選手" }],
    memberships: [], pbs: [], sourceMappings: [] };
  const res: Resolution = { organizationMap: {}, personMap: { a: "p", b: "p" }, findings: [], changes: [], metrics: emptyMetrics() };
  assert.deepEqual(verifyFacts("b", input, ctx, res).changes[0].operation,
    { kind: "person_fact", personId: "p", field: "registeredPrefecture", value: "東京", asOf: "2026-10-17" });
  input.rows.push({ ...input.rows[0], key: "b", registeredPrefecture: "大阪府" });
  const conflict = verifyFacts("b", input, ctx, res);
  assert.equal(conflict.changes.length, 0);
  assert.equal(conflict.findings.length, 2);
});
