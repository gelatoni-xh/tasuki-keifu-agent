import { runPersonDiagnosis } from "../graph/run.js";

function assertArrayEqual(label: string, actual: string[], expected: string[]) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} mismatch: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
}

async function main() {
  const report: Array<Record<string, unknown>> = [];

  const single = await runPersonDiagnosis({ personSlug: "person-e794b0e4b8ad20e6b3a2e69c" });
  assertArrayEqual("single-person nodeHistory", single.state.runtimeNodeHistory, [
    "resolve_person",
    "load_person_snapshot",
    "check_profile_coverage",
    "check_membership_timeline",
    "check_person_normalization_risk",
    "check_personal_best_consistency",
    "check_relation_cache_status",
    "summarize_findings",
    "build_action_plan",
  ]);
  report.push({ label: "single-person", ok: true });

  const clarification = await runPersonDiagnosis({ personName: "中川拓海" });
  assertArrayEqual("clarification-needed nodeHistory", clarification.state.runtimeNodeHistory, ["resolve_person"]);
  report.push({ label: "clarification-needed", ok: true });

  const clarified = await runPersonDiagnosis({
    personName: "中川拓海",
    clarification: "person-nittaidai324-5e12a45e5b3a94345664",
  });
  assertArrayEqual("clarified-duplicate-name nodeHistory", clarified.state.runtimeNodeHistory, [
    "resolve_person",
    "clarification",
    "resolve_person",
    "load_person_snapshot",
    "check_profile_coverage",
    "check_membership_timeline",
    "check_person_normalization_risk",
    "check_personal_best_consistency",
    "check_relation_cache_status",
    "summarize_findings",
    "build_action_plan",
  ]);
  report.push({ label: "clarified-duplicate-name", ok: true });

  const notFound = await runPersonDiagnosis({ personSlug: "person-this-slug-should-not-exist-20260728" });
  assertArrayEqual("not-found nodeHistory", notFound.state.runtimeNodeHistory, ["resolve_person"]);
  report.push({ label: "not-found", ok: true });

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
