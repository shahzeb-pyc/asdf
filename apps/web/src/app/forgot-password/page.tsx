'use client';

/**
 * Password recovery (spec 136 §5.3) — one route, two steps (spec 018's
 * unified flow): email step → combined code + new-password step. Both
 * forms are on the §3.8 form standard (react-hook-form + zod on the
 * shared/ui Form primitives, `onTouched` validation, errors inline
 * only, input never cleared) and talk to the API through
 * the typed client — the three raw `fetch` calls that used to live
 * here are gone, and with them the local `FormErrorCallout` pattern
 * (deleted in this PR; UI Rule 11).
 *
 * Preserved behaviours (§4.3): the 60-second resend cooldown countdown
 * with the `Resend code (<N>s)` label, disabled while cooling down; the
 * success state, then the automatic redirect after 2,000 ms to
 * `/login?reset=success`; step 2's description naming the email the
 * code was sent to. OD-136-7 (?email= prefill) is NOT approved — the
 * page does not read an `email` parameter.
 */

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
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
import { AuthSplitLayout } from '@/components/auth/auth-split-layout';
import { PasswordInput } from '@/components/auth/password-input';
import { sanitizeAuthErrorMessage } from '@/lib/auth-errors';
import { api, isApiError } from '@/lib/api';
import {
  ForgotPasswordSuccessResponseSchema,
  ResendRecoveryCodeSuccessResponseSchema,
  ResetPasswordSuccessResponseSchema,
  type ForgotPasswordErrorBody,
  type ResetPasswordErrorBody,
} from '@/lib/api/schemas/auth';
import { reportError } from '@/lib/report-error';
import {
  forgotPasswordEmailFormSchema,
  resetPasswordFormSchema,
  type ForgotPasswordEmailFormValues,
  type ResetPasswordFormValues,
} from './forgot-password-form-schema';

/** Delay before redirecting to login after a successful password reset. */
const SUCCESS_REDIRECT_DELAY_MS = 2000;

const EMAIL_FIELD_ID = 'forgot-email';
const OTP_FIELD_ID = 'forgot-otp';
const PASSWORD_FIELD_ID = 'forgot-new-password';
const CONFIRM_FIELD_ID = 'forgot-confirm-password';

/* ------------------------------------------------------------------ */
/* Step 1 — email                                                      */
/* ------------------------------------------------------------------ */

function ForgotEmailForm({
  initialEmail,
  onCodeSent,
}: Readonly<{
  initialEmail: string;
  onCodeSent: (email: string) => void;
}>) {
  const [generalError, setGeneralError] = useState<string | null>(null);

  const form = useForm<ForgotPasswordEmailFormValues>({
    resolver: zodResolver(forgotPasswordEmailFormSchema),
    mode: 'onTouched',
    shouldFocusError: false,
    defaultValues: { email: initialEmail },
  });
  const { formState } = form;
  const isSubmitting = formState.isSubmitting;

  const onSubmit = async (values: ForgotPasswordEmailFormValues) => {
    setGeneralError(null);
    const cleanEmail = values.email.trim().toLowerCase();
    try {
      await api.post(
        '/api/auth/forgot-password',
        { email: cleanEmail },
        { schema: ForgotPasswordSuccessResponseSchema }
      );
      onCodeSent(cleanEmail);
    } catch (error) {
      if (!isApiError(error)) {
        reportError(error, { source: 'forgot-password-request' });
        setGeneralError("Couldn't process your request. Please check your connection and try again.");
        return;
      }
      const body = (error.cause ?? null) as ForgotPasswordErrorBody | null;
      if (error.status === 400 && body?.error) {
        form.setError('email', {
          type: 'server',
          message: sanitizeAuthErrorMessage(body.error),
        });
        return;
      }
      if (error.kind === 'network') {
        setGeneralError("Couldn't process your request. Please check your connection and try again.");
        return;
      }
      if (error.kind === 'parse' || (error.status !== undefined && error.status >= 500)) {
        reportError(error, {
          source: 'forgot-password-request',
          kind: error.kind,
          status: error.status,
        });
      }
      setGeneralError(
        sanitizeAuthErrorMessage(body?.error, "Couldn't send the verification code. Please try again.")
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
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem id={EMAIL_FIELD_ID}>
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
                    if (generalError) setGeneralError(null);
                  }}
                />
              </FormControl>
              <FormDescription>
                We will send a 6-digit verification code to your registered Gmail address.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        {generalError && (
          <p role="alert" className="text-metadata font-medium text-brand-rose">
            {generalError}
          </p>
        )}

        <Button type="submit" size="lg" loading={isSubmitting} className="mt-1 w-full">
          Send Verification Code
        </Button>
      </form>
    </Form>
  );
}

/* ------------------------------------------------------------------ */
/* Step 2 — verification code + new password                           */
/* ------------------------------------------------------------------ */

function ResetPasswordForm({
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
              <FormDescription>Enter the 6-digit numeric code sent to your email.</FormDescription>
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
          <p role="alert" className="text-metadata font-medium text-brand-rose">
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

/* ------------------------------------------------------------------ */
/* Page — step / success orchestration only                            */
/* ------------------------------------------------------------------ */

export interface ForgotPasswordPageProps {
  initialSuccess?: boolean | undefined;
}

export default function ForgotPasswordPage({ initialSuccess = false }: ForgotPasswordPageProps = {}) {
  const router = useRouter();
  const [step, setStep] = useState<1 | 2>(1);
  const [email, setEmail] = useState('');
  const [isSuccess, setIsSuccess] = useState(initialSuccess);
  const [redirectArmed, setRedirectArmed] = useState(false);

  // Success end (§4.3.3): the success state shows, then the timed
  // redirect closes the loop on the login page's reset-success banner.
  useEffect(() => {
    if (!redirectArmed) return;
    const timer = setTimeout(() => {
      router.push('/login?reset=success');
    }, SUCCESS_REDIRECT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [redirectArmed, router]);

  let content: React.ReactNode;
  if (isSuccess) {
    content = (
      <div className="flex flex-col gap-6">
        <Alert variant="success">
          <div className="flex flex-col gap-1">
            <AlertTitle>Password Updated</AlertTitle>
            <AlertDescription>
              Your password has been successfully reset. Redirecting you to sign in...
            </AlertDescription>
          </div>
        </Alert>
        <Button asChild size="lg" className="w-full">
          <Link href="/login?reset=success">Proceed to Sign In</Link>
        </Button>
      </div>
    );
  } else if (step === 1) {
    content = (
      <ForgotEmailForm
        initialEmail={email}
        onCodeSent={(cleanEmail) => {
          setEmail(cleanEmail);
          setStep(2);
        }}
      />
    );
  } else {
    content = (
      <ResetPasswordForm
        email={email}
        onBack={() => setStep(1)}
        onSuccess={() => {
          setIsSuccess(true);
          setRedirectArmed(true);
        }}
      />
    );
  }

  return (
    <AuthSplitLayout
      title={step === 1 ? 'Reset Password' : 'Set New Password'}
      description={
        step === 1
          ? 'Enter your registered Gmail address to receive a 6-digit verification code.'
          : `Enter the 6-digit verification code sent to ${email} and your new password.`
      }
      footer={
        <span className="text-metadata text-ink-sub">
          Remember your password?{' '}
          <Link href="/login" className="font-semibold text-link no-underline hover:underline">
            Sign in
          </Link>
        </span>
      }
    >
      {content}
    </AuthSplitLayout>
  );
}
