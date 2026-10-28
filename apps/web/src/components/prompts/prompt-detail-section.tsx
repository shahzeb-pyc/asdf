"use client";

import React from "react";
import Image from "next/image";
import { TriangleAlertIcon } from "lucide-react";

import { Alert } from "@/components/shared/ui/alert";

import {
  PromptFormatLabels,
  promptCategoryLabel,
  promptLanguageLabel,
  promptLengthDisplay,
  promptToolLabel,
  type PromptDetail,
} from "@fbuploadpro/contracts";

/**
 * Dedicated section for one prompt — the only place the master
 * prompt and how-to steps appear. The card itself never shows them.
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
 * success, no made-up count.
 */
export type PromptDetailSectionProps = {
  detail: PromptDetail;
  subdomain: string;
  onBack: () => void;
  onCopied: (slug: string, copiedCount: number) => void;
};

export function PromptDetailSection({
  detail,
  subdomain,
  onBack,
  onCopied,
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
      <div className="mx-auto w-full">
        <button
          type="button"
          data-testid="prompt-detail-back"
          onClick={onBack}
          className="text-sm font-semibold text-brand-gold"
        >
          ← Back to prompts
        </button>
        <h2 className="mt-4 text-3xl font-bold leading-tight text-ink">
          {detail.title}
        </h2>
        <p className="mt-2 text-sm text-ink-sub">
          <span className="font-semibold text-ink">
            {promptToolLabel(detail.tool)}
          </span>
          {` · ${promptCategoryLabel(detail.category)} · ${promptLanguageLabel(detail.language)} · ${promptLengthDisplay(detail.exactDurationSeconds, detail.length)} · ${PromptFormatLabels[detail.format]}`}
        </p>
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
            className="mt-6 h-60 w-full rounded-2xl border border-line bg-panel object-cover object-center"
          />
        ) : (
          <div className="relative mt-6 h-60 w-full overflow-hidden rounded-2xl border border-line bg-panel">
            <Image
              key={selectedMedia.id}
              data-testid="prompt-detail-preview"
              data-media-id={selectedMedia.id}
              src={selectedMedia.url}
              alt=""
              fill
              unoptimized
              sizes="100vw"
              className="object-cover object-center"
            />
          </div>
        )}
        {detail.media.length > 1 ? (
          <div
            data-testid="prompt-detail-gallery"
            className="mt-3 flex flex-wrap gap-3"
          >
            {detail.media.map((item) => {
              const selected = item.id === selectedMedia.id;
              const thumb = item.posterUrl ?? item.url;
              return (
                <button
                  key={item.id}
                  type="button"
                  data-testid="prompt-detail-gallery-item"
                  data-media-id={item.id}
                  aria-pressed={selected}
                  aria-label={`Show ${item.mediaType} ${item.position}`}
                  onClick={() => setSelectedMediaId(item.id)}
                  className={
                    selected
                      ? "relative h-20 w-28 overflow-hidden rounded-xl border-2 border-brand-gold bg-panel"
                      : "relative h-20 w-28 overflow-hidden rounded-xl border border-line bg-panel"
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
              );
            })}
          </div>
        ) : null}
        <h3 className="mt-8 text-xl font-bold text-ink">Master prompt</h3>
        <p className="mt-3 rounded-2xl border border-line bg-panel p-4 text-sm leading-relaxed text-ink">
          {detail.masterPrompt}
        </p>
        <button
          type="button"
          data-testid="prompt-detail-copy"
          onClick={() => void handleCopy()}
          className="mt-4 rounded-xl border border-brand-gold px-4 py-2 text-sm font-semibold text-brand-gold"
        >
          {copyState === "copied" ? "Copied ✓" : "Copy prompt"}
        </button>
        {copyState === "error" ? (
          // Inline, as before (under the Copy button, where the
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
        <p className="mt-3 text-sm text-ink-sub">
          {`Copied ${detail.copiedCount} times`}
        </p>
        <h3 className="mt-8 text-xl font-bold text-ink">
          How to make the video with it
        </h3>
        <ol className="mt-3 list-decimal space-y-2 pl-6 text-sm leading-relaxed text-ink-sub">
          {detail.steps.map((step) => (
            <li key={step.id}>
              {step.title ? (
                <span className="font-semibold text-ink">
                  {step.title}:{" "}
                </span>
              ) : null}
              {step.body}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
