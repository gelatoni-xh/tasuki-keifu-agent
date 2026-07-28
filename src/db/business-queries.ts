import type { Pool } from "pg";

import { getBusinessPool } from "./business.js";
import { normalizeSearchKey } from "../lib/normalize.js";
import { toDateString, toIsoString } from "../lib/time.js";
import type {
  MembershipSnapshot,
  PersonCandidate,
  PersonProfile,
  PersonalBestSnapshot,
  RelationCacheSnapshot,
} from "../types/diagnosis.js";

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
  updatedAt: Date;
};

type QueryClient = Pick<Pool, "query">;

function getQueryClient(client?: QueryClient) {
  return client ?? getBusinessPool();
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
  client?: QueryClient;
}): Promise<PersonCandidate[]> {
  const client = getQueryClient(input.client);
  const normalized = normalizeSearchKey(input.displayNameJa);
  const { rows } = await client.query<{
    id: string;
    slug: string;
    displayNameJa: string;
  }>(
    `
      SELECT
        p."id",
        p."slug",
        p."displayNameJa"
      FROM "Person" p
      WHERE p."displayNameJaSearch" = $1
        AND p."id" <> $2
      ORDER BY p."updatedAt" DESC, p."displayNameJa" ASC
      LIMIT 10
    `,
    [normalized, input.personId],
  );

  return (rows as Array<{
    id: string;
    slug: string;
    displayNameJa: string;
  }>).map((row) => ({
    personId: row.id,
    personSlug: row.slug,
    displayNameJa: row.displayNameJa,
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
