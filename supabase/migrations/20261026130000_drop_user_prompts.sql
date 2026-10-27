-- Prompt Library removal — drop the personal prompts table.
--
-- The Prompt Library frontend, API routes, and contracts were removed
-- (branch remove/prompt-library); this migration removes the data table
-- they read and wrote. It is one-way: dropping the table deletes all
-- saved personal prompts. No other table references user_prompts, so no
-- CASCADE is needed — its index (idx_user_prompts_user_created) and its
-- RLS policy (user_prompts_user_access) are owned by the table and drop
-- with it. The table's foreign key points outward to users(id); nothing
-- points back at user_prompts.
--
-- The Prompt Library code removal has merged (PR #17), so no code on
-- main reads this table anymore; this migration is now safe to apply.

DROP TABLE IF EXISTS public.user_prompts;
