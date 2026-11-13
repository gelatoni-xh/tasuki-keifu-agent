import assert from "node:assert/strict";
import test from "node:test";
import {
  academicWindow,
  adjacentSchoolWindow,
  fillUnknownDates,
  markMillis,
  membershipConflict,
  shouldUpdatePB,
} from "../rules.js";
import {
  batchInputSchema,
  manifestSchema,
  type Membership,
} from "../contracts.js";
import { governMemberships, verifyFacts } from "../agents.js";
import { parseMailConfig } from "../notifications.js";
import type { Context, Resolution } from "../contracts.js";

const membership = (overrides: Partial<Membership> = {}): Membership => ({
  id: "m",
  personId: "p",
  organizationId: "h",
  type: "enrolled",
  organizationType: "high_school",
  startBasis: "unknown",
  endBasis: "unknown",
  endState: "unknown",
  ...overrides,
});
test("academic year boundary and reciprocal school anchors", () => {
  assert.equal(
    academicWindow("university", 1, "2024-03-31")?.startDate,
    "2023-04-01",
  );
  assert.equal(
    academicWindow("university", 1, "2024-04-01")?.startDate,
    "2024-04-01",
  );
  assert.equal(academicWindow("high_school", 4, "2024-04-01"), null);
  assert.equal(academicWindow("club", 1, "2024-04-01"), null);
  assert.equal(
    adjacentSchoolWindow("university", [
      membership({ endDate: "2024-03-31", endBasis: "source" }),
    ])?.endDate,
    "2028-03-31",
  );
  assert.equal(
    adjacentSchoolWindow("high_school", [
      membership({
        organizationType: "university",
        startDate: "2024-04-01",
        startBasis: "source",
      }),
    ])?.startDate,
    "2021-04-01",
  );
  assert.equal(
    adjacentSchoolWindow("high_school", [
      membership({
        organizationType: "university",
        startDate: "2024-04-01",
        startBasis: "inferred",
      }),
    ]),
    null,
  );
});
test("inference fills blanks and does not treat estimates as facts or end employment", () => {
  const old = membership({ startDate: "2022-04-01", startBasis: "source" });
  const next = fillUnknownDates(old, {
    startDate: "2021-04-01",
    endDate: "2024-03-31",
    startBasis: "inferred",
    endBasis: "inferred",
    endState: "unknown",
  });
  assert.equal(next.startDate, "2022-04-01");
  assert.equal(next.endState, "unknown");
  assert.equal(
    membershipConflict(
      membership({ organizationType: "corporate_team" }),
      membership({
        organizationId: "other",
        organizationType: "corporate_team",
      }),
    ),
    false,
  );
});
test("PB parser refuses uncertain text and source recency cannot worsen PB", () => {
  assert.equal(markMillis("２８:３０.５０"), 1710500);
  for (const s of ["28:??", "28:99", "DNF", "28分30秒?", "0"])
    assert.equal(markMillis(s), null);
  assert.equal(
    shouldUpdatePB(1720000, 5, { markMillis: 1700000, reliability: 4 }),
    false,
  );
  assert.equal(
    shouldUpdatePB(1690000, 4, { markMillis: 1700000, reliability: 4 }),
    true,
  );
  assert.equal(shouldUpdatePB(1690000, 1), false);
});
test("manifest rejects duplicate units and withdrawn qualifier before database access", () => {
  const batch = batchInputSchema.parse({
    unitType: "leg",
    unitKey: "1",
    sequence: 0,
    sourceId: "s",
    raceSlug: "race-1",
    organizations: [],
    rows: [{ key: "r", name: "選手" }],
  });
  assert.equal(
    manifestSchema.safeParse({
      version: "event-governance/1",
      requestKey: "r",
      eventEditionId: "e",
      batches: [batch, batch],
    }).success,
    false,
  );
  assert.equal(
    batchInputSchema.safeParse({
      ...batch,
      raceSlug: "hakone-qualifier-103-leg-1",
    }).success,
    false,
  );
});
const ctx: Context = {
  raceId: "race",
  raceDate: "2024-11-01",
  editionId: "e",
  source: { id: "s", reliability: 4 },
  sources: [{ id: "s", reliability: 4 }],
  organizations: [],
  people: [],
  memberships: [],
  pbs: [],
  sourceMappings: [],
};
const res: Resolution = {
  organizationMap: { u: "u", h: "h" },
  personMap: { r: "p" },
  changes: [],
  findings: [],
  metrics: {
    ruleDecisions: 0,
    llmCalls: 0,
    networkCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    llmModels: [],
    durationMs: 0,
    stoppedReasons: [],
  },
};
test("college race grade must not be applied to the athlete's high school", async () => {
  const input = batchInputSchema.parse({
    unitType: "leg",
    unitKey: "1",
    sequence: 0,
    sourceId: "s",
    raceSlug: "race",
    organizations: [
      { key: "u", name: "大学", type: "university" },
      { key: "h", name: "高校", type: "high_school" },
    ],
    rows: [
      {
        key: "r",
        name: "選手",
        organizationKey: "u",
        grade: 1,
        memberships: [
          { organizationKey: "u", type: "enrolled" },
          { organizationKey: "h", type: "enrolled" },
        ],
      },
    ],
  });
  const result = await governMemberships("b", input, ctx, res, async () => {
    assert.fail("Ordinary memberships must not research");
  });
  const highSchool = result.changes
    .map((c) => c.operation)
    .find(
      (o) => o.kind === "membership" && o.membership.organizationId === "h",
    );
  assert.equal(
    highSchool?.kind === "membership"
      ? highSchool.membership.startDate
      : undefined,
    "2021-04-01",
  );
  assert.equal(result.metrics.llmCalls, 0);
});
test("ordinary empty or uncertain facts never invoke research or create a problem", () => {
  const input = batchInputSchema.parse({
    unitType: "leg",
    unitKey: "1",
    sequence: 0,
    sourceId: "s",
    raceSlug: "race",
    organizations: [],
    rows: [
      {
        key: "r",
        name: "選手",
        pbs: [{ discipline: "m10000", mark: "28:??" }],
      },
    ],
  });
  const facts = verifyFacts("b", input, ctx, res);
  assert.equal(facts.changes.length, 0);
  assert.equal(facts.findings.length, 0);
  assert.equal(facts.metrics.llmCalls, 0);
});

