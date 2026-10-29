'use client';

/**
 * Command palette host (spec 130 §5.6, PR-130-4) — the only part of
 * the palette that ships in the tenant frame's initial bundle: a
 * search-style header button (OD130-6, DECIDED: YES — label + ⌘K
 * hint) and the ⌘K / Ctrl+K listener. The palette itself (and the
 * Command primitive + cmdk behind it) loads via `next/dynamic` on
 * first open only — closed-by-default UI never weighs on the frame
 * (spec §6 duty 5; the bundle-analyzer excerpt in the PR proves the
 * split).
 *
 * The chord works from anywhere in the tenant frame, including from
 * text fields — ⌘K is a command chord, not a typed character
 * (matrix §30). Esc handling and focus return to this button (the
 * invoker) are the Dialog primitive's, inside the palette.
 */

import React, { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';

const CommandPalette = dynamic(
  () => import('./command-palette').then((mod) => mod.CommandPalette),
  { ssr: false }
);

export interface CommandPaletteHostProps {
  subdomain: string;
  useCleanPaths?: boolean | undefined;
}

export function CommandPaletteHost({
  subdomain,
  useCleanPaths = false,
}: Readonly<CommandPaletteHostProps>) {
  const [open, setOpen] = useState(false);
  // Once loaded, the palette stays mounted (its Dialog closed) so a
  // second open is instant and close animations/focus can complete.
  const [mounted, setMounted] = useState(false);
  // Esc must return focus to the invoking element (spec §5.6): the
  // palette is opened programmatically (button or chord), so the
  // host records the invoker at open time and restores it on close.
  const invokerRef = React.useRef<Element | null>(null);
  const wasOpenRef = React.useRef(false);

  const openPalette = () => {
    invokerRef.current = document.activeElement;
    setMounted(true);
    setOpen(true);
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (open) {
          setOpen(false);
        } else {
          openPalette();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open ]);

  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      return;
    }
    if (wasOpenRef.current) {
      wasOpenRef.current = false;
      const invoker = invokerRef.current;
      if (invoker instanceof HTMLElement) {
        // After the Dialog has closed (next frame), restore focus.
        requestAnimationFrame(() => invoker.focus());
      }
    }
  }, [open ]);

  return (
    <>
      <button
        type="button"
        data-testid="command-palette-trigger"
        aria-label="Search and commands (Control or Command plus K)"
        aria-keyshortcuts="Meta+K Control+K"
        onClick={openPalette}
        className="ml-auto flex h-control min-w-9 items-center gap-2 rounded-sm border border-line bg-panel px-3 text-body text-ink-dim outline-none transition-colors duration-base ease-standard hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link sm:min-w-48"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="shrink-0"
        >
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.3-4.3" />
        </svg>
        <span className="hidden flex-1 text-left sm:inline">Search…</span>
        <kbd aria-hidden="true" className="hidden shrink-0 text-metadata text-ink-dim sm:inline">
          ⌘K
        </kbd>
      </button>
      {mounted && (
        <CommandPalette
          subdomain={subdomain}
          useCleanPaths={useCleanPaths}
          open={open}
          onOpenChange={setOpen}
        />
      )}
    </>
  );
}
