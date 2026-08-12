# tasuki-keifu-agent

Internal LangGraph-based agent for `tasuki-keifu` data diagnosis.

V1 scope:

- `person diagnosis graph`
- read-only access to the main `tasuki_keifu` business database
- write runtime data to the separate `tasuki_keifu_agent` database
- structured findings and suggested manual actions
- governance batch runner with per-person action-bundle audit records
- LangSmith tracing through standard `LANGCHAIN_*` environment variables
- optional GPT-5.4 name identity research for ambiguous normalization candidates
- direct Wikipedia MediaWiki API profile checks that follow standard HTTP proxy settings or the local macOS system proxy

## Local Setup

```bash
pnpm install
pnpm prisma:generate
cp .env.example .env
```

Set:

- `TASUKI_KEIFU_BUSINESS_DATABASE_URL`
- `TASUKI_KEIFU_BUSINESS_WRITE_DATABASE_URL` only when enabling business writes
- `TASUKI_KEIFU_AGENT_DATABASE_URL`
- `LANGSMITH_API_KEY`
- `LANGSMITH_WORKSPACE_ID`
- `LANGSMITH_TRACING=true`
- `LANGSMITH_PROJECT=tasuki-keifu-agent-v1`
- optional `OPENAI_API_KEY`, `OPENAI_BASE_URL`, and `OPENAI_MODEL`; when omitted, local Codex settings are used
- optional `HTTPS_PROXY` or `HTTP_PROXY` for Wikipedia API access; on macOS, the agent falls back to the system proxy configuration

## Run

```bash
pnpm diagnose -- --person-slug example-person
pnpm diagnose -- --person-id cmxxxx
pnpm diagnose -- --person-name "選手名"
npm run inspect -- --limit 5
npm run inspect -- --person-slug example-person
```

## Smoke Checks

```bash
npm run smoke:diagnosis
npm run smoke:tools
npm run smoke:nodes
```

Current coverage:

- `smoke:diagnosis`: end-to-end graph outputs on real sample cases
- `smoke:tools`: direct tool-level findings for core diagnosis tools
- `smoke:nodes`: graph node-path regression for key resolution branches, including a real ambiguous-name path through `research_name_identity`
- `inspect`: recent agent runs and diagnosis results

The current release records diagnosis results, action bundles, risk holds, and batch audit data in the agent database. The first constrained business write, `merge_person_duplicate`, is available only behind the explicit write-mode safeguards below.

## Governance Batch

```bash
npm run governance:batch -- --limit 20
npm run governance:batch -- --limit 20 --execute
```

The batch runner compares the latest `Person` / `Membership` / `PersonalBest` update with the person's most recent finalized governance run. A risk-held result is finalized too, so unchanged cases are not repeatedly re-run.

- Default mode is dry-run.
- `--execute` still remains dry-run unless both `TASUKI_AGENT_WRITE_ENABLED=true` and `TASUKI_KEIFU_BUSINESS_WRITE_DATABASE_URL` are configured.
- The first registered business write is `merge_person_duplicate`: one LLM-confirmed, normalized-name-identical pair with a clear non-temporary canonical slug.
- The executor re-reads and row-locks both people, moves related records, preserves name variants, clears relation caches, writes a business `AuditLog`, then removes the duplicate in one transaction.
- Membership, PB, and profile actions remain held until they have their own explicit execution rules.
- A high-risk person is held without affecting the rest of the batch.
