import { env } from "../config/env.js";
import { traceNameIdentityResearch } from "./tracing.js";

type JsonValue = Record<string, unknown>;

export type NameIdentityResearchInput = {
  targetName: string;
  candidates: Array<{
    personId: string;
    personSlug: string;
    displayNameJa: string;
    displayNameKana?: string | null;
    displayNameRoman?: string | null;
  }>;
};

export type NameIdentityResearchResult = {
  verdict: "same" | "different" | "uncertain";
  summary: string;
  reason: string;
  sourceMode: "web_search" | "llm_only" | "unavailable";
};

function getTimeoutMs() {
  const parsed = Number(env.TASUKI_LLM_TIMEOUT_MS ?? "25000");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 25000;
}

function getConfig() {
  const apiKey = env.OPENAI_API_KEY?.trim();
  const baseUrl = (env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = env.OPENAI_MODEL?.trim() || "gpt-5.4";
  return apiKey ? { apiKey, baseUrl, model } : null;
}

async function postJson(path: string, body: JsonValue, config: { apiKey: string; baseUrl: string }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), getTimeoutMs());
  try {
    const response = await fetch(`${config.baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`LLM request failed (${response.status}): ${text.slice(0, 300)}`);
    }
    return JSON.parse(text) as JsonValue;
  } finally {
    clearTimeout(timeout);
  }
}

function parseJsonObject(value: unknown): JsonValue {
  if (typeof value !== "string") {
    throw new Error("LLM returned non-text content");
  }
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1] ?? value;
  return JSON.parse(fenced) as JsonValue;
}

function parseResearchResult(value: JsonValue, sourceMode: NameIdentityResearchResult["sourceMode"]) {
  const verdict = value.verdict;
  return {
    verdict: verdict === "same" || verdict === "different" || verdict === "uncertain" ? verdict : "uncertain",
    summary: typeof value.summary === "string" ? value.summary : "模型没有返回可用摘要。",
    reason: typeof value.reason === "string" ? value.reason : "模型没有返回可用理由。",
    sourceMode,
  } satisfies NameIdentityResearchResult;
}

async function researchNameIdentityImpl(input: NameIdentityResearchInput): Promise<NameIdentityResearchResult> {
  const config = getConfig();
  if (!config) {
    return {
      verdict: "uncertain",
      summary: "未配置本地 LLM 认证，无法继续研究。",
      reason: "OPENAI_API_KEY 不存在。",
      sourceMode: "unavailable",
    };
  }

  const payload = JSON.stringify(input, null, 2);
  const instructions = [
    "你负责判断日本长跑选手姓名是否可能指向同一个人。",
    "先尽量使用联网搜索核对公开资料；资料少时不要过度推断。",
    "只在证据充分时输出 same 或 different，证据不足必须输出 uncertain。",
    "不要因为姓名完全相同就直接断定 same；要综合所属组织、年代、项目、生日等信息。",
    "只输出 JSON，不要 Markdown。字段必须是 verdict、summary、reason。",
    'verdict 只能是 "same"、"different"、"uncertain"。',
  ].join("\n");

  try {
    const response = await postJson(
      "/responses",
      {
        model: config.model,
        instructions,
        input: payload,
        tools: [{ type: "web_search_preview" }],
        max_output_tokens: 400,
      },
      config,
    );
    const outputText =
      (typeof response.output_text === "string" && response.output_text) ||
      (Array.isArray(response.output)
        ? response.output
            .flatMap((item) => (item && typeof item === "object" && Array.isArray((item as { content?: unknown[] }).content)
              ? (item as { content: unknown[] }).content
              : []))
            .map((item) => item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string"
              ? (item as { text: string }).text
              : "")
            .join("")
        : "");
    return parseResearchResult(parseJsonObject(outputText), "web_search");
  } catch {
    try {
      const response = await postJson(
        "/chat/completions",
        {
          model: config.model,
          messages: [
            { role: "system", content: instructions },
            {
              role: "user",
              content: `${payload}\n\n当前接口不一定支持联网工具。若无法核验公开资料，必须输出 uncertain。`,
            },
          ],
          response_format: { type: "json_object" },
          max_tokens: 400,
        },
        config,
      );
      const content = (response.choices as Array<{ message?: { content?: unknown } }> | undefined)?.[0]?.message?.content;
      return parseResearchResult(parseJsonObject(content), "llm_only");
    } catch (error) {
      return {
        verdict: "uncertain",
        summary: "LLM 研究未完成，已保留为不确定结果。",
        reason: error instanceof Error ? error.message : String(error),
        sourceMode: "unavailable",
      };
    }
  }
}

export const researchNameIdentity = traceNameIdentityResearch(researchNameIdentityImpl);
