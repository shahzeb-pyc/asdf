import { z } from 'zod';
import { validateClientPhoneNumber } from '@fbuploadpro/contracts';

/**
 * Signup form schemas (spec 136 §5.2 / spec 137 §3.8) — beside the form,
 * following the `login-form-schema.ts` pattern. The validation wording is
 * spec 136 §3.3's, verbatim: these strings are the messages the hand-rolled
 * validator produced, carried into zod unchanged. Server-side validation
 * (the contracts `SignupRequestSchema` in the route) stays authoritative:
 * 400 `details` from the route are mapped back onto the fields.
 */
export const signupFormSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Full name is required.')
      .max(100, 'Full name must be 100 characters or fewer.'),
    phone: z.string().superRefine((value, ctx) => {
      const result = validateClientPhoneNumber(value);
      if (!result.isValid) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: result.error || 'Please enter a valid international phone number.',
        });
      }
    }),
    email: z
      .string()
      .trim()
      .refine((value) => value.includes('@'), 'A valid email address is required.')
      .refine((value) => {
        const domain = value.split('@')[1]?.toLowerCase();
        return domain === 'gmail.com' || domain === 'googlemail.com';
      }, 'Registration is limited to @gmail.com (or @googlemail.com) accounts.'),
    password: z
      .string()
      .min(1, 'Password is required.')
      .min(8, 'Password must be at least 8 characters long.'),
    confirmPassword: z.string().min(1, 'Please confirm your password.'),
  })
  .refine((values) => values.password === values.confirmPassword, {
    message: 'Passwords do not match. Enter the same password in both fields.',
    path: ['confirmPassword'],
  });

export type SignupFormValues = z.infer<typeof signupFormSchema>;

/**
 * OTP step schema (spec 136 §5.4): a single 6-digit code. The field strips
 * non-digits as the user types/pastes, so the value checked here is digits
 * only; the wording is §3.3's incomplete-code message, verbatim.
 */
export const signupOtpFormSchema = z.object({
  otp: z
    .string()
    .refine(
      (value) => /^\d{6}$/.test(value),
      'Enter the full 6-digit code.'
    ),
});

export type SignupOtpFormValues = z.infer<typeof signupOtpFormSchema>;
