/**
 * Signup (spec 136 §5.2) — server page, page-level orchestration only.
 *
 * The paused gate lives HERE, on the server, and is evaluated at
 * request time from the current runtime env (the same env the signup
 * API reads). It must not live in a client component: NEXT_PUBLIC_*
 * values are inlined into the client bundle at BUILD time, so a
 * client-side gate shows the form based on the flag at the last
 * build, then the API correctly 403s — and the server-rendered paused
 * card flashes into the form on hydration. With the gate here, a
 * paused render contains no form at all, so there is nothing to flash
 * into, and no 'Check the form' 403 can follow a form the user
 * should never have seen.
 *
 * Preserved behaviours (§4.2): direct entry at the OTP step (login's
 * OTP-pending redirect depends on it), the OTP step staying completable
 * while signups are paused, and the layout titles/descriptions per
 * state. The forms themselves live in `components/auth/`
 * (`SignupDetailsForm`, `SignupOtpStep`, via `SignupFlow`) on the
 * §3.8 form standard.
 */

import React from 'react';
import Link from 'next/link';

import { AuthSplitLayout } from '@/components/auth/auth-split-layout';
import { SignupFlow } from '@/components/auth/signup-flow';
import { SignupPausedCard } from '@/components/auth/signup-paused-card';
import { sanitizeAuthRedirectUrl } from '@/lib/auth-redirect';
import { isSignupEnabled } from '@fbuploadpro/contracts';
import {
  signupFormSchema,
  type SignupFormValues,
} from './signup-form-schema';
import { getSignupLayoutMeta } from './signup-layout-meta';

export { getSignupLayoutMeta } from './signup-layout-meta';

export interface FieldErrors {
  name?: string | undefined;
  phone?: string | undefined;
  email?: string | undefined;
  password?: string | undefined;
  confirmPassword?: string | undefined;
  otp?: string | undefined;
}

/**
 * Kept for parity with the previous hand-rolled validator: runs the zod
 * form schema and returns the first message per field. The details form
 * itself validates through the RHF resolver.
 */
export function validateSignupDetails(input: SignupFormValues): FieldErrors {
  const result = signupFormSchema.safeParse(input);
  if (result.success) return {};
  const errors: FieldErrors = {};
  for (const issue of result.error.issues) {
    const key = issue.path[0];
    if (typeof key === 'string' && !(key in errors)) {
      errors[key as keyof FieldErrors] = issue.message;
    }
  }
  return errors;
}

export function mapApiFieldErrors(details: unknown): FieldErrors {
  const mappedErrors: FieldErrors = {};
  if (!details || typeof details !== 'object') return mappedErrors;
  for (const [key, msgs] of Object.entries(details as Record<string, unknown>)) {
    if (Array.isArray(msgs) && msgs.length > 0 && typeof msgs[0] === 'string') {
      mappedErrors[key as keyof FieldErrors] = msgs[0];
    }
  }
  return mappedErrors;
}

export function parseInitialQueryParams(search: string) {
  const params = new URLSearchParams(search);
  const ret = params.get('returnUrl');
  const initialStep = params.get('step');
  const emailParam = params.get('email');
  const noticeParam = params.get('notice');
  return {
    returnUrl: ret ? sanitizeAuthRedirectUrl(ret) : undefined,
    step: initialStep === 'otp' ? ('otp' as const) : undefined,
    email: emailParam || undefined,
    successNotice:
      noticeParam === 'pending_verification'
        ? 'We sent a fresh 6-digit verification code. Please confirm your email to complete registration.'
        : undefined,
  };
}

export default async function SignupPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolved = (await searchParams) ?? {};
  const first = (v: string | string[] | undefined) =>
    Array.isArray(v) ? v[0] : v;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(resolved)) {
    const v = first(value);
    if (v !== undefined) query.set(key, v);
  }
  const initial = parseInitialQueryParams(query.toString() ? `?${query.toString()}` : '');

  // Server-side gate, request time — never the build-time client value.
  const isPaused = !isSignupEnabled() && initial.step !== 'otp';

  if (isPaused) {
    const layoutMeta = getSignupLayoutMeta(true, 'details', initial.email ?? '');
    return (
      <AuthSplitLayout
        title={layoutMeta.title}
        description={layoutMeta.description}
        footer={
          <span className="text-metadata text-ink-sub">
            Already have an account?{' '}
            <Link
              href={
                initial.returnUrl
                  ? `/login?returnUrl=${encodeURIComponent(initial.returnUrl)}`
                  : '/login'
              }
              className="font-semibold text-link no-underline hover:underline"
            >
              Sign in
            </Link>
          </span>
        }
      >
        <SignupPausedCard />
      </AuthSplitLayout>
    );
  }

  // When paused, the flow only ever renders for the OTP step (the
  // details branch above already returned the paused card). Pass
  // the paused state in so a back-navigation from the OTP step
  // lands on the paused card, never on the details form.
  return (
    <SignupFlow
      initialStep={initial.step ?? 'details'}
      initialEmail={initial.email ?? ''}
      initialReturnUrl={initial.returnUrl}
      initialSuccessNotice={initial.successNotice ?? null}
      initialIsPaused={!isSignupEnabled()}
    />
  );
}
