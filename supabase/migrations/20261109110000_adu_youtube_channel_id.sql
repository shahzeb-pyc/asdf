-- ADU YouTube Data API discovery (spec 154): cache the resolved YouTube
-- channel ID on the config so repeat checks skip the channels.list
-- resolve (1 quota unit). Nullable: NULL until the first API discovery
-- for that config. The Switch Source flow in the web API clears it when
-- the source changes, so a stale channel can never follow a new handle.
-- The uploads playlist ID is derived from the channel ID in code
-- (UU + channel ID without the UC prefix) and is not stored.
-- Additive, no backfill, no SECURITY DEFINER function, no new table.
-- This migration auto-applies through the Supabase GitHub integration
-- on merge to main; there is no separate manual step. After merging,
-- verify the apply (ledger row for 20261109110000 plus the
-- youtube_channel_id column present on adu_configs) before redeploying
-- the VPS scraper, which fails loudly on YouTube jobs until the column
-- lands.

alter table public.adu_configs
  add column if not exists youtube_channel_id text;

comment on column public.adu_configs.youtube_channel_id is
  'Resolved YouTube channel ID for a youtube source (Data API discovery, spec 154). NULL until first discovery; cleared when the source changes.';
