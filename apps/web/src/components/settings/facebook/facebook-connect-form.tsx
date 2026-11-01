'use client';

/**
 * Facebook tab — guided 2-step connect form (spec 135 PR-135-2,
 * spec §5.2 / §6.3 / §8.1).
 *
 * The finalized 2026-10-16 form on the spec 137 form standard:
 * react-hook-form + zod (the schema's messages are §5.2 verbatim —
 * the hand-rolled validator is deleted), `onTouched` validation, the
 * FormErrorSummary on submit failure with focus to the summary, input
 * never cleared by a failed submit, and the submit button loading +
 * disabled while pending ("Connecting...").
 *
 * "Connect Facebook" IS the submit: saving auto-tests the details
 * server-side in the same action — there is no separate test step
 * (§5.2). A server-returned failure arrives here as `serverError`
 * (form scope, in the summary); a network failure is toasted by the
 * container with §5.2's fixed sentence — the two paths stay
 * distinguishable exactly as before.
 *
 * Edit mode is this same form (the container remounts it keyed by
 * mode): the App ID is pre-filled and the secret starts blank —
 * blank means "keep the existing secret", so the schema only
 * requires a secret when the workspace has none saved (§5.7).
 */

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import { Button } from '@/components/shared/ui/button';
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
import { FacebookSetupCard } from './facebook-setup-card';
import { FacebookPrivacyUrlRow } from './facebook-privacy-url-row';

const APP_ID_FIELD_ID = 'fb-app-id-input';
const APP_SECRET_FIELD_ID = 'fb-app-secret-input';

export interface FacebookConnectPayload {
  fbAppId: string;
  /** Omitted when the field is left blank in edit mode (keep existing). */
  fbAppSecret?: string;
}

/**
 * The connect form's schema — §5.2's validation messages verbatim.
 * Values are trimmed before judging, exactly as the shipped form did:
 * an empty App ID and a non-numeric one are different failures with
 * different sentences.
 */
export function createFacebookConnectFormSchema(hasExistingSecret: boolean) {
  return z.object({
    appId: z
      .string()
      .refine((value) => value.trim().length > 0, 'Please enter your App ID.')
      .refine(
        (value) => /^\d{10,20}$/.test(value.trim()),
        'App ID must be numeric (10–20 digits).'
      ),
    appSecret: z
      .string()
      .refine(
        (value) => hasExistingSecret || value.trim().length > 0,
        'Please enter your App Secret.'
      ),
  });
}

export type FacebookConnectFormValues = z.infer<
  ReturnType<typeof createFacebookConnectFormSchema>
>;

export interface FacebookConnectFormProps {
  subdomain: string;
  privacyUrl: string;
  /** App ID to pre-fill (edit mode); empty for a first connect. */
  initialAppId: string;
  /** True when the workspace already has a secret saved (edit mode). */
  hasExistingSecret: boolean;
  isEditMode: boolean;
  isConnecting: boolean;
  /** Server-returned save/test failure, presented at form scope. */
  serverError: string | null;
  onConnect: (payload: FacebookConnectPayload) => Promise<void>;
  onCancelEdit: () => void;
}

function StepBadge({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <span
      aria-hidden="true"
      className="flex size-6 shrink-0 items-center justify-center rounded-full border border-line bg-canvas text-metadata font-semibold text-ink-sub"
    >
      {children}
    </span>
  );
}

const LABEL_CLASS_NAME =
  'text-metadata font-medium tracking-caption text-ink-dim uppercase';

