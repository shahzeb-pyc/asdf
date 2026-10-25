import { z } from 'zod';

/**
 * Password-recovery form schemas (spec 136 §5.3 / spec 137 §3.8) —
 * beside the forms, following the `login-form-schema.ts` pattern. The
 * validation wording is spec 136 §3.3's plus the exact strings the
 * previous hand-rolled validators produced, carried into zod unchanged:
 * these messages are the inline + summary wording, and the server
 * remains authoritative (its sanitized messages map back onto the
 * fields / summary by the submit handlers).
 */

/** Step 1 — request the 6-digit recovery code for a Gmail address. */
export const forgotPasswordEmailFormSchema = z.object({
  email: z
    .string()
    .trim()
    .refine((value) => value.includes('@'), 'Please enter a valid Gmail address.')
    .refine((value) => {
      const domain = value.split('@')[1]?.toLowerCase();
      return domain === 'gmail.com' || domain === 'googlemail.com';
    }, 'Password recovery is available for @gmail.com (or @googlemail.com) accounts.'),
});

export type ForgotPasswordEmailFormValues = z.infer<typeof forgotPasswordEmailFormSchema>;

/**
 * Step 2 — the combined code + new-password + confirm form (spec 018's
 * unified flow). The code field strips non-digits as the user types /
 * pastes (§5.4 OTP pattern), so the value checked here is digits only.
 */
export const resetPasswordFormSchema = z
  .object({
    otp: z
      .string()
      .min(1, 'Verification code is required.')
      .refine((value) => /^\d{6}$/.test(value), 'Verification code must be exactly 6 digits.'),
    password: z
      .string()
      .min(1, 'New password is required.')
      .min(8, 'Password must be at least 8 characters long.')
      .max(128, 'Password must be 128 characters or fewer.'),
    confirmPassword: z.string().min(1, 'Please confirm your new password.'),
  })
  .refine((values) => values.password === values.confirmPassword, {
    message: 'Passwords do not match. Enter the same password in both fields.',
    path: ['confirmPassword'],
  });

export type ResetPasswordFormValues = z.infer<typeof resetPasswordFormSchema>;
