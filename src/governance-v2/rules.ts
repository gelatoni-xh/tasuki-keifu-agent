import { createHash } from "node:crypto";
import type { Basis, Membership, Window } from "./contracts.js";

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export const fingerprint = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
export const stableId = (...parts: string[]) =>
  `gov_${fingerprint(parts).slice(0, 28)}`;
export const normalizeName = (s: string) =>
  s
    .normalize("NFKC")
    .replace(/[\s・･]/gu, "")
    .toLocaleLowerCase("ja");
export const normalizeOrganizationName = (s: string) =>
  normalizeName(s)
    .replace(/高等学校$/u, "高校")
    .replace(/大学$/u, "大")
    .replace(/付属/gu, "附属");
export function markMillis(raw: string): number | null {
  const s = raw.normalize("NFKC").trim();
  if (!/^\d+(?::[0-5]\d){0,2}(?:\.\d{1,3})?$/.test(s)) return null;
  const parts = s.split(":").map(Number);
  const seconds = parts.reduce((n, p) => n * 60 + p, 0);
  const millis = Math.round(seconds * 1000);
  return millis > 0 && millis <= 2147483647 ? millis : null;
}
export function academicWindow(
  kind: string,
  grade: number | undefined,
  raceDate: string | undefined,
): Window | null {
  const duration = (
    { junior_high_school: 3, high_school: 3, university: 4 } as Record<
      string,
      number
    >
  )[kind];
  if (!duration || !grade || grade > duration || !raceDate) return null;
  const d = new Date(raceDate);
  if (Number.isNaN(d.getTime())) return null;
  const academicYear = d.getUTCFullYear() - (d.getUTCMonth() < 3 ? 1 : 0);
  const startYear = academicYear - grade + 1;
  return inferredWindow(startYear, startYear + duration, {
    rule: "grade_to_academic_window",
    grade,
    raceDate,
    kind,
  });
}
export function inferredWindow(
  startYear: number,
  endYear: number,
  evidence: Record<string, unknown>,
): Window {
  return {
    startDate: `${startYear}-04-01`,
    endDate: `${endYear}-03-31`,
    startBasis: "inferred",
    endBasis: "inferred",
    endState: "unknown",
    evidence,
  };
}
export function adjacentSchoolWindow(
  kind: string,
  memberships: Membership[],
): Window | null {
  if (kind === "high_school") {
    const anchors = memberships.filter(
      (m) =>
        m.organizationType === "university" &&
        m.startDate &&
        (m.startBasis === "source" ||
          (m.startBasis === "inferred" &&
            m.evidence?.rule === "grade_to_academic_window")),
    );
    const years = [
      ...new Set(anchors.map((m) => Number(m.startDate!.slice(0, 4)))),
    ];
    if (years.length === 1)
      return inferredWindow(years[0] - 3, years[0], {
        rule: "university_start_to_high_school",
        anchorIds: anchors.map((m) => m.id),
      });
  }
  if (kind === "university") {
    const anchors = memberships.filter(
      (m) =>
        m.organizationType === "high_school" &&
        m.endDate &&
        (m.endBasis === "source" ||
          (m.endBasis === "inferred" &&
            m.evidence?.rule === "grade_to_academic_window")),
    );
    const years = [
      ...new Set(anchors.map((m) => Number(m.endDate!.slice(0, 4)))),
    ];
    if (years.length === 1)
      return inferredWindow(years[0], years[0] + 4, {
        rule: "high_school_end_to_university",
        anchorIds: anchors.map((m) => m.id),
      });
  }
  return null;
}
export function fillUnknownDates(existing: Window, incoming: Window): Window {
  const replaceStart =
    !existing.startDate ||
    (existing.startBasis === "inferred" && incoming.startBasis === "source");
  const replaceEnd =
    !existing.endDate ||
    (existing.endBasis === "inferred" && incoming.endBasis === "source");
  return {
    startDate: replaceStart ? incoming.startDate : existing.startDate,
    endDate: replaceEnd ? incoming.endDate : existing.endDate,
    startBasis: replaceStart ? incoming.startBasis : existing.startBasis,
    endBasis: replaceEnd ? incoming.endBasis : existing.endBasis,
    endState:
      incoming.endState !== "unknown" ? incoming.endState : existing.endState,
    evidence: { ...existing.evidence, ...incoming.evidence },
  };
}
export function definiteOverlap(a: Window, b: Window) {
  const knownEnd = (w: Window) =>
    (w.endBasis === "source" && !!w.endDate) || w.endState === "ongoing";
  return (
    a.startBasis === "source" &&
    b.startBasis === "source" &&
    knownEnd(a) &&
    knownEnd(b) &&
    !!(
      a.startDate &&
      b.startDate &&
      a.startDate <= (b.endDate ?? "9999-12-31") &&
      b.startDate <= (a.endDate ?? "9999-12-31")
    )
  );
}
export function membershipConflict(a: Membership, b: Membership): boolean {
  const exclusive =
    a.exclusivityGroup && a.exclusivityGroup === b.exclusivityGroup;
  const sameSchoolStage =
    a.type === "enrolled" &&
    b.type === "enrolled" &&
    a.organizationType === b.organizationType &&
    ["high_school", "university", "junior_high_school"].includes(
      a.organizationType,
    );
  return (
    a.personId === b.personId &&
    a.organizationId !== b.organizationId &&
    !!(exclusive || sameSchoolStage) &&
    definiteOverlap(a, b)
  );
}
export function basis(value: unknown): Basis {
  return value === "source" || value === "inferred" ? value : "unknown";
}
export function shouldUpdatePB(
  incoming: number | null,
  reliability: number,
  existing?: { markMillis: number | null; reliability: number },
) {
  return (
    incoming !== null &&
    reliability >= 3 &&
    (!existing ||
      (existing.markMillis !== null &&
        incoming < existing.markMillis &&
        reliability >= existing.reliability))
  );
}
