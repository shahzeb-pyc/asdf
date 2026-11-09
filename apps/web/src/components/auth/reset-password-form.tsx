'use client';

/**
 * ResetPasswordForm — step 2 of password recovery (verification code
 * + new password). Split out of `app/forgot-password/page.tsx` for
 * spec 159 O3 so it loads on demand via `next/dynamic` instead of
 * shipping in the first load: it only renders after the email step
 * succeeds. Behaviour unchanged (60 s resend cooldown, server-outcome
 * field routing, 2 s success redirect handled by the page).
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
import { PasswordInput } from '@/components/auth/password-input';
import { sanitizeAuthErrorMessage } from '@/lib/auth-errors';
import { api, isApiError } from '@/lib/api';
import {
  ResendRecoveryCodeSuccessResponseSchema,
  ResetPasswordSuccessResponseSchema,
  type ForgotPasswordErrorBody,
  type ResetPasswordErrorBody,
} from '@/lib/api/schemas/auth';
import { reportError } from '@/lib/report-error';
import {
  resetPasswordFormSchema,
  type ResetPasswordFormValues,
} from '@/app/forgot-password/forgot-password-form-schema';

const OTP_FIELD_ID = 'forgot-otp';
const PASSWORD_FIELD_ID = 'forgot-new-password';
const CONFIRM_FIELD_ID = 'forgot-confirm-password';

/* ------------------------------------------------------------------ */
/* Step 2 — verification code + new password                           */
/* ------------------------------------------------------------------ */

