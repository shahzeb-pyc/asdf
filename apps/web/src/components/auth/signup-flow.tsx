'use client';

/**
 * SignupFlow — the client-side signup flow (details → email OTP).
 * Extracted from the signup page so the paused gate can live in a
 * server component: this component NEVER decides whether signups are
 * allowed. The server page renders it only when signups are enabled,
 * or when the user is completing an OTP step while paused. Initial
 * values come from the server page's searchParams, not from
 * window.location, so there is no details-then-OTP flash on entry.
 *
 * Preserved behaviours: direct entry at the OTP step, the OTP step
 * staying completable while signups are paused, and the layout
 * titles/descriptions per state.
 */

import React, { useState } from 'react';
import Link from 'next/link';

import { AuthSplitLayout } from '@/components/auth/auth-split-layout';
import { SignupDetailsForm } from '@/components/auth/signup-details-form';
import { SignupOtpStep } from '@/components/auth/signup-otp-step';
import { getSignupLayoutMeta } from '@/app/signup/signup-layout-meta';

export interface SignupFlowProps {
  initialStep?: 'details' | 'otp';
  initialEmail?: string;
  initialReturnUrl?: string | undefined;
  initialSuccessNotice?: string | null;
}

export function SignupFlow({
  initialStep = 'details',
  initialEmail = '',
  initialReturnUrl,
  initialSuccessNotice = null,
}: Readonly<SignupFlowProps>) {
  const [step, setStep] = useState<'details' | 'otp'>(initialStep);
  const [email, setEmail] = useState(initialEmail);
  const [returnUrl] = useState<string | undefined>(initialReturnUrl);
  const [otpCooldown, setOtpCooldown] = useState(0);
  const [successNotice, setSuccessNotice] = useState<string | null>(initialSuccessNotice);

  // The paused gate lives in the server page; by the time this renders,
  // signups are either enabled or the user is on the OTP step.
  const layoutMeta = getSignupLayoutMeta(false, step, email);

  const signInFooter = (
    <span className="text-metadata text-ink-sub">
      Already have an account?{' '}
      <Link
        href={returnUrl ? `/login?returnUrl=${encodeURIComponent(returnUrl)}` : '/login'}
        className="font-semibold text-link no-underline hover:underline"
      >
        Sign in
      </Link>
    </span>
  );

  if (step === 'otp') {
    return (
      <AuthSplitLayout
        title={layoutMeta.title}
        description={layoutMeta.description}
        footer={
          <button
            type="button"
            onClick={() => setStep('details')}
            className="inline-flex min-h-11 items-center px-3 py-2.5 text-metadata text-ink-sub underline"
          >
            Need to change your details? Return to form
          </button>
        }
      >
        <SignupOtpStep
          email={email}
          returnUrl={returnUrl}
          initialCooldown={otpCooldown}
          onBack={() => setStep('details')}
        />
      </AuthSplitLayout>
    );
  }

  return (
    <AuthSplitLayout
      title={layoutMeta.title}
      description={layoutMeta.description}
      footer={signInFooter}
    >
      <SignupDetailsForm
        initialEmail={email || undefined}
        successNotice={successNotice}
        onDismissSuccessNotice={() => setSuccessNotice(null)}
        onRequiresOtp={(submittedEmail, cooldownSecondsRemaining) => {
          setEmail(submittedEmail);
          setOtpCooldown(cooldownSecondsRemaining);
          setStep('otp');
        }}
      />
    </AuthSplitLayout>
  );
}
