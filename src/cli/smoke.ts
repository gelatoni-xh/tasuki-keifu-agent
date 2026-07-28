import { runPersonDiagnosis } from "../graph/run.js";
import { diagnosisSamplePool } from "./diagnosis-sample-pool.js";

async function main() {
  const results: Array<Record<string, unknown>> = [];

  for (const item of diagnosisSamplePool) {
    const result = await runPersonDiagnosis(item.input);
    const runtimeStatusOk = result.state.runtimeStatus === item.expectedRuntimeStatus;
    const resolutionStatusOk =
      item.expectedResolutionStatus === undefined || result.state.resolutionStatus === item.expectedResolutionStatus;
    const issueCountOk = item.expectedIssueCount === undefined || result.state.findings.length === item.expectedIssueCount;
    const actionCountOk = item.expectedActionCount === undefined || result.state.actions.length === item.expectedActionCount;
    const issueCodesOk =
      item.expectedIssueCodes === undefined ||
      JSON.stringify(result.state.findings.map((issue) => issue.code)) === JSON.stringify(item.expectedIssueCodes);
    const actionCodesOk =
      item.expectedActionCodes === undefined ||
      JSON.stringify(result.state.actions.map((action) => action.code)) === JSON.stringify(item.expectedActionCodes);
    results.push({
      label: item.label,
      runtimeStatus: result.state.runtimeStatus,
      resolutionStatus: result.state.resolutionStatus,
      issueCount: result.state.findings.length,
      actionCount: result.state.actions.length,
      ok: runtimeStatusOk && resolutionStatusOk && issueCountOk && actionCountOk && issueCodesOk && actionCodesOk,
    });
  }

  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