export function FacebookConnectForm({
  subdomain,
  privacyUrl,
  initialAppId,
  hasExistingSecret,
  isEditMode,
  isConnecting,
  serverError,
  onConnect,
  onCancelEdit,
}: Readonly<FacebookConnectFormProps>) {
  const [showSecret, setShowSecret] = React.useState(false);
  const [submitAttempted, setSubmitAttempted] = React.useState(false);

  const form = useForm<FacebookConnectFormValues>({
    resolver: zodResolver(createFacebookConnectFormSchema(hasExistingSecret)),
    mode: 'onTouched',
    shouldFocusError: false,
    defaultValues: { appId: initialAppId, appSecret: '' },
  });

  const handleValidSubmit = async (values: FacebookConnectFormValues) => {
    const trimmedSecret = values.appSecret.trim();
    const payload: FacebookConnectPayload = { fbAppId: values.appId.trim() };
    if (trimmedSecret) {
      payload.fbAppSecret = trimmedSecret;
    }
    try {
      await onConnect(payload);
      setSubmitAttempted(false);
    } catch {
      // The container has already surfaced the failure (form-scope
      // serverError, or the network-failure toast). The form stays
      // open in its attempted state with the typed values intact — a
      // failed connect never clears the input.
      setSubmitAttempted(true);
    }
  };

  const summaryEntries: FormErrorSummaryEntry[] = [];
  if (submitAttempted) {
    const appIdError = form.formState.errors.appId?.message;
    if (appIdError) {
      summaryEntries.push({ fieldId: APP_ID_FIELD_ID, message: appIdError });
    }
    const appSecretError = form.formState.errors.appSecret?.message;
    if (appSecretError) {
      summaryEntries.push({ fieldId: APP_SECRET_FIELD_ID, message: appSecretError });
    }
  }
  if (serverError) {
    summaryEntries.push({ message: serverError });
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Coming-soon video guide: a placeholder only — no link, no
          button, nothing to click that leads nowhere. First connect
          only; edit and connected states do not show it. */}
      {!isEditMode && (
        <div
          data-testid="fb-video-guide-coming-soon"
          className="flex flex-col items-center gap-1 rounded-md border border-dashed border-line bg-canvas px-6 py-7 text-center"
        >
          <span aria-hidden="true" className="text-xxl text-link">
            ▶
          </span>
          <span className="font-semibold text-ink">Video guide coming soon</span>
        </div>
      )}

      {isEditMode && (
        <p data-testid="fb-unsaved-changes-note" className="text-body text-ink-sub">
          Unsaved changes. Your previously saved app remains connected until you save.
        </p>
      )}

      {/* Step 1 — first connect only: an editor already has an app. */}
      {!isEditMode && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <StepBadge>1</StepBadge>
            <h3 className="text-body font-semibold text-ink">Find your app details</h3>
          </div>
          <p className="pl-8 text-body text-ink-sub">
            If you do not have an app yet, create one in the{' '}
            <a
              href="https://developers.facebook.com"
              target="_blank"
              rel="noopener noreferrer"
              data-testid="fb-meta-dashboard-link"
              className="font-semibold text-link hover:underline"
            >
              Meta developer dashboard →
            </a>
            , then copy your App ID and App Secret from Settings → Basic.
          </p>
        </div>
      )}

      <div aria-hidden="true" className="h-px w-full bg-line" />

      {/* Step 2 — the sign-in address, before any details are typed. */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <StepBadge>2</StepBadge>
          <h3 className="text-body font-semibold text-ink">Before you connect</h3>
        </div>
        <p className="pl-8 text-body text-ink-sub">
          Add this address to your Meta app so Facebook can return you here after you
          sign in.
        </p>
        <div className="pl-8 max-sm:pl-0">
          <FacebookSetupCard subdomain={subdomain} bare />
        </div>
      </div>

      <div aria-hidden="true" className="h-px w-full bg-line" />

      {/* Step 3 — Privacy Policy URL. */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <StepBadge>3</StepBadge>
          <h3 className="text-body font-semibold text-ink">Privacy Policy URL</h3>
        </div>
        <p className="pl-8 text-body text-ink-sub">
          Add this address to your Meta app as the Privacy Policy URL.
        </p>
        <div className="pl-8 max-sm:pl-0">
          <FacebookPrivacyUrlRow privacyUrl={privacyUrl} />
        </div>
      </div>

      <div aria-hidden="true" className="h-px w-full bg-line" />

      {/* Step 4 */}
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <StepBadge>4</StepBadge>
          <h3 className="text-body font-semibold text-ink">Add your app details here</h3>
        </div>

        <Form {...form}>
          <form
            noValidate
            onSubmit={(event) => {
              setSubmitAttempted(true);
              void form.handleSubmit(handleValidSubmit)(event);
            }}
            className="flex flex-col gap-4 pl-8 max-sm:pl-0"
          >
            <FormErrorSummary errors={summaryEntries} />

            <FormField
              control={form.control}
              name="appId"
              render={({ field }) => (
                <FormItem id={APP_ID_FIELD_ID}>
                  <FormLabel className={LABEL_CLASS_NAME}>App ID</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      type="text"
                      inputMode="numeric"
                      autoComplete="off"
                      placeholder="e.g. 123456789012345"
                      data-testid="fb-app-id-input"
                      disabled={isConnecting}
                    />
                  </FormControl>
                  <FormDescription>
                    You will find this in your Meta app under Settings → Basic.
                  </FormDescription>
                  <FormMessage data-testid="fb-app-id-error" />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="appSecret"
              render={({ field }) => (
                <FormItem id={APP_SECRET_FIELD_ID}>
                  <FormLabel className={LABEL_CLASS_NAME}>App Secret</FormLabel>
                  <div className="relative">
                    <FormControl>
                      <Input
                        {...field}
                        type={showSecret ? 'text' : 'password'}
                        placeholder="Enter your App Secret"
                        data-testid="fb-app-secret-input"
                        disabled={isConnecting}
                        className="pr-14"
                      />
                    </FormControl>
                    <button
                      type="button"
                      data-testid="fb-app-secret-toggle"
                      onClick={() => setShowSecret((previous) => !previous)}
                      className="absolute inset-y-0 right-0 flex min-w-11 items-center justify-center px-3 text-metadata font-medium text-ink-sub transition-colors hover:text-ink"
                    >
                      {showSecret ? 'Hide' : 'Show'}
                    </button>
                  </div>
                  <FormDescription>
                    {isEditMode ? (
                      <>
                        <strong>Leave this blank to keep your current secret.</strong>{' '}
                        To change it, you will find the new secret in your Meta app under
                        Settings → Basic. Only you can see this — it stays hidden until
                        you choose to show it.
                      </>
                    ) : (
                      <>
                        You will find this in your Meta app under Settings → Basic, next
                        to App ID. Only you can see this — it stays hidden until you
                        choose to show it.
                      </>
                    )}
                  </FormDescription>
                  <FormMessage data-testid="fb-app-secret-error" />
                </FormItem>
              )}
            />

            <div className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="submit"
                  data-testid="fb-connect-btn"
                  loading={isConnecting}
                  disabled={isConnecting}
                >
                  {isEditMode
                    ? isConnecting
                      ? 'Saving...'
                      : 'Save changes'
                    : isConnecting
                      ? 'Connecting...'
                      : 'Connect Facebook'}
                </Button>
                {isEditMode && (
                  <Button
                    type="button"
                    variant="secondary"
                    data-testid="fb-cancel-edit-btn"
                    onClick={onCancelEdit}
                    disabled={isConnecting}
                  >
                    Cancel
                  </Button>
                )}
              </div>
              <span className="text-metadata text-ink-dim">
                Your details are checked as soon as you connect.
              </span>
            </div>
          </form>
        </Form>
      </div>
    </div>
  );
}
