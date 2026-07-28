import { createServer } from "node:http";

import { toJson } from "./lib/json.js";
import { runPersonDiagnosis } from "./graph/run.js";

function readBody(request: import("node:http").IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function sendJson(response: import("node:http").ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(`${toJson(payload)}\n`);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "POST" && url.pathname === "/diagnose") {
    try {
      const raw = await readBody(request);
      const input = raw ? JSON.parse(raw) : {};
      const result = await runPersonDiagnosis({
        personSlug: typeof input.personSlug === "string" ? input.personSlug : null,
        personId: typeof input.personId === "string" ? input.personId : null,
        personName: typeof input.personName === "string" ? input.personName : null,
        clarification: typeof input.clarification === "string" ? input.clarification : null,
        threadId: typeof input.threadId === "string" ? input.threadId : null,
        triggeredBy: "admin_api",
      });

      sendJson(response, 200, {
        runId: result.runId,
        threadId: result.threadId,
        runtimeStatus: result.state.runtimeStatus,
        resolutionStatus: result.state.resolutionStatus,
        targetPersonId: result.state.targetPersonId,
        targetPersonSlug: result.state.targetPersonSlug,
        findings: result.state.findings,
        actions: result.state.actions,
        resultSummary: result.state.resultSummary,
      });
      return;
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
  }

  sendJson(response, 404, { ok: false, error: "not_found" });
});

const port = Number.parseInt(process.env.PORT ?? "3040", 10);
server.listen(port, "0.0.0.0", () => {
  process.stdout.write(`tasuki-keifu-agent listening on ${port}\n`);
});
