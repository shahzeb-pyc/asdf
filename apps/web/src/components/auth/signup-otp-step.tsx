'use client';

/**
 * Signup OTP step (spec 136 §5.4 — the product's one OTP pattern):
 * a single 6-digit field, non-digits stripped on entry, the code pastes
 * whole, `autoComplete="one-time-code"` for OS / password-manager
 * autofill; resend carries the server cooldown as a live countdown and
 * is disabled with the countdown as its visible reason; an expired-code
 * error reveals `Resend code` in place. Verify + resend go through
 * the typed API client; the form is on the §3.8 standard (RHF + zod +
 * errors inline only).
 */

import React, { useEffect, useState } from 'react';
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
import { sanitizeAuthErrorMessage } from '@/lib/auth-errors';
import { sanitizeAuthRedirectUrl } from '@/lib/auth-redirect';
import { completeAuthRedirect } from '@/lib/auth-broadcast';
import { api, isApiError } from '@/lib/api';
import {
  ResendOtpSuccessResponseSchema,
  VerifyOtpSuccessResponseSchema,
  type ResendOtpErrorBody,
  type VerifyOtpErrorBody,
} from '@/lib/api/schemas/auth';
import { reportError } from '@/lib/report-error';
import {
  signupOtpFormSchema,
  type SignupOtpFormValues,
} from '@/app/signup/signup-form-schema';

export interface SignupOtpStepProps {
  readonly email: string;
  readonly returnUrl?: string | undefined;
  readonly initialCooldown?: number | undefined;
  readonly onBack: () => void;
}

export function getResendButtonText(resendCooldown: number, isResending: boolean): string {
  if (resendCooldown > 0) {
    return `Resend code in ${resendCooldown}s`;
  }
  if (isResending) {
    return 'Sending fresh code...';
  }
  return 'Did not receive code? Resend';
}

const OTP_FIELD_ID = 'signup-otp-code';

