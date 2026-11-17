import {
  batchInputSchema,
  type BatchInput,
  type OrgInput,
} from "./contracts.js";

// Legacy payload support is an input adapter, not historical Agent model compatibility.
export function adaptRacePayload(
  raw: Record<string, unknown>,
  unit: { unitType: BatchInput["unitType"]; unitKey: string; sequence: number },
): BatchInput {
  const organizations = new Map<string, OrgInput>();
  const org = (slug: unknown, name: unknown, type: unknown) => {
    if (typeof name !== "string" || !name.trim()) return undefined;
    const key = typeof slug === "string" && slug ? slug : name;
    organizations.set(key, {
      key,
      name,
      slug: typeof slug === "string" ? slug : undefined,
      type: (type ?? "unknown") as OrgInput["type"],
    });
    return key;
  };
  if (!Array.isArray(raw.entries))
    throw new Error("Missing legacy entries array");
  const rows = raw.entries.map((e: Record<string, unknown>, i: number) => {
    const organizationKey = org(
      e.raceOrganizationSlug,
      e.raceOrganizationNameJa,
      e.raceOrganizationType,
    );
    const affiliation = org(
      e.affiliationOrganizationSlug,
      e.affiliationOrganizationNameJa,
      e.affiliationOrganizationType,
    );
    const university = org(e.universitySlug, e.universityNameJa, "university");
    const highSchool = org(e.highSchoolSlug, e.highSchoolNameJa, "high_school");
    const memberships: Array<Record<string, unknown>> = [];
    const add = (key: string | undefined) => {
      if (!key || memberships.some((m) => m.organizationKey === key)) return;
      const type = organizations.get(key)?.type;
      if (
        [
          "prefecture_representative",
          "student_union_select",
          "organizer",
          "unknown",
        ].includes(type ?? "unknown")
      )
        return;
      memberships.push({
        organizationKey: key,
        type: ["university", "high_school", "junior_high_school"].includes(
          type!,
        )
          ? "enrolled"
          : "affiliated",
      });
    };
    add(organizationKey);
    add(affiliation);
    add(university);
    add(highSchool);
    return {
      key:
        typeof e.sourceEntityKey === "string"
          ? e.sourceEntityKey
          : `row:${i}:${String(e.slug ?? e.displayNameJa)}`,
      sourceKey: e.sourceEntityKey,
      sourceUrl: e.sourceUrl,
      name: e.displayNameJa,
      slug: e.slug,
      kana: e.displayNameKana ?? undefined,
      roman: e.displayNameRoman ?? undefined,
      organizationKey,
      memberships,
      grade: e.grade ?? undefined,
      mark: e.mark,
      rank: e.rank,
      teamRank: e.teamRank ?? undefined,
      notes: e.notes ?? undefined,
      pbs: e.pbs ?? [],
    };
  });
  const teams = Array.isArray(raw.teamResults)
    ? raw.teamResults.map((t: Record<string, unknown>) => {
        const snapshot = t.snapshot as Record<string, unknown>;
        return {
          organizationKey: org(
            t.organizationSlug,
            t.organizationNameJa,
            t.organizationType,
          ),
          finalRank: t.finalRank ?? undefined,
          finalMark: t.finalMark ?? undefined,
          leg: snapshot.leg,
          cumulativeRank: snapshot.cumulativeRank ?? undefined,
          cumulativeMark: snapshot.cumulativeMark ?? undefined,
          gapFromLeader: snapshot.gapFromLeader ?? undefined,
          notes: t.notes ?? undefined,
        };
      })
    : [];
  return batchInputSchema.parse({
    ...unit,
    sourcePayload: raw,
    sourceId: raw.sourceId,
    raceSlug: raw.raceSlug,
    organizations: [...organizations.values()],
    rows,
    teams,
  });
}
