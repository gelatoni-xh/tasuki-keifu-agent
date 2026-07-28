import {
  auditMembershipTimelineTool,
  auditPersonNormalizationRiskTool,
  auditPersonalBestConsistencyTool,
  auditProfileCoverageTool,
  checkRelationCacheTool,
  resolvePersonTool,
} from "../tools/person-tools.js";

function assertArrayEqual(label: string, actual: string[], expected: string[]) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} mismatch: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
}

async function main() {
  const report: Array<Record<string, unknown>> = [];

  async function resolveUniquePersonId(personSlug: string) {
    const resolved = await resolvePersonTool({ personSlug });
    if (!resolved.ok || resolved.data?.matchType !== "unique") {
      throw new Error(`resolveUniquePersonId failed for ${personSlug}`);
    }

    return resolved.data.person.personId;
  }

  const resolvedSingle = await resolvePersonTool({ personSlug: "person-e794b0e4b8ad20e6b3a2e69c" });
  if (!resolvedSingle.ok || resolvedSingle.data?.matchType !== "unique") {
    throw new Error("resolvePersonTool unique case failed");
  }
  report.push({ tool: "resolvePersonTool", label: "unique", ok: true });

  const resolvedMultiple = await resolvePersonTool({ personName: "中川拓海" });
  if (!resolvedMultiple.ok || resolvedMultiple.data?.matchType !== "multiple") {
    throw new Error("resolvePersonTool multiple case failed");
  }
  report.push({ tool: "resolvePersonTool", label: "multiple", ok: true });

  const resolvedMissing = await resolvePersonTool({ personSlug: "person-this-slug-should-not-exist-20260728" });
  if (!resolvedMissing.ok || resolvedMissing.data?.matchType !== "not_found") {
    throw new Error("resolvePersonTool not_found case failed");
  }
  report.push({ tool: "resolvePersonTool", label: "not_found", ok: true });

  const profileCoverage = await auditProfileCoverageTool({
    personId: await resolveUniquePersonId("person-e794b0e4b8ad20e6b3a2e69c"),
    personSlug: "person-e794b0e4b8ad20e6b3a2e69c",
  });
  assertArrayEqual(
    "auditProfileCoverageTool",
    profileCoverage.ok && profileCoverage.data ? profileCoverage.data.findings.map((item) => item.code) : [],
    ["profile_coverage_missing_fields"],
  );
  report.push({ tool: "auditProfileCoverageTool", ok: true });

  const membershipTimeline = await auditMembershipTimelineTool({
    personId: await resolveUniquePersonId("person-m-and-a-best-partners-06debb74"),
    personSlug: "person-m-and-a-best-partners-06debb74",
  });
  assertArrayEqual(
    "auditMembershipTimelineTool",
    membershipTimeline.ok && membershipTimeline.data ? membershipTimeline.data.findings.map((item) => item.code) : [],
    ["multiple_current_memberships"],
  );
  report.push({ tool: "auditMembershipTimelineTool", ok: true });

  const normalizationRisk = await auditPersonNormalizationRiskTool({
    personId: await resolveUniquePersonId("person-nittaidai324-1611f58a45b3bd8b24f5"),
    personSlug: "person-nittaidai324-1611f58a45b3bd8b24f5",
    displayNameJa: "小島大輝",
  });
  assertArrayEqual(
    "auditPersonNormalizationRiskTool",
    normalizationRisk.ok && normalizationRisk.data ? normalizationRisk.data.findings.map((item) => item.code) : [],
    ["duplicate_normalized_name"],
  );
  report.push({ tool: "auditPersonNormalizationRiskTool", ok: true });

  const personalBestConsistency = await auditPersonalBestConsistencyTool({
    personId: await resolveUniquePersonId("nakano-shota"),
    personSlug: "nakano-shota",
  });
  assertArrayEqual(
    "auditPersonalBestConsistencyTool",
    personalBestConsistency.ok && personalBestConsistency.data ? personalBestConsistency.data.findings.map((item) => item.code) : [],
    [
      "conflicting_personal_best",
      "conflicting_personal_best",
      "conflicting_personal_best",
    ],
  );
  report.push({ tool: "auditPersonalBestConsistencyTool", ok: true });

  const relationCache = await checkRelationCacheTool({
    personId: await resolveUniquePersonId("person-kao-f94f0d89"),
    personSlug: "person-kao-f94f0d89",
  });
  assertArrayEqual(
    "checkRelationCacheTool",
    relationCache.ok && relationCache.data ? relationCache.data.findings.map((item) => item.code) : [],
    ["relation_cache_stale"],
  );
  report.push({ tool: "checkRelationCacheTool", ok: true });

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
