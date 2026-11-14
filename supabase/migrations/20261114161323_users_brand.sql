-- Spec 191: white-label brand on the user record.
--
-- Every account belongs to exactly one brand. Our brand ('fbuploadpro')
-- is the default and the fail-safe: every existing row, and any row
-- created without a brand, is ours. A NextRise student account carries
-- 'nextrise' and can only log in on the white-label brand.
--
-- The reverse migration lives at
-- supabase/migrations/reverse/20261114161323_users_brand.sql
-- (never auto-applied; run manually with a code revert).

alter table public.users
  add column if not exists brand text not null default 'fbuploadpro'
    check (brand in ('fbuploadpro', 'nextrise'));
