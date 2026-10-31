import { z } from 'zod';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { SubdomainSchema, UserRoleSchema, UserStatusSchema, RESERVED_SUBDOMAINS, type ReservedSubdomain } from './user.js';

/**
 * Strict Gmail address canonicalization:
 * 1. Trim whitespace and convert to lowercase.
 * 2. Validate domain is exclusively @gmail.com or @googlemail.com.
 * 3. Extract username portion.
 * 4. Remove plus subaddressing tags and everything following up to @ (johndoe+xyz -> johndoe).
 * 5. Strip all dots from username (john.doe -> johndoe).
 * 6. Recombine as <clean_username>@gmail.com.
 */
export function canonicalizeGmailAddress(rawEmail: string): string {
  if (!rawEmail || typeof rawEmail !== 'string') {
    throw new Error('Valid email address is required');
  }

  const trimmed = rawEmail.trim().toLowerCase();
  const atIndex = trimmed.lastIndexOf('@');
  if (atIndex === -1 || atIndex === 0 || atIndex === trimmed.length - 1) {
    throw new Error('Valid email address is required');
  }

  const username = trimmed.slice(0, atIndex);
  const domain = trimmed.slice(atIndex + 1);

  if (domain !== 'gmail.com' && domain !== 'googlemail.com') {
    throw new Error('Only @gmail.com (or @googlemail.com) email addresses are permitted');
  }

  // 1. Remove plus tags and everything following up to @: e.g. 'johndoe+xyz' -> 'johndoe'
  const withoutPlusTag = username.split('+')[0] ?? '';
  // 2. Strip all dots and non-alphanumeric characters: e.g. 'john.doe' -> 'johndoe', 'john_doe' -> 'johndoe'
  const cleanUsername = withoutPlusTag.replace(/[^a-z0-9]/g, '');

  if (!cleanUsername) {
    throw new Error('Email username cannot be empty');
  }

  if (cleanUsername.length < 6 || cleanUsername.length > 30) {
    throw new Error('Gmail username must be between 6 and 30 characters');
  }

  if (RESERVED_SUBDOMAINS.includes(cleanUsername as ReservedSubdomain)) {
    throw new Error(`Gmail username cannot use a reserved system keyword: ${cleanUsername}`);
  }

  return `${cleanUsername}@gmail.com`;
}

export interface ClientPhoneValidationResult {
  isValid: boolean;
  error?: string;
  formatted?: string;
}

/**
 * Validates a raw client phone input and returns specific, friendly error guidance.
 */
export function validateClientPhoneNumber(rawPhone: string): ClientPhoneValidationResult {
  if (!rawPhone || typeof rawPhone !== 'string' || !rawPhone.trim()) {
    return { isValid: false, error: 'Phone number is required.' };
  }

  const trimmed = rawPhone.trim();
  if (!trimmed.startsWith('+')) {
    return {
      isValid: false,
      error: 'Phone number must include an international calling code starting with + (e.g. +1 555 123 4567 or +92 300 1234567).',
    };
  }

  const rest = trimmed.slice(1);
  if (/[a-zA-Z]/.test(rest)) {
    return {
      isValid: false,
      error: 'Phone numbers cannot contain letters. Please enter numbers only.',
    };
  }

  const sanitized = '+' + rest.replace(/\D/g, '');
  if (sanitized.length < 8) {
    return {
      isValid: false,
      error: 'Please enter a complete, valid international phone number.',
    };
  }

  if (sanitized.length > 16) {
    return {
      isValid: false,
      error: 'Phone number cannot exceed 15 digits.',
    };
  }

  const parsed = parsePhoneNumberFromString(sanitized);
  if (!parsed?.isValid()) {
    return {
      isValid: false,
      error: 'Please enter a valid international phone number with a recognized country code.',
    };
  }

  return { isValid: true, formatted: parsed.format('E.164') };
}

/**
 * International E.164 phone number validation and normalization:
 * 1. Requires leading + international country calling code.
 * 2. Strips spaces, dashes, brackets, and non-numeric characters (except leading +).
 * 3. Validates country code and numeric length using libphonenumber-js.
 * 4. Returns formatted standard E.164 string (e.g. +923001234567, +15551234567).
 */
export function validateAndFormatE164Phone(rawPhone: string): string {
  const result = validateClientPhoneNumber(rawPhone);
  if (!result.isValid || !result.formatted) {
    throw new Error(result.error || 'Please enter a valid international phone number in E.164 format');
  }
  return result.formatted;
}

export function deriveSubdomainFromEmail(email: string): string {
  if (!email?.includes('@')) {
    return 'workspace';
  }

  const usernamePart = email.split('@')[0] || '';
  // 1. Strip plus subaddress tags: e.g. 'john.doe+reels' -> 'john.doe'
  const withoutPlusTag = usernamePart.split('+')[0] || '';
  // 2. Strip all dots: e.g. 'john.doe' -> 'johndoe'
  const withoutDots = withoutPlusTag.replaceAll('.', '');
  // 3. Lowercase and keep alphanumeric and hyphens
  let slug = withoutDots
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  // 4. Pad if shorter than 3 chars
  if (slug.length === 0) {
    slug = 'workspace';
  } else if (slug.length < 3) {
    slug = (slug + 'workspace').slice(0, 50);
  } else if (slug.length > 50) {
    slug = slug.slice(0, 50);
    while (slug.endsWith('-')) {
      slug = slug.slice(0, -1);
    }
  }

  // 5. If slug matches a reserved subdomain, append '1' to avoid conflict
  if (RESERVED_SUBDOMAINS.includes(slug as ReservedSubdomain)) {
    slug = `${slug}1`;
  }

  return slug;
}

