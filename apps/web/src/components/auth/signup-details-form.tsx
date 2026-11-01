'use client';

/**
 * Signup details form (spec 136 §5.2) — the registration details step,
 * extracted from the signup page and converted to the form standard
 * (spec 137 §3.8): react-hook-form + zod on the shared/ui Form
 * primitives, `onTouched` validation, errors inline only (under each
 * field, plus one plain inline line for server errors), input never
 * cleared, submit through the typed API client.
 *
 * Preserved behaviours (§4.2): the Gmail rule and phone validation with
 * §3.3's wording, server 400 field errors mapped inline, the 429
 * cooldown surfacing the §3.3 wait message with the submit disabled
 * while it counts down, the already-registered conflict panel offering
 * `Sign in instead` / `Reset password` in place, and the pending-
 * verification success notice (`Code Sent`).
 */

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';

import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/shared/ui/form';
import { Input } from '@/components/shared/ui/input';
import { Button } from '@/components/shared/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/shared/ui/alert';
import { PasswordInput } from '@/components/auth/password-input';
import { sanitizeAuthErrorMessage } from '@/lib/auth-errors';
import { completeAuthRedirect } from '@/lib/auth-broadcast';
import { api, isApiError } from '@/lib/api';
import {
  SignupSuccessResponseSchema,
  type SignupErrorBody,
} from '@/lib/api/schemas/auth';
import { ReferralValidateResponseSchema } from '@/lib/api/schemas/sellers';
import { reportError } from '@/lib/report-error';
import { signupFormSchema, type SignupFormValues } from '@/app/signup/signup-form-schema';

export interface SignupDetailsFormProps {
  /** Email arriving via the page's entry parameters (`?email=`). */
  initialEmail?: string | undefined;
  /** Referral code arriving via a seller link (`?ref=`). */
  initialReferralCode?: string | undefined;
  /** Pending-verification notice arriving via `?notice=pending_verification`. */
  successNotice?: string | null | undefined;
  onDismissSuccessNotice?: (() => void) | undefined;
  /** The details step succeeded and the server asked for the OTP step. */
  onRequiresOtp: (email: string, cooldownSecondsRemaining: number) => void;
}

type SignupFieldName = 'name' | 'phone' | 'email' | 'password' | 'confirmPassword';

const FIELD_IDS: Record<SignupFieldName, string> = {
  name: 'signup-name',
  phone: 'signup-phone',
  email: 'signup-email',
  password: 'signup-password',
  confirmPassword: 'signup-confirm-password',
};

const FIELD_ORDER: SignupFieldName[] = ['name', 'phone', 'email', 'password', 'confirmPassword'];

