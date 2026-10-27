'use client';

/**
 * Add/Edit posting-time form (spec 134 §3.3) on the spec 137 form
 * standard: shared/ui Dialog + Form primitives, react-hook-form + zod,
 * `onTouched` validation, a FormErrorSummary on submit failure with
 * focus-to-summary, inline messages under their fields, and user input
 * never cleared by a failed submit.
 *
 * Spec 112 #19 is fixed by construction: the orchestrator mounts this
 * dialog only while open and keys it by the slot being edited, so the
 * form initialises fresh from that slot on every open — the first open
 * after using Add shows the edited slot's own time, never a leaked Add
 * value (regression-tested in posting-time-form.test.tsx).
 */
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import { Button } from '@/components/shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/shared/ui/dialog';
import {
  Form,
  FormControl,
  FormDescription,
  FormErrorSummary,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  type FormErrorSummaryEntry,
} from '@/components/shared/ui/form';
import { Input } from '@/components/shared/ui/input';
import { cn } from '@/lib/utils';
import type { PageSlotSummary } from '../tab-dashboard';
import {
  ALL_POST_FORMATS,
  formatSlotDisplay,
  getPostingTimeFormInitialState,
} from './posting-time-utils';

export const postingTimeFormSchema = z.object({
  timeInput: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Enter a valid time (for example, 09:00 or 17:30).'),
  selectedFormats: z.array(z.string()).min(1, 'Choose at least one post type.'),
});

export type PostingTimeFormValues = z.infer<typeof postingTimeFormSchema>;

export { getPostingTimeFormInitialState };

export interface PostingTimeFormProps {
  activeTimezone: string;
  slotToEdit?: PageSlotSummary | null;
  onClose: () => void;
  onSave: (data: {
    slotTime: string;
    timezone: string;
    allowedFormats: string[];
  }) => Promise<void>;
}

export function PostingTimeForm({
  activeTimezone,
  slotToEdit,
  onClose,
  onSave,
}: Readonly<PostingTimeFormProps>) {
  const isEditing = Boolean(slotToEdit);
  const [submitAttempted, setSubmitAttempted] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);

  const form = useForm<PostingTimeFormValues>({
    resolver: zodResolver(postingTimeFormSchema),
    mode: 'onTouched',
    reValidateMode: 'onSubmit',
    shouldFocusError: false,
    defaultValues: (() => {
      const initial = getPostingTimeFormInitialState(slotToEdit);
      return { timeInput: initial.timeInput, selectedFormats: initial.selectedFormats };
    })(),
  });

  const isSubmitting = form.formState.isSubmitting;
  const timeInput = form.watch('timeInput');
  const selectedFormats = form.watch('selectedFormats');
  const preview = formatSlotDisplay(/^\d{2}:\d{2}$/.test(timeInput) ? timeInput : '09:00');

  const toggleFormat = (formatId: string) => {
    const next = selectedFormats.includes(formatId)
      ? selectedFormats.filter((f) => f !== formatId)
      : [...selectedFormats, formatId];
    form.setValue('selectedFormats', next, { shouldValidate: submitAttempted, shouldTouch: true });
  };

  const handleSelectAll = () => {
    form.setValue('selectedFormats', ALL_POST_FORMATS.map((f) => f.id), {
      shouldValidate: submitAttempted,
      shouldTouch: true,
    });
  };

  const handleValidSubmit = async (values: PostingTimeFormValues) => {
    setServerError(null);
    try {
      await onSave({
        slotTime: values.timeInput,
        timezone: activeTimezone,
        allowedFormats: values.selectedFormats,
      });
      onClose();
    } catch (err) {
      setServerError(
        err instanceof Error ? err.message : "Couldn't save this posting time. Please try again."
      );
    }
  };

  const handleInvalidSubmit = () => {
    setSubmitAttempted(true);
    setServerError(null);
  };

  const timeError = form.formState.errors.timeInput?.message
    ? String(form.formState.errors.timeInput.message)
    : null;
  const formatsError = form.formState.errors.selectedFormats?.message
    ? String(form.formState.errors.selectedFormats.message)
    : null;
  const summaryErrors: FormErrorSummaryEntry[] =
    submitAttempted || serverError
      ? [
          ...(timeError ? [{ fieldId: 'posting-time-input', message: timeError }] : []),
          ...(formatsError ? [{ fieldId: 'posting-time-formats', message: formatsError }] : []),
          ...(serverError ? [{ message: serverError }] : []),
        ]
      : [];

  let submitButtonText = 'Save Posting Time';
  if (isSubmitting) {
    submitButtonText = 'Saving...';
  } else if (isEditing) {
    submitButtonText = 'Update Posting Time';
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent data-testid="add-posting-time-modal" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEditing ? 'Edit Posting Time' : 'Add Daily Posting Time'}</DialogTitle>
          <DialogDescription>
            Set the time and choose which post types go out at this time.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form
            noValidate
            className="flex flex-col gap-4"
            onSubmit={form.handleSubmit(handleValidSubmit, handleInvalidSubmit)}
          >
            {summaryErrors.length > 0 ? <FormErrorSummary errors={summaryErrors} /> : null}

            <FormField
              control={form.control}
              name="timeInput"
              render={({ field }) => (
                <FormItem id="posting-time-input">
                  <FormLabel>Time of day</FormLabel>
                  <FormControl>
                    <Input
                      data-testid="posting-time-input"
                      type="time"
                      required
                      className="w-44"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    Posts will go out at {preview.time12} {preview.ampm}.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div
              data-testid="modal-schedule-timezone-note"
              className="flex items-center gap-1.5 text-metadata text-ink-sub"
            >
              <span>Timezone for these posting times:</span>
              <span className="font-semibold text-ink">{activeTimezone}</span>
            </div>

            <FormField
              control={form.control}
              name="selectedFormats"
              render={() => (
                <FormItem id="posting-time-formats">
                  <div className="flex items-center justify-between">
                    <FormLabel>Post types</FormLabel>
                    <Button type="button" variant="link" size="sm" onClick={handleSelectAll}>
                      Select All
                    </Button>
                  </div>
                  <div
                    data-testid="modal-format-selection-group"
                    className="flex flex-wrap gap-2"
                    role="group"
                    aria-label="Post types"
                  >
                    {ALL_POST_FORMATS.map((format) => {
                      const isSelected = selectedFormats.includes(format.id);
                      return (
                        <button
                          key={format.id}
                          type="button"
                          data-testid={`modal-format-toggle-${format.id}`}
                          aria-pressed={isSelected}
                          onClick={() => toggleFormat(format.id)}
                          className={cn(
                            'inline-flex min-h-9 items-center rounded-full px-3 text-body font-medium outline-none transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold',
                            isSelected
                              ? 'bg-brand-gold/10 text-ink'
                              : 'bg-subtle text-ink-sub hover:text-ink'
                          )}
                        >
                          <span>{format.label}</span>
                        </button>
                      );
                    })}
                  </div>
                  <FormDescription>
                    Only queued posts of the selected post types go out at this time.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={isSubmitting}>
                Cancel
              </Button>
              <Button type="submit" data-testid="save-slot-btn" loading={isSubmitting}>
                {submitButtonText}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
