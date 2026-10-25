'use client';

/**
 * Platform credentials — shared "Add them here" connect form
 * (spec 135 PR-135-3, spec §5.3/§5.4 / §6.3 / §8.2).
 *
 * One config-driven form for Instagram and Threads (UI Rule 11 — the
 * platform differences are copy/config only), on the spec 137 form
 * standard exactly as the Facebook tab's form: react-hook-form + zod
 * (the schema's messages are the §5.2 pattern with the platform's
 * labels substituted, verbatim — the hand-rolled
 * `validatePlatformCredentialsInput` is deleted), `onTouched`
 * validation, the FormErrorSummary on submit failure with focus to
 * the summary, input never cleared by a failed submit, and the submit
 * button loading + disabled while pending ("Connecting...").
 *
 * "Connect <Platform>" IS the submit: saving auto-tests the details
 * server-side in the same action — there is no separate test step. A
 * server-returned failure arrives here as `serverError` (form scope,
 * in the summary); a network failure is toasted by the container with
 * the platform's fixed sentence — the two paths stay distinguishable.
 *
 * The platform's setup guide renders above the form step (the
 * container passes it as children, as before). Edit mode is this same
 * form: the App ID is pre-filled and the secret starts blank — blank
 * means "keep the existing secret", so the schema only requires a
 * secret when the workspace has none saved (§5.7).
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

import { GuideDivider } from './platform-setup-card';
import type { PlatformCredentialsConfig } from './platform-credentials-helpers';

export interface PlatformConnectPayload {
  appId: string;
  /** Omitted when the field is left blank in edit mode (keep existing). */
  appSecret?: string;
}

/**
 * The connect form's schema — the §5.2 validation pattern with the
 * platform's labels substituted, verbatim. Values are trimmed before
 * judging, exactly as the shipped form did: an empty App ID and a
 * non-numeric one are different failures with different sentences.
 */
export function createPlatformConnectFormSchema(
  config: Pick<PlatformCredentialsConfig, 'appIdLabel' | 'appSecretLabel'>,
  hasExistingSecret: boolean
) {
  return z.object({
    appId: z
      .string()
      .refine((value) => value.trim().length > 0, `Please enter your ${config.appIdLabel}.`)
      .refine(
        (value) => /^\d{10,20}$/.test(value.trim()),
        `${config.appIdLabel} must be numeric (10–20 digits).`
      ),
    appSecret: z
      .string()
      .refine(
        (value) => hasExistingSecret || value.trim().length > 0,
        `Please enter your ${config.appSecretLabel}.`
      ),
  });
}

export type PlatformConnectFormValues = z.infer<
  ReturnType<typeof createPlatformConnectFormSchema>
>;

export interface PlatformConnectFormProps {
  config: PlatformCredentialsConfig;
  /** App ID to pre-fill (edit mode); empty for a first connect. */
  initialAppId: string;
  /** True when the workspace already has a secret saved (edit mode). */
  hasExistingSecret: boolean;
  isEditMode: boolean;
  isConnecting: boolean;
  /** Server-returned save/test failure, presented at form scope. */
  serverError: string | null;
  onConnect: (payload: PlatformConnectPayload) => Promise<void>;
  onCancelEdit: () => void;
  /** The platform's setup guide, shown above the "Add them here" step. */
  children?: React.ReactNode;
  /**
   * Hide the numbered step badge on "Add them here" (2026-10-25
   * redesign). Tabs whose guide was removed have no steps 1–4, so a
   * lone "5" badge would be orphaned; those tabs hide it and the
   * heading stands on its own. Classic tabs keep the badge.
   */
  showStepBadge?: boolean;
}

const LABEL_CLASS_NAME =
  'text-metadata font-medium tracking-caption text-ink-dim uppercase';

