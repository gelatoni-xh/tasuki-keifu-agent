#!/usr/bin/env bash
set -euo pipefail
# Dedicated disposable PostgreSQL. No .env database URL is read or reused.
agent_root="$(cd "$(dirname "$0")/.." && pwd)"
main_root="${GOVERNANCE_MAIN_REPO:-$(dirname "$agent_root")/tasuki-keifu}"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/tasuki-governance.XXXXXX")"
cleanup() { pg_ctl -D "$test_root/pgdata" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$test_root"; }
trap cleanup EXIT
initdb -D "$test_root/pgdata" -A trust -U governance_test --encoding=UTF8 --no-locale >"$test_root/init.log"
# Unix socket only; no network listener and no interference with production tunnels.
pg_ctl -D "$test_root/pgdata" -l "$test_root/postgres.log" -o "-h '' -k $test_root -p 55488" start >/dev/null
createdb -h "$test_root" -p 55488 -U governance_test governance_v2_test
# Use the complete real migration chain, including custom SQL constraints.
test_url="postgresql://governance_test@localhost:55488/governance_v2_test?host=$test_root"
(cd "$main_root" && DATABASE_URL="$test_url" node node_modules/prisma/build/index.js migrate deploy)
cd "$agent_root"
GOVERNANCE_TEST_DATABASE_URL="$test_url" node --import tsx --test src/governance-v2/tests/integration.test.ts
