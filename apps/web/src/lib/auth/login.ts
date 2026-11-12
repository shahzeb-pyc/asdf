/**
 * Tenant login flow (spec 137 §3.2.5 split).
 *
 * Split from the former 1,314-line auth monolith
 * by spec 137 PR-A1b (audit #6 / spec §3.2.5). Function bodies are
 * verbatim; only imports/exports were re-wired to the new modules.
 */

import {
  asWorkspaceIdClaim,
  canonicalizeGmailAddress,
  deriveSubdomainFromEmail,
  getSessionSecret,
  signSessionToken,
} from '@fbuploadpro/contracts';
import { resolveAdminLoginRedirect, sanitizeAuthRedirectUrl } from '@/lib/auth-redirect';
import { logServerError } from '../server-analytics';
import { getSupabaseAdminClient, getSupabaseAuthClient } from './clients';
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
    const authClient = getSupabaseAuthClient();
    if (!authClient) {
      throw new Error('Supabase auth client is unavailable: NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required for password login.');
    }
    const { data: authData, error: authError } = await authClient.auth.signInWithPassword({
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
  // S3: the id of the user's primary workspace, for the session
  // token's workspaceId claim (role === 'user' only — admin and
  // seller tokens carry no claim). Resolved from the same
  // owner-checked select below, so minting adds zero extra queries.
  // A miss mints claimless and never fails login (rule 5).
  let workspaceId: string | undefined;
  if (supabase) {
    try {
      const { data: allWorkspaces } = await supabase
        .from('workspaces')
        .select('id, subdomain')
        .eq('owner_id', user.id);
      const rows = (allWorkspaces || []) as Array<{ id?: string; subdomain?: string }>;
      const subs = Array.from(
        new Set(
          rows
            .map((w: { subdomain?: string }) => w.subdomain?.toLowerCase())
            .filter((sub): sub is string => Boolean(sub))
        )
      );
      if (subs.length > 0) {
        allowedSubdomains = subs;
      }
      if (user.role === 'user') {
        const match = rows.find(
          (w) => w.subdomain?.toLowerCase() === user.subdomain.toLowerCase() && w.id
        );
        workspaceId = asWorkspaceIdClaim(match?.id);
        if (!workspaceId) {
          logServerError('[login] workspace id for session claim not resolved', null, {
            source: 'login',
            subdomain: user.subdomain,
          });
        }
      }
    } catch (err) {
      // Fallback to primary workspace subdomain. A failed select also
      // means no claim for this login — loud-log the miss for a user
      // session, never fail login for the optimisation (S3 rule 5).
      if (user.role === 'user') {
        logServerError('[login] workspace id for session claim not resolved', err, {
          source: 'login',
          subdomain: user.subdomain,
        });
      }
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
      ...(workspaceId ? { workspaceId } : {}),
      allowedSubdomains,
    },
    sessionSecret,
    86400 * 30 // 30 days matching fbup_session cookie maxAge
  );

  const rootDomain = process.env.NEXT_PUBLIC_ROOT_DOMAIN || 'localhost:3000';
  // Sellers have no workspace: they always land on /seller, never
  // on a workspace URL (their session subdomain is only an
  // email-derived fallback). Any returnUrl is ignored for them.
  // Admins land on the admin section: a /admin/* returnUrl is
  // honored, an old tenant admin location maps through the compat
  // table, anything else becomes /admin/subscriptions. Admin
  // returnUrls bypass sanitizeAuthRedirectUrl, which would
  // tenant-prefix a /admin/* path. Users keep the sanitized
  // returnUrl or tenant home.
  const redirectUrl =
    user.role === 'seller'
      ? '/seller'
      : user.role === 'admin'
        ? resolveAdminLoginRedirect(params.returnUrl)
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
