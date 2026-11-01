import { z } from 'zod';

/**
 * Auth-adjacent resources (spec 137 §3.1 / §3.8).
 *
 * Source: `POST /api/auth/login` — the success body exactly as its
 * route handler constructs it (`{ success, user, redirectUrl }`). The
 * login form (PR-A6's reference conversion) submits through the typed
 * client with this schema; its error bodies are control flow, not data
 * (403 `requiresOtp` / suspended `redirectUrl`, 400 `details`), and are
 * read from the thrown `ApiError`'s `cause` by the form.
 *
 * Passthrough choices: none. Every field here is consumed by the
 * post-login redirect path (`completeAuthRedirect` reads `id`, `email`,
 * `subdomain`; the rest mirrors the route's construction).
 */

export const LoginUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable().optional(),
  subdomain: z.string(),
  role: z.string(),
  status: z.string(),
});
export type LoginUser = z.infer<typeof LoginUserSchema>;

export const LoginSuccessResponseSchema = z.object({
  success: z.literal(true),
  user: LoginUserSchema,
  redirectUrl: z.string(),
});
export type LoginSuccessResponse = z.infer<typeof LoginSuccessResponseSchema>;

/** The login route's error body shape, read from an `ApiError` cause. */
export interface LoginErrorBody {
  error?: string;
  requiresOtp?: boolean;
  email?: string;
  redirectUrl?: string;
  details?: Record<string, string[]>;
}

/* ------------------------------------------------------------------ */
/* Signup + OTP (spec 136 PR-136B — additive; the login schemas above  */
/* are untouched). Success bodies exactly as their route handlers      */
/* construct them:                                                     */
/*   POST /api/auth/signup        → { success, requiresOtp,            */
/*     cooldownSecondsRemaining, email, message }                      */
/*   POST /api/auth/signup/verify-otp → 201 { success, user,          */
/*     redirectUrl }                                                   */
/*   POST /api/auth/signup/resend-otp → { success, message }           */
/* Error bodies are control flow (400 `details`, 409 conflict, 429     */
/* cooldown) and are read from the thrown `ApiError`'s `cause`.        */
/* ------------------------------------------------------------------ */

export const SignupSuccessResponseSchema = z.object({
  success: z.literal(true),
  requiresOtp: z.boolean().optional(),
  cooldownSecondsRemaining: z.number().optional(),
  email: z.string().optional(),
  message: z.string().optional(),
  redirectUrl: z.string().optional(),
  user: LoginUserSchema.optional(),
});
export type SignupSuccessResponse = z.infer<typeof SignupSuccessResponseSchema>;

/** The signup route's error body shape, read from an `ApiError` cause. */
export interface SignupErrorBody {
  error?: string;
  details?: Record<string, string[]>;
  retryAfterSeconds?: number;
  cooldownSecondsRemaining?: number;
  /** Supabase Auth hourly email budget: 429 with no retry timing. */
  emailRateLimited?: boolean;
}

export const VerifyOtpSuccessResponseSchema = z.object({
  success: z.literal(true),
  user: LoginUserSchema,
  redirectUrl: z.string(),
});
export type VerifyOtpSuccessResponse = z.infer<typeof VerifyOtpSuccessResponseSchema>;

/** The verify-otp route's error body shape, read from an `ApiError` cause. */
export interface VerifyOtpErrorBody {
  error?: string;
  retryAfterSeconds?: number;
  cooldownSecondsRemaining?: number;
}

export const ResendOtpSuccessResponseSchema = z.object({
  success: z.literal(true),
  message: z.string().optional(),
});
export type ResendOtpSuccessResponse = z.infer<typeof ResendOtpSuccessResponseSchema>;

/** The resend-otp route's error body shape, read from an `ApiError` cause. */
export interface ResendOtpErrorBody {
  error?: string;
  retryAfterSeconds?: number;
  cooldownSecondsRemaining?: number;
  /** Supabase Auth hourly email budget: 429 with no retry timing. */
  emailRateLimited?: boolean;
}

/* ------------------------------------------------------------------ */
/* Password recovery (spec 136 PR-136C — additive; the login and      */
/* signup schemas above are untouched). Success bodies exactly as     */
/* their route handlers construct them:                               */
/*   POST /api/auth/forgot-password        → { success, requiresOtp,  */
/*     email, message }                                               */
/*   POST /api/auth/forgot-password/resend → { success, message }     */
/*   POST /api/auth/reset-password         → { success, message }     */
/* Error bodies are control flow (400 field/message mapping, 429      */
/* cooldown) and are read from the thrown `ApiError`'s `cause`.       */
/* ------------------------------------------------------------------ */

export const ForgotPasswordSuccessResponseSchema = z.object({
  success: z.literal(true),
  requiresOtp: z.boolean().optional(),
  email: z.string().optional(),
  message: z.string().optional(),
});
export type ForgotPasswordSuccessResponse = z.infer<
  typeof ForgotPasswordSuccessResponseSchema
>;

/** The forgot-password + resend routes' error body shape. */
export interface ForgotPasswordErrorBody {
  error?: string;
  retryAfterSeconds?: number;
  cooldownSecondsRemaining?: number;
}

export const ResendRecoveryCodeSuccessResponseSchema = z.object({
  success: z.literal(true),
  message: z.string().optional(),
});
export type ResendRecoveryCodeSuccessResponse = z.infer<
  typeof ResendRecoveryCodeSuccessResponseSchema
>;

export const ResetPasswordSuccessResponseSchema = z.object({
  success: z.literal(true),
  message: z.string().optional(),
});
export type ResetPasswordSuccessResponse = z.infer<
  typeof ResetPasswordSuccessResponseSchema
>;

/** The reset-password route's error body shape, read from an `ApiError` cause. */
export interface ResetPasswordErrorBody {
  error?: string;
  retryAfterSeconds?: number;
  cooldownSecondsRemaining?: number;
}
