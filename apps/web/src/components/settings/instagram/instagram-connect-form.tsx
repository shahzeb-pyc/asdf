'use client';

/**
 * Instagram App tab — dedicated connect/edit form (Unified Login).
 *
 * Instagram-owned, like Facebook's form: it does NOT use the shared
 * platform connect form, so Threads behaviour is untouched. The four
 * steps follow the confirmed mockup exactly, in order: 1 Find your app
 * details, 2 Before you connect (the direct callback address, to be
 * registered in the configuration's Redirect URL list), 3 Privacy
 * Policy URL, 4 Add your app details here. The video guide card is
 * text only, "Video guide coming soon" — no link, no thumbnail.
 *
 * This section connects a developer app, not an account: no
 * account-eligibility facts (professional account, business portfolio,
 * no Page) appear here. Those belong at account-connect time.
 *
 * Copy is professional throughout, with no contractions. The
 * Configuration ID is an identifier, not a secret, so it is shown
 * like the App ID, never masked.
 */

import * as React from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '@/components/shared/ui/button';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/shared/ui/form';
import { Input } from '@/components/shared/ui/input';
import { SettingsGuideStep } from '@/components/settings/platform/platform-setup-card';

export function createInstagramConnectFormSchema(hasExistingSecret: boolean) {
  return z.object({
    appId: z
      .string()
      .refine((value) => value.trim().length > 0, 'Please enter your Meta App ID.')
      .refine(
        (value) => /^\d{10,20}$/.test(value.trim()),
        'Meta App ID must be numeric (10–20 digits).'
      ),
    appSecret: z
      .string()
      .refine(
        (value) => hasExistingSecret || value.trim().length > 0,
        'Please enter your App Secret.'
      ),
    configId: z
      .string()
      .refine((value) => value.trim().length > 0, 'Please enter your Configuration ID.'),
  });
}

export type InstagramConnectFormValues = z.infer<
  ReturnType<typeof createInstagramConnectFormSchema>
>;

export interface InstagramConnectPayload {
  appId: string;
  appSecret: string;
  configId: string;
}

export interface InstagramConnectFormProps {
  signInCallback: string;
  privacyUrl: string;
  initialAppId: string;
  initialConfigId: string;
  hasExistingSecret: boolean;
  isEditMode: boolean;
  isConnecting: boolean;
  serverError: string | null;
  onConnect: (payload: InstagramConnectPayload) => Promise<void>;
  onCancelEdit: () => void;
}

function CopyAddressRow({
  label,
  url,
  helper,
}: Readonly<{ label: string; url: string; helper: string }>) {
  const [copied, setCopied] = React.useState(false);
  const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    },
    []
  );
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Clipboard unavailable: the address is still selectable text.
    }
    setCopied(true);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="flex flex-col gap-2">
      <span className="text-metadata font-medium tracking-caption text-ink-dim uppercase">
        {label}
      </span>
      <div className="flex items-center justify-between gap-4 border-t border-line py-2.5">
        <span className="font-mono text-body text-gold break-all">{url}</span>
        <Button type="button" variant="ghost" size="sm" onClick={handleCopy}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <p className="text-body text-ink-sub">{helper}</p>
    </div>
  );
}

