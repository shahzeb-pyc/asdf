/**
 * Password-reset OTP + password reset flows (spec 137 §3.2.5 split).
 *
 * Split from the former 1,314-line auth monolith
 * by spec 137 PR-A1b (audit #6 / spec §3.2.5). Function bodies are
 * verbatim; only imports/exports were re-wired to the new modules.
 */

import {
  canonicalizeGmailAddress,
  deriveSubdomainFromEmail,
} from '@fbuploadpro/contracts';
import { escapePostgrestFilterValue, resolveCanonicalEmail } from './email';
import { getSupabaseAdminClient, getSupabaseAuthClient } from './clients';
import { hashPassword } from './passwords';
import { localPasswordStore, localUserStore } from './stores';
import { findUserByEmail } from './users';
import { ensureWorkspaceForUser } from './workspaces';

export async function sendPasswordResetOtpViaSupabase(email: string): Promise<{
  success: boolean;
  otp?: string | undefined;
  error?: string | undefined;
}> {
  let canonicalEmail: string;
  try {
    canonicalEmail = canonicalizeGmailAddress(email);
  } catch {
    canonicalEmail = email.trim().toLowerCase();
  }

  const supabase = getSupabaseAdminClient();
  if (supabase) {
    const { error } = await supabase.auth.resetPasswordForEmail(canonicalEmail);
    if (error) {
      return { success: false, error: error.message };
    }
    return { success: true };
  }

  const { createPasswordResetOtp } = await import('@/lib/otp-service');
  const { otp } = await createPasswordResetOtp(canonicalEmail);
  console.info(`[SupabaseAuth Fallback] Simulated Password Reset OTP dispatch triggered for ${canonicalEmail}`);
  return { success: true, otp };
}

export async function resendPasswordResetOtpViaSupabase(email: string): Promise<{
  success: boolean;
  otp?: string | undefined;
  cooldownSecondsRemaining?: number | undefined;
  error?: string | undefined;
}> {
  let canonicalEmail: string;
  try {
    canonicalEmail = canonicalizeGmailAddress(email);
  } catch {
    canonicalEmail = email.trim().toLowerCase();
  }

  const supabase = getSupabaseAdminClient();
  if (supabase) {
    const { error } = await supabase.auth.resetPasswordForEmail(canonicalEmail);
    if (error) {
      return { success: false, error: error.message };
    }
    return { success: true };
  }

  const { resendPasswordResetOtp } = await import('@/lib/otp-service');
  return await resendPasswordResetOtp(canonicalEmail);
}

export async function resetUserPasswordWithOtp(params: {
  email: string;
  otp: string;
  password: string;
}): Promise<{ message: string }> {
  if (!params.password || typeof params.password !== 'string' || params.password.length < 8) {
    throw new Error('Password must be at least 8 characters long');
  }
  if (params.password.length > 128) {
    throw new Error('Password cannot exceed 128 characters');
  }

  let canonicalEmail: string;
  try {
    canonicalEmail = canonicalizeGmailAddress(params.email);
  } catch {
    canonicalEmail = params.email.trim().toLowerCase();
  }

  const supabase = getSupabaseAdminClient();
  if (supabase) {
    // Spec 168: verifyOtp + updateUser + getUser are session calls —
    // one auth-only client for the whole flow, never the admin singleton.
    const authClient = getSupabaseAuthClient();
    if (!authClient) {
      throw new Error('Supabase auth client is unavailable: NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required for password reset.');
    }
    const { error } = await authClient.auth.verifyOtp({
      email: canonicalEmail,
      token: params.otp,
      type: 'recovery',
    });
    if (error) {
      throw new Error('Invalid or expired verification code.');
    }

    const { error: updateError } = await authClient.auth.updateUser({
      password: params.password,
    });
    if (updateError) {
      const existingUser = await findUserByEmail(canonicalEmail);
      if (existingUser?.id) {
        await supabase.auth.admin.updateUserById(existingUser.id, {
          password: params.password,
        });
      } else {
        throw new Error(updateError.message);
      }
    }

    // Ensure public.users profile exists, is active, and records password_updated_at
    const nowIso = new Date().toISOString();
    try {
      const existingUser = await findUserByEmail(canonicalEmail);
      if (existingUser?.id) {
        await supabase
          .from('users')
          .update({
            status: 'active',
            password_updated_at: nowIso,
            updated_at: nowIso,
          })
          .eq('id', existingUser.id);
      } else {
        const { data: authUserData } = await authClient.auth.getUser();
        if (authUserData?.user) {
          const u = authUserData.user;
          const metadata = u.user_metadata || {};
          const subdomain = metadata.subdomain || deriveSubdomainFromEmail(canonicalEmail);
          await supabase.from('users').upsert(
            {
              id: u.id,
              email: u.email || canonicalEmail,
              normalized_email: canonicalEmail,
              name: metadata.name || null,
              phone: metadata.phone || null,
              role: 'user',
              status: 'active',
              password_updated_at: nowIso,
              updated_at: nowIso,
            },
            { onConflict: 'id' }
          );
          await ensureWorkspaceForUser(
            supabase,
            u.id,
            metadata.name || canonicalEmail.split('@')[0],
            subdomain
          );
        }
      }
    } catch (profileErr) {
      console.error('[Supabase PostgREST] Error activating user on password reset:', profileErr);
    }
  } else {
    // 1. Verify OTP with constant-time comparison and lockout checks in fallback
    const { verifyPasswordResetOtp } = await import('@/lib/otp-service');
    const verification = await verifyPasswordResetOtp(canonicalEmail, params.otp);
    if (!verification.success) {
      throw new Error(verification.error || 'Invalid or expired verification code.');
    }

    // 2. Hash new password in fallback
    const hashed = await hashPassword(params.password);
    localPasswordStore.set(canonicalEmail, hashed);

    let existing = localUserStore.get(canonicalEmail);
    if (!existing) {
      const rawSubdomain = deriveSubdomainFromEmail(canonicalEmail);
      existing = {
        id: crypto.randomUUID(),
        email: canonicalEmail,
        name: null,
        phone: null,
        subdomain: rawSubdomain,
        role: 'user',
        status: 'active',
      };
      localUserStore.set(canonicalEmail, existing);
    } else {
      existing.status = 'active';
    }
  }

  // 3. Invalidate existing sessions by updating passwordUpdatedAt
  const nowSeconds = Math.floor(Date.now() / 1000);
  const user = localUserStore.get(canonicalEmail);
  if (user) {
    user.passwordUpdatedAt = nowSeconds;
  }

  return {
    message: 'Your password has been successfully updated.',
  };
}


