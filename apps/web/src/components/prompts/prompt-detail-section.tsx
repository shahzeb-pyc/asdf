"use client";

import React from "react";
import Image from "next/image";
import { DownloadIcon, HeartIcon, TriangleAlertIcon } from "lucide-react";

import { Alert } from "@/components/shared/ui/alert";
import { Button } from "@/components/shared/ui/button";
import { Tag } from "@/components/shared/ui/tag";

import {
  PromptFormatLabels,
  promptCategoryLabel,
  promptLanguageLabel,
  promptLengthDisplay,
  promptToolLabel,
  type PromptDetail,
  type PromptMedia,
} from "@fbuploadpro/contracts";

/**
 * Dedicated section for one prompt — revised layout, approved
 * 2026-10-28 ("yes build"): narrow centred column (detail only,
 * ~720px), preview in full with contain (never cover/crop),
 * meta as pills, guide link as a card, readable scrollable
 * prompt field with Copy top-right in the field header
 * (Option A), no per-prompt how-to section. The single
 * "How to use a master prompt" guide replaces per-prompt
 * how-to and is linked from here; how-to steps still exist
 * in the API/database but are deliberately NOT rendered here
 * (UI-only removal, backend untouched).
 *
 * Preview media are the prompt's reference: each media item
 * shown (the large preview and every gallery thumbnail) carries
 * a Download button, so a user can download the reference and
 * upload it to ChatGPT when asked, or reply USE YOUR DESIGN.
 *
 * Download: a plain `download` attribute is ignored for
 * cross-origin R2 public URLs (media.vinsmokemedia.online), so
 * the button first tries fetch-to-blob (which saves the file
 * under its real name) and falls back to opening the URL in a
 * new tab if the fetch is blocked (e.g. CORS) — the user can
 * still save the file from there. No silent failure: the
 * fallback always gives the user the file itself.
 *
 * Media gallery (detail only, never on the card): the main media
 * shows large, and the OTHER media appear as thumbnails below it.
 * Tapping a thumbnail swaps it into the large preview (video plays
 * with controls, image shows full). The API returns media main
 * first, then by position, so the first item is always the main.
 *
 * Copy prompt: copies the master prompt to the clipboard first;
 * only then calls the copy endpoint, which increments the real
 * copied count via the server RPC. If either step fails, the count
 * is not updated and the failure is shown plainly — no silent
 * success, no made-up count. The prompt text is rendered verbatim
 * and in full — never truncated, shortened, or paraphrased.
 */
export type PromptDetailSectionProps = {
  detail: PromptDetail;
  subdomain: string;
  onBack: () => void;
  onCopied: (slug: string, copiedCount: number) => void;
  onToggleFavourite: (slug: string, currentlyFavourite: boolean) => void;
};

