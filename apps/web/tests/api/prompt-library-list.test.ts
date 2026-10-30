/**
 * @file prompt-library-list.test.ts
 * @description Route-level tests for GET + POST
 * /api/tenant/[subdomain]/prompts: published-only listing, every
 * list filter, sort orders, pagination (pageSize capped at 50 by
 * the contracts schema), invalid params rejected, favorites_only
 * (including the empty-favourites empty page), admin POST success,
 * non-admin 403, slug clash 409, invalid body rejected, and
 * admin-client failure -> 503 with no silent degradation. The
 * Supabase client is mocked at the auth-clients boundary with an
 * in-memory store (see prompt-library-route-mock.ts).
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import {
  GET as listPrompts,
  POST as createPrompt,
} from "@/app/api/tenant/[subdomain]/prompts/route";
import * as authModule from "@/lib/auth/clients";
import {
  ADMIN_ID,
  SUBDOMAIN,
  TEST_SECRET,
  USER_ID,
  basePromptStore,
  makeClient,
  newStore,
  sessionCookieFor,
  type Store,
} from "./prompt-library-route-mock";

const P1 = "00000000-0000-4000-8000-000000000001";
const P2 = "00000000-0000-4000-8000-000000000002";

function validCreateBody(overrides: Record<string, unknown> = {}) {
  return {
    title: "Brand new prompt",
    shortDescription: "A brand new prompt.",
    masterPrompt: "A golden puppy sits in a tiny bathtub.",
    tool: "dola_ai",
    category: "animals",
    language: "en",
    length: "1min_plus",
    format: "vertical_reel",
    aspectRatio: "9:16",
    status: "published",
    media: [
      {
        position: 1,
        mediaType: "video",
        storageKey: "prompts/new/preview.mp4",
        posterKey: "prompts/new/poster.jpg",
        durationSeconds: 30,
        isMain: true,
      },
    ],
    steps: [{ position: 1, body: "Open your video tool." }],
    ...overrides,
  };
}

describe("GET /api/tenant/[subdomain]/prompts", () => {
  let userCookie: string;
  let adminCookie: string;

  beforeEach(async () => {
    vi.restoreAllMocks();
    process.env.SESSION_SECRET = TEST_SECRET;
    process.env.R2_PUBLIC_URL = "https://media.example.com";
    userCookie = await sessionCookieFor("user");
    adminCookie = await sessionCookieFor("admin", ADMIN_ID);
  });

  afterEach(() => {
    process.env.R2_PUBLIC_URL = "https://media.example.com";
  });

  async function callList(
    query: string,
    store: Store = basePromptStore(),
    cookie = userCookie,
  ) {
    const client = makeClient(store);
    vi.spyOn(authModule, "getSupabaseAdminClient").mockReturnValue(
      client as never,
    );
    const req = new NextRequest(
      `http://localhost:3000/api/tenant/${SUBDOMAIN}/prompts${query}`,
      { headers: { cookie } },
    );
    const res = await listPrompts(req, {
      params: Promise.resolve({ subdomain: SUBDOMAIN }),
    });
    const body = (await res.json()) as {
      items: { slug: string; isFavourite: boolean }[];
      total: number;
      page: number;
      pageSize: number;
      error?: string;
    };
    return { res, body, store };
  }

  it("lists published prompts only, newest first, with favourite flags", async () => {
    const { res, body } = await callList("");
    expect(res.status).toBe(200);
    // Draft never appears; newest published first.
    expect(body.items.map((item) => item.slug)).toEqual([
      "puppy-first-bath",
      "rainy-neon-street",
    ]);
    expect(body.total).toBe(2);
    expect(body.items[0].isFavourite).toBe(true);
    expect(body.items[1].isFavourite).toBe(false);
  });

  it("filters by category, tool, language, length and format", async () => {
    const cases: [string, string[]][] = [
      ["?category=cinematic", ["rainy-neon-street"]],
      ["?tool=veo3", ["rainy-neon-street"]],
      ["?language=ur", ["rainy-neon-street"]],
      ["?length=15_30s", ["rainy-neon-street"]],
      ["?format=horizontal_video", ["rainy-neon-street"]],
      ["?category=animals&tool=dola_ai", ["puppy-first-bath"]],
    ];
    for (const [query, slugs] of cases) {
      const { body } = await callList(query);
      expect(body.items.map((item) => item.slug)).toEqual(slugs);
    }
  });

  it("searches title and description, escaping ilike wildcards", async () => {
    const { body } = await callList("?search=rainy");
    expect(body.items.map((item) => item.slug)).toEqual(["rainy-neon-street"]);
    const { body: none } = await callList("?search=zzz-no-match");
    expect(none.items).toEqual([]);
    expect(none.total).toBe(0);
    // A literal % in the search term must not act as a wildcard:
    // no prompt contains "%", so nothing matches.
    const { body: pct } = await callList("?search=%");
    expect(pct.items).toEqual([]);
  });

  it("sorts most_copied descending and a_to_z ascending", async () => {
    const { body: copied } = await callList("?sort=most_copied");
    expect(copied.items.map((item) => item.slug)).toEqual([
      "puppy-first-bath",
      "rainy-neon-street",
    ]);
    const { body: az } = await callList("?sort=a_to_z");
    expect(az.items.map((item) => item.slug)).toEqual([
      "puppy-first-bath",
      "rainy-neon-street",
    ]);
    // Default (newest) differs from a_to_z only via created_at;
    // verify the sort param is honoured by reversing created_at.
    const store = basePromptStore();
    const p1 = store.prompts.find((p) => p.id === P1)!;
    const p2 = store.prompts.find((p) => p.id === P2)!;
    p1.created_at = "2026-10-20T00:00:00.000Z";
    p2.created_at = "2026-10-28T00:00:00.000Z";
    const { body: newest } = await callList("?sort=newest", store);
    expect(newest.items.map((item) => item.slug)).toEqual([
      "rainy-neon-street",
      "puppy-first-bath",
    ]);
  });

  it("paginates and caps pageSize at 50", async () => {
    const { body: page2 } = await callList("?page=2&pageSize=1");
    expect(page2.items.map((item) => item.slug)).toEqual([
      "rainy-neon-street",
    ]);
    expect(page2.page).toBe(2);
    expect(page2.pageSize).toBe(1);
    expect(page2.total).toBe(2);
    // pageSize above the cap is rejected by the contracts schema.
    const { res: over } = await callList("?pageSize=51");
    expect(over.status).toBe(400);
    // Beyond the last page is an empty page, not an error.
    const { body: empty } = await callList("?page=9&pageSize=20");
    expect(empty.items).toEqual([]);
    expect(empty.total).toBe(2);
  });

  it("rejects invalid params: bad sort, bad length, bad page, bad favorites_only", async () => {
    for (const query of [
      "?sort=bogus",
      "?length=bogus",
      "?page=0",
      "?page=abc",
      "?favorites_only=maybe",
    ]) {
      const { res } = await callList(query);
      expect(res.status).toBe(400);
    }
  });

  it("favorites_only returns only the signed-in user's favourites", async () => {
    const { body } = await callList("?favorites_only=true");
    expect(body.items.map((item) => item.slug)).toEqual(["puppy-first-bath"]);
  });

  it("favorites_only with no favourites returns an empty page, never all prompts", async () => {
    const store = basePromptStore();
    store.favourites = [];
    const { res, body } = await callList("?favorites_only=true", store);
    expect(res.status).toBe(200);
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("rejects unauthenticated requests and wrong-tenant users", async () => {
    const { res } = await callList("", basePromptStore(), "");
    expect(res.status).toBe(401);
    const client = makeClient(basePromptStore());
    vi.spyOn(authModule, "getSupabaseAdminClient").mockReturnValue(
      client as never,
    );
    const req = new NextRequest(
      `http://localhost:3000/api/tenant/other/prompts`,
      { headers: { cookie: userCookie } },
    );
    const forbidden = await listPrompts(req, {
      params: Promise.resolve({ subdomain: "other" }),
    });
    expect(forbidden.status).toBe(403);
  });

  it("returns 503 when the admin client is unavailable, and when R2 public URL is missing", async () => {
    vi.spyOn(authModule, "getSupabaseAdminClient").mockReturnValue(
      null as never,
    );
    const req = new NextRequest(
      `http://localhost:3000/api/tenant/${SUBDOMAIN}/prompts`,
      { headers: { cookie: userCookie } },
    );
    const noClient = await listPrompts(req, {
      params: Promise.resolve({ subdomain: SUBDOMAIN }),
    });
    expect(noClient.status).toBe(503);

    delete process.env.R2_PUBLIC_URL;
    const client = makeClient(basePromptStore());
    vi.spyOn(authModule, "getSupabaseAdminClient").mockReturnValue(
      client as never,
    );
    const req2 = new NextRequest(
      `http://localhost:3000/api/tenant/${SUBDOMAIN}/prompts`,
      { headers: { cookie: userCookie } },
    );
    const noUrl = await listPrompts(req2, {
      params: Promise.resolve({ subdomain: SUBDOMAIN }),
    });
    expect(noUrl.status).toBe(503);
  });

  it("returns 500 on a database error, not a partial list", async () => {
    const store = basePromptStore();
    store.fail["prompt_library_prompts:range"] = new Error("db down");
    const { res, body } = await callList("", store);
    expect(res.status).toBe(500);
    expect(body.error).toBe("INTERNAL_ERROR");
  });

  it("returns 500 when the media query fails", async () => {
    const store = basePromptStore();
    store.fail["prompt_library_media:then"] = new Error("media down");
    const { res } = await callList("", store);
    expect(res.status).toBe(500);
  });

  it("returns 500 when the favourites flag query fails", async () => {
    const store = basePromptStore();
    store.fail["prompt_library_favourites:then"] = new Error("fav down");
    const { res } = await callList("", store);
    expect(res.status).toBe(500);
  });

  it("returns 500 when the favorites_only list query fails", async () => {
    const store = basePromptStore();
    store.fail["prompt_library_favourites:then"] = new Error("fav down");
    const { res } = await callList("?favorites_only=true", store);
    expect(res.status).toBe(500);
  });
});

describe("POST /api/tenant/[subdomain]/prompts", () => {
  let userCookie: string;
  let adminCookie: string;

  beforeEach(async () => {
    vi.restoreAllMocks();
    process.env.SESSION_SECRET = TEST_SECRET;
    process.env.R2_PUBLIC_URL = "https://media.example.com";
    userCookie = await sessionCookieFor("user");
    adminCookie = await sessionCookieFor("admin", ADMIN_ID);
  });

  async function callPost(
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
      `http://localhost:3000/api/tenant/${SUBDOMAIN}/prompts`,
      {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
        },
        body: rawBody ?? JSON.stringify(body),
      },
    );
    const res = await createPrompt(req, {
      params: Promise.resolve({ subdomain: SUBDOMAIN }),
    });
    const parsed = (await res.json()) as Record<string, unknown>;
    return { res, body: parsed, store };
  }

  it("creates a prompt as admin, with media and steps stored", async () => {
    const { res, body, store } = await callPost(validCreateBody());
    expect(res.status).toBe(201);
    expect(body.slug).toBe("brand-new-prompt");
    expect(typeof body.id).toBe("string");
    const created = store.prompts.find((p) => p.slug === "brand-new-prompt");
    expect(created).toBeTruthy();
    expect(
      store.media.filter((m) => m.prompt_id === created!.id),
    ).toHaveLength(1);
    expect(
      store.steps.filter((s) => s.prompt_id === created!.id),
    ).toHaveLength(1);
    expect(created!.created_by).toBe(ADMIN_ID);
  });

  it("uses an explicit slug when provided", async () => {
    const { res, body } = await callPost(
      validCreateBody({ slug: "custom-slug" }),
    );
    expect(res.status).toBe(201);
    expect(body.slug).toBe("custom-slug");
  });

  it("rejects non-admins with 403 and stores nothing", async () => {
    const store = basePromptStore();
    const before = store.prompts.length;
    const { res } = await callPost(validCreateBody(), store, userCookie);
    expect(res.status).toBe(403);
    expect(store.prompts.length).toBe(before);
  });

  it("rejects unauthenticated POSTs with 401", async () => {
    const { res } = await callPost(validCreateBody(), basePromptStore(), "");
    expect(res.status).toBe(401);
  });

  it("returns 409 on a slug clash and stores nothing new", async () => {
    const store = basePromptStore();
    const { res, body } = await callPost(
      validCreateBody({ slug: "puppy-first-bath" }),
      store,
    );
    expect(res.status).toBe(409);
    expect(body.error).toBe("SLUG_ALREADY_EXISTS");
    expect(store.prompts).toHaveLength(3);
  });

  it("rejects an invalid body: bad format/aspect, media without a main, bad storage key", async () => {
    const badBodies = [
      validCreateBody({ aspectRatio: "16:9" }),
      validCreateBody({
        media: [
          {
            position: 1,
            mediaType: "image",
            storageKey: "prompts/new/shot.jpg",
            isMain: false,
          },
        ],
      }),
      validCreateBody({
        media: [
          {
            position: 1,
            mediaType: "image",
            storageKey: "users/new/shot.jpg",
            isMain: true,
          },
        ],
      }),
      validCreateBody({ title: "" }),
    ];
    for (const bad of badBodies) {
      const { res, body } = await callPost(bad);
      expect(res.status).toBe(400);
      expect(body.error).toBe("INVALID_BODY");
    }
  });

  it("rejects malformed JSON with 400", async () => {
    const { res, body } = await callPost(null, basePromptStore(), adminCookie, "{not json");
    expect(res.status).toBe(400);
    expect(body.error).toBe("INVALID_JSON");
  });

  it("returns 503 when the admin client is unavailable", async () => {
    vi.spyOn(authModule, "getSupabaseAdminClient").mockReturnValue(
      null as never,
    );
    const req = new NextRequest(
      `http://localhost:3000/api/tenant/${SUBDOMAIN}/prompts`,
      {
        method: "POST",
        headers: {
          cookie: adminCookie,
          "content-type": "application/json",
        },
        body: JSON.stringify(validCreateBody()),
      },
    );
    const res = await createPrompt(req, {
      params: Promise.resolve({ subdomain: SUBDOMAIN }),
    });
    expect(res.status).toBe(503);
  });

  it("rolls back the prompt when the media insert fails", async () => {
    const store = basePromptStore();
    store.fail["prompt_library_media:insert"] = new Error("media down");
    const { res } = await callPost(validCreateBody(), store);
    expect(res.status).toBe(500);
    expect(store.prompts.find((p) => p.slug === "brand-new-prompt")).toBeUndefined();
  });

  it("rolls back the prompt when the steps insert fails", async () => {
    const store = basePromptStore();
    store.fail["prompt_library_how_to_steps:insert"] = new Error("steps down");
    const { res } = await callPost(validCreateBody(), store);
    expect(res.status).toBe(500);
    expect(store.prompts.find((p) => p.slug === "brand-new-prompt")).toBeUndefined();
  });

  it("returns 500 when the prompt insert itself fails", async () => {
    const store = basePromptStore();
    store.fail["prompt_library_prompts:single"] = new Error("insert down");
    const { res } = await callPost(validCreateBody(), store);
    expect(res.status).toBe(500);
  });

  it("returns 503 when R2 public URL is missing after a successful insert", async () => {
    delete process.env.R2_PUBLIC_URL;
    const { res } = await callPost(validCreateBody());
    expect(res.status).toBe(503);
    process.env.R2_PUBLIC_URL = "https://media.example.com";
  });
});
