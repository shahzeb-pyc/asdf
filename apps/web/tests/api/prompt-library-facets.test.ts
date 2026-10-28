/**
 * @file prompt-library-facets.test.ts
 * @description Route-level tests for GET /prompts/facets: it returns
 * ONLY values actually present in PUBLISHED prompts, with correct
 * counts, ordered count-descending then value-alphabetically on
 * ties. Draft prompts never contribute, and values no published
 * prompt uses (e.g. unboxing here) simply do not appear. The
 * Supabase client is mocked at the auth-clients boundary with a
 * chainable builder that applies the .eq('status','published')
 * filter the route sets, so the test exercises the route's own
 * filtering and tallying — not just the contracts schema.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { signSessionToken } from "@fbuploadpro/contracts";
import { GET as facets } from "@/app/api/tenant/[subdomain]/prompts/facets/route";
import * as authModule from "@/lib/auth/clients";

const TEST_SECRET = "test-session-secret-for-prompt-facets-tests-000000";
const USER_ID = "11111111-1111-4111-a111-111111111111";
const SUBDOMAIN = "acme";

function row(
  id: string,
  overrides: Record<string, string>,
) {
  return {
    id,
    slug: `prompt-${id.slice(-2)}`,
    title: `Prompt ${id.slice(-2)}`,
    short_description: "Description.",
    master_prompt: "Master prompt.",
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
    ...overrides,
  };
}

const ALL_ROWS = [
  row("00000000-0000-4000-8000-000000000001", {}),
  row("00000000-0000-4000-8000-000000000002", {}),
  row("00000000-0000-4000-8000-000000000003", {
    category: "comedy",
    tool: "veo3",
    language: "ur",
    video_length_bucket: "15_30s",
  }),
  row("00000000-0000-4000-8000-000000000004", {
    category: "tutorial",
    tool: "google_flow",
    language: "hi",
    video_length_bucket: "under_15s",
  }),
  // Draft: same values as the first two rows — if it leaked in,
  // animals / dola_ai / en / 1min_plus would count 3, not 2.
  row("00000000-0000-4000-8000-000000000005", { status: "draft" }),
];

/** Chainable builder applying .eq() filters, then .range(). */
function makeClient(rows: ReturnType<typeof row>[]) {
  const eqCalls: { column: string; value: unknown }[] = [];
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    eq: vi.fn((column: string, value: unknown) => {
      eqCalls.push({ column, value });
      return builder;
    }),
    range: vi.fn(async () => {
      const filtered = rows.filter((r) =>
        eqCalls.every(
          ({ column, value }) =>
            (r as Record<string, unknown>)[column] === value,
        ),
      );
      return { data: filtered, error: null };
    }),
  });
  return {
    from: vi.fn(() => ({
      select: vi.fn(() => builder),
    })),
  };
}

describe("GET /api/tenant/[subdomain]/prompts/facets", () => {
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

  async function callFacets(clientRows = ALL_ROWS, cookie = sessionCookie) {
    const client = makeClient(clientRows);
    vi.spyOn(authModule, "getSupabaseAdminClient").mockReturnValue(
      client as never,
    );
    const req = new NextRequest(
      `http://localhost:3000/api/tenant/${SUBDOMAIN}/prompts/facets`,
      { headers: { cookie } },
    );
    const res = await facets(req, {
      params: Promise.resolve({ subdomain: SUBDOMAIN }),
    });
    return { res, body: (await res.json()) as Record<string, unknown> };
  }

  it("returns only values present in published prompts, with correct counts and ordering", async () => {
    const { res, body } = await callFacets();
    expect(res.status).toBe(200);
    // Count desc, then value alphabetically on ties.
    expect(body.category).toEqual([
      { value: "animals", count: 2 },
      { value: "comedy", count: 1 },
      { value: "tutorial", count: 1 },
    ]);
    expect(body.tool).toEqual([
      { value: "dola_ai", count: 2 },
      { value: "google_flow", count: 1 },
      { value: "veo3", count: 1 },
    ]);
    expect(body.language).toEqual([
      { value: "en", count: 2 },
      { value: "hi", count: 1 },
      { value: "ur", count: 1 },
    ]);
    expect(body.length).toEqual([
      { value: "1min_plus", count: 2 },
      { value: "15_30s", count: 1 },
      { value: "under_15s", count: 1 },
    ]);
    // Values no published prompt uses never appear.
    const categories = (body.category as { value: string }[]).map(
      (f) => f.value,
    );
    expect(categories).not.toContain("unboxing");
    expect(categories).not.toContain("cinematic");
  });

  it("returns empty facet lists when no prompt is published", async () => {
    const { res, body } = await callFacets([]);
    expect(res.status).toBe(200);
    expect(body).toEqual({
      category: [],
      tool: [],
      language: [],
      length: [],
    });
  });

  it("rejects unauthenticated requests", async () => {
    const { res } = await callFacets(ALL_ROWS, "");
    expect(res.status).toBe(401);
  });
});
