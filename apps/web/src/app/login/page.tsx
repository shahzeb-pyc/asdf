'use client';

/**
 * Login — the form standard's reference implementation (spec 137 §3.8,
 * PR-A6). react-hook-form + zod resolver on the shared/ui Form
 * primitives: `onTouched` validation, errors inline only — under
 * each field via FormMessage, and a single plain inline line above
 * the submit button for server/general errors; no summary box, input
 * never cleared by a failed submit, submit through the typed API
 * client (§3.1).
 *
 * Session-expired contract (§3.1): A1a's global 401 handler redirects
 * here with `?next=<path>&reason=session-expired`. This page renders
 * the plain-language session-expired notice for that reason, and the
 * post-login navigation honours `next` (or the legacy `returnUrl`) —
 * sanitized, so only safe in-app paths are ever followed.
 *
 * Behaviour preserved from the hand-rolled form it replaces: the
 * Gmail-only email rule and its wording, the OTP-pending redirect, the
 * suspended-account redirect, server 400 field errors mapped inline,
 * the reset-success / signed-out / password-changed banners, the email
 * prefill parameter, and the password field's show/hide toggle +
 * Caps Lock warning. Approved copy is unchanged — A6 was a
 * behaviour/standard conversion, not a redesign. Spec 136 (PR-136A)
 * later re-skinned this page's presentation residue (the footer
 * prompt/link) and the split layout/showcase chrome onto tokens;
 * the form logic, schema, and copy remain A6's, untouched.
 *
 * Spec 136 PR-136B: the password field now uses the shared auth
 * `PasswordInput` (components/auth) instead of the A6 inline control —
 * adopted under PR-136B's gate because this page's behavioural suite
 * (`page.test.tsx`) passes unmodified against the shared control.
 */

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';

import { AuthSplitLayout } from '@/components/auth/auth-split-layout';
import { LoginShowcasePanel } from '@/components/auth/login-showcase-panel';
import { PasswordInput } from '@/components/auth/password-input';
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
import { LoginSuccessResponseSchema, type LoginErrorBody } from '@/lib/api/schemas/auth';
import { reportError } from '@/lib/report-error';
import { loginFormSchema, type LoginFormValues } from './login-form-schema';

/** Spec §3.1's exact notice copy. */
export const SESSION_EXPIRED_NOTICE =
  'Your session expired — sign in again to pick up where you left off';

export interface LoginPageProps {
  initialResetSuccess?: boolean | undefined;
}

type LoginFieldName = 'email' | 'password';

/**
 * The return address this page may send to POST /api/auth/login.
 *
 * Why this exists: the page's `returnUrl` state comes from
 * `sanitizeAuthRedirectUrl`, which is a *post-login navigation* helper
 * and may legitimately return an ABSOLUTE URL (e.g. the workspace
 * subdomain the user arrived from). The login API's
 * `LoginRequestSchema` only accepts a RELATIVE path (`SafeReturnUrlSchema`:
 * starts with '/', never '//', no backslash, never /dashboard), so
 * sending the absolute URL made the API answer 400
 * `{ error: 'Validation failed' }` — and since the page only maps
 * field errors for email/password, that surfaced as the bare line
 * above the Sign In button with no explanation.
 *
 * This converts to a relative path before sending: an absolute URL
 * keeps only its pathname + search + hash; an already-relative path
 * passes through; anything else the API would reject (/dashboard,
 * protocol-relative, backslashed, non-path garbage) is omitted so the
 * server falls back to its default instead of rejecting the login.
 * The server still rebuilds the correct workspace address from the
 * relative path (loginTenantUser → sanitizeAuthRedirectUrl with the
 * user's subdomain), so the user still lands where they came from.
 * The server schema is deliberately NOT loosened. A relative result
 * that does not start with '/' is also omitted (opaque absolute URLs
 * parse to a bare path segment, which is not a sendable in-app path).
 */
