import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as authErrorsClient from './auth-errors';

/**
 * Spec 159 O2 guard — the auth-errors split.
 *
 * `lib/auth-errors.ts` is imported by client components (login page,
 * forgot-password page, both signup forms). It MUST NOT import
 * `next/server`: that single import dragged Next's whole server
 * runtime (~28 KB gzip, chunk 1919) into the browser bundle.
 * `formatAuthErrorResponse` (the only `NextResponse` user) lives in
 * the server-only `lib/auth-errors-server.ts`, imported by the 7
 * API routes under `app/api/auth/*` and by nothing client-reachable.
 *
 * This test pins the split at source level so a future re-merge of
 * the two modules fails loudly in CI instead of silently re-adding
 * the chunk. The build-output proof (chunk 1919 absent from the
 * login/forgot/signup first-load script lists) is measured in the
 * spec 159 build stage with the HTML-script method.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const read = (name: string) => readFileSync(join(HERE, name), 'utf8');

const SERVER_ROUTES = [
  'forgot-password/resend/route.ts',
  'forgot-password/route.ts',
  'login/route.ts',
  'reset-password/route.ts',
  'signup/resend-otp/route.ts',
  'signup/route.ts',
  'signup/verify-otp/route.ts',
];

describe('auth-errors split (spec 159 O2)', () => {
  it('client module imports no next/server code', () => {
    const source = read('auth-errors.ts');
    expect(source).not.toContain('next/server');
    expect(source).not.toContain('NextResponse');
  });

  it('client module does not export the server-only formatter', () => {
    expect('formatAuthErrorResponse' in authErrorsClient).toBe(false);
    expect('AuthErrorResponseOptions' in authErrorsClient).toBe(false);
  });

  it('client helpers still work (sanitizer strips technical leaks)', () => {
    expect(authErrorsClient.sanitizeAuthErrorMessage('postgres connection refused')).toBe(
      'Unable to complete your request at this moment. Please try again shortly.'
    );
    expect(authErrorsClient.sanitizeAuthErrorMessage('Invalid email or password')).toBe(
      'Invalid email or password'
    );
    expect(authErrorsClient.isEmailRateLimitError({ code: 'over_email_send_rate_limit' })).toBe(true);
  });

  it('server module owns the formatter and the NextResponse import', () => {
    const source = read('auth-errors-server.ts');
    expect(source).toContain("from 'next/server'");
    expect(source).toContain('export function formatAuthErrorResponse');
    expect(source).toContain('export interface AuthErrorResponseOptions');
  });

  it('all 7 auth API routes import the formatter from the server module', () => {
    for (const route of SERVER_ROUTES) {
      const source = readFileSync(join(HERE, '..', 'app', 'api', 'auth', route), 'utf8');
      expect(source).toContain("from '@/lib/auth-errors-server'");
      expect(source).not.toContain("from '@/lib/auth-errors'");
    }
  });

  it('no client-reachable auth file imports the server module', () => {
    const clientFiles = [
      join(HERE, '..', 'app', 'login', 'page.tsx'),
      join(HERE, '..', 'app', 'forgot-password', 'page.tsx'),
      join(HERE, '..', 'components', 'auth', 'signup-details-form.tsx'),
      join(HERE, '..', 'components', 'auth', 'signup-otp-step.tsx'),
    ];
    for (const file of clientFiles) {
      expect(readFileSync(file, 'utf8')).not.toContain('auth-errors-server');
    }
  });
});
