-- Spec 191 — reverse: drop the brand column from the user record.
--
-- Never auto-applied; run manually with a code revert.
alter table public.users
  drop column if exists brand;
