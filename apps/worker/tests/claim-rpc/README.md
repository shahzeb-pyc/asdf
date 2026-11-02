# Spec 138 claim-RPC parity + scale rig

SQL-level regression rig for `claim_due_queue_items` (spec 138): proves
the grouped-usage rewrite is behaviour-identical to the spec 121
correlated-subquery body (parity suite) and fast enough at certification
shape (scale test), against a **real PostgreSQL** with bootstrap + all
repo migrations applied in filename order. Modelled on the spec 122
load harness (`apps/worker/load-harness/` on that branch).

## Layout

| File | Role |
|---|---|
| `db/bootstrap.sql` | Minimal Supabase stub for plain Postgres: `anon` / `authenticated` / `service_role` roles, `auth` schema, `auth.users`, `auth.uid()` (copied from the load harness) |
| `db/run-migrations.ts` | Applies `bootstrap.sql`, then every file in `supabase/migrations/` in filename order; `CLAIM_RPC_MIGRATIONS_UNTIL=<file>` stops after that file (builds the pre-fix DB) |
| `fixtures.sql` | Deterministic fixture helpers (`claim138_reset`, `claim138_destination`, `claim138_item`, `claim138_logs`, md5-derived ids) applied by the runners |
| `parity.ts` | The 12-case behaviour-parity suite (plan.md §2). Expected values derive from the documented spec 121 semantics, never from the implementation under test |
| `flip-paths.ts` | Cooldown-removal flip paths (migration 20261102160000): the slot claim and the publish-now claim must each flip a 3-day-expired `rate_limited` destination to `active` (anchor cleared) and claim its item in the same call; fresh-anchor and legacy no-anchor controls included. The due-claim path is covered by `parity.ts` case 9 |
| `scale.ts` | Scale regression test (plan.md §3): instagram-shaped seed (5,000 destinations / 2 rules / 3,000 due / ~6,000 in-flight / 21,867 logs); one claim call must complete < 5 s with the fixture's expected outcome counts |
| `explain.ts` | `EXPLAIN (ANALYZE, BUFFERS)` for both grouped passes on the scale seed (plan.md §4) |

Rig code lives outside the worker build's runtime: no file here matches
vitest's `*.test.*` include pattern, so the normal worker suite never
runs the rig; the scripts are run explicitly (below). `pg`, `@types/pg`,
and `tsx` are worker devDependencies used only by this rig and the
spec 122 load harness.

## Setup (one-time)

1. **PostgreSQL** via the `pgserver` Python wheel (a system Postgres
   ≥ 13 also works — any plain PG with a reachable socket/URL):
   ```sh
   python3 -m venv ~/pgvenv && ~/pgvenv/bin/pip install pgserver
   # Start get_server('<data dir outside the repo>') and note the URI it
   # prints, e.g. postgres://postgres@/postgres?host=<data dir>
   ```
   The pgserver wheel ships no `pgcrypto` extension, but the migrations
   only need `gen_random_uuid()`, which is core since PG 13. Drop a stub
   into the wheel's extension dir so the first migration's
   `CREATE EXTENSION pgcrypto` succeeds:
   ```sh
   EXT=$(python3 -c "import pgserver, pathlib; print(pathlib.Path(pgserver.__file__).parent / 'pginstall/share/postgresql/extension')")
   printf "default_version = '1.3'\nrelocatable = true\n" > "$EXT/pgcrypto.control"
   printf -- "-- stub: functions used are core PostgreSQL\n" > "$EXT/pgcrypto--1.3.sql"
   ```
2. **Create the databases** (example names; the pgserver `createdb`
   binary lives in the wheel's `pginstall/bin/`):
   ```sh
   createdb claimrpc138parity        # post-fix parity DB (all migrations)
   createdb claimrpc138parity-pre    # pre-fix parity DB (up to spec 121)
   createdb claimrpc138scale         # scale DB (all migrations)
   createdb claimrpc138scale-pre     # pre-fix scale DB (up to spec 121)
   ```
3. **Apply bootstrap + migrations** to each (from the repo root):
   ```sh
   cd apps/worker
   CLAIM_RPC_PG_URL='postgres://postgres@/claimrpc138parity?host=<data dir>' \
     pnpm exec tsx tests/claim-rpc/db/run-migrations.ts
   CLAIM_RPC_PG_URL='postgres://postgres@/claimrpc138parity-pre?host=<data dir>' \
   CLAIM_RPC_MIGRATIONS_UNTIL='20261022130000_claim_limits_and_refresh_lease.sql' \
     pnpm exec tsx tests/claim-rpc/db/run-migrations.ts
   # scale DBs: same pair of commands with the scale database names
   ```

## Running

```sh
cd apps/worker
# Parity — must pass IDENTICALLY on the pre-fix and post-fix databases:
CLAIM_RPC_PG_URL='...claimrpc138parity-pre...' pnpm exec tsx tests/claim-rpc/parity.ts
CLAIM_RPC_PG_URL='...claimrpc138parity...'     pnpm exec tsx tests/claim-rpc/parity.ts

# Scale — FAILS on the pre-fix database (old timings, ~54 s class) and
# passes on the post-fix database (< 5 s). Prints the measured duration
# either way:
CLAIM_RPC_PG_URL='...claimrpc138scale-pre...' pnpm exec tsx tests/claim-rpc/scale.ts
CLAIM_RPC_PG_URL='...claimrpc138scale...'     pnpm exec tsx tests/claim-rpc/scale.ts

# Planner evidence on the post-fix scale seed: seed a database with
# CLAIM_RPC_SEED_ONLY=1 (seeds without claiming), then run explain.ts
# against that seeded-but-unclaimed state:
CLAIM_RPC_SEED_ONLY=1 CLAIM_RPC_PG_URL='...claimrpc138explain...' \
  pnpm exec tsx tests/claim-rpc/scale.ts
CLAIM_RPC_PG_URL='...claimrpc138explain...'   pnpm exec tsx tests/claim-rpc/explain.ts
```

Parity cases run one transaction per case and seed timestamps relative
to the transaction's `now()` — the same `now()` the RPC uses — so
deferred `scheduled_time` values are asserted exactly (window end,
1-minute floor, MAX across binding rules, LEAST of the two oldest
events), not approximately.