export function SignupOtpStep({
  email,
  returnUrl,
  initialCooldown = 60,
  onBack,
}: Readonly<SignupOtpStepProps>) {
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);
  const [isResending, setIsResending] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(initialCooldown);

  const form = useForm<SignupOtpFormValues>({
    resolver: zodResolver(signupOtpFormSchema),
    mode: 'onTouched',
    shouldFocusError: false,
    defaultValues: { otp: '' },
  });
  const { formState } = form;
  const isSubmitting = formState.isSubmitting;
  const otpError = formState.errors.otp?.message
    ? String(formState.errors.otp.message)
    : null;
  const isExpiredError = Boolean(otpError?.toLowerCase().includes('expired'));

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const interval = setInterval(() => {
      setResendCooldown((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, [resendCooldown]);

  const onSubmit = async (values: SignupOtpFormValues) => {
    setGeneralError(null);
    setSuccessNotice(null);
    const cleanOtp = values.otp.replace(/\D/g, '').trim();
    try {
      const data = await api.post(
        '/api/auth/signup/verify-otp',
        {
          email: email.trim(),
          otp: cleanOtp,
          returnUrl: returnUrl ? sanitizeAuthRedirectUrl(returnUrl) : undefined,
        },
        { schema: VerifyOtpSuccessResponseSchema }
      );
      if (data.redirectUrl) {
        completeAuthRedirect(data.redirectUrl, data.user);
      }
    } catch (error) {
      if (!isApiError(error)) {
        reportError(error, { source: 'signup-verify-otp' });
        setGeneralError("Couldn't verify the code. Please check your connection and try again.");
        return;
      }
      const body = (error.cause ?? null) as VerifyOtpErrorBody | null;
      if (error.kind === 'network') {
        setGeneralError("Couldn't verify the code. Please check your connection and try again.");
        return;
      }
      if (error.kind === 'parse' || (error.status !== undefined && error.status >= 500)) {
        reportError(error, {
          source: 'signup-verify-otp',
          kind: error.kind,
          status: error.status,
        });
      }
      form.setError('otp', {
        type: 'server',
        message: sanitizeAuthErrorMessage(
          body?.error,
          'Invalid or expired verification code. Please try again.'
        ),
      });
    }
  };

  const handleResendOtp = async () => {
    if (resendCooldown > 0 || isResending) return;
    setGeneralError(null);
    setSuccessNotice(null);
    form.clearErrors('otp');
    setIsResending(true);
    try {
      await api.post(
        '/api/auth/signup/resend-otp',
        { email: email.trim() },
        { schema: ResendOtpSuccessResponseSchema }
      );
      setSuccessNotice('A new 6-digit code has been sent to your email.');
      setResendCooldown(60);
    } catch (error) {
      if (!isApiError(error)) {
        reportError(error, { source: 'signup-resend-otp' });
        setGeneralError("Couldn't resend the verification code. Please check your connection.");
        return;
      }
      const body = (error.cause ?? null) as ResendOtpErrorBody | null;
      const cooldownSeconds = body?.cooldownSecondsRemaining || body?.retryAfterSeconds;
      if (cooldownSeconds) {
        setResendCooldown(cooldownSeconds);
      }
      if (error.kind === 'network') {
        setGeneralError("Couldn't resend the verification code. Please check your connection.");
        return;
      }
      if (error.kind === 'parse' || (error.status !== undefined && error.status >= 500)) {
        reportError(error, {
          source: 'signup-resend-otp',
          kind: error.kind,
          status: error.status,
        });
      }
      setGeneralError(sanitizeAuthErrorMessage(body?.error, "Couldn't resend the code right now."));
    } finally {
      setIsResending(false);
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
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => setSuccessNotice(null)}
              className="shrink-0 text-ink-sub hover:text-ink"
            >
              ×
            </button>
          </Alert>
        )}

        <div className="flex items-center justify-between gap-3 rounded-md border border-line bg-subtle px-3.5 py-2.5">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-metadata text-ink-dim">Verification code sent to</span>
            <span className="truncate text-body font-medium text-ink">{email}</span>
          </div>
          <button
            type="button"
            onClick={onBack}
            className="shrink-0 px-2 py-2 text-metadata font-medium text-link underline"
          >
            Wrong email? Edit
          </button>
        </div>

        <FormField
          control={form.control}
          name="otp"
          render={({ field }) => (
            <FormItem id={OTP_FIELD_ID}>
              <FormLabel>6-Digit Verification Code</FormLabel>
              <FormControl>
                <Input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  placeholder="••••••"
                  autoComplete="one-time-code"
                  autoFocus
                  required
                  disabled={isSubmitting}
                  className="text-center text-xl font-bold tracking-widest"
                  {...field}
                  onChange={(e) => {
                    field.onChange(e.target.value.replace(/\D/g, '').slice(0, 6));
                  }}
                />
              </FormControl>
              <FormDescription>
                Check your spam folder if you do not see the email in your inbox.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        {isExpiredError && (
          <div className="-mt-2 text-center">
            <button
              type="button"
              onClick={handleResendOtp}
              disabled={isResending || resendCooldown > 0}
              className="px-2 py-2 text-metadata font-medium text-link underline disabled:cursor-not-allowed disabled:opacity-50"
            >
              Resend code
            </button>
          </div>
        )}

        {generalError && (
          <p role="alert" className="text-metadata font-medium text-brand-rose">
            {generalError}
          </p>
        )}

        <Button type="submit" size="lg" loading={isSubmitting} className="w-full">
          Verify &amp; Activate Account
        </Button>

        <div className="mt-1 text-center">
          <button
            type="button"
            onClick={handleResendOtp}
            disabled={resendCooldown > 0 || isResending}
            aria-describedby={resendCooldown > 0 ? 'signup-otp-resend-reason' : undefined}
            className="min-h-11 px-2 py-1 text-metadata font-medium text-link underline disabled:cursor-default disabled:text-ink-dim disabled:no-underline"
          >
            {getResendButtonText(resendCooldown, isResending)}
          </button>
          {resendCooldown > 0 && (
            <span id="signup-otp-resend-reason" className="sr-only">
              {`For security purposes, please wait ${resendCooldown} seconds before trying again.`}
            </span>
          )}
        </div>
      </form>
    </Form>
  );
}