test("source dates may correct estimates without treating ordinary blank fields as research", () => {
  const updated = fillUnknownDates(
    membership({ startDate: "2021-04-01", startBasis: "inferred" }),
    {
      startDate: "2022-04-01",
      startBasis: "source",
      endBasis: "unknown",
      endState: "unknown",
    },
  );
  assert.equal(updated.startDate, "2022-04-01");
  assert.equal(updated.startBasis, "source");
});
test("explicit exclusive employment can conflict; ordinary club memberships may coexist", () => {
  const a = membership({
    organizationType: "corporate_team",
    type: "affiliated",
    exclusivityGroup: "employment",
    startDate: "2020-04-01",
    startBasis: "source",
    endState: "ongoing",
  });
  const b = membership({
    ...a,
    id: "other",
    organizationId: "other-team",
    startDate: "2022-04-01",
  });
  assert.equal(membershipConflict(a, b), true);
  assert.equal(
    membershipConflict(
      { ...a, exclusivityGroup: undefined },
      { ...b, exclusivityGroup: undefined },
    ),
    false,
  );
});

test("historical school evidence matches university entrant without research; incompatible cohorts do not auto-match", async () => {
  const { normalizePeople } = await import("../agents.js");
  const input = batchInputSchema.parse({
    unitType: "leg",
    unitKey: "1",
    sequence: 0,
    sourceId: "s",
    raceSlug: "race",
    organizations: [
      { key: "u", name: "大学", type: "university" },
      { key: "h", name: "高校", type: "high_school" },
    ],
    rows: [
      {
        key: "r",
        name: "選手",
        organizationKey: "u",
        grade: 1,
        memberships: [
          { organizationKey: "h", type: "graduated" },
          { organizationKey: "u", type: "enrolled" },
        ],
      },
    ],
  });
  const person = { id: "p", slug: "p", displayNameJa: "選手" };
  const result = await normalizePeople(
    "b",
    input,
    { ...ctx, people: [person], memberships: [membership()] },
    res,
    async () => {
      assert.fail("Known school should resolve by rule");
    },
  );
  assert.equal(result.personMap.r, "p");
  let called = false;
  const different = await normalizePeople(
    "b",
    input,
    {
      ...ctx,
      people: [person],
      memberships: [
        membership({
          organizationId: "u",
          organizationType: "university",
          startDate: "2010-04-01",
          endDate: "2014-03-31",
          startBasis: "source",
          endBasis: "source",
        }),
      ],
    },
    res,
    async () => {
      called = true;
      return { evidence: [], stopReason: "insufficient_evidence" };
    },
  );
  assert.equal(called, true);
  assert.notEqual(different.personMap.r, "p");
  assert.equal(different.findings[0].status, "unresolved");
});

test("batch mail uses natural language and does not claim dry run repairs", async () => {
  const { batchReportText } = await import("../notifications.js");
  const body = batchReportText({
    taskId: "t",
    mode: "dry_run",
    summary: { plannedRows: 44, importedRows: 0, repairs: 0, plannedRepairs: 2, unresolved: 1 },
    unresolved: [
      { subjectRef: "選手", reason: "官方资料不足，保留独立来源档案" },
    ],
  });
  assert.match(body, /修复 0 项/);
  assert.match(body, /输入 44 条/);
  assert.match(body, /计划修复 2 项/);
  assert.match(body, /官方资料不足/);
  assert.doesNotMatch(body, /"subjectRef"/);
});
test("governance mail accepts gelatoni-xh MAIL_CONFIG shapes", () => {
  assert.deepEqual(
    parseMailConfig(
      JSON.stringify({
        provider: "smtp",
        host: "smtp.163.com",
        port: 465,
        username: "sender@example.com",
        password: "app-password",
        from: "sender@example.com",
        to: "recipient@example.com",
      }),
    ),
    {
      provider: "smtp",
      host: "smtp.163.com",
      port: 465,
      username: "sender@example.com",
      password: "app-password",
      from: "sender@example.com",
      to: "recipient@example.com",
    },
  );
  assert.equal(
    parseMailConfig(
      JSON.stringify({
        provider: "resend",
        api_key: "key",
        from: "Reports <reports@example.com>",
        to: "recipient@example.com",
      }),
    ).provider,
    "resend",
  );
  assert.throws(() => parseMailConfig('{"provider":"smtp"}'), /requires/);
});
