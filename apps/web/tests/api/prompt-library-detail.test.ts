/**
 * @file prompt-library-detail.test.ts
 * @description Route-level tests for GET + PATCH + DELETE
 * /api/tenant/[subdomain]/prompts/[slug]: published detail for any
 * tenant user, draft 404 to non-admins, draft visible to admins,
 * unknown slug 404, PATCH success (including media/steps
 * replacement with restore on failure), non-admin 403, slug clash
 * 409, invalid patch, merged-format validation, and DELETE success
 * / 403 / 404. Supabase is mocked at the auth-clients boundary
 * with an in-memory store (see prompt-library-route-mock.ts).
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import {
  GET as getPrompt,
  PATCH as patchPrompt,
  DELETE as deletePrompt,
} from "@/app/api/tenant/[subdomain]/prompts/[slug]/route";
import * as authModule from "@/lib/auth/clients";
import {
  ADMIN_ID,
  SUBDOMAIN,
  TEST_SECRET,
  USER_ID,
  basePromptStore,
  makeClient,
  sessionCookieFor,
  type Store,
} from "./prompt-library-route-mock";

const P1 = "00000000-0000-4000-8000-000000000001";
const P2 = "00000000-0000-4000-8000-000000000002";

describe("GET /api/tenant/[subdomain]/prompts/[slug]", () => {
  let userCookie: string;
  let adminCookie: string;

  beforeEach(async () => {
    vi.restoreAllMocks();
    process.env.SESSION_SECRET = TEST_SECRET;
    process.env.R2_PUBLIC_URL = "https://media.example.com";
    userCookie = await sessionCookieFor("user");
    adminCookie = await sessionCookieFor("admin", ADMIN_ID);
  });

  async function callGet(
    slug: string,
    store: Store = basePromptStore(),
    cookie = userCookie,
  ) {
    const client = makeClient(store);
    vi.spyOn(authModule, "getSupabaseAdminClient").mockReturnValue(
      client as never,
    );
    const req = new NextRequest(
      `http://localhost:3000/api/tenant/${SUBDOMAIN}/prompts/${slug}`,
      { headers: { cookie } },
    );
    const res = await getPrompt(req, {
      params: Promise.resolve({ subdomain: SUBDOMAIN, slug }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    return { res, body, store };
  }

  it("returns the published detail with gallery main-first, steps sorted, and favourite flag", async () => {
    const { res, body } = await callGet("puppy-first-bath");
    expect(res.status).toBe(200);
    expect(body.slug).toBe("puppy-first-bath");
    expect(body.masterPrompt).toBeTruthy();
    expect(body.isFavourite).toBe(true);
    const media = body.media as { isMain: boolean }[];
    expect(media).toHaveLength(1);
    expect(media[0].isMain).toBe(true);
    expect(body.previewUrl).toBe(
      "https://media.example.com/prompts/00000000-0000-4000-8000-000000000001/preview.mp4",
    );
  });

  it("returns a non-favourited published prompt with isFavourite false", async () => {
    const { body } = await callGet("rainy-neon-street");
    expect(body.isFavourite).toBe(false);
  });

  it("returns 404 for a draft to a non-admin, without leaking its existence", async () => {
    const { res, body } = await callGet("draft-prompt");
    expect(res.status).toBe(404);
    expect(body.error).toBe("NOT_FOUND");
  });

  it("shows a draft to an admin", async () => {
    const { res, body } = await callGet("draft-prompt", basePromptStore(), adminCookie);
    expect(res.status).toBe(200);
    expect(body.slug).toBe("draft-prompt");
    expect(body.status).toBe("draft");
  });

  it("returns 404 for an unknown slug", async () => {
    const { res } = await callGet("no-such-prompt");
    expect(res.status).toBe(404);
  });

  it("returns 401 unauthenticated and 503 without an admin client or R2 URL", async () => {
    const { res } = await callGet("puppy-first-bath", basePromptStore(), "");
    expect(res.status).toBe(401);

    vi.spyOn(authModule, "getSupabaseAdminClient").mockReturnValue(
      null as never,
    );
    const req = new NextRequest(
      `http://localhost:3000/api/tenant/${SUBDOMAIN}/prompts/puppy-first-bath`,
      { headers: { cookie: userCookie } },
    );
    const noClient = await getPrompt(req, {
      params: Promise.resolve({ subdomain: SUBDOMAIN, slug: "puppy-first-bath" }),
    });
    expect(noClient.status).toBe(503);

    delete process.env.R2_PUBLIC_URL;
    const client = makeClient(basePromptStore());
    vi.spyOn(authModule, "getSupabaseAdminClient").mockReturnValue(
      client as never,
    );
    const req2 = new NextRequest(
      `http://localhost:3000/api/tenant/${SUBDOMAIN}/prompts/puppy-first-bath`,
      { headers: { cookie: userCookie } },
    );
    const noUrl = await getPrompt(req2, {
      params: Promise.resolve({ subdomain: SUBDOMAIN, slug: "puppy-first-bath" }),
    });
    expect(noUrl.status).toBe(503);
    process.env.R2_PUBLIC_URL = "https://media.example.com";
  });

  it("returns 500 when the prompt load fails", async () => {
    const store = basePromptStore();
    store.fail["prompt_library_prompts:maybeSingle"] = new Error("db down");
    const { res, body } = await callGet("puppy-first-bath", store);
    expect(res.status).toBe(500);
    expect(body.error).toBe("INTERNAL_ERROR");
  });

  it("returns 500 when the steps load fails", async () => {
    const store = basePromptStore();
    store.fail["prompt_library_how_to_steps:then"] = new Error("steps down");
    const { res } = await callGet("puppy-first-bath", store);
    expect(res.status).toBe(500);
  });

  it("returns 500 when the media load fails", async () => {
    const store = basePromptStore();
    store.fail["prompt_library_media:then"] = new Error("media down");
    const { res } = await callGet("puppy-first-bath", store);
    expect(res.status).toBe(500);
  });
});

describe("PATCH /api/tenant/[subdomain]/prompts/[slug]", () => {
  let userCookie: string;
  let adminCookie: string;

  beforeEach(async () => {
    vi.restoreAllMocks();
    process.env.SESSION_SECRET = TEST_SECRET;
    process.env.R2_PUBLIC_URL = "https://media.example.com";
    userCookie = await sessionCookieFor("user");
    adminCookie = await sessionCookieFor("admin", ADMIN_ID);
  });

  async function callPatch(
    slug: string,
    body: unknown,
    store: Store = basePromptStore(),
    cookie = adminCookie,
    rawBody?: string,
  ) {
    const client = makeClient(store);
    vi.spyOn(authModule, "getSupabaseAdminClient").mockReturnValue(
      client as never,
    );
    const req = new NextRequest(
      `http://localhost:3000/api/tenant/${SUBDOMAIN}/prompts/${slug}`,
      {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: rawBody ?? JSON.stringify(body),
      },
    );
    const res = await patchPrompt(req, {
      params: Promise.resolve({ subdomain: SUBDOMAIN, slug }),
    });
    const parsed = (await res.json()) as Record<string, unknown>;
    return { res, body: parsed, store };
  }

  it("updates title and status, returning the (unchanged) slug", async () => {
    const { res, body, store } = await callPatch("puppy-first-bath", {
      title: "Puppy first bath, revised",
      status: "draft",
    });
    expect(res.status).toBe(200);
    expect(body.slug).toBe("puppy-first-bath");
    const row = store.prompts.find((p) => p.id === P1)!;
    expect(row.title).toBe("Puppy first bath, revised");
    expect(row.status).toBe("draft");
  });

  it("renames via a new slug", async () => {
    const { res, body, store } = await callPatch("puppy-first-bath", {
      slug: "puppy-bath-v2",
    });
    expect(res.status).toBe(200);
    expect(body.slug).toBe("puppy-bath-v2");
    expect(store.prompts.find((p) => p.id === P1)!.slug).toBe("puppy-bath-v2");
  });

  it("replaces media and steps wholesale", async () => {
    const { res, store } = await callPatch("puppy-first-bath", {
      media: [
        {
          position: 1,
          mediaType: "image",
          storageKey: "prompts/new/shot.jpg",
          isMain: true,
        },
      ],
      steps: [
        { position: 1, body: "Step one, replaced." },
        { position: 2, body: "Step two, replaced." },
      ],
    });
    expect(res.status).toBe(200);
    const media = store.media.filter((m) => m.prompt_id === P1);
    expect(media).toHaveLength(1);
    expect(media[0].storage_key).toBe("prompts/new/shot.jpg");
    const steps = store.steps.filter((s) => s.prompt_id === P1);
    expect(steps).toHaveLength(2);
  });

  it("restores previous media when the media replacement insert fails", async () => {
    const store = basePromptStore();
    store.fail["prompt_library_media:insert"] = new Error("media down");
    const { res } = await callPatch(
      "puppy-first-bath",
      {
        media: [
          {
            position: 1,
            mediaType: "image",
            storageKey: "prompts/new/shot.jpg",
            isMain: true,
          },
        ],
      },
      store,
    );
    expect(res.status).toBe(500);
    // Previous gallery restored, not left deleted.
    const media = store.media.filter((m) => m.prompt_id === P1);
    expect(media).toHaveLength(1);
    expect(media[0].storage_key).toContain("preview.mp4");
  });

  it("restores previous steps when the steps replacement insert fails", async () => {
    const store = basePromptStore();
    store.fail["prompt_library_how_to_steps:insert"] = new Error("steps down");
    const { res } = await callPatch(
      "puppy-first-bath",
      { steps: [{ position: 1, body: "Replacement step." }] },
      store,
    );
    expect(res.status).toBe(500);
    const steps = store.steps.filter((s) => s.prompt_id === P1);
    expect(steps).toHaveLength(1);
    expect(steps[0].body).toBe("Open your video tool.");
  });

  it("returns 500 when the steps delete fails", async () => {
    const store = basePromptStore();
    store.fail["prompt_library_how_to_steps:delete"] = new Error("delete down");
    const { res } = await callPatch(
      "puppy-first-bath",
      { steps: [{ position: 1, body: "Replacement step." }] },
      store,
    );
    expect(res.status).toBe(500);
  });

  it("returns 500 when the media delete fails", async () => {
    const store = basePromptStore();
    store.fail["prompt_library_media:delete"] = new Error("delete down");
    const { res } = await callPatch(
      "puppy-first-bath",
      {
        media: [
          {
            position: 1,
            mediaType: "image",
            storageKey: "prompts/new/shot.jpg",
            isMain: true,
          },
        ],
      },
      store,
    );
    expect(res.status).toBe(500);
  });

  it("returns 500 when the prompt update itself fails", async () => {
    const store = basePromptStore();
    store.fail["prompt_library_prompts:update"] = new Error("update down");
    const { res } = await callPatch("puppy-first-bath", { title: "New title" }, store);
    expect(res.status).toBe(500);
  });

  it("rejects non-admins with 403 and changes nothing", async () => {
    const store = basePromptStore();
    const { res } = await callPatch(
      "puppy-first-bath",
      { title: "Hacked title" },
      store,
      userCookie,
    );
    expect(res.status).toBe(403);
    expect(store.prompts.find((p) => p.id === P1)!.title).toBe(
      "Puppy first bath",
    );
  });

  it("returns 404 for an unknown slug", async () => {
    const { res } = await callPatch("no-such-prompt", { title: "New title" });
    expect(res.status).toBe(404);
  });

  it("returns 401 unauthenticated", async () => {
    const { res } = await callPatch(
      "puppy-first-bath",
      { title: "New title" },
      basePromptStore(),
      "",
    );
    expect(res.status).toBe(401);
  });

  it("returns 409 on a slug clash with another prompt", async () => {
    const { res, body } = await callPatch("puppy-first-bath", {
      slug: "rainy-neon-street",
    });
    expect(res.status).toBe(409);
    expect(body.error).toBe("SLUG_ALREADY_EXISTS");
  });

  it("allows patching with the prompt's own slug (no false clash)", async () => {
    const { res } = await callPatch("puppy-first-bath", {
      slug: "puppy-first-bath",
      title: "Same slug, new title",
    });
    expect(res.status).toBe(200);
  });

  it("rejects a patch that breaks format/aspect on the merged row", async () => {
    // Existing row is vertical 9:16; switching format alone to
    // horizontal without its aspect ratio breaks the invariant.
    const { res, body } = await callPatch("puppy-first-bath", {
      format: "horizontal_video",
    });
    expect(res.status).toBe(400);
    expect(body.error).toContain("Aspect ratio");
  });

  it("accepts a format change paired with its matching aspect ratio", async () => {
    const { res } = await callPatch("puppy-first-bath", {
      format: "horizontal_video",
      aspectRatio: "16:9",
    });
    expect(res.status).toBe(200);
  });

  it("rejects an invalid patch body and malformed JSON", async () => {
    const { res, body } = await callPatch("puppy-first-bath", {
      aspectRatio: "4:3",
    });
    expect(res.status).toBe(400);
    expect(body.error).toBe("INVALID_BODY");
    const { res: badJson, body: badJsonBody } = await callPatch(
      "puppy-first-bath",
      null,
      basePromptStore(),
      adminCookie,
      "{not json",
    );
    expect(badJson.status).toBe(400);
    expect(badJsonBody.error).toBe("INVALID_JSON");
  });

  it("returns 503 without an admin client", async () => {
    vi.spyOn(authModule, "getSupabaseAdminClient").mockReturnValue(
      null as never,
    );
    const req = new NextRequest(
      `http://localhost:3000/api/tenant/${SUBDOMAIN}/prompts/puppy-first-bath`,
      {
        method: "PATCH",
        headers: { cookie: adminCookie, "content-type": "application/json" },
        body: JSON.stringify({ title: "New title" }),
      },
    );
    const res = await patchPrompt(req, {
      params: Promise.resolve({ subdomain: SUBDOMAIN, slug: "puppy-first-bath" }),
    });
    expect(res.status).toBe(503);
  });
});

describe("DELETE /api/tenant/[subdomain]/prompts/[slug]", () => {
  let userCookie: string;
  let adminCookie: string;

  beforeEach(async () => {
    vi.restoreAllMocks();
    process.env.SESSION_SECRET = TEST_SECRET;
    process.env.R2_PUBLIC_URL = "https://media.example.com";
    userCookie = await sessionCookieFor("user");
    adminCookie = await sessionCookieFor("admin", ADMIN_ID);
  });

  async function callDelete(
    slug: string,
    store: Store = basePromptStore(),
    cookie = adminCookie,
  ) {
    const client = makeClient(store);
    vi.spyOn(authModule, "getSupabaseAdminClient").mockReturnValue(
      client as never,
    );
    const req = new NextRequest(
      `http://localhost:3000/api/tenant/${SUBDOMAIN}/prompts/${slug}`,
      { method: "DELETE", headers: { cookie } },
    );
    const res = await deletePrompt(req, {
      params: Promise.resolve({ subdomain: SUBDOMAIN, slug }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    return { res, body, store };
  }

  it("deletes as admin and returns deleted:true", async () => {
    const { res, body, store } = await callDelete("puppy-first-bath");
    expect(res.status).toBe(200);
    expect(body.deleted).toBe(true);
    expect(store.prompts.find((p) => p.id === P1)).toBeUndefined();
  });

  it("rejects non-admins with 403 and deletes nothing", async () => {
    const store = basePromptStore();
    const { res } = await callDelete("puppy-first-bath", store, userCookie);
    expect(res.status).toBe(403);
    expect(store.prompts.find((p) => p.id === P1)).toBeTruthy();
  });

  it("returns 404 for an unknown slug", async () => {
    const { res } = await callDelete("no-such-prompt");
    expect(res.status).toBe(404);
  });

  it("returns 401 unauthenticated and 503 without an admin client", async () => {
    const { res } = await callDelete("puppy-first-bath", basePromptStore(), "");
    expect(res.status).toBe(401);
    vi.spyOn(authModule, "getSupabaseAdminClient").mockReturnValue(
      null as never,
    );
    const req = new NextRequest(
      `http://localhost:3000/api/tenant/${SUBDOMAIN}/prompts/puppy-first-bath`,
      { method: "DELETE", headers: { cookie: adminCookie } },
    );
    const noClient = await deletePrompt(req, {
      params: Promise.resolve({ subdomain: SUBDOMAIN, slug: "puppy-first-bath" }),
    });
    expect(noClient.status).toBe(503);
  });

  it("returns 500 when the delete fails", async () => {
    const store = basePromptStore();
    store.fail["prompt_library_prompts:delete"] = new Error("delete down");
    const { res } = await callDelete("puppy-first-bath", store);
    expect(res.status).toBe(500);
    expect(store.prompts.find((p) => p.id === P1)).toBeTruthy();
  });

  it("returns 500 when the prompt load fails", async () => {
    const store = basePromptStore();
    store.fail["prompt_library_prompts:maybeSingle"] = new Error("db down");
    const { res } = await callDelete("puppy-first-bath", store);
    expect(res.status).toBe(500);
  });
});
