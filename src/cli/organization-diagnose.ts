import { env } from "../config/env.js";
import { recordAgentEvent } from "../db/repositories.js";
import { runOrganizationDiagnosis } from "../graph/organization-run.js";
import { executeAction } from "../governance/action-executor.js";
import { toJson } from "../lib/json.js";

function readArg(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

async function main() {
  const organizationSlug = readArg("--organization-slug");
  const organizationId = readArg("--organization-id");
  const organizationName = readArg("--organization-name");
  const execute = process.argv.includes("--execute");

  if (!organizationSlug && !organizationId && !organizationName) {
    process.stderr.write(
      "Usage: npm run diagnose:organization -- --organization-slug <slug>\n"
      + "   or: npm run diagnose:organization -- --organization-id <id>\n"
      + "   or: npm run diagnose:organization -- --organization-name <name>\n",
    );
    process.exitCode = 1;
    return;
  }

  const result = await runOrganizationDiagnosis({ organizationSlug, organizationId, organizationName });
  const actionResults: Array<Record<string, unknown>> = [];
  const writeEnabled = env.TASUKI_AGENT_WRITE_ENABLED?.trim().toLowerCase() === "true"
    && Boolean(env.TASUKI_KEIFU_BUSINESS_WRITE_DATABASE_URL?.trim());

  if (execute && result.state.actionRiskAssessment?.executionStatus === "planned" && writeEnabled) {
    for (const action of result.state.actionBundle?.items ?? []) {
      const executionResult = await executeAction(action);
      actionResults.push({ code: action.code, status: "succeeded", result: executionResult });
      await recordAgentEvent({
        runId: result.runId,
        nodeName: "execute_action_bundle",
        level: "info",
        message: "action_succeeded",
        payload: { action, result: executionResult },
      });
    }
  } else if (execute) {
    actionResults.push({
      status: "skipped",
      reason: writeEnabled
        ? result.state.actionRiskAssessment?.executionStatus ?? "no_planned_action"
        : "write_mode_not_enabled",
    });
  }

  process.stdout.write(`${toJson({
    runId: result.runId,
    threadId: result.threadId,
    runtimeStatus: result.state.runtimeStatus,
    resolutionStatus: result.state.resolutionStatus,
    targetOrganizationId: result.state.targetOrganizationId,
    targetOrganizationSlug: result.state.targetOrganizationSlug,
    targetOrganizationNameJa: result.state.targetOrganizationNameJa,
    findings: result.state.findings,
    actions: result.state.actions,
    actionBundle: result.state.actionBundle,
    actionRiskAssessment: result.state.actionRiskAssessment,
    referenceStats: result.state.referenceStats,
    resultSummary: result.state.resultSummary,
    resultNotes: result.state.resultNotes,
    actionResults,
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