export async function resetUserPassword(params: {
  email?: string | undefined;
  password: string;
  otp?: string | undefined;
  token?: string | undefined;
  code?: string | undefined;
}): Promise<{ message: string }> {
  if (params.otp && params.email) {
    return resetUserPasswordWithOtp({
      email: params.email,
      otp: params.otp,
      password: params.password,
    });
  }

  if (!params.password || typeof params.password !== 'string' || params.password.length < 8) {
    throw new Error('Password must be at least 8 characters long');
  }
  if (params.password.length > 128) {
    throw new Error('Password cannot exceed 128 characters');
  }

  const recoveryToken = params.token || params.code;
  if (!recoveryToken || typeof recoveryToken !== 'string' || !recoveryToken.trim()) {
    throw new Error('A valid password reset link or token is required.');
  }

  const supabase = getSupabaseAdminClient();
  if (supabase) {
    // Spec 168: exchangeCodeForSession / verifyOtp / updateUser /
    // getUser are session calls — one auth-only client instance for the
    // whole flow, never the admin singleton. Trace note for the
    // no-code/no-token updateUser branch: the only caller (the
    // reset-password route) always passes otp, token, or code, and this
    // function's own guard throws unless token||code is present — so
    // that branch is unreachable via the route; its old session source
    // was a session stored on the shared admin client, i.e. the poison itself.
    const authClient = getSupabaseAuthClient();
    if (!authClient) {
      throw new Error('Supabase auth client is unavailable: NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required for password reset.');
    }
    if (params.code) {
      const { data, error: exchangeError } = await authClient.auth.exchangeCodeForSession(params.code);
      if (exchangeError || !data?.session) {
        throw new Error('Invalid or expired password reset link.');
      }
      const { error: updateError } = await authClient.auth.updateUser({
        password: params.password,
      });
      if (updateError) {
        throw new Error(updateError.message);
      }
    } else if (params.token) {
      const { data, error: verifyError } = await authClient.auth.verifyOtp({
        token_hash: params.token,
        type: 'recovery',
      });
      if (verifyError || !data?.session) {
        throw new Error('Invalid or expired password reset link.');
      }
      const { error: updateError } = await authClient.auth.updateUser({
        password: params.password,
      });
      if (updateError) {
        throw new Error(updateError.message);
      }
    } else {
      const { error } = await authClient.auth.updateUser({
        password: params.password,
      });
      if (error) {
        throw new Error(error.message);
      }
    }

    // Invalidate existing sessions in production by updating password_updated_at in public.users
    try {
      const nowIso = new Date().toISOString();
      const authUserData = typeof authClient.auth?.getUser === 'function' ? (await authClient.auth.getUser())?.data : null;
      const targetUserId = authUserData?.user?.id;
      if (targetUserId) {
        await supabase
          .from('users')
          .update({
            password_updated_at: nowIso,
            updated_at: nowIso,
          })
          .eq('id', targetUserId);
      } else if (params.email) {
        const canonicalEmail = resolveCanonicalEmail(params.email);
        const quoted = escapePostgrestFilterValue(canonicalEmail);
        await supabase
          .from('users')
          .update({
            password_updated_at: nowIso,
            updated_at: nowIso,
          })
          .or(`normalized_email.eq.${quoted},email.ilike.${quoted}`);
      }
    } catch (invalErr) {
      console.error('[Supabase PostgREST] Failed to persist password_updated_at on resetUserPassword:', invalErr);
    }
  } else {
    throw new Error('A valid password reset link or active Supabase session is required.');
  }

  return {
    message: 'Your password has been successfully updated.',
  };
}
