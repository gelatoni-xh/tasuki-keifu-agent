import { parseMergePersonPayload } from "../governance/action-executor.js";
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

  process.stdout.write(`${JSON.stringify({ validPayload: true, invalidPayloadRejected: true }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
