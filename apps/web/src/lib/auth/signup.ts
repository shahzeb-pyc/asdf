/**
 * Tenant signup + signup-OTP flows (spec 137 §3.2.5 split).
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
  validateAndFormatE164Phone,
} from '@fbuploadpro/contracts';
import { sanitizeAuthRedirectUrl } from '@/lib/auth-redirect';
import { logServerError } from '../server-analytics';
import { resolveCanonicalEmail } from './email';
import { getSupabaseAdminClient } from './clients';
import { hashPassword } from './passwords';
import { localPasswordStore, localUserStore } from './stores';
import { findUserByEmail, type AuthUser } from './users';
import { resolveUniqueSubdomain } from './workspaces';

export async function signUpTenantUser(params: {
  name: string;
  phone: string;
  email: string;
  password?: string | undefined;
  hashedPassword?: string | undefined;
  /**
   * Pre-resolved referral (route-resolved via resolveReferralCode).
   * Written ONLY at users-row creation and never afterwards:
   * attribution is frozen at signup, and later link clicks or a
   * second signup attempt for an existing (unconfirmed) account
   * cannot change it. Local fallback (no Supabase client) signs
   * up without a referrer — there is no database to record it in.
   */
  referral?: { sellerId: string; code: string } | undefined;
}): Promise<{
  user: AuthUser;
  requiresOtp: boolean;
  simulatedOtp?: string | undefined;
  cooldownSecondsRemaining?: number | undefined;
}> {
  let canonicalEmail: string;
  try {
    canonicalEmail = canonicalizeGmailAddress(params.email);
  } catch {
    canonicalEmail = params.email.trim().toLowerCase();
  }

  let formattedPhone: string;
  try {
    formattedPhone = validateAndFormatE164Phone(params.phone);
  } catch {
    formattedPhone = params.phone.trim();
  }

  const existingUser = await findUserByEmail(canonicalEmail);
  const supabase = getSupabaseAdminClient();

  if (supabase && existingUser) {
    // Check if this existing user is already confirmed in Supabase Auth
    try {
      const { data: authUserData, error: authUserError } = await supabase.auth.admin.getUserById(existingUser.id);
      if (!authUserError && authUserData?.user) {
        if (authUserData.user.email_confirmed_at) {
          throw new Error('Email is already registered');
        }
      }
    } catch (adminErr: unknown) {
      if ((adminErr as Error)?.message === 'Email is already registered') {
        throw adminErr;
      }
      logServerError('[Supabase Auth Admin] getUserById exception:', adminErr);
    }

    // User is unconfirmed in Supabase: update details and resend code.
    // The update goes through the validated server-side function, not a
    // PostgREST write: the signup write happens before any session
    // exists, and public.users has no policy covering that moment, so a
    // direct write fails RLS whenever the server client is not holding
    // the service-role key (fix 2026-11-01). The function only updates
    // name/phone for an unconfirmed account and can never touch
    // role, status, or referral.
    try {
      const { error: updateError } = await supabase.rpc('update_unconfirmed_signup_profile', {
        p_user_id: existingUser.id,
        p_email: canonicalEmail,
        p_name: params.name,
        p_phone: formattedPhone,
      });

      if (updateError) {
        throw new Error(updateError.message || 'User detail update failed');
      }
    } catch (uErr) {
      console.error('[Supabase PostgREST] User detail update error:', uErr);
      throw uErr;
    }

    const resendRes = await resendSignupOtpViaSupabase(canonicalEmail);
    return {
      user: {
        ...existingUser,
        name: params.name,
        phone: formattedPhone,
      },
      requiresOtp: true,
      cooldownSecondsRemaining: resendRes.cooldownSecondsRemaining,
    };
  } else if (!supabase && existingUser) {
    // Local / test fallback
    const { isPendingSignup } = await import('@/lib/otp-service');
    if (!isPendingSignup(canonicalEmail)) {
      throw new Error('Email is already registered');
    }
    const resendRes = await resendSignupOtpViaSupabase(canonicalEmail);
    return {
      user: existingUser,
      requiresOtp: true,
      simulatedOtp: resendRes.otp,
      cooldownSecondsRemaining: resendRes.cooldownSecondsRemaining,
    };
  }

  const rawSubdomain = deriveSubdomainFromEmail(canonicalEmail);
  const subdomain = await resolveUniqueSubdomain(rawSubdomain);
  const rawPassword = params.password || '';
  const hashedPassword = params.hashedPassword || (rawPassword ? await hashPassword(rawPassword) : '');

  let userRecord: AuthUser;

  if (supabase) {
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email: canonicalEmail,
      password: rawPassword,
      options: {
        data: {
          name: params.name,
          phone: formattedPhone,
          subdomain,
        },
      },
    });

    if (authError) {
      if (authError.message?.toLowerCase().includes('already registered')) {
        throw new Error('Email is already registered');
      }

      const isRateLimited =
        authError.message?.toLowerCase().includes('for security purposes') ||
        /after\s+(\d+)\s+seconds/i.test(authError.message);

      if (isRateLimited) {
        const match = authError.message.match(/after\s+(\d+)\s+seconds/i);
        const seconds = match ? Number.parseInt(match[1], 10) : 60;

        // If user already exists in unconfirmed state, allow continuing to OTP step
        if (existingUser) {
          return {
            user: existingUser,
            requiresOtp: true,
            cooldownSecondsRemaining: seconds,
          };
        }

        // If new email on a rate-limited IP/project, throw rate limit error
        const rateLimitError = new Error(
          `For security purposes, please wait ${seconds} seconds before requesting another verification code.`
        );
        (rateLimitError as unknown as { code: string; retryAfterSeconds: number }).code = 'RATE_LIMITED';
        (rateLimitError as unknown as { retryAfterSeconds: number }).retryAfterSeconds = seconds;
        throw rateLimitError;
      }

      throw new Error(authError.message || 'Authentication registration failed');
    }

    if (!authData.user) {
      throw new Error('Authentication registration failed');
    }

    // GoTrue anti-enumeration: existing confirmed user returns user with empty identities
    if (Array.isArray(authData.user.identities) && authData.user.identities.length === 0) {
      throw new Error('Email is already registered');
    }

    const userId = authData.user.id;
    userRecord = {
      id: userId,
      email: canonicalEmail,
      name: params.name,
      phone: formattedPhone,
      subdomain,
      role: 'user',
      status: 'active',
    };

    // Profile + workspace creation goes through the validated
    // server-side function (migration 20261101150000), NOT a PostgREST
    // upsert: the write happens before any session exists and
    // public.users has no policy covering that moment, so a direct
    // write fails RLS ("new row violates row-level security policy for
    // table users") whenever the server client is not holding the
    // service-role key (fix 2026-11-01). The function forces
    // role 'user' / status 'active', freezes referral at creation,
    // and is idempotent — a failure here is loud, never silent.
    try {
      const { data: created, error: createError } = await supabase.rpc('create_signup_profile', {
        p_user_id: userId,
        p_email: canonicalEmail,
        p_name: params.name,
        p_phone: formattedPhone,
        p_subdomain: subdomain,
        ...(params.referral
          ? {
              p_referred_by_seller_id: params.referral.sellerId,
              p_referred_by_code: params.referral.code,
            }
          : {}),
      });

      if (createError) {
        throw new Error(createError.message || 'User profile creation failed');
      }

      const createdRow = (Array.isArray(created) ? created[0] : created) as
        | {
            id?: string;
            email?: string;
            name?: string | null;
            phone?: string | null;
            subdomain?: string | null;
          }
        | null
        | undefined;
      if (!createdRow?.id) {
        throw new Error('User profile creation failed');
      }

      userRecord = {
        id: createdRow.id,
        email: createdRow.email || canonicalEmail,
        name: createdRow.name ?? params.name,
        phone: createdRow.phone ?? formattedPhone,
        subdomain: createdRow.subdomain || subdomain,
        role: 'user',
        status: 'active',
      };
    } catch (insertErr) {
      logServerError('[Supabase PostgREST] User insert exception', insertErr);
      throw insertErr;
    }
  } else {
    // Local / test fallback
    const { createPendingSignup } = await import('@/lib/otp-service');
    const { otp } = await createPendingSignup({
      name: params.name,
      phone: formattedPhone,
      email: canonicalEmail,
      password: rawPassword,
      hashedPassword,
    });

    const userId = crypto.randomUUID();
    userRecord = {
      id: userId,
      email: canonicalEmail,
      name: params.name,
      phone: formattedPhone,
      subdomain,
      role: 'user',
      status: 'active',
    };
    localUserStore.set(canonicalEmail, userRecord);
    if (hashedPassword) {
      localPasswordStore.set(canonicalEmail, hashedPassword);
    }
    console.info(`[SupabaseAuth Fallback] Simulated OTP dispatch triggered for ${canonicalEmail}`);
    return {
      user: userRecord,
      requiresOtp: true,
      simulatedOtp: otp,
      cooldownSecondsRemaining: 60,
    };
  }

  return {
    user: userRecord,
    requiresOtp: true,
    cooldownSecondsRemaining: 60,
  };
}

