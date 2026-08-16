import {
  parseMarkMembershipsConflictingPayload,
  parseMarkPersonalBestsConflictingPayload,
  parseMergePersonPayload,
  parseWikipediaPersonalBestsPayload,
  parseWikipediaProfilePayload,
} from "../governance/action-executor.js";
import type { ActionBundleItem } from "../types/diagnosis.js";

const validAction: ActionBundleItem = {
  code: "merge_person_duplicate",
  title: "Merge confirmed duplicate person",
  order: 1,
  rationale: "smoke test",
  relatedIssueCodes: ["duplicate_normalized_name"],
  payload: {
    canonicalPersonId: "canonical-id",
    canonicalPersonSlug: "canonical-person",
    duplicatePersonId: "duplicate-id",
    duplicatePersonSlug: "duplicate-person",
    researchSummary: "same person",
  },
  idempotencyKey: "person:canonical-id:duplicate-id:merge_person_duplicate",
};

const validWikipediaProfileAction: ActionBundleItem = {
  code: "backfill_profile_from_wikipedia",
  title: "Backfill profile fields from Wikipedia",
  order: 1,
  rationale: "smoke test",
  relatedIssueCodes: ["profile_wikipedia_data_available"],
  payload: {
    personId: "person-id",
    personSlug: "person-slug",
    sourceUrl: "https://ja.wikipedia.org/wiki/%E4%BD%90%E8%97%A4%E7%A2%A7",
    suggestedFields: { birthDate: "1997-09-25" },
  },
  idempotencyKey: "person:person-id:backfill_profile_from_wikipedia:birthDate=1997-09-25",
};

const validWikipediaPersonalBestAction: ActionBundleItem = {
  code: "upsert_personal_bests_from_wikipedia",
  title: "Upsert personal bests from Wikipedia",
  order: 1,
  rationale: "smoke test",
  relatedIssueCodes: ["wikipedia_personal_bests_available"],
  payload: {
    personId: "person-id",
    personSlug: "person-slug",
    sourceUrl: "https://ja.wikipedia.org/wiki/%E4%BD%90%E8%97%A4%E7%A2%A7",
    personalBests: [{ discipline: "m5000", mark: "13:45.67", markMillis: 825670 }],
  },
  idempotencyKey: "person:person-id:upsert_personal_bests_from_wikipedia:m5000=825670",
};

const validMembershipConflictAction: ActionBundleItem = {
  code: "mark_memberships_conflicting",
  title: "Mark conflicting memberships",
  order: 1,
  rationale: "smoke test",
  relatedIssueCodes: ["multiple_current_memberships"],
  payload: {
    personId: "person-id",
    membershipIds: ["membership-a", "membership-b"],
    findingCodes: ["multiple_current_memberships"],
  },
  idempotencyKey: "person:membership-a:membership-b:mark_memberships_conflicting:multiple_current_memberships",
};

const validPersonalBestConflictAction: ActionBundleItem = {
  code: "mark_personal_bests_conflicting",
  title: "Mark conflicting personal bests",
  order: 1,
  rationale: "smoke test",
  relatedIssueCodes: ["conflicting_personal_best"],
  payload: {
    personId: "person-id",
    personalBestIds: ["pb-a", "pb-b"],
    findingCodes: ["conflicting_personal_best"],
  },
  idempotencyKey: "person:pb-a:pb-b:mark_personal_bests_conflicting:conflicting_personal_best",
};

async function main() {
  const payload = parseMergePersonPayload(validAction);
  if (payload.canonicalPersonId !== "canonical-id" || payload.duplicatePersonId !== "duplicate-id") {
    throw new Error("valid merge payload was not parsed");
  }

  let invalidPayloadRejected = false;
  try {
    parseMergePersonPayload({
      ...validAction,
      payload: {
        canonicalPersonId: "same-id",
        canonicalPersonSlug: "same-person",
        duplicatePersonId: "same-id",
        duplicatePersonSlug: "same-person",
      },
    });
  } catch {
    invalidPayloadRejected = true;
  }

  if (!invalidPayloadRejected) {
    throw new Error("merge action with identical targets was accepted");
  }

  const profile = parseWikipediaProfilePayload(validWikipediaProfileAction);
  const personalBests = parseWikipediaPersonalBestsPayload(validWikipediaPersonalBestAction);
  const memberships = parseMarkMembershipsConflictingPayload(validMembershipConflictAction);
  const personalBestConflicts = parseMarkPersonalBestsConflictingPayload(validPersonalBestConflictAction);
  if (
    profile.suggestedFields.birthDate !== "1997-09-25"
    || personalBests.personalBests[0]?.discipline !== "m5000"
    || memberships.membershipIds.length !== 2
    || personalBestConflicts.personalBestIds.length !== 2
  ) {
    throw new Error("new action payload was not parsed");
  }

  process.stdout.write(`${JSON.stringify({
    validMergePayload: true,
    invalidMergePayloadRejected: true,
    validWikipediaProfilePayload: true,
    validWikipediaPersonalBestPayload: true,
    validMembershipConflictPayload: true,
    validPersonalBestConflictPayload: true,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
