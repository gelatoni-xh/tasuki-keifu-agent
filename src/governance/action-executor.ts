import type { PoolClient } from "pg";

import { getBusinessWritePool } from "../db/business.js";
import type { ActionBundleItem } from "../types/diagnosis.js";

type MergePersonPayload = {
  canonicalPersonId: string;
  canonicalPersonSlug: string;
  duplicatePersonId: string;
  duplicatePersonSlug: string;
  researchSummary?: string | null;
};

type WikipediaProfilePayload = {
  personId: string;
  personSlug: string;
  sourceUrl: string;
  suggestedFields: Record<string, string>;
};

type WikipediaPersonalBestsPayload = {
  personId: string;
  personSlug: string;
  sourceUrl: string;
  personalBests: Array<{
    discipline: string;
    mark: string;
    markMillis: number;
  }>;
};

type MarkMembershipsConflictingPayload = {
  personId: string;
  membershipIds: string[];
  findingCodes: string[];
};

type MarkPersonalBestsConflictingPayload = {
  personId: string;
  personalBestIds: string[];
  findingCodes: string[];
};

type PersonForMerge = {
  id: string;
  slug: string;
  displayNameJa: string;
  displayNameJaSearch: string;
  updatedAt: Date;
};

const wikipediaSourceUrl = "https://ja.wikipedia.org/";
const profileFieldNames = ["birthDate", "hometown", "nationality", "displayNameKana"] as const;
const personalBestDisciplines = new Set([
  "m800",
  "m1500",
  "m2000sc",
  "m3000",
  "m3000sc",
  "m5000",
  "m10000",
  "ten_mile",
  "half_marathon",
  "marathon",
]);

