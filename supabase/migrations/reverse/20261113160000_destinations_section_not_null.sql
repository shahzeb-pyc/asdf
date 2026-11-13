-- Spec 174 PR 4A part 2 (lock) — reverse: drop the NOT NULL constraint.
--
-- The straggler labels stay (they are correct labels); only the lock is
-- removed. Never auto-applied; run manually with a code revert.
alter table public.destinations
  alter column section drop not null;
