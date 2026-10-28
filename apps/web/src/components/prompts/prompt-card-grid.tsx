"use client";

import React from "react";
import Image from "next/image";
import { HeartIcon, PauseIcon, PlayIcon } from "lucide-react";

import {
  PromptFormatLabels,
  promptCategoryLabel,
  promptLanguageLabel,
  promptLengthDisplay,
  promptToolLabel,
  type PromptListItem,
} from "@fbuploadpro/contracts";

/**
 * Prompt cards grid — B design, real catalogue data.
 *
 * Uniform card size with a fixed preview height (h-60): preview
 * media is centred with object-cover. Preview media is the prompt's
 * real R2 preview (image, or a video with a poster) — never mock
 * media, never hotlinked. Hovering a preview plays its video
 * muted; leaving stops it. Tapping the play control plays/pauses
 * without opening the detail section. Cards lift slightly and gain
 * a thin gold border on hover (tokens only).
 *
 * Clicking a card (anywhere except the play control and the
 * favourite heart) opens the dedicated section for that prompt.
 * The heart persists through the API (the page owns the toggle and
 * reverts on failure); a tap never opens the detail section.
 * Cards carry NO master prompt text and NO how-to steps — those
 * live only in the dedicated section. Copied counts are real
 * counts from the API, incremented only by the copy endpoint.
 */
export type PromptCardGridProps = {
  items: readonly PromptListItem[];
  onSelect: (slug: string) => void;
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

export function PromptCardGrid({
  items,
  onSelect,
  onToggleFavourite,
}: PromptCardGridProps) {
  const [playing, setPlaying] = React.useState<ReadonlySet<string>>(
    new Set(),
  );
  const videoRefs = React.useRef<Record<string, HTMLVideoElement | null>>({});

  const setPlayingState = (slug: string, value: boolean) => {
    setPlaying((previous) => {
      const next = new Set(previous);
      if (value) {
        next.add(slug);
      } else {
        next.delete(slug);
      }
      return next;
    });
  };

  const playVideo = (item: PromptListItem) => {
    const video = videoRefs.current[item.slug];
    if (video) {
      const result = video.play() as unknown as
        | { catch: (handler: () => void) => void }
        | undefined;
      result?.catch(() => {
        /* Preview playback is best-effort. */
      });
      setPlayingState(item.slug, true);
    }
  };

  const pauseVideo = (item: PromptListItem) => {
    const video = videoRefs.current[item.slug];
    if (video) {
      video.pause();
      video.currentTime = 0;
    }
    setPlayingState(item.slug, false);
  };

  return (
    <section
      data-testid="prompt-card-grid"
      aria-label="Prompt cards"
      className="bg-canvas px-4 pb-12 sm:px-6 sm:pb-16"
    >
      <div className="mx-auto grid w-full grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {items.map((item) => {
          const isFavourite = item.isFavourite;
          const isPlaying = playing.has(item.slug);
          const isVideo = item.previewMediaType === "video";
          return (
            <article
              key={item.slug}
              data-testid="prompt-card"
              onClick={() => onSelect(item.slug)}
              className="cursor-pointer overflow-hidden rounded-2xl border border-line bg-panel shadow-card transition hover:-translate-y-1 hover:border-brand-gold hover:shadow-elevated"
            >
              <div
                data-testid="prompt-card-preview"
                className="relative h-60 overflow-hidden"
                onMouseEnter={() => {
                  if (isVideo) playVideo(item);
                }}
                onMouseLeave={() => {
                  if (isVideo) pauseVideo(item);
                }}
              >
                {isVideo ? (
                  <video
                    ref={(element) => {
                      videoRefs.current[item.slug] = element;
                    }}
                    data-testid="prompt-card-video"
                    src={item.previewUrl}
                    poster={item.previewPosterUrl ?? undefined}
                    muted
                    loop
                    playsInline
                    preload="metadata"
                    className="h-full w-full object-cover object-center"
                  />
                ) : (
                  <Image
                    data-testid="prompt-card-image"
                    src={item.previewUrl}
                    alt=""
                    fill
                    unoptimized
                    sizes="(max-width: 768px) 100vw, (max-width: 1280px) 50vw, 25vw"
                    className="object-cover object-center"
                  />
                )}
                {isVideo ? (
                  <button
                    type="button"
                    data-testid="prompt-card-play"
                    aria-label={
                      isPlaying
                        ? `Pause preview for ${item.title}`
                        : `Play preview for ${item.title}`
                    }
                    onClick={(event) => {
                      event.stopPropagation();
                      if (isPlaying) {
                        pauseVideo(item);
                      } else {
                        playVideo(item);
                      }
                    }}
                    className="absolute left-1/2 top-1/2 flex size-12 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-neutral-black/75 text-neutral-white"
                  >
                    {isPlaying ? (
                      <PauseIcon aria-hidden className="size-6" />
                    ) : (
                      <PlayIcon aria-hidden className="size-6" />
                    )}
                  </button>
                ) : null}
                <button
                  type="button"
                  data-testid="prompt-card-favourite"
                  aria-label={
                    isFavourite ? `Saved ${item.title}` : `Save ${item.title}`
                  }
                  aria-pressed={isFavourite}
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleFavourite(item.slug, isFavourite);
                  }}
                  className="absolute right-2 top-2 flex size-9 items-center justify-center rounded-full bg-neutral-black/75 text-neutral-white"
                >
                  <HeartIcon
                    aria-hidden
                    className={
                      isFavourite ? "size-5 text-brand-gold" : "size-5"
                    }
                    fill={isFavourite ? "currentColor" : "none"}
                  />
                </button>
                <span className="absolute bottom-2 right-2 rounded-sm bg-neutral-black/75 px-2 py-1 text-xs font-medium text-neutral-white">
                  {promptLengthDisplay(item.exactDurationSeconds, item.length)}
                </span>
              </div>
              <div className="p-4">
                <h3 className="text-lg font-bold leading-snug text-ink">
                  {item.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-sub">
                  {item.shortDescription}
                </p>
                <p className="mt-3 text-sm text-ink-sub">
                  <span className="font-semibold text-ink">
                    {promptToolLabel(item.tool)}
                  </span>
                  {` · ${promptCategoryLabel(item.category)} · ${promptLanguageLabel(item.language)} · ${promptLengthDisplay(item.exactDurationSeconds, item.length)} · ${PromptFormatLabels[item.format]}`}
                </p>
                <div
                  data-testid="prompt-card-footer"
                  className="mt-3 flex items-center justify-between gap-2 border-t border-line pt-3 text-sm text-ink-sub"
                >
                  <span
                    data-testid="prompt-card-copied"
                    className="min-w-0 truncate"
                  >
                    {`Copied ${item.copiedCount} times`}
                  </span>
                  <span
                    data-testid="prompt-card-added"
                    className="shrink-0 whitespace-nowrap"
                  >
                    {`Added ${formatDateAdded(item.createdAt)}`}
                  </span>
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
