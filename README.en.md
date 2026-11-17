# tasuki-keifu-agent

[![中文](https://img.shields.io/badge/阅读中文-README.md-555?style=flat-square)](README.md) [![English](https://img.shields.io/badge/Read%20English-README.en.md-1677ff?style=flat-square)](README.en.md) [![日本語](https://img.shields.io/badge/日本語で読む-README.ja.md-555?style=flat-square)](README.ja.md)

`tasuki-keifu-agent` is the internal data-governance service for `tasuki-keifu`. Its current workflow is event- and unit-driven: existing event data is submitted and governed one leg, heat, or group at a time. The production entry point is the event governance runner in `src/governance-v2/cli.ts`. The older person-diagnosis and batch CLIs remain for compatibility; they are not the new event-import workflow.

## Governance Workflow

1. The competition, edition, Race records, and Source must already exist in the main site database. This service does not create event shells or call the legacy race-import writer.
2. A task contains one or more explicit batches. Each batch specifies `unitType` (`leg`, `heat`, or `group`), `unitKey`, `sequence`, `raceSlug`, and source data.
3. Deterministic rules handle explainable normalization and matching first. Remaining identity questions go through one lightweight whole-batch normalization pass, followed by budgeted research. A cross-check reviews organization and person decisions for contradictions. If independent organization evidence changes a mapping, only affected people are reassessed once; the graph does not loop.
4. Batches run sequentially within an event task. Serious unresolved findings are retained with their evidence and can trigger an alert; they are never silently converted into confirmed identities. Other unresolved findings do not block valid rows from being processed.
5. `dry_run` creates a plan and report without writing business tables. After reviewing the plan, submit an `apply` task with a new `requestKey`. Apply uses separate read/write database connections and controlled transactions.

See [`docs/governance-v2.md`](docs/governance-v2.md) for the input contract, recovery behavior, deployment requirements, and rollback procedure.

## Observability and Notifications

Tasks, batches, agent executions, model calls, governance changes, and unresolved evidence are stored in the main site's `governance` schema. Observability includes queue wait, execution and retry duration, model and call counts, input/output tokens, web queries, estimated cost, and resolved/unresolved and planned-change outcomes. Cost estimates require configured model pricing.

An independent mail worker sends durable queued notifications. Event summaries include the event name in the subject; alerts include the event and leg/group identifier. Failed delivery is retried, and a stable Message-ID helps identify duplicate messages.

## Local Development

```bash
pnpm install
pnpm typecheck
pnpm test:governance
GOVERNANCE_MAIN_REPO=/path/to/tasuki-keifu bash scripts/test-governance-integration.sh
```

The integration script starts a disposable local PostgreSQL instance, applies the site's full migration chain, runs the tests, and removes the database. It never connects to production. Local PostgreSQL tools (`initdb`, `pg_ctl`, and `createdb`) are required.

Set these variables before running the governance CLI:

- `GOVERNANCE_DATABASE_URL`: runtime connection to the main site database with the `governance` schema.
- `GOVERNANCE_READ_DATABASE_URL`: read-only connection; apply mode requires a separate connection.
- `GOVERNANCE_PAYLOAD_DIR`: absolute path for durable raw batch payloads.
- `GOVERNANCE_WRITE_ENABLED`: off by default; enable apply writes only after reviewing the plan.
- `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `GOVERNANCE_RESEARCH_MODEL`: optional explicit research-model configuration. Rules still run without a model; serious questions requiring research remain unresolved.
- `GOVERNANCE_RESEARCH_REQUESTS`, `GOVERNANCE_RESEARCH_TIMEOUT_MS`: per-batch research request budget and timeout.
- `GOVERNANCE_MAIL_ENABLED`, `MAIL_CONFIG`: explicit mail-worker switch and SMTP/Resend configuration.

See [`deploy/governance-v2.env.example`](deploy/governance-v2.env.example) for the environment template. Never commit credentials or copy production connection strings into a development environment.

## Event Task Commands

```bash
node --import tsx src/governance-v2/cli.ts adapt eventspec.json > manifest.json
node --import tsx src/governance-v2/cli.ts submit manifest.json
node --import tsx src/governance-v2/cli.ts run TASK_UUID
node --import tsx src/governance-v2/cli.ts status TASK_UUID
node --import tsx src/governance-v2/cli.ts worker
node --import tsx src/governance-v2/cli.ts retry TASK_UUID
```

`adapt` converts an existing `RaceImportPayload` into a validated manifest and does not write data. Start with `dry_run` and review its plan and report. Submit `apply` only after the plan, database access, and write switch have been reviewed. Inspect a failed task before explicitly retrying it. Later batches stop when an earlier batch fails.

Mail operations:

```bash
node --import tsx src/governance-v2/cli.ts health
node --import tsx src/governance-v2/cli.ts deliver
node --import tsx src/governance-v2/cli.ts mail-worker
```

The operations manual documents checkpoint initialization, database permissions, Compose resource limits, and rollback. Production runs should be scheduled and observed group by group by the event owner; these local examples do not authorize running a real event.
