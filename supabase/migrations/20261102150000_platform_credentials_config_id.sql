-- Instagram BYOC Unified Login: store the workspace's Unified Login
-- configuration ID alongside its Meta App ID and Secret. The ID is not
-- a secret; it identifies the configuration at dialog time. Pre-Unified
-- rows have no configuration, so the column is nullable. No existing
-- column, row, or token is touched.
alter table public.platform_credentials
  add column if not exists config_id text;
