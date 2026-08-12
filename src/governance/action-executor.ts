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

type PersonForMerge = {
  id: string;
  slug: string;
  displayNameJa: string;
  displayNameJaSearch: string;
  updatedAt: Date;
};

function isMergePersonPayload(value: Record<string, unknown>): value is MergePersonPayload {
  return [
    "canonicalPersonId",
    "canonicalPersonSlug",
    "duplicatePersonId",
    "duplicatePersonSlug",
  ].every((key) => typeof value[key] === "string" && value[key].trim().length > 0);
}

export function parseMergePersonPayload(action: ActionBundleItem) {
  if (action.code !== "merge_person_duplicate" || !isMergePersonPayload(action.payload)) {
    throw new Error(`Unsupported action payload: ${action.code}`);
  }

  const payload = action.payload;
  if (payload.canonicalPersonId === payload.duplicatePersonId) {
    throw new Error("Merge action requires two different person records.");
  }

  return payload;
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

export async function executeAction(action: ActionBundleItem) {
  if (action.code === "merge_person_duplicate") {
    return executeMergePersonDuplicate(action);
  }

  throw new Error(`No executor is registered for action: ${action.code}`);
}
