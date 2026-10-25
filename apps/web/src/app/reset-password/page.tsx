'use client';

/**
 * Legacy recovery URL (spec 136 §5.3, OD-136-5): an explanatory
 * redirect stub — emailed legacy reset links may still land here, so
 * the route is kept, rebuilt on primitives. It explains that recovery
 * moved to the 6-digit code BEFORE its timed redirect (UX Rule 8),
 * auto-redirects to `/forgot-password` after 1,500 ms, and offers a
 * manual action for anyone who doesn't want to wait. Copy verbatim
 * (§3.3).
 */

import React, { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

import { Button } from '@/components/shared/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/shared/ui/alert';
import { AuthSplitLayout } from '@/components/auth/auth-split-layout';

/** Delay before redirecting to the OTP recovery page. */
const REDIRECT_DELAY_MS = 1500;

export default function ResetPasswordPage() {
  const router = useRouter();

  useEffect(() => {
    // Gracefully route visitors to the unified OTP recovery interface
    const timer = setTimeout(() => {
      router.replace('/forgot-password');
    }, REDIRECT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [router]);

  return (
    <AuthSplitLayout
      title="Reset password"
      description="Password reset uses a 6-digit code sent to your email."
      footer={
        <span className="text-metadata text-ink-sub">
          Back to{' '}
          <Link href="/login" className="font-semibold text-link no-underline hover:underline">
            Sign in
          </Link>
        </span>
      }
    >
      <div className="flex flex-col gap-6">
        <Alert>
          <div className="flex flex-col gap-1">
            <AlertTitle>Redirecting to Reset password</AlertTitle>
            <AlertDescription>
              Taking you to the reset page…
            </AlertDescription>
          </div>
        </Alert>
        <Button asChild size="lg" className="w-full">
          <Link href="/forgot-password">Go to Reset password</Link>
        </Button>
      </div>
    </AuthSplitLayout>
  );
}
