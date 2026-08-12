import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { env } from "../config/env.js";
import { traceProfileWikipediaResearch } from "./tracing.js";
import { resolveHttpProxy } from "./network-proxy.js";

const execFileAsync = promisify(execFile);
const WIKIPEDIA_API_URL = "https://ja.wikipedia.org/w/api.php";

export type ProfileWikipediaResearchInput = {
  targetName: string;
  missingFields: string[];
};

export type ProfileWikipediaResearchResult = {
  status: "found" | "not_found" | "unavailable";
  summary: string;
  sourceUrl: string | null;
  suggestedFields: Record<string, string>;
};

type WikipediaPage = {
  title?: string;
  missing?: boolean;
  pageprops?: { disambiguation?: string };
  revisions?: Array<{ slots?: { main?: { content?: string } } }>;
};

function getTimeoutMs() {
  const parsed = Number(env.TASUKI_WIKIPEDIA_TIMEOUT_MS ?? "25000");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 25000;
}

function cleanWikiValue(value: string | null) {
  if (!value) {
    return null;
  }

  return value
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/''+/g, "")
    .trim()
    .replace(/[。;].*$/u, "")
    .trim() || null;
}

function normalizeWikipediaTitle(value: string) {
  return value.replace(/[\s　]+/g, "").normalize("NFKC");
}

function fieldValue(wikitext: string, names: string[]) {
  for (const name of names) {
    const match = wikitext.match(new RegExp(`^\\s*\\|\\s*${name}\\s*=\\s*(.+)$`, "mi"));
    const value = cleanWikiValue(match?.[1] ?? null);
    if (value) {
      return value;
    }
  }

  return null;
}

function birthDateValue(wikitext: string) {
  const value = fieldValue(wikitext, ["生年月日"]);
  if (!value) {
    return null;
  }

  const templateDate = value.match(/(?:生年月日と年齢|生年月日)\|(\d{4})\|(\d{1,2})\|(\d{1,2})/);
  if (templateDate) {
    return `${templateDate[1]}-${templateDate[2].padStart(2, "0")}-${templateDate[3].padStart(2, "0")}`;
  }

  const textDate = value.match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/);
  return textDate
    ? `${textDate[1]}-${textDate[2].padStart(2, "0")}-${textDate[3].padStart(2, "0")}`
    : null;
}

function suggestedProfileFields(wikitext: string, missingFields: string[]) {
  const fields: Record<string, string> = {};

  if (missingFields.includes("birthDate")) {
    const birthDate = birthDateValue(wikitext);
    if (birthDate) fields.birthDate = birthDate;
  }
  if (missingFields.includes("hometown")) {
    const hometown = fieldValue(wikitext, ["出身地", "出生地"]);
    if (hometown) fields.hometown = hometown;
  }
  if (missingFields.includes("nationality")) {
    const nationality = fieldValue(wikitext, ["国籍"]);
    if (nationality) fields.nationality = nationality;
  }
  if (missingFields.includes("displayNameKana")) {
    const kana = fieldValue(wikitext, ["ふりがな", "読み仮名", "よみがな"]);
    if (kana) fields.displayNameKana = kana;
  }

  return fields;
}

async function fetchWikipediaPage(title: string) {
  const parameters = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    redirects: "1",
    prop: "revisions|pageprops",
    rvprop: "content",
    rvslots: "main",
    titles: title,
  });
  const proxy = await resolveHttpProxy();
  const args = [
    "--fail-with-body",
    "--silent",
    "--show-error",
    "--location",
    "--connect-timeout",
    "8",
    "--max-time",
    String(Math.ceil(getTimeoutMs() / 1000)),
    "--header",
    "User-Agent: tasuki-keifu-agent/0.1 (profile governance)",
  ];
  if (proxy) {
    args.push("--proxy", proxy);
  }
  args.push(`${WIKIPEDIA_API_URL}?${parameters.toString()}`);

  const { stdout } = await execFileAsync("curl", args, {
    timeout: getTimeoutMs() + 5000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return JSON.parse(stdout) as { query?: { pages?: WikipediaPage[] } };
}

async function researchProfileWikipediaImpl(
  input: ProfileWikipediaResearchInput,
): Promise<ProfileWikipediaResearchResult> {
  try {
    const response = await fetchWikipediaPage(input.targetName);
    const page = response.query?.pages?.[0];
    const wikitext = page?.revisions?.[0]?.slots?.main?.content ?? "";
    const isDisambiguation = Boolean(page?.pageprops?.disambiguation);
    const titleMatchesTarget = page?.title
      ? normalizeWikipediaTitle(page.title) === normalizeWikipediaTitle(input.targetName)
      : false;

    if (!page || page.missing || isDisambiguation || !titleMatchesTarget || !wikitext) {
      return {
        status: "not_found",
        summary: isDisambiguation
          ? "Wikipedia 返回同名消歧义页，不能安全补全 profile。"
          : !titleMatchesTarget
            ? "Wikipedia 重定向到了不同姓名页面，不能安全补全 profile。"
            : "Wikipedia 没有找到可安全使用的对应选手页面。",
        sourceUrl: null,
        suggestedFields: {},
      };
    }

    const suggestedFields = suggestedProfileFields(wikitext, input.missingFields);
    const sourceUrl = `https://ja.wikipedia.org/wiki/${encodeURIComponent(page.title ?? input.targetName)}`;
    if (Object.keys(suggestedFields).length === 0) {
      return {
        status: "not_found",
        summary: "Wikipedia 页面存在，但没有明确提供当前缺失字段。",
        sourceUrl,
        suggestedFields: {},
      };
    }

    return {
      status: "found",
      summary: `Wikipedia 明确提供了 ${Object.keys(suggestedFields).length} 个缺失字段。`,
      sourceUrl,
      suggestedFields,
    };
  } catch (error) {
    return {
      status: "unavailable",
      summary: `Wikipedia API 查询未完成：${error instanceof Error ? error.message : String(error)}`,
      sourceUrl: null,
      suggestedFields: {},
    };
  }
}

export const researchProfileWikipedia = traceProfileWikipediaResearch(researchProfileWikipediaImpl);
