-- Migration: 20261101163000_creator_finder_daily_usage.sql
-- Description: Per-user daily cap on Creator Finder upstream
-- provider calls (100/day across trending, niche, similar, and
-- regions). One counter row per user per Asia/Karachi calendar
-- day, incremented atomically once per actual upstream HTTP
-- attempt (key-rotation retries included: each attempt is its
-- own row increment).
--
-- Gate semantics (enforced by the server routes, not the DB):
-- the count is read at the START of a discovery request; a count
-- at or over 100 blocks the request with 429 before any upstream
-- call. A request that starts under the cap is never aborted
-- mid-flight, even if its calls push the count past 100; only
-- the NEXT request is blocked. Concurrent requests that both
-- pass the start gate both succeed, then blocking begins.
--
-- Access control (database_safety_before_merge):
-- - RLS is enabled on the table with NO policies, so no
--   PostgREST caller (anon or authenticated) can read or write
--   any user's counter directly. Only the server's service-role
--   client, which bypasses RLS, touches the table.
-- - The increment function is SECURITY DEFINER with a pinned
--   search_path, but EXECUTE is revoked from PUBLIC and granted
--   ONLY to service_role. An anon/authenticated caller therefore
--   cannot execute it directly — in particular, nobody can burn
--   another user's daily cap by calling the function with their
--   user id. The only caller is the server route, which always
--   passes the verified session's user id.
-- - The function takes only (user_id, usage_date) and increments
--   by exactly 1; it accepts no count, role, or workspace input
--   and can never set, reset, or lower a counter.

CREATE TABLE IF NOT EXISTS public.creator_finder_daily_usage (
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  usage_date date NOT NULL,
  call_count integer NOT NULL DEFAULT 0 CHECK (call_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, usage_date)
);

ALTER TABLE public.creator_finder_daily_usage ENABLE ROW LEVEL SECURITY;

-- Atomic increment: concurrent discovery requests for the same
-- user can never lose an increment (a read-modify-write in the
-- route would). Returns the new count after the increment.
CREATE OR REPLACE FUNCTION public.increment_creator_finder_usage(
  p_user_id uuid,
  p_usage_date date
)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.creator_finder_daily_usage
    (user_id, usage_date, call_count, updated_at)
  VALUES (p_user_id, p_usage_date, 1, now())
  ON CONFLICT (user_id, usage_date)
  DO UPDATE SET
    call_count = public.creator_finder_daily_usage.call_count + 1,
    updated_at = now()
  RETURNING call_count;
$$;

REVOKE ALL ON FUNCTION public.increment_creator_finder_usage(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.increment_creator_finder_usage(uuid, date) TO service_role;

COMMENT ON TABLE public.creator_finder_daily_usage IS
  'Creator Finder daily upstream-call counter: one row per user per Asia/Karachi calendar day. Read at discovery-request start for the 100/day cap; incremented once per upstream HTTP attempt via increment_creator_finder_usage.';
COMMENT ON FUNCTION public.increment_creator_finder_usage(uuid, date) IS
  'Creator Finder daily-cap increment (2026-11-01): atomically adds 1 to the user''s counter for the given Asia/Karachi date and returns the new count. EXECUTE granted to service_role only; anon/authenticated cannot call it directly.';
