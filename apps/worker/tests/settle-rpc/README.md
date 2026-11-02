# Spec 139 settle-rpc hardening rig

SQL-level regression rig for the spec 139 settle RPC hardening migration
(`supabase/migrations/20261023130000_settle_rpc_hardening.sql`): proves,
against a **real PostgreSQL** with bootstrap + all repo migrations applied
in filename order, that the unified `settle_queue_item_outcome` —

- exists as exactly **one** unified overload after the chain (the old
  16-arg TEXT-code signature is dropped, not shadowed by a second
  overload; the legacy INT-code overload was dropped by exact
  signature in the Phase 7 migration `20261024130000`), with
  service_role-only ACLs and `search_path = public` pinned;
- settles normally (published + retry branches, one `publish_logs` row,
  returns `'settled'`);
- still serves existing callers unchanged (16 named args PostgREST-style
  and 16 positional args pg-adapter-style, no `p_detail`);
- no-ops on a duplicate/late settle (`'already_settled'`: no status
  regression, no second log row, no destination side effects), on a
  merely-queued item, and on a missing item;
- writes NO destination cooldown on any settle (migration
  `20261102160000_remove_cooldown_pacing.sql`): a caller-supplied
  cooldown value is accepted and ignored, and marking `rate_limited`
  stamps the 3-day anchor `metadata.rate_limited_at` instead;
- merges `p_detail` into `publish_logs.detail` (the carrier specs
  124–126 need for platform session ids), with the error-code object
  winning key conflicts and `p_detail = NULL` preserving the previous
  detail behaviour exactly;
- (spec 139 defer outcome, migration
  `20261024100000_deferred_settle_outcome.sql`) settles the `deferred`
  outcome: the item returns to `queued` with the deferral reason
  recorded and its `retry_count` **unchanged** — even when the caller
  passes an inflated `p_retry_count` — across repeated defers; the
  publish log records result `'deferred'`; the terminal-state guard
  holds for defers and defers write no destination cooldown or anchor,
  and the retry branch still advances the count.

Modelled on the spec 117 rls-rpc rig (`apps/worker/tests/rls-rpc/`).

## Layout

| File | Role |
|---|---|
| `db/bootstrap.sql` | Minimal Supabase stub for plain Postgres: `anon` / `authenticated` / `service_role` (BYPASSRLS) roles, `auth` schema, `auth.users`, `auth.uid()` — plus Supabase's default-privilege posture via `ALTER DEFAULT PRIVILEGES`, because this rig exercises GRANTs (copied from the rls-rpc rig) |
| `db/run-migrations.ts` | Applies `bootstrap.sql`, then every file in `supabase/migrations/` in filename order; `SETTLE_RPC_MIGRATIONS_UNTIL=<file>` stops after that file (builds a pre-hardening DB) |
| `fixtures.sql` | Deterministic unified-schema fixture (`settle139_reset`, `settle139_add_item`): one user/workspace/account/destination graph with a queue item in `publishing` |
| `check.ts` | The assertion runner (sections a–h). Prints a `pg_proc` dump of both settle overloads (`SETTLE_RPC_DUMP_FILE=<path>` also writes it to a file) |

Rig code lives outside the worker build's runtime: no file here matches
vitest's `*.test.*` include pattern, so the normal worker suite never
runs the rig; the scripts are run explicitly (below). `pg`, `@types/pg`,
and `tsx` are worker devDependencies shared with the spec 117/138 rigs.

## Setup + running

Any plain PostgreSQL ≥ 13 with a reachable socket/URL works (the
migrations only need `gen_random_uuid()`, core since PG 13; the
`pgcrypto` extension line in the first migration needs the extension
present or stubbed — see the rls-rpc README for the pgserver-wheel stub;
a distro Postgres ships it for real).

```sh
createdb settle139   # disposable database

cd apps/worker
SETTLE_RPC_PG_URL='postgres://postgres@/settle139?host=<socket dir>&port=<port>' \
  pnpm exec tsx tests/settle-rpc/db/run-migrations.ts
SETTLE_RPC_PG_URL='postgres://postgres@/settle139?host=<socket dir>&port=<port>' \
  pnpm exec tsx tests/settle-rpc/check.ts
```

## Results (2026-10-24, PostgreSQL 16.2, full migration chain incl. the defer-outcome migration)

- **60 assertions, 0 failures** — sections: (a) catalog 6, (b) ACL 3,
  (c) normal settle 7, (d) old-signature callers 4, (e) double-settle
  no-op 10, (f) no cooldown 7, (g) p_detail 4, (h) deferred
  outcome 19 (counts include the section sub-assertions as run; see
  check.ts).

### Catalog dump — after (hardened)

```
settle_queue_item_outcome(p_queue_item_id uuid, p_workspace_id uuid, p_destination_id uuid, p_outcome_status text, p_external_post_id text, p_external_comment_id text, p_retry_count integer, p_retry_delay_seconds integer, p_error_code text, p_error_subcode text, p_error_message text, p_comment_warning text, p_target_destination_status text, p_target_account_status text, p_destination_cooldown_seconds integer, p_rate_usage_pct smallint, p_detail jsonb) RETURNS text  {postgres=X/postgres,service_role=X/postgres}
settle_queue_item_outcome(p_queue_item_id uuid, p_user_id uuid, p_fb_page_id uuid, p_outcome_status text, p_fb_post_id text, p_fb_comment_id text, p_retry_count integer, p_retry_delay_seconds integer, p_error_code integer, p_error_subcode integer, p_error_message text, p_comment_warning text, p_target_page_status text, p_target_account_status text, p_page_cooldown_seconds integer, p_buc_usage_pct smallint) RETURNS void  {postgres=X/postgres,service_role=X/postgres}
```