export function InstagramConnectForm({
  signInCallback,
  privacyUrl,
  initialAppId,
  initialConfigId,
  hasExistingSecret,
  isEditMode,
  isConnecting,
  serverError,
  onConnect,
  onCancelEdit,
}: Readonly<InstagramConnectFormProps>) {
  const [showSecret, setShowSecret] = React.useState(false);
  const [submitAttempted, setSubmitAttempted] = React.useState(false);

  const form = useForm<InstagramConnectFormValues>({
    resolver: zodResolver(createInstagramConnectFormSchema(hasExistingSecret)),
    mode: 'onTouched',
    defaultValues: { appId: initialAppId, appSecret: '', configId: initialConfigId },
  });

  const handleSubmit = form.handleSubmit(async (values) => {
    setSubmitAttempted(true);
    await onConnect({
      appId: values.appId.trim(),
      appSecret: values.appSecret.trim(),
      configId: values.configId.trim(),
    });
  });

  return (
    <Form {...form}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-6" noValidate>
        <div className="rounded-md border border-dashed border-line bg-canvas p-5 text-center text-body text-ink-sub">
          <b className="text-ink">Video guide coming soon</b>
        </div>

        {!isEditMode && (
          <SettingsGuideStep number={1} title="Find your app details">
            <p>
              If you do not have an app yet, create one in the Meta developer
              dashboard, then copy your Meta App ID and App Secret from
              Settings → Basic, and your Configuration ID from your Unified
              Login configuration.
            </p>
          </SettingsGuideStep>
        )}

        <div className="rounded-md border border-line bg-canvas p-4">
          <p className="text-body font-semibold text-ink">What this connection asks for</p>
          <ul className="mt-2 list-disc pl-5 text-body text-ink-sub">
            <li>Read your profile and media.</li>
            <li>Publish posts and reels.</li>
            <li>Manage comments.</li>
            <li>View insights.</li>
          </ul>
          <p className="mt-2 text-body text-ink-sub">No messages and no ads are requested.</p>
        </div>

        <SettingsGuideStep number={2} title="Before you connect">
          <p>Add this address to your Meta app so Instagram can bring you back here after you sign in.</p>
          <div className="mt-3">
            <CopyAddressRow
              label="Sign-in address"
              url={signInCallback}
              helper="Paste this into the Redirect URL list in your Unified Login configuration in your Meta app. If this address is not registered there, the sign-in will fail at Meta before you return here."
            />
          </div>
        </SettingsGuideStep>

        <SettingsGuideStep number={3} title="Privacy Policy URL">
          <p>Add this address to your Meta app as the Privacy Policy URL.</p>
          <div className="mt-3">
            <CopyAddressRow
              label="Privacy Policy URL"
              url={privacyUrl}
              helper="Paste this into the Privacy Policy URL field in your Meta app."
            />
          </div>
        </SettingsGuideStep>

        <SettingsGuideStep number={4} title="Add your app details here">
          <div className="flex flex-col gap-4">
            <FormField
              control={form.control}
              name="appId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Meta App ID</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="e.g. 123456789012345" autoComplete="off" />
                  </FormControl>
                  <p className="text-body text-ink-sub">You will find this in your Meta app under Settings → Basic.</p>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="appSecret"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>App Secret</FormLabel>
                  <div className="relative">
                    <FormControl>
                      <Input
                        {...field}
                        type={showSecret ? 'text' : 'password'}
                        placeholder="Enter your App Secret"
                        autoComplete="off"
                        className="pr-16"
                      />
                    </FormControl>
                    <button
                      type="button"
                      onClick={() => setShowSecret((value) => !value)}
                      className="absolute inset-y-0 right-0 w-16 text-body font-semibold text-ink-sub"
                    >
                      {showSecret ? 'Hide' : 'Show'}
                    </button>
                  </div>
                  <p className="text-body text-ink-sub">
                    {isEditMode ? (
                      <>
                        <b className="text-ink">Leave this blank to keep your current secret.</b>{' '}
                        To change it, you will find the new secret in your Meta app under Settings → Basic.
                      </>
                    ) : (
                      'You will find this in your Meta app under Settings → Basic. Only you can see this — it stays hidden until you choose to show it.'
                    )}
                  </p>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="configId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Configuration ID</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="Enter your Configuration ID" autoComplete="off" />
                  </FormControl>
                  <p className="text-body text-ink-sub">
                    You will find this in your Meta app under API setup with Unified login, in your configuration. This is not a secret. It identifies your configuration.
                  </p>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </SettingsGuideStep>

        {serverError && (
          <div role="alert" className="rounded-md border border-signal-critical bg-canvas p-4 text-body text-signal-critical">
            {serverError}
          </div>
        )}
        {submitAttempted && Object.keys(form.formState.errors).length > 0 && (
          <p role="alert" className="text-body text-signal-critical">
            Please fix the highlighted fields and try again.
          </p>
        )}

        <div className="flex flex-col gap-2">
          <p className="text-body text-ink-sub">When the login screen opens, choose Instagram.</p>
          <div className="flex gap-2">
            <Button type="submit" disabled={isConnecting}>
              {isEditMode ? 'Save changes' : 'Connect Instagram'}
            </Button>
            {isEditMode && (
              <Button type="button" variant="outline" onClick={onCancelEdit} disabled={isConnecting}>
                Cancel
              </Button>
            )}
          </div>
          <p className="text-body text-ink-sub">
            Your details are checked as soon as you {isEditMode ? 'save' : 'connect'}. All three details are required before you can connect.
          </p>
        </div>
      </form>
    </Form>
  );
}
