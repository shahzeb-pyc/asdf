'use client';

/**
 * Schedule-timezone change flow (spec 134 §3.3) on the shared/ui
 * Dialog: two steps preserved from spec 106 — choose a zone, then
 * review its impact before applying. The value changes only through
 * the user's explicit confirm here (spec 134 Q2: the rebuild itself
 * changes no destination's timezone value).
 *
 * Second-replacer note (plan §8 / OD131-6): the legacy
 * `schedule-timezone-modal.tsx` at the dedicated/ root is ALSO consumed
 * by posting-times tab.tsx (spec 131's surface), which still imports it on
 * current main. That file therefore stays for its one remaining
 * consumer; this posting-times copy is the rebuilt flow for this
 * surface, and the settings surface's own rebuild is the named deleter
 * of the legacy file. Remaining legacy consumer count: 1
 * (posting-times tab.tsx).
 */
import * as React from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/shared/ui/dialog';
import { TimezoneReviewStep } from './timezone-review-step';
import { TimezoneSelectorStep } from './timezone-selector-step';

export interface ScheduleTimezoneModalProps {
  isOpen: boolean;
  activeTimezone: string;
  slotsCount: number;
  queuedCount: number;
  onClose: () => void;
  onConfirmTimezone: (newTimezone: string) => Promise<void>;
}

export function ScheduleTimezoneModal({
  isOpen,
  activeTimezone,
  slotsCount,
  queuedCount,
  onClose,
  onConfirmTimezone,
}: Readonly<ScheduleTimezoneModalProps>) {
  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {/* Mounted only while open, so every open starts the flow fresh
          at step 1 with the active zone selected. */}
      {isOpen ? (
        <ScheduleTimezoneFlow
          activeTimezone={activeTimezone}
          slotsCount={slotsCount}
          queuedCount={queuedCount}
          onClose={onClose}
          onConfirmTimezone={onConfirmTimezone}
        />
      ) : null}
    </Dialog>
  );
}

function ScheduleTimezoneFlow({
  activeTimezone,
  slotsCount,
  queuedCount,
  onClose,
  onConfirmTimezone,
}: Readonly<Omit<ScheduleTimezoneModalProps, 'isOpen'>>) {
  const [step, setStep] = React.useState<1 | 2>(1);
  const [searchQuery, setSearchQuery] = React.useState('');
  const [selectedTimezone, setSelectedTimezone] = React.useState(activeTimezone);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  const handleConfirm = async () => {
    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      await onConfirmTimezone(selectedTimezone);
      onClose();
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? err.message
          : "Couldn't update the schedule timezone. Please try again."
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <DialogContent data-testid="schedule-timezone-modal" className="sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>
          {step === 1 ? 'Change timezone' : 'Review timezone change'}
        </DialogTitle>
        <DialogDescription>
          {step === 1
            ? "Choose the timezone this page's posting times and queue use."
            : 'Verify how this change affects your recurring posting times and pending posts.'}
        </DialogDescription>
      </DialogHeader>

      {step === 1 ? (
        <TimezoneSelectorStep
          activeTimezone={activeTimezone}
          selectedTimezone={selectedTimezone}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onSelectTimezone={setSelectedTimezone}
          onCancel={onClose}
          onProceed={() => setStep(2)}
        />
      ) : (
        <TimezoneReviewStep
          activeTimezone={activeTimezone}
          selectedTimezone={selectedTimezone}
          slotsCount={slotsCount}
          queuedCount={queuedCount}
          isSubmitting={isSubmitting}
          errorMessage={errorMessage}
          onBack={() => setStep(1)}
          onConfirm={() => void handleConfirm()}
        />
      )}
    </DialogContent>
  );
}
