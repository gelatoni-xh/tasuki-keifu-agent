import type { GovernanceDB } from "./database.js";
import type { Researcher } from "./research.js";

// Only fetch identity footprints when deterministic matching identified a serious ambiguity.
export function withBusinessResearchContext(
  db: GovernanceDB,
  research: Researcher,
): Researcher {
  return async (request, metrics) => {
    // Organization verification needs compact identity context, not a full merge footprint.
    if (request.kind === "organization_identity" || request.allowNetwork === false) return research(request, metrics);
    if (request.kind !== "person_identity")
      return research(request, metrics);
    const person = request.kind === "person_identity",
      column = person ? "personId" : "organizationId";
    const results = (
      await db.readPool.query(
        `SELECT id,"${column}" AS "entityId","raceId","organizationId","gradeAtRace" FROM public."RaceResult" WHERE "${column}"=ANY($1::text[]) ORDER BY "raceId" LIMIT 101`,
        [request.allowedIds],
      )
    ).rows;
    const refs = (
      await db.readPool.query(
        `SELECT id,"${column}" AS "entityId","sourceId","sourceEntityType","sourceEntityKey" FROM public."SourceReference" WHERE "${column}"=ANY($1::text[]) LIMIT 101`,
        [request.allowedIds],
      )
    ).rows;
    if (results.length > 100 || refs.length > 100) {
      metrics.stoppedReasons.push("identity_footprint_too_large");
      return { stopReason: "identity_footprint_too_large", evidence: [] };
    }
    const memberships = (
      await db.readPool.query(
        `SELECT id,"personId","organizationId",type,"startDate","endDate" FROM public."Membership" WHERE "${column}"=ANY($1::text[]) LIMIT 101`,
        [request.allowedIds],
      )
    ).rows;
    if (memberships.length > 100) {
      metrics.stoppedReasons.push("identity_footprint_too_large");
      return { stopReason: "identity_footprint_too_large", evidence: [] };
    }
    const result = await research(
      {
        ...request,
        context: {
          original: request.context,
          footprints: {
            raceResults: results,
            sourceReferences: refs,
            memberships,
          },
        },
      },
      metrics,
    );
    const answer = result.answer;
    if (!answer) return result;
    if (answer.verdict === "split") {
      const s = answer.split;
      const subset = (
        ids: string[],
        records: Array<{ id: string; [key: string]: unknown }>,
      ) =>
        ids.every((id) =>
          records.some(
            (r) =>
              r.id === id && (r.entityId ?? r.personId) === s?.fromPersonId,
          ),
        );
      if (
        !person ||
        !s ||
        !request.allowedIds.includes(s.fromPersonId) ||
        !subset(s.raceResultIds, results) ||
        !subset(s.membershipIds, memberships) ||
        !subset(s.sourceReferenceIds, refs) ||
        (!s.raceResultIds.length && !s.membershipIds.length)
      )
        return {
          stopReason: "split_associations_not_supported_by_context",
          evidence: result.evidence,
        };
    }
    if (answer.verdict === "merge" && answer.targetId) {
      const canonicalRaces = new Set(
        results
          .filter((r) => r.entityId === answer.targetId)
          .map((r) => r.raceId),
      );
      if (
        person &&
        results.some(
          (r) =>
            answer.duplicateIds.includes(r.entityId) &&
            canonicalRaces.has(r.raceId),
        )
      )
        return {
          stopReason: "merge_requires_resolving_overlapping_results",
          evidence: result.evidence,
        };
      if (!person) {
        const ids = [answer.targetId, ...answer.duplicateIds];
        const teams = (
          await db.readPool.query(
            'SELECT "competitionEditionId" FROM public."TeamCompetitionResult" WHERE "organizationId"=ANY($1::text[]) GROUP BY "competitionEditionId" HAVING count(*)>1 LIMIT 1',
            [ids],
          )
        ).rowCount;
        if (teams)
          return {
            stopReason: "merge_requires_resolving_team_result_collision",
            evidence: result.evidence,
          };
      }
    }
    return result;
  };
}