export function PlatformConnectForm({
  config,
  initialAppId,
  hasExistingSecret,
  isEditMode,
  isConnecting,
  serverError,
  onConnect,
  onCancelEdit,
  children,
  showStepBadge = true,
}: Readonly<PlatformConnectFormProps>) {
  const { displayName, appIdLabel, appSecretLabel, testIdPrefix, appIdHelper, formStepNumber } =
    config;
  const appIdFieldId = `${testIdPrefix}-app-id-input`;
  const appSecretFieldId = `${testIdPrefix}-app-secret-input`;

  const [showSecret, setShowSecret] = React.useState(false);
  const [submitAttempted, setSubmitAttempted] = React.useState(false);

  const form = useForm<PlatformConnectFormValues>({
    resolver: zodResolver(createPlatformConnectFormSchema(config, hasExistingSecret)),
    mode: 'onTouched',
    shouldFocusError: false,
    defaultValues: { appId: initialAppId, appSecret: '' },
  });

  const handleValidSubmit = async (values: PlatformConnectFormValues) => {
    const trimmedSecret = values.appSecret.trim();
    const payload: PlatformConnectPayload = { appId: values.appId.trim() };
    if (trimmedSecret) {
      payload.appSecret = trimmedSecret;
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
      summaryEntries.push({ fieldId: appIdFieldId, message: appIdError });
    }
    const appSecretError = form.formState.errors.appSecret?.message;
    if (appSecretError) {
      summaryEntries.push({ fieldId: appSecretFieldId, message: appSecretError });
    }
  }
  if (serverError) {
    summaryEntries.push({ message: serverError });
  }

  return (
    <div className="flex flex-col gap-6">
      {children}
      {children && <GuideDivider />}

      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          {showStepBadge && (
            <span
              aria-hidden="true"
              className="flex size-6 shrink-0 items-center justify-center rounded-full border border-line bg-canvas text-metadata font-semibold text-ink-sub"
            >
              {formStepNumber}
            </span>
          )}
          <h3 className="text-body font-semibold text-ink">Add them here</h3>
        </div>

        <Form {...form}>
          <form
            noValidate
            onSubmit={(event) => {
              setSubmitAttempted(true);
              void form.handleSubmit(handleValidSubmit)(event);
            }}
            className={
              showStepBadge ? 'flex flex-col gap-4 pl-8 max-sm:pl-0' : 'flex flex-col gap-4'
            }
          >
            <FormErrorSummary errors={summaryEntries} />

            <FormField
              control={form.control}
              name="appId"
              render={({ field }) => (
                <FormItem id={appIdFieldId}>
                  <FormLabel className={LABEL_CLASS_NAME}>{appIdLabel}</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      type="text"
                      inputMode="numeric"
                      autoComplete="off"
                      placeholder="e.g. 123456789012345"
                      data-testid={appIdFieldId}
                      disabled={isConnecting}
                    />
                  </FormControl>
                  <FormDescription>{appIdHelper}</FormDescription>
                  <FormMessage data-testid={`${testIdPrefix}-app-id-error`} />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="appSecret"
              render={({ field }) => (
                <FormItem id={appSecretFieldId}>
                  <FormLabel className={LABEL_CLASS_NAME}>{appSecretLabel}</FormLabel>
                  <div className="relative">
                    <FormControl>
                      <Input
                        {...field}
                        type={showSecret ? 'text' : 'password'}
                        placeholder={`Enter your ${appSecretLabel}`}
                        data-testid={appSecretFieldId}
                        disabled={isConnecting}
                        className="pr-14"
                      />
                    </FormControl>
                    <button
                      type="button"
                      data-testid={`${testIdPrefix}-app-secret-toggle`}
                      onClick={() => setShowSecret((previous) => !previous)}
                      className="absolute inset-y-0 right-0 flex min-w-11 items-center justify-center px-3 text-metadata font-medium text-ink-sub transition-colors hover:text-ink"
                    >
                      {showSecret ? 'Hide' : 'Show'}
                    </button>
                  </div>
                  <FormDescription>
                    Only you can see this — it stays hidden until you choose to show it.
                  </FormDescription>
                  <FormMessage data-testid={`${testIdPrefix}-app-secret-error`} />
                </FormItem>
              )}
            />

            <div className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="submit"
                  data-testid={`${testIdPrefix}-connect-btn`}
                  loading={isConnecting}
                  disabled={isConnecting}
                >
                  {isConnecting ? 'Connecting...' : `Connect ${displayName}`}
                </Button>
                {isEditMode && (
                  <Button
                    type="button"
                    variant="secondary"
                    data-testid={`${testIdPrefix}-cancel-edit-btn`}
                    onClick={onCancelEdit}
                    disabled={isConnecting}
                  >
                    Cancel
                  </Button>
                )}
              </div>
              <span className="text-metadata text-ink-dim">
                We check everything works the moment you connect.
              </span>
            </div>
          </form>
        </Form>
      </div>
    </div>
  );
}
