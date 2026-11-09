# ADU selector unblock — Facebook and YouTube (spec)

## What

In the Auto Download/Upload "Add Page" dialog (Facebook hub), Step 3 "Sources",
the per-page source-platform Select currently disables every platform except
TikTok (`disabled={p !== 'tiktok'}`). Change it to
`disabled={p === 'instagram'}` so Facebook and YouTube become selectable,
Instagram stays disabled/greyed, and TikTok is untouched.

File: `apps/web/src/components/auto-download-upload/adu-hub-page.tsx`
(line ~1411, the only platform picker in this dialog).

## Why

- Facebook discovery now has a proven no-login browser path (the Patchright
  spike: 231 reels on one page, 50 on the big news pages — the logged-out
  window is page-specific, not a bug), and the Facebook scraper build follows
  on its own branch. Users must be able to add Facebook sources.
- YouTube discovery is already on main (official Data API, spec 154, PR #195)
  with quota-retry (spec 156, PR #198), and YouTube downloads already work via
  yt-dlp on main. Users must be able to add YouTube sources.
- Instagram stays blocked: logged-out Instagram is refused from the VPS
  (429, IP-based), so there is no working Instagram discovery path yet.
- TikTok is fully working and must not change.

## Scope — only this selector

- ONLY `adu-hub-page.tsx` (Facebook hub dialog) and its test.
- Do NOT touch: the Instagram hub dialog (`ig-adu-hub-page.tsx`), the Threads
  hub dialog (`threads-adu-hub-page.tsx`), the bulk-paste default (stays
  TikTok), any backend/contract code, `apps/adu-scraper`, or any other file.
- No backend or contract change is needed: `AduSourcePlatformSchema` already
  accepts all four platforms, the ADU create route has no platform gate, and
  the scraper claim RPCs already route Facebook and YouTube configs.

## Acceptance criteria

1. In the Add Page dialog, Step 3 "Sources", the platform Select offers
   Facebook, YouTube, and TikTok as selectable options.
2. Instagram remains visible but disabled/greyed in that Select.
3. The default platform for a new source row is still TikTok, and the
   existing submit test (sourcePlatform `'tiktok'`) still passes.
4. A new test asserts: Facebook selectable, YouTube selectable, Instagram
   disabled, TikTok enabled.
5. No other file changes; no new UI is added; no copy changes.
6. Local checks green (build/lint/typecheck/test for `apps/web`), PR opened,
   CI green, independent verification says MERGE, then squash-merge with
   branch deletion.

## Workflow note

The repo's `.agents/rules/git-workflow.md` says agents must not run local
builds/tests before commit and must ask before creating a PR. The user's
standing 2026-10-24 agreement governs instead: local green before PR, CI
green before merge, separate verification subagent, merge on the owner's tap.
For THIS PR the owner additionally ordered "separate PR, push, merge
immediately" — that instruction covers this PR only and supersedes the
preview/mockup step for it.
