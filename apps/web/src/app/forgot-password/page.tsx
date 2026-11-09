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
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/shared/ui/form';
import { Input } from '@/components/shared/ui/input';
import { Button } from '@/components/shared/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/shared/ui/alert';
import dynamic from 'next/dynamic';

import { AuthSplitLayout } from '@/components/auth/auth-split-layout';
import { sanitizeAuthErrorMessage } from '@/lib/auth-errors';
import { api, isApiError } from '@/lib/api';
import {
  ForgotPasswordSuccessResponseSchema,
  type ForgotPasswordErrorBody,
} from '@/lib/api/schemas/auth';
import { reportError } from '@/lib/report-error';
import {
  forgotPasswordEmailFormSchema,
  type ForgotPasswordEmailFormValues,
} from './forgot-password-form-schema';

/** Delay before redirecting to login after a successful password reset. */
const SUCCESS_REDIRECT_DELAY_MS = 2000;

/**
 * Spec 159 O3 — step 2 loads on demand, not in first load. It only
 * renders after the email step succeeds, so its chunk is fetched at
 * that transition instead of upfront.
 */
const ResetPasswordForm = dynamic(
  () => import('@/components/auth/reset-password-form').then((m) => m.ResetPasswordForm),
  { loading: () => null }
);

const EMAIL_FIELD_ID = 'forgot-email';

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
              <FormMessage />
            </FormItem>
          )}
        />

        {generalError && (
          <p role="alert" className="text-metadata font-medium text-signal-critical">
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
              Your password has been reset. Taking you to sign in…
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
