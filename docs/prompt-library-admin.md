# Prompt Library — how US add a prompt (admin only)

Prompts are NEVER uploaded by users. There is no user submission
endpoint and no "add prompt" button in the user-facing library.
Every new prompt is added by US, via the backend admin API only,
with a session whose role is `admin`. A non-admin calling the
admin routes gets 403.

The migration for this feature
(`supabase/migrations/20261028120000_prompt_library.sql`) is
created in the repo but must be applied by Kafka first — the
builder does not apply migrations, and the catalogue is empty
until then. Nothing here works against a database that has not
had that migration applied.

## Step 1 — Upload the preview media to R2 first

R2 has no folders; a "folder" is a key prefix. Prompt media lives
in the shared `fbuploadpro-user-media` bucket under:

```
prompts/{prompt_id}/preview.mp4   (video preview)
prompts/{prompt_id}/poster.jpg    (still poster, required for video)
prompts/{prompt_id}/preview.jpg   (image preview, when the preview is an image)
```

`{prompt_id}` is the prompt's UUID. In practice: create the
prompt as a draft first (Step 2), take the returned `id`, upload
the media under `prompts/{id}/`, then update the prompt with the
keys and publish it (Step 3). Or upload first under a UUID you
generate yourself and use that same UUID's folder in Step 2 —
either way, the keys in the row must match the objects in R2.

The API does NOT upload media for you, and it does NOT check
that the R2 object exists — it checks only that every preview /
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
  "previewMediaType": "video",
  "previewStorageKey": "prompts/{prompt_id}/preview.mp4",
  "previewPosterKey": "prompts/{prompt_id}/poster.jpg",
  "durationSeconds": 30,
  "status": "draft"
}
```

Rules enforced by the API and the database:

- `tool`: `dola_ai` | `veo3` | `google_flow`
- `category`: `animals` | `comedy` | `cinematic` | `ugc` | `tutorial` | `unboxing`
- `language`: `en` | `ur` | `hi`
- `length`: `under_15s` | `15_30s` | `30s_plus` | `1min_plus`
- `format` / `aspectRatio`: `vertical_reel` must be `9:16`,
  `horizontal_video` must be `16:9`
- `previewMediaType`: `video` requires a `previewPosterKey`;
  `image` does not
- `previewStorageKey` and `previewPosterKey` must start with `prompts/`
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

Updating any field, including replacing the whole step list, uses
the same PATCH route with a partial body. Deleting a prompt
(`DELETE …/prompts/{slug}`, admin only) cascade-deletes its
steps, favourites, and copy events.

## What users can do (and only this)

- `GET /api/tenant/{subdomain}/prompts?…` — search, category,
  tool, language, length, format, sort (`newest` | `most_copied` |
  `a_to_z`), `page` / `pageSize` (max 50).
- `GET /api/tenant/{subdomain}/prompts/{slug}` — detail with
  master prompt and steps.
- `POST /api/tenant/{subdomain}/prompts/{slug}/copy` — increments
  the real copied count via the `increment_prompt_copy` RPC and
  returns the new count. The browser never writes the count.
- `POST` / `DELETE /api/tenant/{subdomain}/prompts/{slug}/favourite`
  — the user's own favourite only, idempotent.
