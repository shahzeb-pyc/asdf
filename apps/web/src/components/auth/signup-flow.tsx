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
 *
 * Paused back-navigation guard: when the server page renders this
 * flow while paused (OTP step only — the details step is paused-card
 * only on the server), BOTH back paths from the OTP step — the
 * footer "Return to form" button and the OTP step's "Wrong email?
 * Edit" button — land on the paused card, never on the details
 * form. Without this, a paused user on the OTP step could reach
 * the form and submit into a 403, the exact flash pattern the
 * server-side gate exists to prevent.
 */

import React, { useState } from 'react';
import Link from 'next/link';

import { AuthSplitLayout } from '@/components/auth/auth-split-layout';
import { SignupDetailsForm } from '@/components/auth/signup-details-form';
import { SignupOtpStep } from '@/components/auth/signup-otp-step';
import { SignupPausedCard } from '@/components/auth/signup-paused-card';
import { getSignupLayoutMeta } from '@/app/signup/signup-layout-meta';

export interface SignupFlowProps {
  initialStep?: 'details' | 'otp';
  initialEmail?: string;
  initialReturnUrl?: string | undefined;
  initialSuccessNotice?: string | null;
  /**
   * True when the server page rendered this flow while signups are
   * paused (OTP step only). The details step is never reachable
   * while paused: any step change back to 'details' renders the
   * paused card instead of the form.
   */
  initialIsPaused?: boolean;
}

export function SignupFlow({
  initialStep = 'details',
  initialEmail = '',
  initialReturnUrl,
  initialSuccessNotice = null,
  initialIsPaused = false,
}: Readonly<SignupFlowProps>) {
  const [step, setStep] = useState<'details' | 'otp'>(initialStep);
  const [email, setEmail] = useState(initialEmail);
  const [returnUrl] = useState<string | undefined>(initialReturnUrl);
  const [otpCooldown, setOtpCooldown] = useState(0);
  const [successNotice, setSuccessNotice] = useState<string | null>(initialSuccessNotice);

  // The paused gate lives in the server page; by the time this renders,
  // signups are either enabled or the user is on the OTP step.
  // The paused-details guard below is the client half of that gate:
  // it only fires when the server already said paused.
  const isPausedDetails = initialIsPaused && step === 'details';
  const layoutMeta = getSignupLayoutMeta(isPausedDetails, step, email);

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

  if (isPausedDetails) {
    return (
      <AuthSplitLayout
        title={layoutMeta.title}
        description={layoutMeta.description}
        footer={signInFooter}
      >
        <SignupPausedCard />
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