export const GmailSchema = z
  .string()
  .trim()
  .email('Valid email address is required')
  .max(255, 'Email cannot exceed 255 characters')
  .superRefine((val, ctx) => {
    try {
      canonicalizeGmailAddress(val);
    } catch (err: unknown) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err instanceof Error ? err.message : 'Only @gmail.com addresses are permitted',
      });
    }
  })
  .transform((val) => canonicalizeGmailAddress(val));

export const E164PhoneSchema = z
  .string()
  .trim()
  .min(5, 'Valid phone number is required')
  .max(50, 'Phone number cannot exceed 50 characters')
  .superRefine((val, ctx) => {
    try {
      validateAndFormatE164Phone(val);
    } catch (err: unknown) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err instanceof Error ? err.message : 'Please enter a valid international phone number in E.164 format',
      });
    }
  })
  .transform((val) => validateAndFormatE164Phone(val));

export const SignupRequestSchema = z.object({
  name: z.string().trim().min(1, 'Full name is required').max(100, 'Full name cannot exceed 100 characters'),
  phone: E164PhoneSchema,
  email: GmailSchema,
  password: z.string().min(8, 'Password must be at least 8 characters long').max(128, 'Password cannot exceed 128 characters'),
  /**
   * Optional referral code, threaded from ?ref= on the signup page.
   * Resolved server-side in signUpTenantUser: a valid code from an
   * active seller is stored immutably on the new account; an
   * unknown or paused seller's code is a 400 (the page
   * pre-validates, so normal flows never submit one).
   */
  referralCode: z.string().trim().max(32).optional(),
});

export type SignupRequest = z.infer<typeof SignupRequestSchema>;

export const SafeReturnUrlSchema = z
  .string()
  .trim()
  .superRefine((val, ctx) => {
    // 1. Must be a relative path starting with '/' but not protocol-relative '//'
    if (!val.startsWith('/') || val.startsWith('//')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'returnUrl must be a relative path starting with /',
      });
      return;
    }

    // 2. No backslashes or dangerous schemes
    if (val.includes('\\') || /^(?:javascript|data|vbscript):/i.test(val)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'returnUrl contains invalid characters or schemes',
      });
      return;
    }

    // 3. Extract pathname to verify against banned /dashboard
    try {
      const parsed = new URL(val, 'https://localhost');
      const normalizedPath = parsed.pathname.toLowerCase();
      if (normalizedPath === '/dashboard' || normalizedPath.startsWith('/dashboard/')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'The /dashboard route has been permanently deprecated per Principle 14.',
        });
        return;
      }
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid returnUrl structure',
      });
    }
  });

export const LoginRequestSchema = z.object({
  email: GmailSchema,
  password: z.string().min(1, 'Password is required').max(128, 'Password cannot exceed 128 characters'),
  returnUrl: SafeReturnUrlSchema.optional(),
});

export const ForgotPasswordRequestSchema = z.object({
  email: GmailSchema,
});

export type ForgotPasswordRequest = z.infer<typeof ForgotPasswordRequestSchema>;

export const ResendResetOtpRequestSchema = z.object({
  email: GmailSchema,
});

export type ResendResetOtpRequest = z.infer<typeof ResendResetOtpRequestSchema>;

export const ResetPasswordOtpRequestSchema = z.object({
  email: GmailSchema,
  otp: z.string().trim().regex(/^\d{6}$/, 'Verification code must be exactly 6 digits'),
  password: z.string().min(8, 'Password must be at least 8 characters long').max(128, 'Password cannot exceed 128 characters'),
});

export type ResetPasswordOtpRequest = z.infer<typeof ResetPasswordOtpRequestSchema>;

export const ResetPasswordRequestSchema = z.object({
  password: z.string().min(8, 'Password must be at least 8 characters long').max(128, 'Password cannot exceed 128 characters'),
  email: z.string().optional(),
  otp: z.string().optional(),
  token: z.string().optional(),
  code: z.string().optional(),
});

export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequestSchema>;

export const AuthSuccessResponseSchema = z.object({
  success: z.literal(true),
  user: z.object({
    id: z.string().uuid(),
    email: GmailSchema,
    name: z.string().nullable().optional(),
    subdomain: SubdomainSchema,
    role: UserRoleSchema,
    status: UserStatusSchema,
  }),
  redirectUrl: z.string(),
});

export type AuthSuccessResponse = z.infer<typeof AuthSuccessResponseSchema>;

/**
 * Evaluates whether new account registrations are enabled.
 * Defaults to true if the environment variable is not set.
 * Returns false when set to 'false', '0', 'off', or 'disabled'.
 */
export function isSignupEnabled(env?: Record<string, string | undefined>): boolean {
  const globalEnv = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const envObj = env ?? globalEnv ?? {};
  const raw = envObj.NEXT_PUBLIC_SIGNUPS_ENABLED ?? envObj.ENABLE_SIGNUPS ?? 'true';
  const flag = raw.trim().toLowerCase();
  return flag !== 'false' && flag !== '0' && flag !== 'off' && flag !== 'disabled';
}

