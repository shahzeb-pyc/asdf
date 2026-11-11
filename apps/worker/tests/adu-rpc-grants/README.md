# ADU RPC-grants rig

Proves the ADU RPC hardening from `supabase/migrations/20261030140000_adu_rpc_hardening.sql`
(SEND BACK fix, PR #43) against a real PostgreSQL database:

- All seven ADU claim RPCs are SECURITY DEFINER with EXECUTE revoked
  from PUBLIC, anon and authenticated, and granted to service_role —
  verified in the catalog AND with live 42501 probes as authenticated
  (a service_role call still succeeds, returning 0 rows on empty tables).
- The hub list/stats RPCs carry the same grant closure and are NOT
  security definer.
- Hub list paging, search, status filter, sort and stats sums behave
  as the hub route expects, on seeded data.
- `adu_hub_list` returns `followers_updated_at` (spec 162, round 2):
  a stamped config's timestamp round-trips through the RPC and an
  unstamped config reads null, so the Facebook hub route can hand
  the value to `buildAduConfigView`.
- Re-applying the current hub-RPC definitions
  (`20261111010000_insights_worker_daily_followers.sql`, spec 162) is
  idempotent and the grants still hold afterwards. (The 20261030140000
  hardening file itself is no longer re-appliable as a whole: its hub
  RPCs carry the pre-rename return type.)

The RPCs are intentionally global for the service-side claim loop
(lowest-buffered config first, SKIP LOCKED), so no in-function
workspace/ownership check is asserted — the control is the execution
scope, plus the server-side workspace scoping in the web/worker paths.

## Run (local, needs a PostgreSQL server)

```sh
# create database adu_rpc, then:
ADU_RPC_GRANTS_PG_URL=postgres://postgres@/adu_rpc?host=/path/to/pgsocket&port=5432 \
  pnpm --filter @fbuploadpro/worker exec tsx tests/adu-rpc-grants/db/run-migrations.ts
ADU_RPC_GRANTS_PG_URL=postgres://postgres@/adu_rpc?host=/path/to/pgsocket&port=5432 \
  pnpm --filter @fbuploadpro/worker exec tsx tests/adu-rpc-grants/check.ts
```

In CI the rig runs in the `sql-rigs` job (`.github/workflows/ci.yml`)
against the `postgres:16` service, like the other rigs.