function formatDateAdded(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function downloadFileName(item: PromptMedia): string {
  const last = item.storageKey.split("/").filter(Boolean).pop();
  return last ?? `prompt-media-${item.position}`;
}

async function downloadMedia(item: PromptMedia): Promise<void> {
  try {
    const response = await fetch(item.url);
    if (!response.ok) throw new Error("Download failed");
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = downloadFileName(item);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(objectUrl);
  } catch {
    // Cross-origin fetch blocked (e.g. CORS): open the file itself
    // in a new tab so the user can still save it from there.
    window.open(item.url, "_blank", "noopener");
  }
}

export function PromptDetailSection({
  detail,
  subdomain,
  onBack,
  onCopied,
  onToggleFavourite,
}: PromptDetailSectionProps) {
  const [copyState, setCopyState] = React.useState<
    "idle" | "copied" | "error"
  >("idle");
  const [selectedMediaId, setSelectedMediaId] = React.useState<string | null>(
    null,
  );
  // The selected item, falling back to the main (first) item whenever
  // the detail changes to a prompt that has no such media id.
  const selectedMedia =
    detail.media.find((item) => item.id === selectedMediaId) ??
    detail.media[0];

  const handleCopy = async () => {
    setCopyState("idle");
    try {
      await navigator.clipboard.writeText(detail.masterPrompt);
    } catch {
      setCopyState("error");
      return;
    }
    try {
      const response = await fetch(
        `/api/tenant/${subdomain}/prompts/${detail.slug}/copy`,
        { method: "POST" },
      );
      if (!response.ok) {
        setCopyState("error");
        return;
      }
      const body = (await response.json()) as { copiedCount: number };
      onCopied(detail.slug, body.copiedCount);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  };

  return (
    <section
      data-testid="prompt-detail"
      aria-label={`Details for ${detail.title}`}
      className="bg-canvas px-4 pb-12 sm:px-6 sm:pb-16"
    >
      {/* Narrow centred column, detail only — the library list page
          keeps its own width. Clear vertical spacing between every
          section below; nothing here stretches edge to edge. */}
      <div className="mx-auto w-full max-w-[720px]">
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            data-testid="prompt-detail-back"
            onClick={onBack}
            className="text-sm font-semibold text-brand-gold"
          >
            ← Back to prompts
          </button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="prompt-detail-favourite"
            aria-label={
              detail.isFavourite
                ? `Saved ${detail.title}`
                : `Save ${detail.title}`
            }
            aria-pressed={detail.isFavourite}
            onClick={() =>
              onToggleFavourite(detail.slug, detail.isFavourite)
            }
            className="rounded-full"
          >
            <HeartIcon
              aria-hidden
              className={
                detail.isFavourite ? "text-brand-gold" : undefined
              }
              fill={detail.isFavourite ? "currentColor" : "none"}
            />
            {detail.isFavourite ? "Saved" : "Save"}
          </Button>
        </div>
        {/* Preview card: the main media is shown in FULL with
            object-contain — never object-cover, never cropped into
            a banner. The capped frame + neutral background letterbox
            the media instead of slicing it; this is the reference
            image, so seeing all of it matters. Download sits below
            the preview in the card footer, clearly visible, not as
            a tiny overlay lost in a corner of the image. */}
        <div className="mt-6 rounded-2xl border border-line bg-panel p-3 sm:p-4">
          {selectedMedia.mediaType === "video" ? (
            <video
              key={selectedMedia.id}
              data-testid="prompt-detail-preview"
              data-media-id={selectedMedia.id}
              src={selectedMedia.url}
              poster={selectedMedia.posterUrl ?? undefined}
              controls
              muted
              playsInline
              className="max-h-[480px] w-full rounded-xl bg-subtle object-contain"
            />
          ) : (
            <div className="relative h-80 overflow-hidden rounded-xl bg-subtle sm:h-[420px]">
              <Image
                key={selectedMedia.id}
                data-testid="prompt-detail-preview"
                data-media-id={selectedMedia.id}
                src={selectedMedia.url}
                alt=""
                fill
                unoptimized
                sizes="(max-width: 720px) 100vw, 720px"
                className="object-contain"
              />
            </div>
          )}
          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="text-xs text-ink-sub">
              Reference image · download it to use in ChatGPT
            </span>
            <Button
              type="button"
              size="sm"
              data-testid="prompt-detail-download"
              data-media-id={selectedMedia.id}
              aria-label={`Download ${selectedMedia.mediaType} ${selectedMedia.position}`}
              onClick={() => void downloadMedia(selectedMedia)}
            >
              <DownloadIcon aria-hidden />
              Download
            </Button>
          </div>
        </div>
        {detail.media.length > 1 ? (
          <div
            data-testid="prompt-detail-gallery"
            className="mt-4 flex flex-wrap gap-3"
          >
            {detail.media.map((item) => {
              const selected = item.id === selectedMedia.id;
              const thumb = item.posterUrl ?? item.url;
              return (
                <div key={item.id} className="relative">
                  <button
                    type="button"
                    data-testid="prompt-detail-gallery-item"
                    data-media-id={item.id}
                    aria-pressed={selected}
                    aria-label={`Show ${item.mediaType} ${item.position}`}
                    onClick={() => setSelectedMediaId(item.id)}
                    className={
                      selected
                        ? "relative block h-20 w-28 overflow-hidden rounded-xl border-2 border-brand-gold bg-panel"
                        : "relative block h-20 w-28 overflow-hidden rounded-xl border border-line bg-panel"
                    }
                  >
                    <Image
                      src={thumb}
                      alt=""
                      fill
                      unoptimized
                      sizes="112px"
                      className="object-cover object-center"
                    />
                  </button>
                  <button
                    type="button"
                    data-testid="prompt-detail-gallery-download"
                    data-media-id={item.id}
                    aria-label={`Download ${item.mediaType} ${item.position}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      void downloadMedia(item);
                    }}
                    className="absolute bottom-1 right-1 flex size-7 items-center justify-center rounded-md bg-neutral-black/75 text-neutral-white"
                  >
                    <DownloadIcon aria-hidden className="size-4" />
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}
        <h2 className="mt-8 text-2xl font-bold leading-snug text-ink sm:text-3xl">
          {detail.title}
        </h2>
        {/* Meta as pills, not a grey dot-separated line: each value
            is readable at a glance. Length uses the existing
            promptLengthDisplay helper (exact when present, bucket
            fallback) — length logic is untouched. */}
        <div
          data-testid="prompt-detail-meta"
          className="mt-4 flex flex-wrap gap-2"
        >
          <Tag variant="outline">{promptToolLabel(detail.tool)}</Tag>
          <Tag variant="outline">
            {promptCategoryLabel(detail.category)}
          </Tag>
          <Tag variant="outline">
            {promptLanguageLabel(detail.language)}
          </Tag>
          <Tag
            variant="outline"
            className="border-brand-gold text-brand-gold"
          >
            {promptLengthDisplay(
              detail.exactDurationSeconds,
              detail.length,
            )}
          </Tag>
          <Tag variant="outline">
            {PromptFormatLabels[detail.format]}
          </Tag>
        </div>
        <p className="mt-4 text-sm text-ink-sub">
          <span>{`Copied ${detail.copiedCount} times`}</span>
          {` · Added ${formatDateAdded(detail.createdAt)}`}
        </p>
        <a
          data-testid="prompt-detail-guide-link"
          href={`/tenant/${subdomain}/prompts/guide`}
          className="mt-6 flex items-center justify-between gap-3 rounded-2xl border border-line bg-panel px-4 py-3"
        >
          <span className="text-sm text-ink">
            New here?{" "}
            <span className="font-semibold">
              How to use a master prompt
            </span>
          </span>
          <span aria-hidden className="font-semibold text-brand-gold">
            →
          </span>
        </a>
        <div
          data-testid="prompt-detail-master-prompt-field"
          className="mt-8 overflow-hidden rounded-2xl border border-line bg-panel"
        >
          <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
            <h3 className="text-lg font-bold text-ink">Master prompt</h3>
            <Button
              type="button"
              size="sm"
              data-testid="prompt-detail-copy"
              onClick={() => void handleCopy()}
            >
              {copyState === "copied" ? "Copied ✓" : "Copy prompt"}
            </Button>
          </div>
          <div
            data-testid="prompt-detail-master-prompt-text"
            className="max-h-80 overflow-y-auto whitespace-pre-wrap px-5 py-5 text-base leading-loose text-ink"
          >
            {detail.masterPrompt}
          </div>
          <p className="border-t border-line px-5 py-3 text-xs text-ink-sub">
            Scroll for the full prompt · Copy takes the entire prompt,
            not just what is visible
          </p>
        </div>
        {copyState === "error" ? (
          // Inline, as before (under the prompt field, where the
          // failure belongs) — but now a proper design-system error
          // note (destructive Alert: rose border + icon + text),
          // not plain grey text. Wording unchanged.
          <Alert
            variant="destructive"
            data-testid="prompt-detail-copy-error"
            className="mt-2"
          >
            <TriangleAlertIcon aria-hidden className="size-4 shrink-0" />
            <span>
              Copying failed. Please try again — the count was not changed.
            </span>
          </Alert>
        ) : null}
        {/* No per-prompt how-to section here, by design (Option A):
            the single guide linked above replaces it. detail.steps
            is still returned by the API and stored in the database;
            it is simply not rendered in this section. */}
      </div>
    </section>
  );
}
