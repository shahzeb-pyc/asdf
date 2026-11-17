/**
 * Login form schema — brand rule (spec 199). The factory returns the
 * Gmail-only schema for fbuploadpro and the any-valid-email schema
 * for the white-label brand. Both schemas share the same shape
 * (email / password), so the form values type is unchanged.
 */
import { describe, expect, it } from 'vitest';
import { createLoginFormSchema, loginFormSchema, nextriseLoginFormSchema } from './login-form-schema';

const VALID_PASSWORD = 'correct-password-1';

describe('createLoginFormSchema (spec 199)', () => {
  it('fbuploadpro rejects a non-Gmail address with the exact message', () => {
    const result = createLoginFormSchema('fbuploadpro').safeParse({
      email: 'owner@example.com',
      password: VALID_PASSWORD,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.flatten().fieldErrors.email).toEqual([
      'Only @gmail.com (or @googlemail.com) accounts are supported.',
    ]);
  });

  it('fbuploadpro still accepts gmail.com and googlemail.com', () => {
    for (const email of ['owner@gmail.com', 'owner@googlemail.com', 'Owner@GMAIL.com']) {
      const result = createLoginFormSchema('fbuploadpro').safeParse({
        email,
        password: VALID_PASSWORD,
      });
      expect(result.success).toBe(true);
    }
  });

  it('nextrise accepts a non-Gmail address', () => {
    const result = createLoginFormSchema('nextrise').safeParse({
      email: 'student@protonmail.com',
      password: VALID_PASSWORD,
    });
    expect(result.success).toBe(true);
  });

  it('nextrise still rejects a malformed address', () => {
    const result = createLoginFormSchema('nextrise').safeParse({
      email: 'not-an-email',
      password: VALID_PASSWORD,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.flatten().fieldErrors.email).toEqual([
      'Please enter a valid email address.',
    ]);
  });

  it('the factory returns the same schemas as the named exports', () => {
    expect(createLoginFormSchema('fbuploadpro')).toBe(loginFormSchema);
    expect(createLoginFormSchema('nextrise')).toBe(nextriseLoginFormSchema);
  });
});
