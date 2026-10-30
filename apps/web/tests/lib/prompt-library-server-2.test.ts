/**
 * @file prompt-library-server-2.test.ts
 * @description Second server-layer suite for the Prompt Library,
 * covering the helpers the first suite leaves out: request
 * authentication (401 no cookie, 401 bad token, 403 wrong tenant,
 * success, admin cross-tenant), the R2 public URL gate, media
 * mapping (trailing-slash base, poster null), main-media fallback
 * and empty cases, list-item mapping (only main media, exact
 * duration null fallback, missing main throws), detail mapping
 * (gallery main-first, steps sorted), ilike escaping, create /
 * media-insert / update row mapping, and the admin-client
 * failure mode (null client, logged, not thrown).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { signSessionToken } from "@fbuploadpro/contracts";
import {
  authenticatePromptRequest,
  escapeIlikePattern,
  getPromptAdminClient,
  getPromptPublicUrl,
  logPromptError,
  mainPromptMedia,
  sortPromptMediaForDetail,
  toPromptCreateRow,
  toPromptDetail,
  toPromptListItem,
  toPromptMedia,
  toPromptMediaInsertRows,
  toPromptUpdateRow,
  validateMergedPrompt,
  type PromptDbRow,
  type PromptMediaDbRow,
  type PromptStepDbRow,
} from "@/lib/server/prompt-library";
import * as authModule from "@/lib/auth/clients";

const TEST_SECRET = "test-session-secret-for-prompt-server-tests-000000";
const USER_ID = "11111111-1111-4111-a111-111111111111";
const SUBDOMAIN = "acme";

function row(overrides: Partial<PromptDbRow> = {}): PromptDbRow {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    slug: "puppy-first-bath",
    title: "Puppy first bath",
    short_description: "A golden puppy's first bath.",
    master_prompt: "A golden puppy sits in a tiny bathtub.",
    tool: "dola_ai",
    category: "animals",
    language: "en",
    video_length_bucket: "1min_plus",
    video_duration_seconds: 75,
    format: "vertical_reel",
    aspect_ratio: "9:16",
    copied_count: 12,
    status: "published",
    created_by: null,
    created_at: "2026-10-28T00:00:00.000Z",
    updated_at: "2026-10-28T00:00:00.000Z",
    ...overrides,
  };
}

function media(overrides: Partial<PromptMediaDbRow> = {}): PromptMediaDbRow {
  return {
    id: "00000000-0000-4000-8000-000000000101",
    prompt_id: "00000000-0000-4000-8000-000000000001",
    position: 1,
    media_type: "video",
    storage_key: "prompts/abc/preview.mp4",
    poster_key: "prompts/abc/poster.jpg",
    duration_seconds: 30,
    is_main: true,
    created_at: "2026-10-28T00:00:00.000Z",
    ...overrides,
  };
}

function step(overrides: Partial<PromptStepDbRow> = {}): PromptStepDbRow {
  return {
    id: "00000000-0000-4000-8000-000000000201",
    position: 1,
    title: null,
    body: "Open your video tool.",
    ...overrides,
  };
}

async function cookieFor(
  role: "user" | "admin",
  subdomain = SUBDOMAIN,
): Promise<string> {
  const token = await signSessionToken(
    {
      userId: USER_ID,
      email: "testuser@gmail.com",
      name: "Test User",
      subdomain,
      role,
      status: "active",
    },
    TEST_SECRET,
  );
  return `fbup_session=${token}`;
}

describe("authenticatePromptRequest", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.SESSION_SECRET = TEST_SECRET;
  });

  function requestWith(cookie: string | null): NextRequest {
    return new NextRequest("http://localhost:3000/api/tenant/acme/prompts", {
      headers: cookie ? { cookie } : {},
    });
  }

  it("returns 401 with no session cookie", async () => {
    const result = await authenticatePromptRequest(requestWith(null), "acme");
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error.status).toBe(401);
  });

  it("returns 401 for an unverifiable token", async () => {
    const result = await authenticatePromptRequest(
      requestWith("fbup_session=not-a-real-token"),
      "acme",
    );
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error.status).toBe(401);
  });

  it("returns 403 for a user from another tenant", async () => {
    const cookie = await cookieFor("user");
    const result = await authenticatePromptRequest(requestWith(cookie), "other");
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error.status).toBe(403);
  });

  it("returns the session for a matching tenant user", async () => {
    const cookie = await cookieFor("user");
    const result = await authenticatePromptRequest(requestWith(cookie), "acme");
    expect("session" in result).toBe(true);
    if ("session" in result) {
      expect(result.session.userId).toBe(USER_ID);
      expect(result.session.role).toBe("user");
    }
  });

  it("lets an admin access any tenant", async () => {
    const cookie = await cookieFor("admin");
    const result = await authenticatePromptRequest(requestWith(cookie), "other");
    expect("session" in result).toBe(true);
  });
});

describe("getPromptPublicUrl", () => {
  it("returns the URL when set and null when empty or missing", () => {
    process.env.R2_PUBLIC_URL = "https://media.example.com";
    expect(getPromptPublicUrl()).toBe("https://media.example.com");
    process.env.R2_PUBLIC_URL = "";
    expect(getPromptPublicUrl()).toBeNull();
    delete process.env.R2_PUBLIC_URL;
    expect(getPromptPublicUrl()).toBeNull();
    process.env.R2_PUBLIC_URL = "https://media.example.com";
  });
});

describe("media mapping", () => {
  it("derives URLs and strips a trailing slash from the base", () => {
    const mapped = toPromptMedia(media(), "https://media.example.com/");
    expect(mapped.url).toBe(
      "https://media.example.com/prompts/abc/preview.mp4",
    );
    expect(mapped.posterUrl).toBe(
      "https://media.example.com/prompts/abc/poster.jpg",
    );
    expect(mapped.mediaType).toBe("video");
    expect(mapped.isMain).toBe(true);
  });

  it("maps a poster-less image with posterUrl null", () => {
    const mapped = toPromptMedia(
      media({
        media_type: "image",
        storage_key: "prompts/abc/shot.jpg",
        poster_key: null,
        duration_seconds: null,
        is_main: false,
      }),
      "https://media.example.com",
    );
    expect(mapped.posterUrl).toBeNull();
    expect(mapped.durationSeconds).toBeNull();
  });

  it("mainPromptMedia returns null for empty input and falls back to first by position", () => {
    expect(mainPromptMedia([])).toBeNull();
    const noMain = [
      media({ position: 2, is_main: false }),
      media({ position: 1, is_main: false }),
    ];
    expect(mainPromptMedia(noMain)?.position).toBe(1);
  });

  it("sortPromptMediaForDetail puts main first, then position, without mutating input", () => {
    const rows = [
      media({ position: 2, is_main: false }),
      media({ position: 3, is_main: true }),
      media({ position: 1, is_main: false }),
    ];
    const sorted = sortPromptMediaForDetail(rows);
    expect(sorted.map((r) => r.position)).toEqual([3, 1, 2]);
    expect(rows[0].position).toBe(2);
  });
});

describe("list-item and detail mapping", () => {
  it("maps a list item from only the main media", () => {
    const item = toPromptListItem(
      row(),
      [
        media({ position: 2, is_main: false, storage_key: "prompts/abc/shot-2.jpg" }),
        media(),
      ],
      "https://media.example.com",
      true,
    );
    expect(item.previewMediaType).toBe("video");
    expect(item.previewUrl).toContain("preview.mp4");
    expect(item.previewUrl).not.toContain("shot-2");
    expect(item.exactDurationSeconds).toBe(75);
    expect(item.copiedCount).toBe(12);
    expect(item.isFavourite).toBe(true);
  });

  it("falls back to null exact duration when the row predates the migration", () => {
    const legacy = row();
    delete (legacy as Record<string, unknown>).video_duration_seconds;
    const item = toPromptListItem(row(), [media()], "https://media.example.com", false);
    expect(item.exactDurationSeconds).toBe(75);
    const legacyItem = toPromptListItem(
      legacy,
      [media()],
      "https://media.example.com",
      false,
    );
    expect(legacyItem.exactDurationSeconds).toBeNull();
  });

  it("throws loudly when a prompt has no main media", () => {
    expect(() =>
      toPromptListItem(row(), [], "https://media.example.com", false),
    ).toThrow("has no main media");
  });

  it("maps a detail with gallery main-first, steps sorted, and master prompt", () => {
    const detail = toPromptDetail(
      row(),
      [step({ position: 2, body: "Second." }), step({ position: 1 })],
      [
        media({ position: 2, is_main: false, storage_key: "prompts/abc/shot-2.jpg" }),
        media(),
      ],
      "https://media.example.com",
      false,
    );
    expect(detail.masterPrompt).toContain("tiny bathtub");
    expect(detail.media.map((m) => m.position)).toEqual([1, 2]);
    expect(detail.media[0].isMain).toBe(true);
    expect(detail.steps.map((s) => s.position)).toEqual([1, 2]);
    expect(detail.steps[1].body).toBe("Second.");
  });
});

describe("escaping and merged validation", () => {
  it("escapes backslash, percent and underscore for ilike", () => {
    expect(escapeIlikePattern("100%_\\cool")).toBe("100\\%\\_\\\\cool");
    expect(escapeIlikePattern("plain")).toBe("plain");
    expect(escapeIlikePattern("")).toBe("");
  });

  it("validateMergedPrompt passes when either side is absent or matches", () => {
    expect(validateMergedPrompt({})).toBeNull();
    expect(validateMergedPrompt({ format: "vertical_reel" })).toBeNull();
    expect(validateMergedPrompt({ aspectRatio: "9:16" })).toBeNull();
    expect(
      validateMergedPrompt({ format: "vertical_reel", aspectRatio: "9:16" }),
    ).toBeNull();
    expect(
      validateMergedPrompt({ format: "horizontal_video", aspectRatio: "9:16" }),
    ).not.toBeNull();
  });
});

describe("row mapping", () => {
  const createInput = {
    title: "Brand new prompt",
    shortDescription: "A brand new prompt.",
    masterPrompt: "A golden puppy sits in a tiny bathtub.",
    tool: "dola_ai",
    category: "animals",
    language: "en",
    length: "1min_plus" as const,
    exactDurationSeconds: 75,
    format: "vertical_reel" as const,
    aspectRatio: "9:16" as const,
    status: "published" as const,
    media: [],
    steps: [],
  };

  it("maps a create input to snake_case columns with created_by", () => {
    const mapped = toPromptCreateRow(createInput, "brand-new-prompt", USER_ID);
    expect(mapped).toEqual({
      slug: "brand-new-prompt",
      title: "Brand new prompt",
      short_description: "A brand new prompt.",
      master_prompt: "A golden puppy sits in a tiny bathtub.",
      tool: "dola_ai",
      category: "animals",
      language: "en",
      video_length_bucket: "1min_plus",
      video_duration_seconds: 75,
      format: "vertical_reel",
      aspect_ratio: "9:16",
      status: "published",
      created_by: USER_ID,
    });
  });

  it("maps a missing exact duration to null on create", () => {
    const mapped = toPromptCreateRow(
      { ...createInput, exactDurationSeconds: undefined },
      "brand-new-prompt",
      USER_ID,
    );
    expect(mapped.video_duration_seconds).toBeNull();
  });

  it("maps media inputs to insert rows, defaulting poster and duration to null", () => {
    const rows = toPromptMediaInsertRows(
      [
        {
          position: 1,
          mediaType: "video",
          storageKey: "prompts/new/preview.mp4",
          posterKey: "prompts/new/poster.jpg",
          durationSeconds: 30,
          isMain: true,
        },
        {
          position: 2,
          mediaType: "image",
          storageKey: "prompts/new/shot.jpg",
          isMain: false,
        },
      ],
      "00000000-0000-4000-8000-000000000001",
    );
    expect(rows).toEqual([
      {
        prompt_id: "00000000-0000-4000-8000-000000000001",
        position: 1,
        media_type: "video",
        storage_key: "prompts/new/preview.mp4",
        poster_key: "prompts/new/poster.jpg",
        duration_seconds: 30,
        is_main: true,
      },
      {
        prompt_id: "00000000-0000-4000-8000-000000000001",
        position: 2,
        media_type: "image",
        storage_key: "prompts/new/shot.jpg",
        poster_key: null,
        duration_seconds: null,
        is_main: false,
      },
    ]);
  });

  it("maps an update input field by field, and an empty patch to an empty row", () => {
    expect(
      toPromptUpdateRow({
        title: "New title",
        shortDescription: "New desc.",
        masterPrompt: "New master.",
        tool: "veo3",
        category: "comedy",
        language: "ur",
        length: "15_30s",
        exactDurationSeconds: 30,
        format: "horizontal_video",
        aspectRatio: "16:9",
        status: "draft",
        slug: "new-slug",
      }),
    ).toEqual({
      title: "New title",
      short_description: "New desc.",
      master_prompt: "New master.",
      tool: "veo3",
      category: "comedy",
      language: "ur",
      video_length_bucket: "15_30s",
      video_duration_seconds: 30,
      format: "horizontal_video",
      aspect_ratio: "16:9",
      status: "draft",
      slug: "new-slug",
    });
    expect(toPromptUpdateRow({})).toEqual({});
    // Explicit null exact duration survives (clearing the value).
    expect(
      toPromptUpdateRow({ exactDurationSeconds: null }).video_duration_seconds,
    ).toBeNull();
  });
});

describe("admin client failure mode and error logging", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null, never throws, when the admin client is unavailable", () => {
    vi.spyOn(authModule, "getSupabaseAdminClient").mockReturnValue(
      null as never,
    );
    expect(getPromptAdminClient()).toBeNull();
  });

  it("returns the client when available", () => {
    const fake = { from: vi.fn() };
    vi.spyOn(authModule, "getSupabaseAdminClient").mockReturnValue(
      fake as never,
    );
    expect(getPromptAdminClient()).toBe(fake);
  });

  it("logPromptError does not throw for any error shape", () => {
    expect(() => logPromptError("test", new Error("boom"))).not.toThrow();
    expect(() => logPromptError("test", "string error")).not.toThrow();
    expect(() => logPromptError("test", null)).not.toThrow();
  });
});
