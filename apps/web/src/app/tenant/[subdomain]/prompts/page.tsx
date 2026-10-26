import type { Metadata } from 'next';
import React from 'react';
import { Card } from '@/components/shared/ui/card';

/** Title resolves through the tenant layout's `<Section> · <Workspace>` template (§3.3.4). */
export const metadata: Metadata = { title: 'Prompt Library' };

/**
 * Prompt Library placeholder. The full library (frontend, API, and
 * contracts) was removed; only the sidebar entry and this page remain.
 * This page fetches nothing, prefetches nothing, and calls no API —
 * it is a placeholder, not a stub for the old feature.
 */
export default function TenantPromptLibraryPage() {
  return (
    <div
      data-slot="prompt-library-placeholder"
      data-testid="prompt-library-placeholder"
      className="flex flex-col items-center justify-center px-6 py-12"
    >
      <Card className="w-full max-w-120 items-center gap-4 px-6 py-8 text-center">
        {/* Prompt Library Icon Container (same lightbulb as the sidebar entry) */}
        <div
          data-slot="prompt-library-placeholder-icon"
          data-testid="prompt-library-placeholder-icon"
          className="flex size-12 items-center justify-center rounded-md border border-line bg-active text-primary"
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M9 18h6" />
            <path d="M10 22h4" />
            <path d="M12 2a7 7 0 0 0-4 12c.7.6 1 1.4 1 2h6c0-.6.3-1.4 1-2a7 7 0 0 0-4-12z" />
          </svg>
        </div>

        {/* Title & Coming Soon Notice */}
        <div className="flex flex-col gap-1">
          <h1 className="text-xl leading-heading font-semibold text-ink">Prompt Library</h1>
          <p data-testid="prompt-library-coming-soon" className="max-w-96 text-body text-ink-sub">
            Coming soon.
          </p>
        </div>
      </Card>
    </div>
  );
}
