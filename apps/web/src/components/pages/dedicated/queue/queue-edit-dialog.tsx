'use client';

/**
 * Caption-only edit dialogue for a queued post. Only the caption is
 * editable here: scheduled-time editing is deliberately not surfaced
 * (publisher-driven posts carry no stored time; estimates are
 * derived). The server PATCH still caps captions at 5000 characters —
 * a longer existing caption is shown in full and never truncated, and
 * a save that exceeds the cap surfaces as an error toast.
 */
import * as React from 'react';

import { Button } from '@/components/shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/shared/ui/dialog';
import { Textarea } from '@/components/shared/ui/textarea';
import type { QueueItem } from '@/lib/api/schemas/queue';

export interface QueueEditDialogProps {
  item: QueueItem | null;
  isSaving: boolean;
  onClose: () => void;
  onSave: (caption: string) => Promise<void>;
}

export function QueueEditDialog({
  item,
  isSaving,
  onClose,
  onSave,
}: Readonly<QueueEditDialogProps>) {
  const [caption, setCaption] = React.useState('');

  React.useEffect(() => {
    if (item) setCaption(item.caption);
  }, [item]);

  if (!item) return null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent data-testid="queue-edit-dialog" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit caption</DialogTitle>
          <DialogDescription>
            Only the caption changes. The post keeps its place in the queue and its
            estimated posting time updates automatically.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          data-testid="queue-edit-caption"
          aria-label="Caption"
          value={caption}
          onChange={(event) => setCaption(event.target.value)}
          rows={6}
          disabled={isSaving}
        />
        <DialogFooter>
          <Button type="button" variant="outline" disabled={isSaving} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            data-testid="queue-edit-save-btn"
            disabled={isSaving}
            onClick={() => {
              void onSave(caption);
            }}
          >
            {isSaving ? 'Saving...' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
