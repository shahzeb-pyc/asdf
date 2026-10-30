-- ADU posting jobs: maintained updated_at for stale-publish recovery.
--
-- The worker tick selects publishing jobs whose updated_at is older than
-- the 300s stale window and resets them to pending_publish, and the
-- publish claim (an UPDATE to 'publishing') must refresh updated_at so a
-- just-claimed job is not mistaken for stale. The original ADU table
-- migration (20261030120000_adu.sql) defined adu_posting_jobs WITHOUT
-- updated_at and attached no trigger, so the stale path would error on
-- an unknown column (42703) once the tables exist — the tick would throw
-- every tick and ADU publishing would be dead on arrival. This migration
-- adds the column and attaches the shared set_updated_at() trigger
-- (created by 20261014160000_auto_update_updated_at_triggers.sql), the
-- same pattern as the core tables.
--
-- This migration is NOT applied by the branch that creates it; it is
-- applied separately on the owner's tap, TOGETHER with the other ADU
-- migrations (20261030120000_adu.sql, 20261030130000_adu_claim_rpc.sql,
-- 20261030140000_adu_rpc_hardening.sql). Applying those three without
-- this one leaves the stale path broken.

ALTER TABLE public.adu_posting_jobs
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DROP TRIGGER IF EXISTS trg_adu_posting_jobs_updated_at ON public.adu_posting_jobs;
CREATE TRIGGER trg_adu_posting_jobs_updated_at
    BEFORE UPDATE ON public.adu_posting_jobs
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at();
