/**
 * @file prompt-library-favorites.test.ts
 * @description Route-level tests for the favorites_only list filter:
 * with favorites_only=true the list API returns ONLY rows the
 * current user favourited (via prompt_library_favourites), and
 * without it the full published list is returned. The Supabase
 * client is mocked at the auth-clients boundary with a chainable
 * builder that applies the .in('id', favouriteIds) filter the route
 * sets, so the test exercises the route's own filtering logic —
 * not just the contracts schema. A real signed session token is
 * used, as in the other API route tests.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { signSessionToken } from "@fbuploadpro/contracts";
import { GET as listPrompts } from "@/app/api/tenant/[subdomain]/prompts/route";
import * as authModule from "@/lib/auth/clients";

const TEST_SECRET = "test-session-secret-that-is-long-enough-123456";
const USER_ID = "11111111-1111-4111-a111-111111111111";
const SUBDOMAIN = "acme";

function row(id: string, slug: string, title: string) {
  return {
    id,
    slug,
    title,
    short_description: `${title} description.`,
    master_prompt: `${title} master prompt.`,
    tool: "dola_ai",
    category: "animals",
    language: "en",
    video_length_bucket: "1min_plus",
    format: "vertical_reel",
    aspect_ratio: "9:16",
    copied_count: 0,
    status: "published",
    created_by: null,
    created_at: "2026-10-28T00:00:00.000Z",
    updated_at: "2026-10-28T00:00:00.000Z",
  };
}

function mainMediaRow(promptId: string) {
  return {
    id: `00000000-0000-4000-8000-0000000000${promptId.slice(-2)}`,
    prompt_id: promptId,
    position: 1,
    media_type: "video",
    storage_key: `prompts/${promptId}/preview.mp4`,
    poster_key: `prompts/${promptId}/poster.jpg`,
    duration_seconds: 30,
    is_main: true,
    created_at: "2026-10-28T00:00:00.000Z",
  };
}

const FAV_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ID = "00000000-0000-4000-8000-000000000002";
const ALL_ROWS = [
  row(FAV_ID, "puppy-first-bath", "Puppy first bath"),
  row(OTHER_ID, "rainy-neon-street", "Rainy neon street"),
];

/** Chainable Supabase-style builder that applies .in() filtering. */
function makeClient() {
  const calls: { table: string; inArgs: unknown[] | null }[] = [];
  const promptsBuilder: Record<string, unknown> = {};
  const inFn = vi.fn((column: string, values: unknown[]) => {
    calls.push({ table: "prompt_library_prompts", inArgs: values });
    void column;
    return promptsBuilder;
  });
  Object.assign(promptsBuilder, {
    eq: vi.fn(() => promptsBuilder),
    or: vi.fn(() => promptsBuilder),
    order: vi.fn(() => promptsBuilder),
    in: inFn,
    range: vi.fn(async () => {
      const inCall = calls.find(
        (c) => c.table === "prompt_library_prompts" && c.inArgs,
      );
      const rows = inCall
        ? ALL_ROWS.filter((r) => (inCall.inArgs as string[]).includes(r.id))
        : ALL_ROWS;
      return { data: rows, count: rows.length, error: null };
    }),
  });
  const client = {
    from: vi.fn((table: string) => {
      if (table === "prompt_library_prompts") {
        return {
          select: vi.fn(() => promptsBuilder),
        };
      }
      if (table === "prompt_library_media") {
        // List route media query: .select('*').in('prompt_id', ids)
        // .order('position') — returns the main media per prompt.
        const mediaBuilder: Record<string, unknown> = {};
        Object.assign(mediaBuilder, {
          in: vi.fn(() => mediaBuilder),
          order: vi.fn(async () => ({
            data: ALL_ROWS.map((r) => mainMediaRow(r.id)),
            error: null,
          })),
        });
        return {
          select: vi.fn(() => mediaBuilder),
        };
      }
      if (table === "prompt_library_favourites") {
        // Distinguish the two favourites queries by call order is
        // fragile; instead return a builder whose .eq() resolves for
        // the list query and whose .in() resolves for the flag query.
        // The route calls .select().eq() for the list query and
        // .select().eq().in() for the flag query — so .eq() must
        // return an object that is both awaitable (list query) and
        // has .in() (flag query). A thenable builder does both.
        const flagBuilder = {
          in: vi.fn(async () => ({
            data: [{ prompt_id: FAV_ID }],
            error: null,
          })),
          then: (
            resolve: (v: unknown) => void,
            reject: (e: unknown) => void,
          ) => {
            Promise.resolve({ data: [{ prompt_id: FAV_ID }], error: null })
              .then(resolve, reject);
          },
        };
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => flagBuilder),
          })),
        };
      }
      throw new Error(`unexpected table ${table}`);
    }),
    _calls: calls,
  };
  return client;
}

describe("GET /api/tenant/[subdomain]/prompts favorites_only", () => {
  let sessionCookie: string;

  beforeEach(async () => {
    vi.restoreAllMocks();
    process.env.SESSION_SECRET = TEST_SECRET;
    process.env.R2_PUBLIC_URL = "https://media.example.com";
    const token = await signSessionToken(
      {
        userId: USER_ID,
        email: "testuser@gmail.com",
        name: "Test User",
        subdomain: SUBDOMAIN,
        role: "user",
        status: "active",
      },
      TEST_SECRET,
    );
    sessionCookie = `fbup_session=${token}`;
  });

  async function callList(query: string) {
    const client = makeClient();
    vi.spyOn(authModule, "getSupabaseAdminClient").mockReturnValue(
      client as never,
    );
    const req = new NextRequest(
      `http://localhost:3000/api/tenant/${SUBDOMAIN}/prompts${query}`,
      { headers: { cookie: sessionCookie } },
    );
    const res = await listPrompts(req, {
      params: Promise.resolve({ subdomain: SUBDOMAIN }),
    });
    return { res, body: (await res.json()) as { items: { slug: string }[] } };
  }

  it("returns only favourited rows when favorites_only=true", async () => {
    const { res, body } = await callList("?favorites_only=true");
    expect(res.status).toBe(200);
    expect(body.items.map((item) => item.slug)).toEqual(["puppy-first-bath"]);
  });

  it("returns the full published list without favorites_only", async () => {
    const { res, body } = await callList("");
    expect(res.status).toBe(200);
    expect(body.items.map((item) => item.slug)).toEqual([
      "puppy-first-bath",
      "rainy-neon-street",
    ]);
  });
});
