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
  requirePromptAdmin,
  slugifyPromptTitle,
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

  it("rejects a merged PATCH that breaks format/aspect or drops a video poster", () => {
    expect(
      validateMergedPrompt({
        format: "vertical_reel",
        aspectRatio: "16:9",
      }),
    ).not.toBeNull();
    expect(
      validateMergedPrompt({
        format: "vertical_reel",
        aspectRatio: "9:16",
        previewMediaType: "video",
        previewPosterKey: null,
      }),
    ).not.toBeNull();
    expect(
      validateMergedPrompt({
        format: "horizontal_video",
        aspectRatio: "16:9",
        previewMediaType: "video",
        previewPosterKey: "prompts/abc/poster.jpg",
        previewStorageKey: "prompts/abc/preview.mp4",
      }),
    ).toBeNull();
  });

  it("derives a clean slug from a title", () => {
    expect(slugifyPromptTitle("Puppy First Bath!")).toBe("puppy-first-bath");
    expect(slugifyPromptTitle("  Rainy   Neon Street ")).toBe(
      "rainy-neon-street",
    );
  });
});
