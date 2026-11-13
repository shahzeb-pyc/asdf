-- Reverse of 20261113130000_instagram_adu_hub.sql (ADU optimization
-- Stream D, F20). Drops the Instagram hub RPC pair. Never
-- auto-applied; run manually with a code revert.
drop function if exists public.instagram_adu_hub_list(uuid, text, text, text, integer, integer);
drop function if exists public.instagram_adu_hub_stats(uuid, text, text);
