import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { Finding } from "./contracts.js";

export type Report = {
  taskId: string;
  mode: string;
  status: string;
  importedRows: number;
  plannedRows: number;
  changes: number;
  repairs: number;
  plannedRepairs: number;
  unresolved: number;
  completedBatches: number;
  totalBatches: number;
  unresolvedDetails: Array<{
    reason: string;
    subjectRef: string;
    code: string;
  }>;
  error?: string;
};
export function reportText(report: Report) {
  return [
    `赛事治理 ${report.status}（${report.mode}）`,
    `任务：${report.taskId}`,
    `批次：${report.completedBatches}/${report.totalBatches}`,
    `导入 ${report.importedRows} 条；计划 ${report.plannedRows} 条；修复 ${report.repairs ?? 0} 项；计划修复 ${report.plannedRepairs ?? 0} 项；unresolved ${report.unresolved} 项。`,
    ...(report.error ? [`运行异常：${report.error}`] : []),
    ...report.unresolvedDetails.map((f) => `- ${f.subjectRef}：${f.reason}`),
  ].join("\n");
}
export function batchReportText(payload: {
  taskId?: string;
  batchId?: string;
  mode?: string;
  reason?: string;
  summary?: Record<string, unknown>;
  unresolved?: Array<{ subjectRef: string; reason: string }>;
}) {
  const s = payload.summary;
  return [
    "批次治理需要关注",
    `任务：${payload.taskId ?? "未知"}；批次：${payload.batchId ?? "见站点任务记录"}`,
    ...(s
      ? [
          `导入 ${s.importedRows ?? 0} 条；修复 ${s.repairs ?? 0} 项；计划修复 ${s.plannedRepairs ?? 0} 项；unresolved ${s.unresolved ?? payload.unresolved?.length ?? 0} 项。`,
        ]
      : []),
    ...(payload.reason
      ? [
          `运行异常：${payload.reason}。本批未完成，后续批次已停止，可排查后重试。`,
        ]
      : []),
    ...(payload.unresolved ?? []).map((f) => `- ${f.subjectRef}：${f.reason}`),
    ...(!payload.reason
      ? ["上述未解决事项已保留证据，未阻断数据写入；dry_run 仅记录计划。"]
      : []),
  ].join("\n");
}
export async function enqueueReport(
  c: { query: Pool["query"] },
  owner: { taskId?: string; batchId?: string },
  kind: string,
  key: string,
  payload: unknown,
) {
  await c.query(
    'INSERT INTO governance."NotificationDelivery" (id,"eventTaskId","batchId",kind,"dedupeKey",payload) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT("dedupeKey") DO NOTHING',
    [
      randomUUID(),
      owner.taskId ?? null,
      owner.batchId ?? null,
      kind,
      key,
      payload,
    ],
  );
}
export function needsAttention(findings: Finding[]) {
  return findings.some(
    (f) => f.status === "unresolved" && f.severity === "serious",
  );
}
export type MailTransport = (message: {
  subject: string;
  text: string;
  messageId: string;
}) => Promise<void>;
export async function deliverNotifications(
  pool: Pool,
  transport: MailTransport,
  limit = 20,
) {
  let sent = 0;
  for (let i = 0; i < limit; i++) {
    const token = randomUUID();
    const row = (
      await pool.query(
        `UPDATE governance."NotificationDelivery" SET status='sending',"leaseToken"=$1,"leaseUntil"=clock_timestamp()+interval '120 seconds',"attemptCount"="attemptCount"+1 WHERE id=(SELECT id FROM governance."NotificationDelivery" WHERE ((status IN ('pending','failed') AND "nextAttemptAt"<=clock_timestamp()) OR (status='sending' AND "leaseUntil"<clock_timestamp())) ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,
        [token],
      )
    ).rows[0];
    if (!row) break;
    try {
      const p = row.payload;
      await transport({
        subject: `[襷の系譜] ${row.kind === "event_summary" ? "赛事治理总结" : "批次治理告警"}`,
        text: row.kind === "event_summary" ? reportText(p) : batchReportText(p),
        messageId: `<governance-${row.id}@tasuki-keifu>`,
      });
      await pool.query(
        'UPDATE governance."NotificationDelivery" SET status=\'sent\',"sentAt"=clock_timestamp(),"leaseToken"=NULL,"leaseUntil"=NULL WHERE id=$1 AND "leaseToken"=$2',
        [row.id, token],
      );
      sent++;
    } catch {
      await pool.query(
        'UPDATE governance."NotificationDelivery" SET status=\'failed\',"errorMessage"=\'mail_transport_failed\',"nextAttemptAt"=clock_timestamp()+LEAST(3600,30*power(2,LEAST("attemptCount",6))) * interval \'1 second\',"leaseToken"=NULL,"leaseUntil"=NULL WHERE id=$1 AND "leaseToken"=$2',
        [row.id, token],
      );
    }
  }
  return sent;
}