export function ResetPasswordForm({
  email,
  onBack,
  onSuccess,
}: Readonly<{
  email: string;
  onBack: () => void;
  onSuccess: () => void;
}>) {
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [resendSuccessMessage, setResendSuccessMessage] = useState<string | null>(null);
  const [isResending, setIsResending] = useState(false);
  const [cooldownSeconds, setCooldownSeconds] = useState(60);

  const form = useForm<ResetPasswordFormValues>({
    resolver: zodResolver(resetPasswordFormSchema),
    mode: 'onTouched',
    shouldFocusError: false,
    defaultValues: { otp: '', password: '', confirmPassword: '' },
  });
  const { formState } = form;
  const isSubmitting = formState.isSubmitting;

  // Resend cooldown countdown (§4.3.2): ticks while on step 2.
  useEffect(() => {
    if (cooldownSeconds <= 0) return;
    const interval = setInterval(() => {
      setCooldownSeconds((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, [cooldownSeconds]);

  const handleResendOtp = async () => {
    if (cooldownSeconds > 0 || isResending) return;
    setGeneralError(null);
    setResendSuccessMessage(null);
    setIsResending(true);
    try {
      await api.post(
        '/api/auth/forgot-password/resend',
        { email: email.trim().toLowerCase() },
        { schema: ResendRecoveryCodeSuccessResponseSchema }
      );
      setCooldownSeconds(60);
      setResendSuccessMessage("We've sent a fresh code. Any earlier codes no longer work.");
    } catch (error) {
      if (!isApiError(error)) {
        reportError(error, { source: 'forgot-password-resend' });
        setGeneralError("Couldn't resend the code. Please check your connection.");
        return;
      }
      const body = (error.cause ?? null) as ForgotPasswordErrorBody | null;
      if (body?.cooldownSecondsRemaining) {
        setCooldownSeconds(body.cooldownSecondsRemaining);
      }
      if (error.kind === 'network') {
        setGeneralError("Couldn't resend the code. Please check your connection.");
        return;
      }
      if (error.kind === 'parse' || (error.status !== undefined && error.status >= 500)) {
        reportError(error, {
          source: 'forgot-password-resend',
          kind: error.kind,
          status: error.status,
        });
      }
      setGeneralError(sanitizeAuthErrorMessage(body?.error, "Couldn't resend the code right now."));
    } finally {
      setIsResending(false);
    }
  };

  let resendButtonLabel = 'Resend code';
  if (cooldownSeconds > 0) {
    resendButtonLabel = `Resend code (${cooldownSeconds}s)`;
  } else if (isResending) {
    resendButtonLabel = 'Sending...';
  }

  const onSubmit = async (values: ResetPasswordFormValues) => {
    setGeneralError(null);
    setResendSuccessMessage(null);
    const cleanOtp = values.otp.replace(/\D/g, '').trim();
    try {
      await api.post(
        '/api/auth/reset-password',
        { email: email.trim().toLowerCase(), otp: cleanOtp, password: values.password },
        { schema: ResetPasswordSuccessResponseSchema }
      );
      onSuccess();
    } catch (error) {
      if (!isApiError(error)) {
        reportError(error, { source: 'reset-password-submit' });
        setGeneralError("Couldn't update your password. Please try again.");
        return;
      }
      const body = (error.cause ?? null) as ResetPasswordErrorBody | null;
      if (error.kind === 'network') {
        setGeneralError("Couldn't update your password. Please try again.");
        return;
      }
      if (error.kind === 'parse' || (error.status !== undefined && error.status >= 500)) {
        reportError(error, {
          source: 'reset-password-submit',
          kind: error.kind,
          status: error.status,
        });
      }
      // Server-outcome routing (preserved): code/attempt failures land
      // on the code field, password failures on the password field,
      // everything else in the summary.
      const errorMsg = sanitizeAuthErrorMessage(
        body?.error,
        "Couldn't update your password. Please try again."
      );
      const lowered = errorMsg.toLowerCase();
      if (lowered.includes('code') || lowered.includes('attempt')) {
        form.setError('otp', { type: 'server', message: errorMsg });
      } else if (lowered.includes('password')) {
        form.setError('password', { type: 'server', message: errorMsg });
      } else {
        setGeneralError(errorMsg);
      }
    }
  };

  return (
    <Form {...form}>
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={form.handleSubmit(onSubmit)}
      >
        <FormField
          control={form.control}
          name="otp"
          render={({ field }) => (
            <FormItem id={OTP_FIELD_ID}>
              <FormLabel>Verification Code</FormLabel>
              <FormControl>
                <Input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="123456"
                  autoComplete="one-time-code"
                  required
                  disabled={isSubmitting}
                  {...field}
                  onChange={(e) => {
                    field.onChange(e.target.value.replace(/\D/g, '').slice(0, 6));
                    if (generalError) setGeneralError(null);
                  }}
                />
              </FormControl>
              <FormDescription>Enter the 6-digit code sent to your email.</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem id={PASSWORD_FIELD_ID}>
              <FormLabel>New Password</FormLabel>
              <FormControl>
                <PasswordInput
                  placeholder="••••••••••••"
                  autoComplete="new-password"
                  required
                  disabled={isSubmitting}
                  {...field}
                  onChange={(e) => {
                    field.onChange(e);
                    if (generalError) setGeneralError(null);
                  }}
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
            <FormItem id={CONFIRM_FIELD_ID}>
              <FormLabel>Confirm New Password</FormLabel>
              <FormControl>
                <PasswordInput
                  placeholder="••••••••••••"
                  autoComplete="new-password"
                  required
                  disabled={isSubmitting}
                  {...field}
                  onChange={(e) => {
                    field.onChange(e);
                    if (generalError) setGeneralError(null);
                  }}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {resendSuccessMessage && (
          <output className="text-metadata font-medium text-brand-emerald">
            {resendSuccessMessage}
          </output>
        )}

        {generalError && (
          <p role="alert" className="text-metadata font-medium text-signal-critical">
            {generalError}
          </p>
        )}

        <Button type="submit" size="lg" loading={isSubmitting} className="mt-1 w-full">
          Update Password
        </Button>

        <div className="mt-1 flex items-center justify-between gap-3 text-metadata">
          <button
            type="button"
            onClick={handleResendOtp}
            disabled={cooldownSeconds > 0 || isResending}
            className="inline-flex min-h-11 items-center px-1 py-2.5 font-medium text-link disabled:cursor-not-allowed disabled:text-ink-dim"
          >
            {resendButtonLabel}
          </button>

          <button
            type="button"
            onClick={onBack}
            className="inline-flex min-h-11 items-center px-1 py-2.5 text-ink-sub underline"
          >
            Change email address
          </button>
        </div>
      </form>
    </Form>
  );
}

