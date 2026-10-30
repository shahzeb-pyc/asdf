/**
 * @file prompt-library-favourite-route.test.ts
 * @description Route-level tests for POST + DELETE
 * /api/tenant/[subdomain]/prompts/[slug]/favourite. The existing
 * prompt-library-favorites.test.ts covers the favorites_only list
 * filter but never loads this route, so this file covers the route
 * itself: POST idempotent (already favourited stays one row),
 * DELETE removes, DELETE of a non-favourited prompt is a no-op
 * success, unauthenticated -> 401, unknown slug 404, draft 404,
 * and database-error 500s. Supabase is mocked at the
 * auth-clients boundary with an in-memory store.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import {
  POST as addFavourite,
  DELETE as removeFavourite,
} from "@/app/api/tenant/[subdomain]/prompts/[slug]/favourite/route";
import * as authModule from "@/lib/auth/clients";
import {
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

describe("POST/DELETE /api/tenant/[subdomain]/prompts/[slug]/favourite", () => {
  let userCookie: string;

  beforeEach(async () => {
    vi.restoreAllMocks();
    process.env.SESSION_SECRET = TEST_SECRET;
    process.env.R2_PUBLIC_URL = "https://media.example.com";
    userCookie = await sessionCookieFor("user");
  });

  async function callFav(
    method: "POST" | "DELETE",
    slug: string,
    store: Store = basePromptStore(),
    cookie = userCookie,
  ) {
    const client = makeClient(store);
    vi.spyOn(authModule, "getSupabaseAdminClient").mockReturnValue(
      client as never,
    );
    const req = new NextRequest(
      `http://localhost:3000/api/tenant/${SUBDOMAIN}/prompts/${slug}/favourite`,
      { method, headers: { cookie } },
    );
    const handler = method === "POST" ? addFavourite : removeFavourite;
    const res = await handler(req, {
      params: Promise.resolve({ subdomain: SUBDOMAIN, slug }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    return { res, body, store };
  }

  function favCount(store: Store, promptId: string): number {
    return store.favourites.filter(
      (fav) => fav.user_id === USER_ID && fav.prompt_id === promptId,
    ).length;
  }

  it("POST adds a favourite for the signed-in user only", async () => {
    const store = basePromptStore();
    expect(favCount(store, P2)).toBe(0);
    const { res, body } = await callFav("POST", "rainy-neon-street", store);
    expect(res.status).toBe(200);
    expect(body).toEqual({ slug: "rainy-neon-street", isFavourite: true });
    expect(favCount(store, P2)).toBe(1);
  });

  it("POST is idempotent: already favourited stays exactly one row", async () => {
    const store = basePromptStore();
    expect(favCount(store, P1)).toBe(1);
    const { res, body } = await callFav("POST", "puppy-first-bath", store);
    expect(res.status).toBe(200);
    expect(body.isFavourite).toBe(true);
    expect(favCount(store, P1)).toBe(1);
  });

  it("DELETE removes the favourite", async () => {
    const store = basePromptStore();
    const { res, body } = await callFav("DELETE", "puppy-first-bath", store);
    expect(res.status).toBe(200);
    expect(body).toEqual({ slug: "puppy-first-bath", isFavourite: false });
    expect(favCount(store, P1)).toBe(0);
  });

  it("DELETE of a non-favourited prompt is a no-op success", async () => {
    const store = basePromptStore();
    const { res, body } = await callFav("DELETE", "rainy-neon-street", store);
    expect(res.status).toBe(200);
    expect(body.isFavourite).toBe(false);
    expect(favCount(store, P2)).toBe(0);
  });

  it("DELETE never removes another user's favourite row", async () => {
    const store = basePromptStore();
    store.favourites.push({ user_id: "other-user-id", prompt_id: P1 });
    const { res } = await callFav("DELETE", "puppy-first-bath", store);
    expect(res.status).toBe(200);
    expect(
      store.favourites.filter((fav) => fav.user_id === "other-user-id"),
    ).toHaveLength(1);
  });

  it("returns 404 for an unknown slug on both methods", async () => {
    for (const method of ["POST", "DELETE"] as const) {
      const { res, body } = await callFav(method, "no-such-prompt");
      expect(res.status).toBe(404);
      expect(body.error).toBe("NOT_FOUND");
    }
  });

  it("returns 404 for a draft on both methods", async () => {
    for (const method of ["POST", "DELETE"] as const) {
      const { res } = await callFav(method, "draft-prompt");
      expect(res.status).toBe(404);
    }
  });

  it("returns 401 unauthenticated on both methods", async () => {
    for (const method of ["POST", "DELETE"] as const) {
      const { res } = await callFav(method, "puppy-first-bath", basePromptStore(), "");
      expect(res.status).toBe(401);
    }
  });

  it("returns 503 without an admin client on both methods", async () => {
    vi.spyOn(authModule, "getSupabaseAdminClient").mockReturnValue(
      null as never,
    );
    for (const method of ["POST", "DELETE"] as const) {
      const handler = method === "POST" ? addFavourite : removeFavourite;
      const req = new NextRequest(
        `http://localhost:3000/api/tenant/${SUBDOMAIN}/prompts/puppy-first-bath/favourite`,
        { method, headers: { cookie: userCookie } },
      );
      const res = await handler(req, {
        params: Promise.resolve({ subdomain: SUBDOMAIN, slug: "puppy-first-bath" }),
      });
      expect(res.status).toBe(503);
    }
  });

  it("returns 500 when the upsert fails", async () => {
    const store = basePromptStore();
    store.fail["prompt_library_favourites:upsert"] = new Error("upsert down");
    const { res, body } = await callFav("POST", "rainy-neon-street", store);
    expect(res.status).toBe(500);
    expect(body.error).toBe("INTERNAL_ERROR");
  });

  it("returns 500 when the delete fails", async () => {
    const store = basePromptStore();
    store.fail["prompt_library_favourites:delete"] = new Error("delete down");
    const { res } = await callFav("DELETE", "puppy-first-bath", store);
    expect(res.status).toBe(500);
    expect(favCount(store, P1)).toBe(1);
  });

  it("returns 500 when the prompt lookup fails", async () => {
    const store = basePromptStore();
    store.fail["prompt_library_prompts:maybeSingle"] = new Error("db down");
    const { res } = await callFav("POST", "puppy-first-bath", store);
    expect(res.status).toBe(500);
  });
});
