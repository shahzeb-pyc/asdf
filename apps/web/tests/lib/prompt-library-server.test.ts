/**
 * @file prompt-library-server.test.ts
 * @description Server-layer rules for the Prompt Library: the admin
 * gate (only role === 'admin' may write — a non-admin gets a 403
 * response from requirePromptAdmin), R2 key prefix validation, the
 * merged-row cross-field invariants for PATCH, and slug derivation.
 * Full HTTP route tests are not run here (no live database in unit
 * tests); these are the rules the routes enforce.
 */

import { describe, it, expect } from "vitest";

import {
  isPromptAdmin,
  mainPromptMedia,
  requirePromptAdmin,
  slugifyPromptTitle,
  sortPromptMediaForDetail,
  validateMergedPrompt,
} from "@/lib/server/prompt-library";
import { isPromptLibraryStorageKey } from "@fbuploadpro/contracts";

describe("prompt library server rules", () => {
  it("only admins pass the write gate", () => {
    expect(isPromptAdmin("admin")).toBe(true);
    expect(isPromptAdmin("user")).toBe(false);
    expect(isPromptAdmin("seller")).toBe(false);
    expect(isPromptAdmin(undefined)).toBe(false);
    expect(requirePromptAdmin("admin")).toBeNull();
    expect(requirePromptAdmin("user")?.status).toBe(403);
  });

  it("rejects R2 keys outside prompts/", () => {
    expect(isPromptLibraryStorageKey("prompts/abc/preview.mp4")).toBe(true);
    expect(isPromptLibraryStorageKey("users/abc/preview.mp4")).toBe(false);
  });

  it("rejects a merged PATCH that breaks format/aspect", () => {
    expect(
      validateMergedPrompt({
        format: "vertical_reel",
        aspectRatio: "16:9",
      }),
    ).not.toBeNull();
    expect(
      validateMergedPrompt({
        format: "horizontal_video",
        aspectRatio: "16:9",
      }),
    ).toBeNull();
  });

  it("picks the main media for a card and orders the detail gallery main-first", () => {
    const media = [
      {
        id: "00000000-0000-4000-8000-000000000010",
        prompt_id: "00000000-0000-4000-8000-000000000001",
        position: 2,
        media_type: "image" as const,
        storage_key: "prompts/abc/shot-2.jpg",
        poster_key: null,
        duration_seconds: null,
        is_main: false,
        created_at: "2026-10-28T00:00:00.000Z",
      },
      {
        id: "00000000-0000-4000-8000-000000000011",
        prompt_id: "00000000-0000-4000-8000-000000000001",
        position: 1,
        media_type: "video" as const,
        storage_key: "prompts/abc/preview.mp4",
        poster_key: "prompts/abc/poster.jpg",
        duration_seconds: 30,
        is_main: true,
        created_at: "2026-10-28T00:00:00.000Z",
      },
    ];
    expect(mainPromptMedia(media)?.id).toBe(
      "00000000-0000-4000-8000-000000000011",
    );
    expect(sortPromptMediaForDetail(media).map((row) => row.position)).toEqual([
      1, 2,
    ]);
    // Main first even when it is not position 1.
    const mainLast = media.map((row) =>
      row.position === 2 ? { ...row, is_main: true } : { ...row, is_main: false },
    );
    expect(sortPromptMediaForDetail(mainLast)[0].position).toBe(2);
  });

  it("derives a clean slug from a title", () => {
    expect(slugifyPromptTitle("Puppy First Bath!")).toBe("puppy-first-bath");
    expect(slugifyPromptTitle("  Rainy   Neon Street ")).toBe(
      "rainy-neon-street",
    );
  });
});
