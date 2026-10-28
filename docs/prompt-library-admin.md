# Prompt Library — how US add a prompt (admin only)

Prompts are NEVER uploaded by users. There is no user submission
endpoint and no "add prompt" button in the user-facing library.
Every new prompt is added by US, via the backend admin API only,
with a session whose role is `admin`. A non-admin calling the
admin routes gets 403.

The migrations for this feature
(`supabase/migrations/20261028120000_prompt_library.sql`,
`supabase/migrations/20261028130000_prompt_library_media.sql`,
and `supabase/migrations/20261028140000_relax_prompt_library_taxonomy.sql`)
are created in the repo but must be applied by Kafka first — the
builder does not apply migrations, and nothing here works
against a database that has not had those migrations applied.

## Adding a new category, tool, or language (no migration needed)

Since migration `20261028140000`, `tool`, `category`, and
`language` are free text, not enums. To add a brand-new value,
just use it in an admin create (or PATCH) call — for example
`"category": "travel"`, `"tool": "sora"`, `"language": "fr"` —
and publish the prompt. The filter dropdowns then show it
automatically (facets list whatever published prompts actually
use). No migration, no code change.

Normalisation (applied by the API, so a stored value and a
filter for it always match): category and tool are lowercased
with single spaces (`"  Travel  "` becomes `"travel"`,
`"  Sora  "` becomes `"sora"`); language is lowercased and
must be a 2–5 letter code (`"FR"` becomes `"fr"`).
Empty values and category/tool over 100 characters are
rejected; a language code outside 2–5 letters is rejected.

Typo risk is controlled because ONLY admins can write: there
is no user submission path, and no separate taxonomy table.
Check the new value's spelling before publishing — a typo
becomes a real filter option until the prompt is corrected.

`length`, `format`, and `status` are NOT free text: they are
system values and stay as enums, listed in the rules below.

## Step 1 — Upload the media to R2 first

R2 has no folders; a "folder" is a key prefix. A prompt has
MULTIPLE videos/images, stored in `prompt_library_media` — not
one preview. Prompt media lives in the shared
`fbuploadpro-user-media` bucket under:

```
prompts/{prompt_id}/preview.mp4   (main video, position 1)
prompts/{prompt_id}/poster.jpg    (still poster, required for video)
prompts/{prompt_id}/shot-2.jpg    (second image, position 2)
prompts/{prompt_id}/clip-2.mp4    (second video, position 3)
```

`{prompt_id}` is the prompt's UUID. In practice: create the
prompt as a draft first (Step 2), take the returned `id`, upload
the media under `prompts/{id}/`, then update the prompt with the
media list and publish it (Step 3). Or upload first under a UUID
you generate yourself and use that same UUID's folder in Step 2 —
either way, the keys in the rows must match the objects in R2.

The API does NOT upload media for you, and it does NOT check
that the R2 object exists — it checks only that every storage /
poster key starts with `prompts/`. Uploading to the wrong prefix
(`users/...`, the bucket root, a title slug) is rejected when
the prompt is published, but a missing object under the right
prefix would be a broken preview, so verify the upload before
publishing.

## Step 2 — Create the prompt (draft)

```
POST /api/tenant/{subdomain}/prompts
```

Admin session required. Body (all fields validated by the
contracts schemas in `packages/contracts/src/domain/prompt-library.ts`):

```json
{
  "slug": "puppy-first-bath",
  "title": "Puppy first bath",
  "shortDescription": "A golden puppy's first bath, turned into a warm, funny short.",
  "masterPrompt": "A golden puppy sits in a tiny bathtub in warm morning light…",
  "steps": [
    { "position": 1, "title": "Start a project", "body": "Open your video tool and start a new vertical project." },
    { "position": 2, "title": null, "body": "Paste the master prompt above as the video prompt." }
  ],
  "tool": "dola_ai",
  "category": "animals",
  "language": "en",
  "length": "1min_plus",
  "format": "vertical_reel",
  "aspectRatio": "9:16",
  "media": [
    { "position": 1, "mediaType": "video", "storageKey": "prompts/{prompt_id}/preview.mp4", "posterKey": "prompts/{prompt_id}/poster.jpg", "durationSeconds": 30, "isMain": true },
    { "position": 2, "mediaType": "image", "storageKey": "prompts/{prompt_id}/shot-2.jpg", "posterKey": null, "durationSeconds": null, "isMain": false }
  ],
  "status": "draft"
}
```

Rules enforced by the API and the database:

- `tool`, `category`, and `language` are FREE TEXT — no
  migration is needed for a new value. Add a new category, tool,
  or language by simply using it in an admin create call (see
  "Adding a new category, tool, or language" below); once the
  prompt is published, the filter dropdowns pick it up
  automatically via the facets endpoint. The old values still
  work exactly as before: `tool` `dola_ai` | `veo3` |
  `google_flow`, `category` `animals` | `comedy` | `cinematic` |
  `ugc` | `tutorial` | `unboxing`, `language` `en` | `ur` |
  `hi` — they are just no longer the only allowed values.
- `length`: `under_15s` | `15_30s` | `30s_plus` | `1min_plus`
- `format` / `aspectRatio`: `vertical_reel` must be `9:16`,
  `horizontal_video` must be `16:9`
- `media`: at least one item, unique `position` values, and
  EXACTLY ONE item with `isMain: true` (zero or two mains are
  rejected). The main item is the card preview and the large
  detail preview; the rest appear as gallery thumbnails in the
  detail section only.
- A `mediaType` of `video` requires a `posterKey`; `image` does not.
- Every `storageKey` and `posterKey` must start with `prompts/`.
- `slug` must be lowercase letters, digits, and single hyphens,
  and unique — a clash returns 409. Omit `slug` and one is
  derived from the title.
- Step `position` values must be unique within the prompt.
- `copiedCount` cannot be set by the request — it starts at 0
  and only the copy RPC changes it.

A successful create returns 201 with `{ "slug", "id" }`.

## Step 3 — Publish it

```
PATCH /api/tenant/{subdomain}/prompts/{slug}
{ "status": "published" }
```

Only published prompts appear in the list, the dedicated
section, favourites, and copy. Drafts are visible only to admins
via the detail route (anyone else gets 404).

Updating any field, including replacing the whole media list or
the whole step list, uses the same PATCH route with a partial
body. Deleting a prompt (`DELETE …/prompts/{slug}`, admin only)
cascade-deletes its media, steps, favourites, and copy events.

## What users can do (and only this)

- `GET /api/tenant/{subdomain}/prompts?…` — search, category,
  tool, language, length, format, sort (`newest` | `most_copied` |
  `a_to_z`), `favorites_only=true` (signed-in user's favourites
  only), `page` / `pageSize` (max 50). List items carry only the
  main media.
- `GET /api/tenant/{subdomain}/prompts/{slug}` — detail with
  master prompt, steps, and the full media gallery (main first,
  then by position).
- `POST /api/tenant/{subdomain}/prompts/{slug}/copy` — increments
  the real copied count via the `increment_prompt_copy` RPC and
  returns the new count. The browser never writes the count.
- `POST` / `DELETE /api/tenant/{subdomain}/prompts/{slug}/favourite`
  — the user's own favourite only, idempotent.