export function SignupDetailsForm({
  initialEmail,
  initialReferralCode,
  successNotice,
  onDismissSuccessNotice,
  onRequiresOtp,
}: Readonly<SignupDetailsFormProps>) {
  const [serverError, setServerError] = useState<string | null>(null);
  const [isEmailConflict, setIsEmailConflict] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  /**
   * Referral pre-check state. The server re-resolves the code at
   * submit time — this is display only: 'valid' shows the
   * referred-by banner and submits the code; 'invalid' shows a
   * notice and submits without it; 'unavailable' (endpoint error
   * or 503) also submits without it, quietly, so a check outage
   * never blocks registration.
   */
  const [referralState, setReferralState] = useState<
    | { status: 'none' }
    | { status: 'checking' }
    | { status: 'valid'; sellerName: string | null }
    | { status: 'invalid' }
    | { status: 'unavailable' }
  >({ status: initialReferralCode ? 'checking' : 'none' });

  useEffect(() => {
    if (!initialReferralCode) return;
    let cancelled = false;
    api
      .get(
        `/api/referral/validate?code=${encodeURIComponent(initialReferralCode)}`,
        { schema: ReferralValidateResponseSchema }
      )
      .then((data) => {
        if (cancelled) return;
        setReferralState(
          data.valid ? { status: 'valid', sellerName: data.sellerName } : { status: 'invalid' }
        );
      })
      .catch(() => {
        if (cancelled) return;
        setReferralState({ status: 'unavailable' });
      });
    return () => {
      cancelled = true;
    };
  }, [initialReferralCode]);

  const form = useForm<SignupFormValues>({
    resolver: zodResolver(signupFormSchema),
    mode: 'onTouched',
    shouldFocusError: false,
    defaultValues: {
      name: '',
      phone: '',
      email: initialEmail ?? '',
      password: '',
      confirmPassword: '',
    },
  });
  const { formState } = form;
  const isSubmitting = formState.isSubmitting;
  const emailValue = form.watch('email');

  // Entry-parameter prefill (`?email=`, read by the page after mount):
  // applied once it arrives, without overwriting anything typed since.
  const appliedInitialEmail = React.useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!initialEmail || appliedInitialEmail.current === initialEmail) return;
    appliedInitialEmail.current = initialEmail;
    if (!form.getValues('email')) {
      form.setValue('email', initialEmail);
    }
  }, [initialEmail, form]);

  // Cooldown countdown after a rate-limited signup attempt (§3.3).
  useEffect(() => {
    if (cooldown <= 0) return;
    const interval = setInterval(() => {
      setCooldown((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, [cooldown]);

  const handleServerFieldErrors = (body: SignupErrorBody): boolean => {
    if (!body.details) return false;
    let mapped = false;
    for (const name of FIELD_ORDER) {
      const messages = body.details[name];
      if (Array.isArray(messages) && messages.length > 0 && typeof messages[0] === 'string') {
        form.setError(name, { type: 'server', message: messages[0] });
        mapped = true;
      }
    }
    return mapped;
  };

  const onSubmit = async (values: SignupFormValues) => {
    setServerError(null);
    setIsEmailConflict(false);
    try {
      const data = await api.post(
        '/api/auth/signup',
        {
          name: values.name.trim(),
          phone: values.phone.trim(),
          email: values.email.trim(),
          password: values.password,
          ...(referralState.status === 'valid' && initialReferralCode
            ? { referralCode: initialReferralCode }
            : {}),
        },
        { schema: SignupSuccessResponseSchema }
      );

      if (data.requiresOtp) {
        onRequiresOtp(values.email.trim(), data.cooldownSecondsRemaining ?? 60);
        return;
      }
      if (data.redirectUrl) {
        completeAuthRedirect(data.redirectUrl, data.user);
      }
    } catch (error) {
      if (!isApiError(error)) {
        reportError(error, { source: 'signup-submit' });
        setServerError("Couldn't create your account. Please check your connection and try again.");
        return;
      }
      const body = (error.cause ?? null) as SignupErrorBody | null;

      if (error.status === 400 && body && handleServerFieldErrors(body)) {
        return;
      }
      if (error.status === 429) {
        const waitSeconds = body?.retryAfterSeconds || body?.cooldownSecondsRemaining || 60;
        setCooldown(waitSeconds);
        setServerError(
          sanitizeAuthErrorMessage(
            body?.error,
            `For security purposes, please wait ${waitSeconds} seconds before trying again.`
          )
        );
        return;
      }
      if (
        error.status === 409 ||
        body?.error?.toLowerCase().includes('already registered')
      ) {
        setIsEmailConflict(true);
        form.setError('email', {
          type: 'server',
          message: 'This email is already registered.',
        });
        return;
      }
      if (error.kind === 'network') {
        setServerError("Couldn't create your account. Please check your connection and try again.");
        return;
      }
      if (error.kind === 'parse' || (error.status !== undefined && error.status >= 500)) {
        reportError(error, { source: 'signup-submit', kind: error.kind, status: error.status });
      }
      setServerError(
        sanitizeAuthErrorMessage(body?.error, "Couldn't create your account. Please try again shortly.")
      );
    }
  };

  return (
    <Form {...form}>
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={form.handleSubmit(onSubmit)}
      >
        {successNotice && (
          <Alert variant="success">
            <div className="flex flex-col gap-1">
              <AlertTitle>Code Sent</AlertTitle>
              <AlertDescription>{successNotice}</AlertDescription>
            </div>
            {onDismissSuccessNotice && (
              <button
                type="button"
                aria-label="Dismiss"
                onClick={onDismissSuccessNotice}
                className="shrink-0 text-ink-sub hover:text-ink"
              >
                ×
              </button>
            )}
          </Alert>
        )}

        {referralState.status === 'valid' && (
          <Alert variant="success">
            <div className="flex flex-col gap-1">
              <AlertTitle>Referred by {referralState.sellerName ?? 'a seller'}</AlertTitle>
              <AlertDescription>
                You signed up through a seller&apos;s referral link. This account will be linked
                to them.
              </AlertDescription>
            </div>
          </Alert>
        )}
        {referralState.status === 'invalid' && (
          <Alert variant="warning">
            <div className="flex flex-col gap-1">
              <AlertTitle>Referral link no longer valid</AlertTitle>
              <AlertDescription>
                This referral link is no longer active. You can still create your account — it
                just won&apos;t be linked to a seller.
              </AlertDescription>
            </div>
          </Alert>
        )}

        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem id={FIELD_IDS.name}>
              <FormLabel>Full Name</FormLabel>
              <FormControl>
                <Input
                  placeholder="Jane Doe"
                  autoComplete="name"
                  required
                  disabled={isSubmitting}
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="phone"
          render={({ field }) => (
            <FormItem id={FIELD_IDS.phone}>
              <FormLabel>Phone Number</FormLabel>
              <FormControl>
                <Input
                  type="tel"
                  placeholder="+1 555 123 4567"
                  autoComplete="tel"
                  required
                  disabled={isSubmitting}
                  {...field}
                />
              </FormControl>
              <FormDescription>
                Include your country code, e.g. +1 or +92.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem id={FIELD_IDS.email}>
              <FormLabel>Email Address</FormLabel>
              <FormControl>
                <Input
                  type="email"
                  placeholder="you@gmail.com"
                  autoComplete="email"
                  required
                  disabled={isSubmitting}
                  {...field}
                  onChange={(e) => {
                    field.onChange(e);
                    if (isEmailConflict) setIsEmailConflict(false);
                  }}
                />
              </FormControl>
              <FormDescription>Only @gmail.com (or @googlemail.com) accounts are supported.</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        {isEmailConflict && (
          <div className="-mt-2 flex items-center gap-2 text-metadata">
            <Link
              href={`/login?email=${encodeURIComponent(emailValue.trim())}`}
              className="font-medium text-link underline"
            >
              Sign in instead
            </Link>
            <span className="text-ink-dim">•</span>
            <Link
              href={`/forgot-password?email=${encodeURIComponent(emailValue.trim())}`}
              className="font-medium text-link underline"
            >
              Reset password
            </Link>
          </div>
        )}

        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem id={FIELD_IDS.password}>
              <FormLabel>Password</FormLabel>
              <FormControl>
                <PasswordInput
                  placeholder="••••••••••••"
                  autoComplete="new-password"
                  required
                  disabled={isSubmitting}
                  {...field}
                />
              </FormControl>
              <FormDescription>Minimum 8 characters</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="confirmPassword"
          render={({ field }) => (
            <FormItem id={FIELD_IDS.confirmPassword}>
              <FormLabel>Confirm Password</FormLabel>
              <FormControl>
                <PasswordInput
                  placeholder="••••••••••••"
                  autoComplete="new-password"
                  required
                  disabled={isSubmitting}
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {serverError && (
          <p role="alert" className="text-metadata font-medium text-signal-critical">
            {serverError}
          </p>
        )}

        <Button
          type="submit"
          size="lg"
          loading={isSubmitting}
          disabled={cooldown > 0}
          {...(cooldown > 0
            ? {
                disabledReason: `For security purposes, please wait ${cooldown} seconds before trying again.`,
              }
            : {})}
          className="mt-1 w-full"
        >
          {cooldown > 0 ? `Please wait ${cooldown}s` : 'Create Account'}
        </Button>

        <p className="mt-1 text-center text-metadata leading-body text-ink-sub">
          By creating an account, you agree to our{' '}
          <a
            href="/terms"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Terms of Service (opens in a new tab)"
            className="font-medium text-link no-underline hover:underline"
          >
            Terms of Service
          </a>{' '}
          and{' '}
          <a
            href="/privacy"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Privacy Policy (opens in a new tab)"
            className="font-medium text-link no-underline hover:underline"
          >
            Privacy Policy
          </a>
          .
        </p>
      </form>
    </Form>
  );
}