export function toApiReturnUrl(returnUrl: string | undefined): string | undefined {
  if (!returnUrl) return undefined;
  const trimmed = returnUrl.trim();
  if (!trimmed || trimmed.startsWith('//') || trimmed.includes('\\')) return undefined;
  let relative: string;
  try {
    // Absolute URL (has a scheme) — keep only the in-app path.
    const parsed = new URL(trimmed);
    relative = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    // Not an absolute URL: only a relative path is sendable.
    if (!trimmed.startsWith('/')) return undefined;
    relative = trimmed;
  }
  if (relative.startsWith('//')) return undefined;
  // Hardening: only a path starting with '/' may be sent — an opaque
  // absolute URL (e.g. `https:foo`) parses to a bare path segment.
  if (!relative.startsWith('/')) return undefined;
  const pathOnly = relative.split(/[?#]/, 1)[0];
  if (pathOnly === '/dashboard' || pathOnly.startsWith('/dashboard/')) return undefined;
  return relative;
}

const FIELD_IDS: Record<LoginFieldName, string> = {
  email: 'login-email',
  password: 'login-password',
};

export default function LoginPage({ initialResetSuccess = false }: LoginPageProps = {}) {
  const [returnUrl, setReturnUrl] = useState<string | undefined>(undefined);
  const [isResetSuccess, setIsResetSuccess] = useState(initialResetSuccess);
  const [infoBanner, setInfoBanner] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm<LoginFormValues>({
    resolver: zodResolver(loginFormSchema),
    mode: 'onTouched',
    shouldFocusError: false,
    defaultValues: { email: '', password: '' },
  });
  const { formState } = form;
  const isSubmitting = formState.isSubmitting;

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    // §3.1's handler sends `next`; older flows send `returnUrl`. Both
    // are sanitized — only safe in-app paths survive (no open redirect).
    const rawReturn = params.get('next') ?? params.get('returnUrl');
    if (rawReturn) {
      setReturnUrl(sanitizeAuthRedirectUrl(rawReturn));
    }
    const emailParam = params.get('email');
    if (emailParam) {
      form.setValue('email', emailParam);
    }
    if (params.get('reset') === 'success') {
      setIsResetSuccess(true);
    }
    if (params.get('logout') === 'success') {
      setInfoBanner('You have been signed out.');
    }
    if (params.get('reason') === 'password_changed') {
      setInfoBanner(
        'You were signed out because your password was changed. Sign in again.'
      );
    }
    if (params.get('reason') === 'session-expired') {
      setSessionExpired(true);
    }
    // Mount-only: the query string is the page's entry state.
  }, []);

  const handleServerFieldErrors = (body: LoginErrorBody): boolean => {
    if (!body.details) return false;
    let mapped = false;
    for (const name of Object.keys(FIELD_IDS) as LoginFieldName[]) {
      const messages = body.details[name];
      if (Array.isArray(messages) && messages.length > 0 && typeof messages[0] === 'string') {
        form.setError(name, { type: 'server', message: messages[0] });
        mapped = true;
      }
    }
    return mapped;
  };

  const onSubmit = async (values: LoginFormValues) => {
    setServerError(null);
    try {
      // Send only a relative returnUrl: the API schema rejects absolute
      // URLs, and sanitizeAuthRedirectUrl may have produced one (see
      // toApiReturnUrl). Omitting it lets the server default sensibly.
      const apiReturnUrl = toApiReturnUrl(returnUrl);
      const data = await api.post(
        '/api/auth/login',
        {
          email: values.email.trim(),
          password: values.password,
          ...(apiReturnUrl ? { returnUrl: apiReturnUrl } : {}),
        },
        { schema: LoginSuccessResponseSchema }
      );
      completeAuthRedirect(data.redirectUrl, data.user);
    } catch (error) {
      if (!isApiError(error)) {
        reportError(error, { source: 'login-submit' });
        setServerError("Couldn't sign you in. Please check your connection and try again.");
        return;
      }
      const body = (error.cause ?? null) as LoginErrorBody | null;

      if (body?.requiresOtp) {
        const targetEmail = body.email || values.email.trim();
        window.location.href = `/signup?step=otp&email=${encodeURIComponent(targetEmail)}&notice=pending_verification`;
        return;
      }
      if (error.status === 403 && body?.redirectUrl) {
        window.location.href = body.redirectUrl;
        return;
      }
      if (error.status === 400 && body && handleServerFieldErrors(body)) {
        return;
      }
      if (error.kind === 'network') {
        setServerError("Couldn't sign you in. Please check your connection and try again.");
        return;
      }
      if (error.kind === 'parse' || (error.status !== undefined && error.status >= 500)) {
        reportError(error, { source: 'login-submit', kind: error.kind, status: error.status });
      }
      // A 401 from the login endpoint itself is bad credentials, not a
      // session expiry (the client maps every 401 to session-expired;
      // the login route is excluded from the redirect, and the server's
      // own message is the one the form has always shown).
      setServerError(
        sanitizeAuthErrorMessage(body?.error, 'Invalid email or password. Please try again.')
      );
    }
  };

  return (
    <AuthSplitLayout
      title="Sign In"
      description="Welcome back. Sign in to your workspace."
      showcase={<LoginShowcasePanel />}
      footer={
        <span className="text-metadata text-ink-sub">
          Don&apos;t have an account?{' '}
          <Link
            href={returnUrl ? `/signup?returnUrl=${encodeURIComponent(returnUrl)}` : '/signup'}
            className="font-semibold text-primary no-underline"
          >
            Create one
          </Link>
        </span>
      }
    >
      <Form {...form}>
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={form.handleSubmit(onSubmit)}
        >
          {sessionExpired && (
            <Alert variant="warning">
              <div className="flex flex-col gap-1">
                <AlertDescription>{SESSION_EXPIRED_NOTICE}</AlertDescription>
              </div>
            </Alert>
          )}
          {isResetSuccess && (
            <Alert variant="success">
              <div className="flex flex-col gap-1">
                <AlertTitle>Password Updated</AlertTitle>
                <AlertDescription>
                  Your password has been reset. Sign in with your new password.
                </AlertDescription>
              </div>
            </Alert>
          )}
          {infoBanner && (
            <Alert>
              <div className="flex flex-col gap-1">
                <AlertDescription>{infoBanner}</AlertDescription>
              </div>
            </Alert>
          )}

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
                    autoComplete="username"
                    required
                    disabled={isSubmitting}
                    {...field}
                  />
                </FormControl>
                <FormDescription>Only @gmail.com (or @googlemail.com) accounts are supported.</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="password"
            render={({ field }) => (
              <FormItem id={FIELD_IDS.password}>
                <div className="flex items-center justify-between">
                  <FormLabel>Password</FormLabel>
                  <Link
                    href="/forgot-password"
                    className="text-body font-medium text-link hover:underline"
                  >
                    Forgot password?
                  </Link>
                </div>
                <FormControl>
                  <PasswordInput
                    placeholder="••••••••••••"
                    autoComplete="current-password"
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
            <p role="alert" className="text-metadata font-medium text-brand-rose">
              {serverError}
            </p>
          )}

          <Button type="submit" size="lg" loading={isSubmitting} className="mt-1 w-full">
            Sign In
          </Button>
        </form>
      </Form>
    </AuthSplitLayout>
  );
}
