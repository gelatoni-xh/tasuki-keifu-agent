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
  suggestedPersonalBests: Array<{
    discipline: string;
    mark: string;
    markMillis: number;
  }>;
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

const personalBestFields = [
  { discipline: "m800", names: ["800m", "800メートル", "800メートル走"] },
  { discipline: "m1500", names: ["1500m", "1500メートル", "1500メートル走"] },
  { discipline: "m2000sc", names: ["2000mSC", "2000m障害", "2000メートル障害"] },
  { discipline: "m3000", names: ["3000m", "3000メートル", "3000メートル走"] },
  { discipline: "m3000sc", names: ["3000mSC", "3000m障害", "3000メートル障害"] },
  { discipline: "m5000", names: ["5000m", "5000メートル", "5000メートル走"] },
  { discipline: "m10000", names: ["10000m", "10000メートル", "10000メートル走"] },
  { discipline: "ten_mile", names: ["10マイル", "10mile", "ten mile"] },
  { discipline: "half_marathon", names: ["ハーフマラソン", "half marathon"] },
  { discipline: "marathon", names: ["マラソン", "フルマラソン", "marathon"] },
];

function normalizeFraction(value: string) {
  return value.length === 1 ? Number(value) * 100 : value.length === 2 ? Number(value) * 10 : Number(value.slice(0, 3));
}

function parsePersonalBestMark(value: string) {
  const normalized = value.replace(/[，,].*$/u, "").replace(/\s+/g, "");
  const colonHourMatch = normalized.match(/(\d+):(\d{1,2}):(\d{1,2})(?:[.](\d{1,3}))?/);
  if (colonHourMatch) {
    const hours = Number(colonHourMatch[1]);
    const minutes = Number(colonHourMatch[2]);
    const seconds = Number(colonHourMatch[3]);
    const milliseconds = normalizeFraction(colonHourMatch[4] ?? "0");
    return {
      mark: `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0").slice(0, 2)}`,
      markMillis: (((hours * 60 + minutes) * 60) + seconds) * 1000 + milliseconds,
    };
  }

  const hourMatch = normalized.match(/(\d+)時間(\d+)分(\d{1,2})秒(?:[.．]?(\d{1,3}))?/);
  if (hourMatch) {
    const hours = Number(hourMatch[1]);
    const minutes = Number(hourMatch[2]);
    const seconds = Number(hourMatch[3]);
    const milliseconds = normalizeFraction(hourMatch[4] ?? "0");
    return {
      mark: `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0").slice(0, 2)}`,
      markMillis: (((hours * 60 + minutes) * 60) + seconds) * 1000 + milliseconds,
    };
  }

  const minuteMatch = normalized.match(/(\d+)(?:分|:)(\d{1,2})(?:秒(?:[.．]?(\d{1,3}))?|[.:](\d{1,3}))/);
  if (!minuteMatch) {
    return null;
  }

  const minutes = Number(minuteMatch[1]);
  const seconds = Number(minuteMatch[2]);
  const milliseconds = normalizeFraction(minuteMatch[3] ?? minuteMatch[4] ?? "0");
  if (seconds >= 60) {
    return null;
  }

  return {
    mark: `${minutes}:${String(seconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0").slice(0, 2)}`,
    markMillis: (minutes * 60 + seconds) * 1000 + milliseconds,
  };
}

export function extractWikipediaPersonalBests(wikitext: string) {
  const fields = [];

  for (const definition of personalBestFields) {
    const rawValue = fieldValue(wikitext, definition.names);
    const parsed = rawValue ? parsePersonalBestMark(rawValue) : null;
    if (parsed) {
      fields.push({
        discipline: definition.discipline,
        ...parsed,
      });
    }
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
        suggestedPersonalBests: [],
      };
    }

    const suggestedFields = suggestedProfileFields(wikitext, input.missingFields);
    const personalBests = extractWikipediaPersonalBests(wikitext);
    const sourceUrl = `https://ja.wikipedia.org/wiki/${encodeURIComponent(page.title ?? input.targetName)}`;
    if (Object.keys(suggestedFields).length === 0 && personalBests.length === 0) {
      return {
        status: "not_found",
        summary: "Wikipedia 页面存在，但没有明确提供当前可写入字段。",
        sourceUrl,
        suggestedFields: {},
        suggestedPersonalBests: [],
      };
    }

    return {
      status: "found",
      summary: `Wikipedia 明确提供了 ${Object.keys(suggestedFields).length} 个 profile 字段和 ${personalBests.length} 个 PB 字段。`,
      sourceUrl,
      suggestedFields,
      suggestedPersonalBests: personalBests,
    };
  } catch (error) {
    return {
      status: "unavailable",
      summary: `Wikipedia API 查询未完成：${error instanceof Error ? error.message : String(error)}`,
      sourceUrl: null,
      suggestedFields: {},
      suggestedPersonalBests: [],
    };
  }
}

export const researchProfileWikipedia = traceProfileWikipediaResearch(researchProfileWikipediaImpl);
