'use client';

/**
 * Bulk Text: the fast path for many text posts.
 *
 * One post per line — the user types or pastes a list of texts,
 * the live count says how many posts that is, and one action
 * appends every line as its own text post block. Typing into
 * single blocks one at a time is too slow for that job, which is
 * why this exists alongside Bulk Post (media) rather than inside
 * it: Bulk Post stays media-only, Bulk Text stays text-only.
 */

import * as React from 'react';

import { Button } from '@/components/shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/shared/ui/dialog';
import { Textarea } from '@/components/shared/ui/textarea';

export interface BulkTextDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (texts: string[]) => void;
}

function toLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function BulkTextDialog({ open, onOpenChange, onAdd }: Readonly<BulkTextDialogProps>) {
  const [value, setValue] = React.useState('');

  React.useEffect(() => {
    if (open) setValue('');
  }, [open ]);

  const lines = React.useMemo(() => toLines(value), [value]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="bulk-text-dialog">
        <DialogHeader>
          <DialogTitle>Bulk Text</DialogTitle>
          <DialogDescription>
            One post per line — type or paste as many as you want, fast.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          data-testid="bulk-text-input"
          placeholder={'Morning motivation\nNew recipe video\nWeekend sale reminder'}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          className="min-h-32"
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-metadata text-ink-sub">
            {lines.length === 0
              ? 'No posts yet'
              : `${lines.length} post${lines.length === 1 ? '' : 's'}`}
          </span>
          <span className="flex gap-2">
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            <Button
              type="button"
              data-testid="bulk-text-add-btn"
              disabled={lines.length === 0}
              onClick={() => {
                onAdd(lines);
                onOpenChange(false);
              }}
            >
              {lines.length === 0 ? 'Add posts' : `Add posts (${lines.length})`}
            </Button>
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
