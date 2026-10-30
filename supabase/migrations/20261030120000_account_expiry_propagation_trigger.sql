-- Account-expiry propagation trigger (Facebook Accounts audit, BG2/BG4).
--
-- WRITTEN BUT NOT APPLIED TO PROD. Apply it manually after merge.
-- Until it is applied, propagation still happens through the app
-- helpers (the web accounts-list expired sync and the worker refresh
-- job), which flip the same rows; this trigger is the safety net for
-- expiry flips that happen inside SQL, where no app helper can run —
-- above all the settle RPC (`settle_queue_item_outcome`), which flips
-- an account to 'expired' on an auth failure at publish time.
--
-- Rule (Schema B, owner decision): an account flipping to 'expired'
-- flips its currently 'active' destinations to 'error', the existing
-- destination status for a broken token. No new page status is
-- introduced. The flip is idempotent (active-only), so re-running it
-- changes nothing, and paused pages (stored as 'disconnected' +
-- the metadata fb_status='paused' marker), plain 'disconnected'
-- pages, pages already in 'error', and 'rate_limited' pages are
-- untouched by construction. On reconnect, the existing page-token
-- refresh flips 'error' destinations back to 'active' only when
-- Facebook returns a fresh token for them — never blindly.

CREATE OR REPLACE FUNCTION public.propagate_account_expiry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'expired' AND OLD.status IS DISTINCT FROM 'expired' THEN
    UPDATE public.destinations
    SET status = 'error', updated_at = now()
    WHERE account_id = NEW.id
      AND status = 'active';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_social_accounts_expiry_propagation ON public.social_accounts;
CREATE TRIGGER trg_social_accounts_expiry_propagation
  AFTER UPDATE OF status ON public.social_accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.propagate_account_expiry();
