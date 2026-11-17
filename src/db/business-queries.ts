import type { Pool } from "pg";

import { getBusinessPool } from "./business.js";
import { buildLowercaseJaVariants, buildLowercaseKanaVariants, normalizeSearchKey } from "../lib/normalize.js";
import { toDateString, toIsoString } from "../lib/time.js";
import type {
  MembershipSnapshot,
  PersonCandidate,
  PersonProfile,
  PersonalBestSnapshot,
  RelationCacheSnapshot,
} from "../types/diagnosis.js";
import type {
  OrganizationCandidate,
  OrganizationProfile,
  OrganizationReferenceStats,
} from "../types/organization-diagnosis.js";

type PersonRow = {
  id: string;
  slug: string;
  displayNameJa: string;
  displayNameKana: string | null;
  displayNameRoman: string | null;
  displayNameZh: string | null;
  displayNameEn: string | null;
  birthDate: Date | null;
  hometown: string | null;
  nationality: string | null;
  heightCm: number | null;
  weightKg: number | null;
  type: string;
  status: string;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type QueryClient = Pick<Pool, "query">;

function getQueryClient(client?: QueryClient) {
  return client ?? getBusinessPool();
}

export type GovernanceCandidate = {
  personId: string;
  personSlug: string;
  displayNameJa: string;
  businessUpdatedAt: string;
  priority: number;
};

export async function listGovernanceCandidates(input: {
  limit: number;
  personSlug?: string;
  client?: QueryClient;
}): Promise<GovernanceCandidate[]> {
  const client = getQueryClient(input.client);
  const { rows } = await client.query<{
    personId: string;
    personSlug: string;
    displayNameJa: string;
    businessUpdatedAt: Date;
    priority: number;
  }>(
    `
      WITH scored_candidates AS (
        SELECT
          p."id" AS "personId",
          p."slug" AS "personSlug",
          p."displayNameJa",
          p."displayNameJaSearch",
          GREATEST(
            p."updatedAt",
            COALESCE((
              SELECT MAX(m."updatedAt")
              FROM "Membership" m
              WHERE m."personId" = p."id"
            ), p."updatedAt"),
            COALESCE((
              SELECT MAX(pb."updatedAt")
              FROM "PersonalBest" pb
              WHERE pb."personId" = p."id"
            ), p."updatedAt")
          ) AS "businessUpdatedAt",
          CASE
            -- Exact normalized-name collisions can lead to a person merge and are held before any write.
            WHEN p."displayNameJaSearch" <> ''
              AND EXISTS (
                SELECT 1
                FROM "Person" other
                WHERE other."id" <> p."id"
                  AND other."displayNameJaSearch" = p."displayNameJaSearch"
              )
              THEN 1
            -- Multiple current memberships are safe to isolate by marking the related rows conflicting.
            WHEN (
              SELECT COUNT(*)
              FROM "Membership" m
              WHERE m."personId" = p."id"
                AND (m."startDate" IS NULL OR m."startDate" <= CURRENT_DATE)
                AND (m."endDate" IS NULL OR m."endDate" >= CURRENT_DATE)
            ) > 1
              THEN 2
            -- Only prioritize duplicate PB rows that have not already been isolated as conflicting.
            WHEN EXISTS (
              SELECT 1
              FROM "PersonalBest" pb
              WHERE pb."personId" = p."id"
                AND pb."status" <> 'conflicting'
              GROUP BY pb."discipline", COALESCE(pb."markMillis"::text, pb."mark")
              HAVING COUNT(*) > 1
            )
              THEN 3
            ELSE 9
          END AS "priority"
        FROM "Person" p
      ),
      ranked_candidates AS (
        SELECT
          *,
          ROW_NUMBER() OVER (
            PARTITION BY CASE
              WHEN "priority" = 1 THEN "displayNameJaSearch"
              ELSE "personId"
            END
            ORDER BY "businessUpdatedAt" ASC, "personId" ASC
          ) AS "groupRank"
        FROM scored_candidates
      )
      SELECT
        "personId",
        "personSlug",
        "displayNameJa",
        "businessUpdatedAt",
        "priority"
      FROM ranked_candidates
      WHERE "groupRank" = 1
        AND ($2::text IS NULL OR "personSlug" = $2)
      ORDER BY "priority" ASC, "businessUpdatedAt" ASC, "personId" ASC
      LIMIT $1
    `,
    [input.limit, input.personSlug ?? null],
  );

  return rows.map((row) => ({
    personId: row.personId,
    personSlug: row.personSlug,
    displayNameJa: row.displayNameJa,
    businessUpdatedAt: row.businessUpdatedAt.toISOString(),
    priority: row.priority,
  }));
}

export async function resolvePersonCandidates(input: {
  personId?: string | null;
  personSlug?: string | null;
  personName?: string | null;
  client?: QueryClient;
}): Promise<PersonCandidate[]> {
  const client = getQueryClient(input.client);
  const clauses: string[] = [];
  const params: Array<string> = [];

  if (input.personId) {
    params.push(input.personId);
    clauses.push(`p."id" = $${params.length}`);
  }

  if (input.personSlug) {
    params.push(input.personSlug);
    clauses.push(`p."slug" = $${params.length}`);
  }

  if (input.personName) {
    const normalized = normalizeSearchKey(input.personName);
    params.push(normalized);
    clauses.push(`p."displayNameJaSearch" = $${params.length}`);
    params.push(input.personName);
    clauses.push(`LOWER(p."displayNameJa") = LOWER($${params.length})`);
    params.push(input.personName);
    clauses.push(`LOWER(COALESCE(p."displayNameRoman", '')) = LOWER($${params.length})`);
    params.push(input.personName);
    clauses.push(`LOWER(COALESCE(p."displayNameKana", '')) = LOWER($${params.length})`);
  }

  if (clauses.length === 0) {
    return [];
  }

  const { rows } = await client.query<PersonRow>(
    `
      SELECT
        p."id",
        p."slug",
        p."displayNameJa",
        p."displayNameKana",
        p."displayNameRoman",
        p."displayNameZh",
        p."displayNameEn",
        p."birthDate",
        p."hometown",
        p."nationality",
        p."heightCm",
        p."weightKg",
        p."type",
        p."status",
        p."notes",
        p."updatedAt"
      FROM "Person" p
      WHERE ${clauses.join(" OR ")}
      ORDER BY p."updatedAt" DESC, p."displayNameJa" ASC
      LIMIT 20
    `,
    params,
  );

  return (rows as PersonRow[]).map((row: PersonRow) => ({
    personId: row.id,
    personSlug: row.slug,
    displayNameJa: row.displayNameJa,
  }));
}

export async function loadPersonSnapshot(input: {
  personId: string;
  client?: QueryClient;
}): Promise<{
  profile: PersonProfile;
  memberships: MembershipSnapshot[];
  personalBests: PersonalBestSnapshot[];
  relationCache: RelationCacheSnapshot;
}> {
  const client = getQueryClient(input.client);

  const [profileResult, membershipsResult, personalBestsResult, relationCacheResult] = await Promise.all([
    client.query<PersonRow>(
      `
        SELECT
          p."id",
          p."slug",
          p."displayNameJa",
          p."displayNameKana",
          p."displayNameRoman",
          p."displayNameZh",
          p."displayNameEn",
          p."birthDate",
          p."hometown",
          p."nationality",
          p."heightCm",
          p."weightKg",
          p."type",
          p."status",
          p."notes",
          p."updatedAt"
        FROM "Person" p
        WHERE p."id" = $1
        LIMIT 1
      `,
      [input.personId],
    ),
    client.query<{
      membershipId: string;
      personId: string;
      organizationId: string;
      organizationSlug: string;
      organizationNameJa: string;
      organizationType: string;
      type: string;
      startDate: Date | null;
      endDate: Date | null;
      startYear: number | null;
      endYear: number | null;
      status: string;
      notes: string | null;
      updatedAt: Date;
    }>(
      `
        SELECT
          m."id" AS "membershipId",
          m."personId",
          m."organizationId",
          o."slug" AS "organizationSlug",
          o."nameJa" AS "organizationNameJa",
          o."type" AS "organizationType",
          m."type",
          m."startDate",
          m."endDate",
          m."startYear",
          m."endYear",
          m."status",
          m."notes",
          m."updatedAt"
        FROM "Membership" m
        INNER JOIN "Organization" o ON o."id" = m."organizationId"
        WHERE m."personId" = $1
        ORDER BY m."startDate" ASC NULLS LAST, m."updatedAt" ASC
      `,
      [input.personId],
    ),
    client.query<{
      personalBestId: string;
      personId: string;
      discipline: string;
      mark: string;
      markMillis: number | null;
      achievedOn: Date | null;
      competitionName: string | null;
      venue: string | null;
      organizationId: string | null;
      stage: string | null;
      isHighSchoolPb: boolean;
      isCollegePb: boolean;
      status: string;
      notes: string | null;
      updatedAt: Date;
    }>(
      `
        SELECT
          pb."id" AS "personalBestId",
          pb."personId",
          pb."discipline",
          pb."mark",
          pb."markMillis",
          pb."achievedOn",
          pb."competitionName",
          pb."venue",
          pb."organizationId",
          pb."stage",
          pb."isHighSchoolPb",
          pb."isCollegePb",
          pb."status",
          pb."notes",
          pb."updatedAt"
        FROM "PersonalBest" pb
        WHERE pb."personId" = $1
        ORDER BY pb."discipline" ASC, pb."markMillis" ASC NULLS LAST, pb."updatedAt" DESC
      `,
      [input.personId],
    ),
    client.query<{
      relationCacheId: string | null;
      generatedAt: Date | null;
      sourceHash: string | null;
      payload: unknown;
    }>(
      `
        SELECT
          rpc."id" AS "relationCacheId",
          rpc."generatedAt",
          rpc."sourceHash",
          rpc."payload"
        FROM "PlayerRelationCache" rpc
        WHERE rpc."personId" = $1
        LIMIT 1
      `,
      [input.personId],
    ),
  ]);

  const profileRows = profileResult.rows as PersonRow[];
  const profileRow = profileRows[0];
  if (!profileRow) {
    throw new Error(`person_not_found:${input.personId}`);
  }

  const profile: PersonProfile = {
    personId: profileRow.id,
    personSlug: profileRow.slug,
    displayNameJa: profileRow.displayNameJa,
    displayNameKana: profileRow.displayNameKana,
    displayNameRoman: profileRow.displayNameRoman,
    displayNameZh: profileRow.displayNameZh,
    displayNameEn: profileRow.displayNameEn,
    birthDate: toDateString(profileRow.birthDate),
    hometown: profileRow.hometown,
    nationality: profileRow.nationality,
    heightCm: profileRow.heightCm,
    weightKg: profileRow.weightKg,
    type: profileRow.type,
    status: profileRow.status,
    notes: profileRow.notes,
    updatedAt: toIsoString(profileRow.updatedAt) ?? new Date().toISOString(),
  };

  const memberships: MembershipSnapshot[] = (membershipsResult.rows as Array<{
    membershipId: string;
    personId: string;
    organizationId: string;
    organizationSlug: string;
    organizationNameJa: string;
    organizationType: string;
    type: string;
    startDate: Date | null;
    endDate: Date | null;
    startYear: number | null;
    endYear: number | null;
    status: string;
    notes: string | null;
    updatedAt: Date;
  }>).map((row) => ({
    membershipId: row.membershipId,
    personId: row.personId,
    organizationId: row.organizationId,
    organizationSlug: row.organizationSlug,
    organizationNameJa: row.organizationNameJa,
    organizationType: row.organizationType,
    type: row.type,
    startDate: toDateString(row.startDate),
    endDate: toDateString(row.endDate),
    startYear: row.startYear,
    endYear: row.endYear,
    status: row.status,
    notes: row.notes,
    updatedAt: toIsoString(row.updatedAt) ?? new Date().toISOString(),
  }));

  const personalBests: PersonalBestSnapshot[] = (personalBestsResult.rows as Array<{
    personalBestId: string;
    personId: string;
    discipline: string;
    mark: string;
    markMillis: number | null;
    achievedOn: Date | null;
    competitionName: string | null;
    venue: string | null;
    organizationId: string | null;
    stage: string | null;
    isHighSchoolPb: boolean;
    isCollegePb: boolean;
    status: string;
    notes: string | null;
    updatedAt: Date;
  }>).map((row) => ({
    personalBestId: row.personalBestId,
    personId: row.personId,
    discipline: row.discipline,
    mark: row.mark,
    markMillis: row.markMillis,
    achievedOn: toDateString(row.achievedOn),
    competitionName: row.competitionName,
    venue: row.venue,
    organizationId: row.organizationId,
    stage: row.stage,
    isHighSchoolPb: row.isHighSchoolPb,
    isCollegePb: row.isCollegePb,
    status: row.status,
    notes: row.notes,
    updatedAt: toIsoString(row.updatedAt) ?? new Date().toISOString(),
  }));

  const relationRows = relationCacheResult.rows as Array<{
    relationCacheId: string | null;
    generatedAt: Date | null;
    sourceHash: string | null;
    payload: unknown;
  }>;
  const relationRow = relationRows[0] ?? null;
  const relationCache: RelationCacheSnapshot = {
    relationCacheId: relationRow?.relationCacheId ?? null,
    generatedAt: toIsoString(relationRow?.generatedAt ?? null),
    sourceHash: relationRow?.sourceHash ?? null,
    payload: relationRow?.payload ?? null,
  };

  return { profile, memberships, personalBests, relationCache };
}

export async function findNameNormalizationCandidates(input: {
  personId: string;
  personSlug: string;
  displayNameJa: string;
  displayNameKana?: string | null;
  client?: QueryClient;
}): Promise<PersonCandidate[]> {
  const client = getQueryClient(input.client);
  const normalized = normalizeSearchKey(input.displayNameJa);
  const jaVariants = buildLowercaseJaVariants(input.displayNameJa);
  const kanaVariants = input.displayNameKana ? buildLowercaseKanaVariants(input.displayNameKana) : [];
  const clauses = [`p."displayNameJaSearch" = $1`];
  const params: Array<string | string[]> = [normalized, input.personId];

  if (jaVariants.length > 0) {
    params.push(jaVariants);
    clauses.push(
      `regexp_replace(LOWER(p."displayNameJa"), '\\s+', '', 'g') = ANY($${params.length}::text[])`,
    );
  }

  if (kanaVariants.length > 0) {
    params.push(kanaVariants);
    clauses.push(
      `regexp_replace(LOWER(COALESCE(p."displayNameKana", '')), '\\s+', '', 'g') = ANY($${params.length}::text[])`,
    );
  }

  const { rows } = await client.query<{
    id: string;
    slug: string;
    displayNameJa: string;
    displayNameKana: string | null;
    displayNameRoman: string | null;
  }>(
    `
      SELECT
        p."id",
        p."slug",
        p."displayNameJa",
        p."displayNameKana",
        p."displayNameRoman"
      FROM "Person" p
      WHERE (${clauses.join(" OR ")})
        AND p."id" <> $2
      ORDER BY p."updatedAt" DESC, p."displayNameJa" ASC
      LIMIT 10
    `,
    params,
  );

  return (rows as Array<{
    id: string;
    slug: string;
    displayNameJa: string;
    displayNameKana: string | null;
    displayNameRoman: string | null;
  }>).map((row) => ({
    personId: row.id,
    personSlug: row.slug,
    displayNameJa: row.displayNameJa,
    displayNameKana: row.displayNameKana,
    displayNameRoman: row.displayNameRoman,
  }));
}

export async function countDuplicateNormalizedNames(input: {
  displayNameJa: string;
  client?: QueryClient;
}) {
  const client = getQueryClient(input.client);
  const normalized = normalizeSearchKey(input.displayNameJa);
  const { rows } = await client.query<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM "Person" p
      WHERE p."displayNameJaSearch" = $1
    `,
    [normalized],
  );

  return Number.parseInt(rows[0]?.count ?? "0", 10);
}

type OrganizationRow = {
  id: string;
  slug: string;
  nameJa: string;
  nameKana: string | null;
  nameRoman: string | null;
  nameZh: string | null;
  nameEn: string | null;
  shortName: string | null;
  type: string;
  location: string | null;
  prefecture: string | null;
  country: string;
  websiteUrl: string | null;
  status: string;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function toOrganizationCandidate(row: OrganizationRow): OrganizationCandidate {
  return {
    organizationId: row.id,
    organizationSlug: row.slug,
    nameJa: row.nameJa,
    nameKana: row.nameKana,
    nameRoman: row.nameRoman,
    type: row.type,
  };
}

export async function resolveOrganizationCandidates(input: {
  organizationId?: string | null;
  organizationSlug?: string | null;
  organizationName?: string | null;
  client?: QueryClient;
}): Promise<OrganizationCandidate[]> {
  const client = getQueryClient(input.client);
  const clauses: string[] = [];
  const params: string[] = [];

  if (input.organizationId) {
    params.push(input.organizationId);
    clauses.push(`o."id" = $${params.length}`);
  }
  if (input.organizationSlug) {
    params.push(input.organizationSlug);
    clauses.push(`o."slug" = $${params.length}`);
  }
  if (input.organizationName) {
    const normalized = normalizeSearchKey(input.organizationName);
    params.push(normalized);
    clauses.push(`regexp_replace(LOWER(o."nameJa"), '\\s+', '', 'g') = $${params.length}`);
    params.push(input.organizationName);
    clauses.push(`LOWER(COALESCE(o."nameRoman", '')) = LOWER($${params.length})`);
    params.push(input.organizationName);
    clauses.push(`LOWER(COALESCE(o."nameKana", '')) = LOWER($${params.length})`);
  }
  if (clauses.length === 0) {
    return [];
  }

  const { rows } = await client.query<OrganizationRow>(
    `
      SELECT
        o."id", o."slug", o."nameJa", o."nameKana", o."nameRoman",
        o."nameZh", o."nameEn", o."shortName", o."type", o."location",
        o."prefecture", o."country", o."websiteUrl", o."status", o."notes", o."createdAt", o."updatedAt"
      FROM "Organization" o
      WHERE ${clauses.join(" OR ")}
      ORDER BY o."updatedAt" DESC, o."nameJa" ASC
      LIMIT 20
    `,
    params,
  );

  return rows.map(toOrganizationCandidate);
}

export async function loadOrganizationSnapshot(input: {
  organizationId: string;
  client?: QueryClient;
}): Promise<{ organization: OrganizationProfile; referenceStats: OrganizationReferenceStats }> {
  const client = getQueryClient(input.client);
  const [organizationResult, referencesResult] = await Promise.all([
    client.query<OrganizationRow>(
      `
        SELECT
          o."id", o."slug", o."nameJa", o."nameKana", o."nameRoman",
          o."nameZh", o."nameEn", o."shortName", o."type", o."location",
          o."prefecture", o."country", o."websiteUrl", o."status", o."notes", o."createdAt", o."updatedAt"
        FROM "Organization" o
        WHERE o."id" = $1
        LIMIT 1
      `,
      [input.organizationId],
    ),
    client.query<{
      membershipCount: string;
      personalBestCount: string;
      raceResultCount: string;
      teamCompetitionResultCount: string;
      nameVariantCount: string;
      sourceReferenceCount: string;
    }>(
      `
        SELECT
          (SELECT COUNT(*)::text FROM "Membership" WHERE "organizationId" = $1) AS "membershipCount",
          (SELECT COUNT(*)::text FROM "PersonalBest" WHERE "organizationId" = $1) AS "personalBestCount",
          (SELECT COUNT(*)::text FROM "RaceResult" WHERE "organizationId" = $1) AS "raceResultCount",
          (SELECT COUNT(*)::text FROM "TeamCompetitionResult" WHERE "organizationId" = $1) AS "teamCompetitionResultCount",
          (SELECT COUNT(*)::text FROM "NameVariant" WHERE "organizationId" = $1) AS "nameVariantCount",
          (SELECT COUNT(*)::text FROM "SourceReference" WHERE "organizationId" = $1) AS "sourceReferenceCount"
      `,
      [input.organizationId],
    ),
  ]);

  const row = organizationResult.rows[0];
  if (!row) {
    throw new Error(`organization_not_found:${input.organizationId}`);
  }
  const references = referencesResult.rows[0];
  if (!references) {
    throw new Error(`organization_reference_stats_not_found:${input.organizationId}`);
  }

  return {
    organization: {
      ...toOrganizationCandidate(row),
      nameZh: row.nameZh,
      nameEn: row.nameEn,
      shortName: row.shortName,
      location: row.location,
      prefecture: row.prefecture,
      country: row.country,
      websiteUrl: row.websiteUrl,
      status: row.status,
      notes: row.notes,
      createdAt: toIsoString(row.createdAt) ?? new Date().toISOString(),
      updatedAt: toIsoString(row.updatedAt) ?? new Date().toISOString(),
    },
    referenceStats: {
      membershipCount: Number.parseInt(references.membershipCount, 10),
      personalBestCount: Number.parseInt(references.personalBestCount, 10),
      raceResultCount: Number.parseInt(references.raceResultCount, 10),
      teamCompetitionResultCount: Number.parseInt(references.teamCompetitionResultCount, 10),
      nameVariantCount: Number.parseInt(references.nameVariantCount, 10),
      sourceReferenceCount: Number.parseInt(references.sourceReferenceCount, 10),
    },
  };
}

export async function findOrganizationNormalizationCandidates(input: {
  organizationId: string;
  nameJa: string;
  client?: QueryClient;
}): Promise<OrganizationCandidate[]> {
  const client = getQueryClient(input.client);
  const { rows } = await client.query<OrganizationRow>(
    `
      WITH target_names AS (
        SELECT regexp_replace(LOWER(o."nameJa"), '\\s+', '', 'g') AS "normalizedName"
        FROM "Organization" o
        WHERE o."id" = $1
        UNION
        SELECT regexp_replace(LOWER(nv."value"), '\\s+', '', 'g') AS "normalizedName"
        FROM "NameVariant" nv
        WHERE nv."organizationId" = $1
      )
      SELECT
        o."id", o."slug", o."nameJa", o."nameKana", o."nameRoman",
        o."nameZh", o."nameEn", o."shortName", o."type", o."location",
        o."prefecture", o."country", o."websiteUrl", o."status", o."notes", o."createdAt", o."updatedAt"
      FROM "Organization" o
      WHERE o."id" <> $1
        AND (
          regexp_replace(LOWER(o."nameJa"), '\\s+', '', 'g') IN (SELECT "normalizedName" FROM target_names)
          OR EXISTS (
            SELECT 1
            FROM "NameVariant" nv
            WHERE nv."organizationId" = o."id"
              AND regexp_replace(LOWER(nv."value"), '\\s+', '', 'g') IN (SELECT "normalizedName" FROM target_names)
          )
        )
      ORDER BY o."updatedAt" DESC, o."nameJa" ASC
      LIMIT 10
    `,
    [input.organizationId],
  );
  return rows.map(toOrganizationCandidate);
}
