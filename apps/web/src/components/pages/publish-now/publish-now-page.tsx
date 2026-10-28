'use client';

/**
 * Publish Now page.
 *
 * The page itself is deliberately thin: the account selector
 * dialogue opens automatically on first load (the approved entry
 * point), and closing it is never a dead end — the page always
 * offers a button to start a publish. After a finished run (Done),
 * the page returns to the same start button instead of
 * auto-reopening in a loop.
 */
import * as React from 'react';
import { Button } from '@/components/shared/ui/button';
import { PublishNowDialog } from './publish-now-dialog';

export function PublishNowPage({ subdomain }: Readonly<{ subdomain: string }>) {
  const [dialogOpen, setDialogOpen] = React.useState(true);
  const [hasFinishedRun, setHasFinishedRun] = React.useState(false);

  return (
    <div className="mx-auto w-full max-w-300 px-6 py-6">
      <h1 className="text-xl leading-heading font-bold tracking-h1 text-ink">
        Publish Now
      </h1>
      <p className="mt-2 max-w-160 text-body leading-body text-ink-sub">
        Publish one post directly to several Facebook pages at once.
        Nothing in this flow is saved — no queue, no post record —
        and pages you publish to here are not added to your Pages
        list unless you add them separately.
      </p>
      <div className="mt-6">
        <Button
          type="button"
          data-testid="publish-now-start-btn"
          onClick={() => setDialogOpen(true)}
        >
          {hasFinishedRun ? 'Start a new publish' : 'Publish Now'}
        </Button>
      </div>
      <PublishNowDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        subdomain={subdomain}
        onDone={() => {
          setDialogOpen(false);
          setHasFinishedRun(true);
        }}
      />
    </div>
  );
}
