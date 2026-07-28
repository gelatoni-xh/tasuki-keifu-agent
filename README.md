# tasuki-keifu-agent

Internal LangGraph-based agent for `tasuki-keifu` data diagnosis.

V1 scope:

- `person diagnosis graph`
- read-only access to the main `tasuki_keifu` business database
- write runtime data to the separate `tasuki_keifu_agent` database
- structured findings and suggested manual actions
- LangSmith tracing through standard `LANGCHAIN_*` environment variables

## Local Setup

```bash
pnpm install
pnpm prisma:generate
cp .env.example .env
```

Set:

- `TASUKI_KEIFU_BUSINESS_DATABASE_URL`
- `TASUKI_KEIFU_AGENT_DATABASE_URL`
- `LANGCHAIN_API_KEY`
- `LANGCHAIN_TRACING_V2=true`
- `LANGCHAIN_PROJECT=tasuki-keifu-agent-v1`

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
- `smoke:nodes`: graph node-path regression for key resolution branches
- `inspect`: recent agent runs and diagnosis results

V1 diagnoses only. It never writes to the main business database.
