/**
 * @file prompt-library-copy.test.ts
 * @description Route-level tests for POST
 * /api/tenant/[subdomain]/prompts/[slug]/copy: success increments
 * via the increment_prompt_copy RPC only and returns the new
 * count, unknown slug 404, draft 404, RPC error 500, and — the
 * key invariant — the route never writes copied_count directly
 * (asserted from the mocked client's recorded calls: no insert or
 * update payload anywhere carries copied_count). Supabase is
 * mocked at the auth-clients boundary with an in-memory store.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST as copyPrompt } from "@/app/api/tenant/[subdomain]/prompts/[slug]/copy/route";
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

describe("POST /api/tenant/[subdomain]/prompts/[slug]/copy", () => {
  let userCookie: string;

  beforeEach(async () => {
    vi.restoreAllMocks();
    process.env.SESSION_SECRET = TEST_SECRET;
    process.env.R2_PUBLIC_URL = "https://media.example.com";
    userCookie = await sessionCookieFor("user");
  });

  async function callCopy(
    slug: string,
    store: Store = basePromptStore(),
    cookie = userCookie,
  ) {
    const client = makeClient(store);
    vi.spyOn(authModule, "getSupabaseAdminClient").mockReturnValue(
      client as never,
    );
    const req = new NextRequest(
      `http://localhost:3000/api/tenant/${SUBDOMAIN}/prompts/${slug}/copy`,
      { method: "POST", headers: { cookie } },
    );
    const res = await copyPrompt(req, {
      params: Promise.resolve({ subdomain: SUBDOMAIN, slug }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    return { res, body, store };
  }

  function assertRpcOnly(store: Store, promptId: string) {
    const rpcCalls = store.calls.filter((call) => call.op === "rpc");
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].table).toBe("increment_prompt_copy");
    expect(rpcCalls[0].payload).toEqual({
      p_prompt_id: promptId,
      p_user_id: USER_ID,
    });
    // No direct write of the counter anywhere: no insert/update/
    // upsert payload carries copied_count, and no update touches
    // the prompts table at all.
    for (const call of store.calls) {
      if (
        call.op === "insert" ||
        call.op === "update" ||
        call.op === "upsert"
      ) {
        expect(call.payload).not.toHaveProperty("copied_count");
      }
      if (call.op === "update") {
        expect(call.table).not.toBe("prompt_library_prompts");
      }
    }
  }

  it("increments via RPC and returns the new count", async () => {
    const store = basePromptStore();
    store.rpcCount = 13;
    const { res, body } = await callCopy("puppy-first-bath", store);
    expect(res.status).toBe(200);
    expect(body).toEqual({ slug: "puppy-first-bath", copiedCount: 13 });
    assertRpcOnly(store, "00000000-0000-4000-8000-000000000001");
    // The RPC owns the counter: the stored row itself is untouched
    // by the route (the RPC would change it in the real database).
    expect(
      store.prompts.find(
        (p) => p.id === "00000000-0000-4000-8000-000000000001",
      )!.copied_count,
    ).toBe(12);
  });

  it("returns 404 for an unknown slug and calls no RPC", async () => {
    const store = basePromptStore();
    const { res, body } = await callCopy("no-such-prompt", store);
    expect(res.status).toBe(404);
    expect(body.error).toBe("NOT_FOUND");
    expect(store.calls.filter((call) => call.op === "rpc")).toHaveLength(0);
  });

  it("returns 404 for a draft and calls no RPC", async () => {
    const store = basePromptStore();
    const { res } = await callCopy("draft-prompt", store);
    expect(res.status).toBe(404);
    expect(store.calls.filter((call) => call.op === "rpc")).toHaveLength(0);
  });

  it("returns 401 unauthenticated and 503 without an admin client", async () => {
    const { res } = await callCopy("puppy-first-bath", basePromptStore(), "");
    expect(res.status).toBe(401);
    vi.spyOn(authModule, "getSupabaseAdminClient").mockReturnValue(
      null as never,
    );
    const req = new NextRequest(
      `http://localhost:3000/api/tenant/${SUBDOMAIN}/prompts/puppy-first-bath/copy`,
      { method: "POST", headers: { cookie: userCookie } },
    );
    const noClient = await copyPrompt(req, {
      params: Promise.resolve({ subdomain: SUBDOMAIN, slug: "puppy-first-bath" }),
    });
    expect(noClient.status).toBe(503);
  });

  it("returns 500 when the RPC fails", async () => {
    const store = basePromptStore();
    store.fail["rpc:increment_prompt_copy"] = new Error("rpc down");
    const { res, body } = await callCopy("puppy-first-bath", store);
    expect(res.status).toBe(500);
    expect(body.error).toBe("INTERNAL_ERROR");
  });

  it("returns 500 when the prompt lookup fails", async () => {
    const store = basePromptStore();
    store.fail["prompt_library_prompts:maybeSingle"] = new Error("db down");
    const { res } = await callCopy("puppy-first-bath", store);
    expect(res.status).toBe(500);
  });
});