export async function verifySignupOtpViaSupabase(params: {
  email: string;
  otp: string;
  returnUrl?: string | undefined;
  requestHost?: string | null | undefined;
}): Promise<{ user: AuthUser; token: string; redirectUrl: string }> {
  const canonicalEmail = resolveCanonicalEmail(params.email);

  const supabase = getSupabaseAdminClient();
  let userRecord: AuthUser | null = await findUserByEmail(canonicalEmail);

  if (supabase) {
    const firstAttempt = await supabase.auth.verifyOtp({
      email: canonicalEmail,
      token: params.otp,
      type: 'signup',
    });
    let verifiedAuthUser = firstAttempt.data?.user ?? null;

    if (firstAttempt.error) {
      const retry = await supabase.auth.verifyOtp({
        email: canonicalEmail,
        token: params.otp,
        type: 'email',
      });
      if (retry.error) {
        throw new Error('Invalid or expired verification code.');
      }
      verifiedAuthUser = retry.data?.user ?? null;
    }

    // No status UPDATE here (fix 2026-11-01): creation already sets
    // 'active', so the update was a no-op for every legitimate signup
    // row, it hard-fails under a weak server key (same RLS root cause
    // as the signup insert), and unconditionally writing 'active'
    // could reactivate a suspended account. A suspended row now fails
    // loudly below instead of being reactivated.
    userRecord = await findUserByEmail(canonicalEmail);
    if (!userRecord && verifiedAuthUser) {
      // Weak-key read fallback, same precedent as login: construct the
      // session user from the verified auth user's metadata. The
      // profile row itself was created at signup via the validated
      // server-side function; this only covers the read, never a
      // write, and never invents a user (verifiedAuthUser is null
      // unless the OTP just verified).
      const metadata = (verifiedAuthUser.user_metadata || {}) as Record<string, unknown>;
      const metaSubdomain = typeof metadata.subdomain === 'string' ? metadata.subdomain : '';
      userRecord = {
        id: verifiedAuthUser.id,
        email: verifiedAuthUser.email || canonicalEmail,
        name: typeof metadata.name === 'string' ? metadata.name : null,
        phone: typeof metadata.phone === 'string' ? metadata.phone : null,
        subdomain: metaSubdomain || deriveSubdomainFromEmail(canonicalEmail),
        role: 'user',
        status: 'active',
      };
    }
    if (userRecord?.status === 'suspended') {
      throw new Error('Account is suspended');
    }
  } else {
    // Local / test fallback
    const { verifySignupOtp } = await import('@/lib/otp-service');
    const verification = await verifySignupOtp(canonicalEmail, params.otp);
    if (!verification.success) {
      throw new Error(verification.error || 'Invalid or expired verification code.');
    }

    if (!userRecord) {
      const rawSubdomain = deriveSubdomainFromEmail(canonicalEmail);
      userRecord = {
        id: crypto.randomUUID(),
        email: canonicalEmail,
        name: verification.signupData?.name || null,
        phone: verification.signupData?.phone || null,
        subdomain: rawSubdomain,
        role: 'user',
        status: 'active',
      };
      localUserStore.set(canonicalEmail, userRecord);
    } else {
      userRecord.status = 'active';
    }
  }

  if (!userRecord) {
    throw new Error('Unable to find user account after verification.');
  }

  const sessionSecret = getSessionSecret();
  const token = await signSessionToken(
    {
      userId: userRecord.id,
      email: userRecord.email,
      name: userRecord.name,
      subdomain: userRecord.subdomain,
      role: userRecord.role,
      status: 'active',
    },
    sessionSecret,
    86400 * 30
  );

  const rootDomain = process.env.NEXT_PUBLIC_ROOT_DOMAIN || 'localhost:3000';
  const redirectUrl = sanitizeAuthRedirectUrl(
    params.returnUrl,
    userRecord.subdomain,
    rootDomain,
    params.requestHost
  );

  return {
    user: userRecord,
    token,
    redirectUrl,
  };
}

export async function resendSignupOtpViaSupabase(email: string): Promise<{
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
    const { error } = await supabase.auth.resend({
      type: 'signup',
      email: canonicalEmail,
    });
    if (error) {
      const match = error.message.match(/after\s+(\d+)\s+seconds/i);
      const cooldown = match ? Number.parseInt(match[1], 10) : undefined;
      return {
        success: false,
        error: error.message,
        cooldownSecondsRemaining: cooldown,
      };
    }
    return { success: true };
  }

  const { resendSignupOtp } = await import('@/lib/otp-service');
  return await resendSignupOtp(canonicalEmail);
}
