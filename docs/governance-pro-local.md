# Governance model configuration

The explicitly selected route is CC Switch's `gpt pro` credential with
`gpt-6.1-sol`, using `https://xcode.best/v1/responses`. Do not use the `plus`
credential merely because its profile selects the same model. Do not inherit the
currently selected Codex group/model.

`npm run governance:pro -- --check` validates the local credential locator and
prints only non-secret configuration. It makes no model call or database connection.
The launcher reads the existing CC Switch store at runtime and passes the credential
to the child process without creating a credential file.

`npm run governance:pro -- <governance CLI arguments>` uses the ordinary governance
CLI, with its normal database, manifest, write and payload configuration. This is
a local launcher; it does not configure or deploy the server worker. The ad hoc
`pilot-nittai333-run.ts` launcher reads server-container configuration and does not
inherit this model selection. Do not use that launcher as evidence of this setup.

The previous 333 heat-1 dry-run lacked model configuration. Its measurements
cover the rules/degraded path only. Keep that report as-is; do not relabel it as
an LLM-enabled run. Selecting a model and listing it do not verify successful
Responses calls, structured outputs, web search, or real prices. Verify those
capabilities before submitting another governance experiment. An unset price
must not be interpreted as a verified zero cost.

No race task is submitted, retried or applied by configuration checks.

## Online configuration verified 2026-11-12

The Ubuntu-3 worker now uses the same explicitly selected `gpt pro` credential,
`gpt-6.1-sol`, `https://xcode.best/v1`, with a 120,000 ms request timeout.
The protected server env file is `/opt/apps/tasuki-keifu-agent/.env.governance`.
No key is stored in this repository. Provisioning is repeatable with
`python3 scripts/configure-governance-model.py --apply`; it backs up the env file
with mode 0600 and does not start a worker or submit tasks.

The provider route needs Responses SSE and message-array input. The adapter
sends the structural strict JSON schema and validates URL/date/nonempty-string
constraints locally with the full Zod schema. Partial/failed streams cannot
produce a decision. Optional output/tool cap parameters are omitted in the
verified protocol; the 120 s timeout, 4 MiB response limit, request-size limit,
and persisted per-batch request budget still apply. There is currently no
verified hard token or monetary ceiling on one provider request.

Because the local checkout contains extensive unrelated work, deployment used
`python3 scripts/deploy-governance-model-adapter.py --apply` to build a derivative
of the existing production image, copying only `research.ts`. The worker image
is `tasuki-keifu-agent:llm-pro-4434c06ae8f4`; the mail service was not recreated.
The script requires an empty task table before enabling the worker and retains
a Compose backup plus `tasuki-keifu-agent:before-llm-4434c06ae8f4` for rollback.
The new container is healthy with writes disabled and no submitted experiment.
This is a server deployment plus local source changes; no commit/push was made.
A later full CI deployment must include the adapter source changes; uploading
an old Compose file/image would otherwise replace this patch.

`scripts/governance-model-smoke.mjs` imports only the actual adapter and contracts,
never the graph/runner/database. Run it through `docker exec -i` with Node's
`--import tsx --input-type=module`; append `- --network` for web-search evidence.
These are paid capability checks and must be kept separate from race metrics.

Prices remain unverified; capability reports explicitly use null/unknown rather
than claim zero cost. A passing capability check is not a completed race-group
experiment or proof that all governance observability requirements are complete.
