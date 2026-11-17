import { z } from 'zod';
import type { Brand } from '@fbuploadpro/contracts';

/**
 * Login form schema (spec 137 §3.8) — the client half of the login
 * payload. The payload itself is the contracts `LoginRequestSchema`
 * the `/api/auth/login` route validates with; this schema mirrors its
 * shape (email / password / returnUrl) with the login form's approved
 * inline wording, so a client-side failure reads exactly as the form
 * has always presented it. Server-side validation stays authoritative:
 * 400 `details` from the route are mapped back onto the fields.
 *
 * Email rule — brand-aware (spec 199):
 * - `fbuploadpro` (unchanged behaviour): a Gmail address — the domain
 *   must be gmail.com or googlemail.com (case-insensitive). The value
 *   is trimmed before submit; the server canonicalizes it.
 * - `nextrise` (white label): every syntactically valid email
 *   address is accepted. The white label only uses login, and its
 *   students do not all have Gmail addresses. The server route
 *   mirrors this with its own brand-aware schema; the contracts
 *   `LoginRequestSchema` stays Gmail-only for fbuploadpro.
 */
const loginFormPassword = z.string().min(1, 'Please enter your password.');

export const loginFormSchema = z.object({
  email: z
    .string()
    .trim()
    .refine((value) => value.includes('@'), 'Please enter a valid Gmail address.')
    .refine((value) => {
      const domain = value.split('@')[1]?.toLowerCase();
      return domain === 'gmail.com' || domain === 'googlemail.com';
    }, 'Only @gmail.com (or @googlemail.com) accounts are supported.'),
  password: loginFormPassword,
});

export const nextriseLoginFormSchema = z.object({
  email: z.string().trim().email('Please enter a valid email address.'),
  password: loginFormPassword,
});

/** The login form schema for the current brand. */
export function createLoginFormSchema(brand: Brand) {
  return brand === 'nextrise' ? nextriseLoginFormSchema : loginFormSchema;
}

export type LoginFormValues = z.infer<typeof loginFormSchema>;
