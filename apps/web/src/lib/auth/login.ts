/**
 * Tenant login flow (spec 137 §3.2.5 split).
 *
 * Split from the former 1,314-line auth monolith
 * by spec 137 PR-A1b (audit #6 / spec §3.2.5). Function bodies are
 * verbatim; only imports/exports were re-wired to the new modules.
 */

import {
  canonicalizeGmailAddress,
  deriveSubdomainFromEmail,
  getSessionSecret,
  signSessionToken,
} from '@fbuploadpro/contracts';
import { sanitizeAuthRedirectUrl } from '@/lib/auth-redirect';
import { logServerError } from '../server-analytics';
import { getSupabaseAdminClient } from './clients';
import { verifyPassword } from './passwords';
import { localPasswordStore } from './stores';
import { findUserByEmail, type AuthUser } from './users';
import { ensureWorkspaceForUser } from './workspaces';

export async function loginTenantUser(params: {
  email: string;
  password: string;
  returnUrl?: string | undefined;
  requestHost?: string | null | undefined;
}): Promise<{ user: AuthUser; token: string; redirectUrl: string }> {
  let canonicalEmail: string;
  try {
    canonicalEmail = canonicalizeGmailAddress(params.email);
  } catch {
    canonicalEmail = params.email.trim().toLowerCase();
  }
  let user = await findUserByEmail(canonicalEmail);

  const supabase = getSupabaseAdminClient();
  if (supabase) {
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
      email: user?.email || canonicalEmail,
      password: params.password,
    });

    if (authError) {
      const isEmailNotConfirmed =
        authError.message?.toLowerCase().includes('email not confirmed') ||
        authError.code === 'email_not_confirmed' ||
        ((authError as { status?: number }).status === 400 &&
          authError.message?.toLowerCase().includes('confirm'));

      if (isEmailNotConfirmed) {
        const error = new Error('Please verify your email address to complete registration.');
        (error as unknown as { code: string; requiresOtp: boolean; email: string }).code = 'REQUIRES_OTP';
        (error as unknown as { requiresOtp: boolean }).requiresOtp = true;
        (error as unknown as { email: string }).email = canonicalEmail;
        throw error;
      }
      throw new Error('Invalid email or password');
    }

    // If user record wasn't loaded from public.users yet, construct from authenticated user and upsert
    if (!user && authData?.user) {
      const metadata = authData.user.user_metadata || {};
      const subdomain = metadata.subdomain || deriveSubdomainFromEmail(canonicalEmail);
      user = {
        id: authData.user.id,
        email: authData.user.email || canonicalEmail,
        name: metadata.name || null,
        phone: metadata.phone || null,
        subdomain,
        role: 'user',
        status: 'active',
      };
      try {
        await supabase.from('users').upsert(
          {
            id: user.id,
            email: user.email,
            normalized_email: canonicalEmail,
            name: user.name,
            phone: user.phone,
            role: 'user',
            status: 'active',
          },
          { onConflict: 'id' }
        );
        const wsSubdomain = await ensureWorkspaceForUser(
          supabase,
          user.id,
          user.name || canonicalEmail.split('@')[0],
          subdomain
        );
        user.subdomain = wsSubdomain;
      } catch (upsertErr) {
        logServerError('[Supabase PostgREST] User upsert on login error', upsertErr, { email: canonicalEmail });
      }
    }
  } else {
    const storedHash =
      localPasswordStore.get(canonicalEmail) ||
      localPasswordStore.get(params.email.trim().toLowerCase());
    if (!storedHash || !(await verifyPassword(params.password, storedHash))) {
      throw new Error('Invalid email or password');
    }
  }

  if (!user) {
    throw new Error('Invalid email or password');
  }

  if (user.status === 'suspended') {
    const error = new Error('Account is suspended');
    (error as unknown as { code: string }).code = 'ACCOUNT_SUSPENDED';
    throw error;
  }

  let allowedSubdomains: string[] = [user.subdomain];
  if (supabase) {
    try {
      const { data: allWorkspaces } = await supabase
        .from('workspaces')
        .select('subdomain')
        .eq('owner_id', user.id);
      const subs = Array.from(
        new Set(
          (allWorkspaces || [])
            .map((w: { subdomain?: string }) => w.subdomain?.toLowerCase())
            .filter((sub): sub is string => Boolean(sub))
        )
      );
      if (subs.length > 0) {
        allowedSubdomains = subs;
      }
    } catch {
      // Fallback to primary workspace subdomain
    }
  }

  const sessionSecret = getSessionSecret();
  const now = Math.floor(Date.now() / 1000);
  const minIat = user.passwordUpdatedAt ? Math.max(now, user.passwordUpdatedAt + 1) : now;
  const token = await signSessionToken(
    {
      userId: user.id,
      email: user.email,
      name: user.name,
      subdomain: user.subdomain,
      role: user.role,
      status: user.status,
      iat: minIat,
      allowedSubdomains,
    },
    sessionSecret,
    86400 * 30 // 30 days matching fbup_session cookie maxAge
  );

  const rootDomain = process.env.NEXT_PUBLIC_ROOT_DOMAIN || 'localhost:3000';
  // Sellers have no workspace: they always land on /seller, never
  // on a workspace URL (their session subdomain is only an
  // email-derived fallback). Any returnUrl is ignored for them.
  const redirectUrl =
    user.role === 'seller'
      ? '/seller'
      : sanitizeAuthRedirectUrl(
          params.returnUrl,
          user.subdomain,
          rootDomain,
          params.requestHost,
          allowedSubdomains
        );

  return {
    user,
    token,
    redirectUrl,
  };
}
