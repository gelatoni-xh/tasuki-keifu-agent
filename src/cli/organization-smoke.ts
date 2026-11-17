import { runOrganizationDiagnosis } from "../graph/organization-run.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  const result = await runOrganizationDiagnosis({ organizationSlug: "aoyama-gakuin-university" });
  const state = result.state;

  assert(state.runtimeStatus === "completed", "organization smoke should complete");
  assert(state.runtimeNodeHistory.includes("check_organization_normalization_risk"), "normalization node was not visited");
  assert(!state.runtimeNodeHistory.includes("research_organization_identity"), "non-collision organization must not enter LLM research");
  assert(
    !state.findings.some((finding) => finding.code === "duplicate_normalized_organization_name"),
    "non-collision organization unexpectedly produced a normalization finding",
  );
  assert(
    state.actionRiskAssessment?.executionStatus === "skipped" && state.actionRiskAssessment.level === "low",
    "non-collision organization should not create a normalization action",
  );

  process.stdout.write(`${JSON.stringify({ label: "organization-no-normalization-collision", ok: true }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