function actionPayload(action: ActionBundleItem) {
  return action.payload as Record<string, unknown>;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isWikipediaUrl(value: unknown): value is string {
  if (!isNonEmptyString(value)) {
    return false;
  }

  try {
    return new URL(value).hostname.endsWith(".wikipedia.org");
  } catch {
    return false;
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every((item) => isNonEmptyString(item));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

function isMergePersonPayload(value: Record<string, unknown>): value is MergePersonPayload {
  return [
    "canonicalPersonId",
    "canonicalPersonSlug",
    "duplicatePersonId",
    "duplicatePersonSlug",
  ].every((key) => typeof value[key] === "string" && value[key].trim().length > 0);
}

export function parseMergePersonPayload(action: ActionBundleItem): MergePersonPayload {
  const payload = actionPayload(action);
  if (action.code !== "merge_person_duplicate" || !isMergePersonPayload(payload)) {
    throw new Error(`Unsupported action payload: ${action.code}`);
  }

  if (payload.canonicalPersonId === payload.duplicatePersonId) {
    throw new Error("Merge action requires two different person records.");
  }

  return payload;
}

export function parseWikipediaProfilePayload(action: ActionBundleItem): WikipediaProfilePayload {
  const payload = actionPayload(action);
  if (
    action.code !== "backfill_profile_from_wikipedia"
    || !isNonEmptyString(payload.personId)
    || !isNonEmptyString(payload.personSlug)
    || !isWikipediaUrl(payload.sourceUrl)
    || !isStringRecord(payload.suggestedFields)
  ) {
    throw new Error(`Unsupported action payload: ${action.code}`);
  }

  const suggestedFields = Object.fromEntries(
    Object.entries(payload.suggestedFields).filter(
      ([field, value]) => profileFieldNames.includes(field as (typeof profileFieldNames)[number]) && isNonEmptyString(value),
    ),
  );
  if (Object.keys(suggestedFields).length === 0) {
    throw new Error("Wikipedia profile action has no supported fields.");
  }

  return {
    personId: payload.personId,
    personSlug: payload.personSlug,
    sourceUrl: payload.sourceUrl,
    suggestedFields,
  };
}

export function parseWikipediaPersonalBestsPayload(action: ActionBundleItem): WikipediaPersonalBestsPayload {
  const payload = actionPayload(action);
  if (
    action.code !== "upsert_personal_bests_from_wikipedia"
    || !isNonEmptyString(payload.personId)
    || !isNonEmptyString(payload.personSlug)
    || !isWikipediaUrl(payload.sourceUrl)
    || !Array.isArray(payload.personalBests)
  ) {
    throw new Error(`Unsupported action payload: ${action.code}`);
  }

  const personalBests = payload.personalBests.flatMap((item) => {
    if (
      !item
      || typeof item !== "object"
      || !isNonEmptyString((item as Record<string, unknown>).discipline)
      || !isNonEmptyString((item as Record<string, unknown>).mark)
      || !Number.isInteger((item as Record<string, unknown>).markMillis)
      || Number((item as Record<string, unknown>).markMillis) <= 0
      || !personalBestDisciplines.has((item as Record<string, unknown>).discipline as string)
    ) {
      return [];
    }

    return [{
      discipline: (item as Record<string, unknown>).discipline as string,
      mark: (item as Record<string, unknown>).mark as string,
      markMillis: (item as Record<string, unknown>).markMillis as number,
    }];
  });
  if (personalBests.length === 0) {
    throw new Error("Wikipedia PB action has no supported records.");
  }

  return {
    personId: payload.personId,
    personSlug: payload.personSlug,
    sourceUrl: payload.sourceUrl,
    personalBests,
  };
}

export function parseMarkMembershipsConflictingPayload(action: ActionBundleItem): MarkMembershipsConflictingPayload {
  const payload = actionPayload(action);
  if (
    action.code !== "mark_memberships_conflicting"
    || !isNonEmptyString(payload.personId)
    || !isStringArray(payload.membershipIds)
    || !isStringArray(payload.findingCodes)
  ) {
    throw new Error(`Unsupported action payload: ${action.code}`);
  }

  return {
    personId: payload.personId,
    membershipIds: [...new Set(payload.membershipIds)].sort(),
    findingCodes: [...new Set(payload.findingCodes)].sort(),
  };
}

export function parseMarkPersonalBestsConflictingPayload(action: ActionBundleItem): MarkPersonalBestsConflictingPayload {
  const payload = actionPayload(action);
  if (
    action.code !== "mark_personal_bests_conflicting"
    || !isNonEmptyString(payload.personId)
    || !isStringArray(payload.personalBestIds)
    || !isStringArray(payload.findingCodes)
  ) {
    throw new Error(`Unsupported action payload: ${action.code}`);
  }

  return {
    personId: payload.personId,
    personalBestIds: [...new Set(payload.personalBestIds)].sort(),
    findingCodes: [...new Set(payload.findingCodes)].sort(),
  };
}

async function loadPeopleForMerge(client: PoolClient, payload: MergePersonPayload) {
  const { rows } = await client.query<PersonForMerge>(
    `
      SELECT
        p."id",
        p."slug",
        p."displayNameJa",
        p."displayNameJaSearch",
        p."updatedAt"
      FROM "Person" p
      WHERE p."id" = ANY($1::text[])
      ORDER BY p."id"
      FOR UPDATE
    `,
    [[payload.canonicalPersonId, payload.duplicatePersonId]],
  );

  const canonical = rows.find((row) => row.id === payload.canonicalPersonId);
  const duplicate = rows.find((row) => row.id === payload.duplicatePersonId);
  if (!canonical || !duplicate) {
    throw new Error("Merge action target no longer exists.");
  }

  if (canonical.slug !== payload.canonicalPersonSlug || duplicate.slug !== payload.duplicatePersonSlug) {
    throw new Error("Merge action target slug changed after diagnosis.");
  }

  if (!canonical.displayNameJaSearch || canonical.displayNameJaSearch !== duplicate.displayNameJaSearch) {
    throw new Error("Merge action name normalization no longer matches.");
  }

  return { canonical, duplicate };
}

async function movePersonReferences(client: PoolClient, canonicalId: string, duplicateId: string) {
  await client.query(`UPDATE "Membership" SET "personId" = $1 WHERE "personId" = $2`, [canonicalId, duplicateId]);
  await client.query(`UPDATE "PersonalBest" SET "personId" = $1 WHERE "personId" = $2`, [canonicalId, duplicateId]);
  await client.query(`UPDATE "RaceResult" SET "personId" = $1 WHERE "personId" = $2`, [canonicalId, duplicateId]);
  await client.query(`UPDATE "SourceReference" SET "personId" = $1 WHERE "personId" = $2`, [canonicalId, duplicateId]);
}

async function mergePersonProfiles(client: PoolClient, canonicalId: string, duplicateId: string) {
  await client.query(
    `
      UPDATE "Person" canonical
      SET
        "displayNameKana" = COALESCE(canonical."displayNameKana", duplicate."displayNameKana"),
        "displayNameRoman" = COALESCE(canonical."displayNameRoman", duplicate."displayNameRoman"),
        "displayNameZh" = COALESCE(canonical."displayNameZh", duplicate."displayNameZh"),
        "displayNameEn" = COALESCE(canonical."displayNameEn", duplicate."displayNameEn"),
        "birthDate" = COALESCE(canonical."birthDate", duplicate."birthDate"),
        "hometown" = COALESCE(canonical."hometown", duplicate."hometown"),
        "nationality" = COALESCE(canonical."nationality", duplicate."nationality"),
        "heightCm" = COALESCE(canonical."heightCm", duplicate."heightCm"),
        "weightKg" = COALESCE(canonical."weightKg", duplicate."weightKg"),
        "notes" = COALESCE(canonical."notes", duplicate."notes")
      FROM "Person" duplicate
      WHERE canonical."id" = $1
        AND duplicate."id" = $2
    `,
    [canonicalId, duplicateId],
  );
}

async function preserveNameVariants(client: PoolClient, canonical: PersonForMerge, duplicate: PersonForMerge) {
  await client.query(
    `
      INSERT INTO "NameVariant" ("id", "value", "type", "isPrimary", "personId", "sourceId", "language", "createdAt", "updatedAt")
      SELECT
        CONCAT('agent-', substr(md5(random()::text || clock_timestamp()::text), 1, 21)),
        nv."value",
        nv."type",
        false,
        $1,
        nv."sourceId",
        nv."language",
        NOW(),
        NOW()
      FROM "NameVariant" nv
      WHERE nv."personId" = $2
        AND NOT EXISTS (
          SELECT 1
          FROM "NameVariant" existing
          WHERE existing."personId" = $1
            AND existing."value" = nv."value"
        )
    `,
    [canonical.id, duplicate.id],
  );

  for (const value of new Set([canonical.displayNameJa, duplicate.displayNameJa])) {
    await client.query(
      `
        INSERT INTO "NameVariant" ("id", "value", "type", "isPrimary", "personId", "createdAt", "updatedAt")
        SELECT
          CONCAT('agent-', substr(md5(random()::text || clock_timestamp()::text), 1, 21)),
          $2,
          'official',
          false,
          $1,
          NOW(),
          NOW()
        WHERE NOT EXISTS (
          SELECT 1
          FROM "NameVariant" existing
          WHERE existing."personId" = $1
            AND existing."value" = $2
        )
      `,
      [canonical.id, value],
    );
  }
}

async function executeMergePersonDuplicate(action: ActionBundleItem) {
  const payload = parseMergePersonPayload(action);
  const pool = getBusinessWritePool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const { canonical, duplicate } = await loadPeopleForMerge(client, payload);

    await mergePersonProfiles(client, canonical.id, duplicate.id);
    await movePersonReferences(client, canonical.id, duplicate.id);
    await preserveNameVariants(client, canonical, duplicate);
    await client.query(
      `DELETE FROM "PlayerRelationCache" WHERE "personId" = ANY($1::text[])`,
      [[canonical.id, duplicate.id]],
    );
    await client.query(
      `
        INSERT INTO "AuditLog" (
          "id",
          "entityType",
          "entityId",
          "action",
          "oldValue",
          "newValue",
          "reasonType",
          "reasonNote",
          "actorType",
          "metadata",
          "createdAt"
        )
        VALUES (
          CONCAT('agent-', substr(md5(random()::text || clock_timestamp()::text), 1, 21)),
          'Person',
          $1,
          'merge',
          jsonb_build_object(
            'mergedPersonId', $2,
            'mergedPersonSlug', $3,
            'mergedPersonNameJa', $4
          ),
          jsonb_build_object(
            'canonicalPersonId', $1,
            'canonicalPersonSlug', $5,
            'canonicalPersonNameJa', $6
          ),
          'entity_merge',
          $7,
          'system',
          jsonb_build_object('agentActionCode', $8, 'idempotencyKey', $9),
          NOW()
        )
      `,
      [
        canonical.id,
        duplicate.id,
        duplicate.slug,
        duplicate.displayNameJa,
        canonical.slug,
        canonical.displayNameJa,
        payload.researchSummary ?? "Agent-confirmed duplicate person merge.",
        action.code,
        action.idempotencyKey,
      ],
    );
    await client.query(`DELETE FROM "NameVariant" WHERE "personId" = $1`, [duplicate.id]);
    await client.query(`DELETE FROM "Person" WHERE "id" = $1`, [duplicate.id]);
    await client.query("COMMIT");

    return {
      canonicalPersonId: canonical.id,
      canonicalPersonSlug: canonical.slug,
      duplicatePersonId: duplicate.id,
      duplicatePersonSlug: duplicate.slug,
      action: "merged",
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function ensureWikipediaSource(client: PoolClient) {
  const { rows } = await client.query<{ id: string }>(
    `
      SELECT "id"
      FROM "Source"
      WHERE "name" = 'Wikipedia'
        AND "url" = $1
      ORDER BY "createdAt" ASC
      LIMIT 1
      FOR UPDATE
    `,
    [wikipediaSourceUrl],
  );
  if (rows[0]) {
    await client.query(`UPDATE "Source" SET "accessedOn" = NOW() WHERE "id" = $1`, [rows[0].id]);
    return rows[0].id;
  }

  const { rows: inserted } = await client.query<{ id: string }>(
    `
      INSERT INTO "Source" (
        "id", "name", "url", "type", "accessedOn", "reliability", "notes", "createdAt", "updatedAt"
      )
      VALUES (
        CONCAT('agent-', substr(md5(random()::text || clock_timestamp()::text), 1, 21)),
        'Wikipedia',
        $1,
        'data_site',
        NOW(),
        4,
        'Created by tasuki-keifu-agent for Wikipedia-governed writes.',
        NOW(),
        NOW()
      )
      RETURNING "id"
    `,
    [wikipediaSourceUrl],
  );
  return inserted[0].id;
}

async function requirePersonForWrite(client: PoolClient, input: { personId: string; personSlug: string }) {
  const { rows } = await client.query<{
    id: string;
    slug: string;
    birthDate: Date | null;
    hometown: string | null;
    nationality: string | null;
    displayNameKana: string | null;
  }>(
    `
      SELECT "id", "slug", "birthDate", "hometown", "nationality", "displayNameKana"
      FROM "Person"
      WHERE "id" = $1
      FOR UPDATE
    `,
    [input.personId],
  );
  const person = rows[0];
  if (!person || person.slug !== input.personSlug) {
    throw new Error("Person target changed after diagnosis.");
  }
  return person;
}

async function recordAuditLog(client: PoolClient, input: {
  entityType: string;
  entityId: string;
  action: "create" | "update";
  fieldName?: string | null;
  oldValue: unknown;
  newValue: unknown;
  reasonType: "source_update" | "verification_update";
  reasonNote: string;
  sourceId?: string | null;
  metadata: Record<string, unknown>;
}) {
  await client.query(
    `
      INSERT INTO "AuditLog" (
        "id", "entityType", "entityId", "action", "fieldName",
        "oldValue", "newValue", "reasonType", "reasonNote",
        "sourceId", "actorType", "metadata", "createdAt"
      )
      VALUES (
        CONCAT('agent-', substr(md5(random()::text || clock_timestamp()::text), 1, 21)),
        $1, $2, $3, $4,
        $5::jsonb, $6::jsonb, $7, $8,
        $9, 'system', $10::jsonb, NOW()
      )
    `,
    [
      input.entityType,
      input.entityId,
      input.action,
      input.fieldName ?? null,
      JSON.stringify(input.oldValue),
      JSON.stringify(input.newValue),
      input.reasonType,
      input.reasonNote,
      input.sourceId ?? null,
      JSON.stringify(input.metadata),
    ],
  );
}

async function executeBackfillProfileFromWikipedia(action: ActionBundleItem) {
  const payload = parseWikipediaProfilePayload(action);
  const pool = getBusinessWritePool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const person = await requirePersonForWrite(client, payload);
    const sourceId = await ensureWikipediaSource(client);
    const next = {
      birthDate: person.birthDate ? null : payload.suggestedFields.birthDate ?? null,
      hometown: person.hometown ? null : payload.suggestedFields.hometown ?? null,
      nationality: person.nationality ? null : payload.suggestedFields.nationality ?? null,
      displayNameKana: person.displayNameKana ? null : payload.suggestedFields.displayNameKana ?? null,
    };
    const changed = Object.fromEntries(
      Object.entries(next).filter(([, value]) => value !== null),
    );

    if (Object.keys(changed).length === 0) {
      await client.query("COMMIT");
      return { personId: person.id, action: "skipped", reason: "profile_fields_already_present" };
    }

    await client.query(
      `
        UPDATE "Person"
        SET
          "birthDate" = COALESCE("birthDate", $2::date),
          "hometown" = COALESCE("hometown", $3),
          "nationality" = COALESCE("nationality", $4),
          "displayNameKana" = COALESCE("displayNameKana", $5)
        WHERE "id" = $1
      `,
      [person.id, next.birthDate, next.hometown, next.nationality, next.displayNameKana],
    );
    await client.query(
      `
        INSERT INTO "SourceReference" (
          "id", "sourceId", "sourceEntityType", "sourceEntityKey", "sourceUrl", "personId", "metadata", "createdAt", "updatedAt"
        )
        VALUES (
          CONCAT('agent-', substr(md5(random()::text || clock_timestamp()::text), 1, 21)),
          $1, 'wikipedia_person', $2, $3, $2, $4::jsonb, NOW(), NOW()
        )
        ON CONFLICT ("sourceId", "sourceEntityType", "sourceEntityKey")
        DO UPDATE SET
          "sourceUrl" = EXCLUDED."sourceUrl",
          "metadata" = EXCLUDED."metadata",
          "updatedAt" = NOW()
      `,
      [sourceId, person.id, payload.sourceUrl, JSON.stringify({ agentActionCode: action.code })],
    );
    await recordAuditLog(client, {
      entityType: "Person",
      entityId: person.id,
      action: "update",
      oldValue: {
        birthDate: person.birthDate?.toISOString().slice(0, 10) ?? null,
        hometown: person.hometown,
        nationality: person.nationality,
        displayNameKana: person.displayNameKana,
      },
      newValue: changed,
      reasonType: "source_update",
      reasonNote: "Wikipedia supplied explicit missing profile fields.",
      sourceId,
      metadata: { agentActionCode: action.code, idempotencyKey: action.idempotencyKey, sourceUrl: payload.sourceUrl },
    });
    await client.query("COMMIT");

    return { personId: person.id, action: "updated", fields: Object.keys(changed) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function executeUpsertPersonalBestsFromWikipedia(action: ActionBundleItem) {
  const payload = parseWikipediaPersonalBestsPayload(action);
  const pool = getBusinessWritePool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await requirePersonForWrite(client, payload);
    const sourceId = await ensureWikipediaSource(client);
    const results: Array<Record<string, unknown>> = [];

    for (const personalBest of payload.personalBests) {
      const { rows: existingRows } = await client.query<{
        id: string;
        mark: string;
        markMillis: number | null;
        sourceId: string | null;
        status: string;
      }>(
        `
          SELECT "id", "mark", "markMillis", "sourceId", "status"
          FROM "PersonalBest"
          WHERE "personId" = $1
            AND "discipline" = $2
          ORDER BY "createdAt" ASC
          FOR UPDATE
        `,
        [payload.personId, personalBest.discipline],
      );

      if (existingRows.length === 0 || existingRows.length >= 2) {
        const { rows: inserted } = await client.query<{ id: string }>(
          `
            INSERT INTO "PersonalBest" (
              "id", "personId", "discipline", "mark", "markMillis",
              "isHighSchoolPb", "isCollegePb", "status", "sourceId", "createdAt", "updatedAt"
            )
            VALUES (
              CONCAT('agent-', substr(md5(random()::text || clock_timestamp()::text), 1, 21)),
              $1, $2, $3, $4,
              false, false, 'verified', $5, NOW(), NOW()
            )
            RETURNING "id"
          `,
          [payload.personId, personalBest.discipline, personalBest.mark, personalBest.markMillis, sourceId],
        );
        await recordAuditLog(client, {
          entityType: "PersonalBest",
          entityId: inserted[0].id,
          action: "create",
          oldValue: null,
          newValue: personalBest,
          reasonType: "source_update",
          reasonNote: existingRows.length >= 2
            ? "Wikipedia PB was added without replacing multiple existing records."
            : "Wikipedia supplied a new PB record.",
          sourceId,
          metadata: { agentActionCode: action.code, idempotencyKey: action.idempotencyKey, sourceUrl: payload.sourceUrl },
        });
        results.push({
          discipline: personalBest.discipline,
          action: "created",
          personalBestId: inserted[0].id,
          existingCount: existingRows.length,
        });
        continue;
      }

      const existing = existingRows[0];
      const changed =
        existing.mark !== personalBest.mark
        || existing.markMillis !== personalBest.markMillis
        || existing.sourceId !== sourceId
        || existing.status !== "verified";
      if (changed) {
        await client.query(
          `
            UPDATE "PersonalBest"
            SET
              "mark" = $2,
              "markMillis" = $3,
              "sourceId" = $4,
              "status" = 'verified'
            WHERE "id" = $1
          `,
          [existing.id, personalBest.mark, personalBest.markMillis, sourceId],
        );
        await recordAuditLog(client, {
          entityType: "PersonalBest",
          entityId: existing.id,
          action: "update",
          oldValue: existing,
          newValue: personalBest,
          reasonType: "source_update",
          reasonNote: "Wikipedia supplied an explicit PB value.",
          sourceId,
          metadata: { agentActionCode: action.code, idempotencyKey: action.idempotencyKey, sourceUrl: payload.sourceUrl },
        });
      }
      results.push({ discipline: personalBest.discipline, action: changed ? "updated" : "skipped", personalBestId: existing.id });
    }

    await client.query("COMMIT");
    return { personId: payload.personId, results };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function executeMarkMembershipsConflicting(action: ActionBundleItem) {
  const payload = parseMarkMembershipsConflictingPayload(action);
  const pool = getBusinessWritePool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string; status: string }>(
      `
        SELECT "id", "status"
        FROM "Membership"
        WHERE "personId" = $1
          AND "id" = ANY($2::text[])
        ORDER BY "id"
        FOR UPDATE
      `,
      [payload.personId, payload.membershipIds],
    );
    if (rows.length !== payload.membershipIds.length) {
      throw new Error("Membership targets changed after diagnosis.");
    }

    for (const membership of rows) {
      if (membership.status === "conflicting") {
        continue;
      }
      await client.query(`UPDATE "Membership" SET "status" = 'conflicting' WHERE "id" = $1`, [membership.id]);
      await recordAuditLog(client, {
        entityType: "Membership",
        entityId: membership.id,
        action: "update",
        oldValue: { status: membership.status },
        newValue: { status: "conflicting" },
        reasonType: "verification_update",
        reasonNote: "Agent detected a membership timeline anomaly.",
        metadata: { agentActionCode: action.code, idempotencyKey: action.idempotencyKey, findingCodes: payload.findingCodes },
      });
    }
    await client.query("COMMIT");
    return { personId: payload.personId, action: "marked_conflicting", membershipIds: rows.map((row) => row.id) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function executeMarkPersonalBestsConflicting(action: ActionBundleItem) {
  const payload = parseMarkPersonalBestsConflictingPayload(action);
  const pool = getBusinessWritePool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string; status: string }>(
      `
        SELECT "id", "status"
        FROM "PersonalBest"
        WHERE "personId" = $1
          AND "id" = ANY($2::text[])
        ORDER BY "id"
        FOR UPDATE
      `,
      [payload.personId, payload.personalBestIds],
    );
    if (rows.length !== payload.personalBestIds.length) {
      throw new Error("PB targets changed after diagnosis.");
    }

    for (const personalBest of rows) {
      if (personalBest.status === "conflicting") {
        continue;
      }
      await client.query(`UPDATE "PersonalBest" SET "status" = 'conflicting' WHERE "id" = $1`, [personalBest.id]);
      await recordAuditLog(client, {
        entityType: "PersonalBest",
        entityId: personalBest.id,
        action: "update",
        oldValue: { status: personalBest.status },
        newValue: { status: "conflicting" },
        reasonType: "verification_update",
        reasonNote: "Agent detected a PB conflict without Wikipedia confirmation.",
        metadata: { agentActionCode: action.code, idempotencyKey: action.idempotencyKey, findingCodes: payload.findingCodes },
      });
    }
    await client.query("COMMIT");
    return { personId: payload.personId, action: "marked_conflicting", personalBestIds: rows.map((row) => row.id) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function executeAction(action: ActionBundleItem) {
  if (action.code === "merge_person_duplicate") {
    return executeMergePersonDuplicate(action);
  }
  if (action.code === "backfill_profile_from_wikipedia") {
    return executeBackfillProfileFromWikipedia(action);
  }
  if (action.code === "upsert_personal_bests_from_wikipedia") {
    return executeUpsertPersonalBestsFromWikipedia(action);
  }
  if (action.code === "mark_memberships_conflicting") {
    return executeMarkMembershipsConflicting(action);
  }
  if (action.code === "mark_personal_bests_conflicting") {
    return executeMarkPersonalBestsConflicting(action);
  }

  throw new Error(`No executor is registered for action: ${action.code}`);
}
