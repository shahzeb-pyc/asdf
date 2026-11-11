import { describe, it, expect } from 'vitest';
import {
  canonicalizeGmailAddress,
  validateAndFormatE164Phone,
  validateClientPhoneNumber,
  SignupRequestSchema,
  LoginRequestSchema,
  AuthSuccessResponseSchema,
  SessionPayloadSchema,
} from '../src/index.js';

describe('Auth Hardening Contracts (Spec 014)', () => {
  describe('canonicalizeGmailAddress', () => {
    it('normalizes standard gmail address', () => {
      expect(canonicalizeGmailAddress('johndoe@gmail.com')).toBe('johndoe@gmail.com');
      expect(canonicalizeGmailAddress('  JOHNDOE@GMAIL.COM  ')).toBe('johndoe@gmail.com');
    });

    it('strips all dots from username', () => {
      expect(canonicalizeGmailAddress('john.doe@gmail.com')).toBe('johndoe@gmail.com');
      expect(canonicalizeGmailAddress('j.o.h.n.d.o.e@gmail.com')).toBe('johndoe@gmail.com');
    });

    it('strips non-alphanumeric characters (underscores, hyphens) from username', () => {
      expect(canonicalizeGmailAddress('john_doe@gmail.com')).toBe('johndoe@gmail.com');
      expect(canonicalizeGmailAddress('john-doe@gmail.com')).toBe('johndoe@gmail.com');
      expect(canonicalizeGmailAddress('john_doe-reels@gmail.com')).toBe('johndoereels@gmail.com');
    });

    it('removes plus tags and everything up to @', () => {
      expect(canonicalizeGmailAddress('johndoe+promo@gmail.com')).toBe('johndoe@gmail.com');
      expect(canonicalizeGmailAddress('john.doe+reels+promo@gmail.com')).toBe('johndoe@gmail.com');
    });

    it('normalizes @googlemail.com to @gmail.com', () => {
      expect(canonicalizeGmailAddress('janedoe@googlemail.com')).toBe('janedoe@gmail.com');
      expect(canonicalizeGmailAddress('jane.doe+vip@googlemail.com')).toBe('janedoe@gmail.com');
    });

    it('rejects non-gmail domains', () => {
      expect(() => canonicalizeGmailAddress('user@yahoo.com')).toThrow(
        /Only @gmail\.com \(or @googlemail\.com\) email addresses are permitted/
      );
      expect(() => canonicalizeGmailAddress('user@outlook.com')).toThrow();
      expect(() => canonicalizeGmailAddress('user@tempmail.com')).toThrow();
      expect(() => canonicalizeGmailAddress('user@company.org')).toThrow();
    });

    it('rejects invalid or empty email formats', () => {
      expect(() => canonicalizeGmailAddress('')).toThrow();
      expect(() => canonicalizeGmailAddress('not-an-email')).toThrow();
      expect(() => canonicalizeGmailAddress('@gmail.com')).toThrow();
    });

    it('rejects usernames shorter than 6 characters (1-5 characters)', () => {
      expect(() => canonicalizeGmailAddress('a@gmail.com')).toThrow(/between 6 and 30 characters/i);
      expect(() => canonicalizeGmailAddress('ab@gmail.com')).toThrow(/between 6 and 30 characters/i);
      expect(() => canonicalizeGmailAddress('abc@gmail.com')).toThrow(/between 6 and 30 characters/i);
      expect(() => canonicalizeGmailAddress('john@gmail.com')).toThrow(/between 6 and 30 characters/i);
      expect(() => canonicalizeGmailAddress('admin@gmail.com')).toThrow();
    });

    it('rejects usernames longer than 30 characters', () => {
      const thirtyOneChars = 'a1234567890123456789012345678901@gmail.com';
      expect(() => canonicalizeGmailAddress(thirtyOneChars)).toThrow(/between 6 and 30 characters/i);
    });

    it('rejects reserved system keywords', () => {
      expect(() => canonicalizeGmailAddress('admin@gmail.com')).toThrow();
      expect(() => canonicalizeGmailAddress('billing@gmail.com')).toThrow(/reserved/i);
      expect(() => canonicalizeGmailAddress('dashboard@gmail.com')).toThrow(/reserved/i);
      expect(() => canonicalizeGmailAddress('internal@gmail.com')).toThrow(/reserved/i);
      expect(() => canonicalizeGmailAddress('system@gmail.com')).toThrow(/reserved/i);
      expect(() => canonicalizeGmailAddress('status@gmail.com')).toThrow(/reserved/i);
    });

    it('accepts usernames at exact 6 and 30 character boundaries', () => {
      expect(canonicalizeGmailAddress('sixchr@gmail.com')).toBe('sixchr@gmail.com');
      const thirtyChars = 'a12345678901234567890123456789';
      expect(canonicalizeGmailAddress(`${thirtyChars}@gmail.com`)).toBe(`${thirtyChars}@gmail.com`);
    });
  });

  describe('validateClientPhoneNumber', () => {
    it('validates and formats valid international phone numbers', () => {
      const res1 = validateClientPhoneNumber('+1 415 555 2671');
      expect(res1.isValid).toBe(true);
      expect(res1.formatted).toBe('+14155552671');
      expect(res1.error).toBeUndefined();

      const res2 = validateClientPhoneNumber('+92 300 1234567');
      expect(res2.isValid).toBe(true);
      expect(res2.formatted).toBe('+923001234567');
    });

    it('rejects empty phone input', () => {
      const res = validateClientPhoneNumber('');
      expect(res.isValid).toBe(false);
      expect(res.error).toMatch(/Phone number is required/);
    });

    it('rejects input without leading + (like asdf or 5551234567)', () => {
      const res1 = validateClientPhoneNumber('asdf');
      expect(res1.isValid).toBe(false);
      expect(res1.error).toMatch(/must include an international calling code starting with \+/);

      const res2 = validateClientPhoneNumber('5551234567');
      expect(res2.isValid).toBe(false);
      expect(res2.error).toMatch(/must include an international calling code starting with \+/);
    });

    it('rejects input containing letters after + (like +1asdf)', () => {
      const res = validateClientPhoneNumber('+1asdf');
      expect(res.isValid).toBe(false);
      expect(res.error).toMatch(/Phone numbers cannot contain letters/);
    });

    it('rejects incomplete numbers like +32433 with too short length or invalid code', () => {
      const res = validateClientPhoneNumber('+32433');
      expect(res.isValid).toBe(false);
      expect(res.error).toMatch(/Please enter a complete, valid international phone number/);
    });
  });

  describe('validateAndFormatE164Phone', () => {
    it('formats valid international phone numbers to E.164', () => {
      expect(validateAndFormatE164Phone('+1 415 555 2671')).toBe('+14155552671');
      expect(validateAndFormatE164Phone('+1 (415) 555-2671')).toBe('+14155552671');
      expect(validateAndFormatE164Phone('+92 300 1234567')).toBe('+923001234567');
      expect(validateAndFormatE164Phone('+44 7911 123456')).toBe('+447911123456');
    });

    it('rejects numbers without leading + international calling code', () => {
      expect(() => validateAndFormatE164Phone('03001234567')).toThrow(
        /must include an international calling code starting with \+/
      );
      expect(() => validateAndFormatE164Phone('5551234567')).toThrow();
    });

    it('rejects raw text strings, letters, and invalid country codes', () => {
      expect(() => validateAndFormatE164Phone('hello-world')).toThrow();
      expect(() => validateAndFormatE164Phone('+0000000000')).toThrow();
      expect(() => validateAndFormatE164Phone('+1')).toThrow();
    });
  });

  describe('SignupRequestSchema hardening', () => {
    it('transforms and canonicalizes email and phone on parse', () => {
      const valid = {
        name: 'Jane Doe',
        phone: '+1 (415) 555-2671',
        email: '  Jane.Doe+reels@GMAIL.COM  ',
        password: 'Password123!',
      };

      const result = SignupRequestSchema.safeParse(valid);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.email).toBe('janedoe@gmail.com');
        expect(result.data.phone).toBe('+14155552671');
      }
    });

    it('rejects non-gmail signup', () => {
      const invalid = {
        name: 'Jane Doe',
        phone: '+14155552671',
        email: 'jane@corporate.com',
        password: 'Password123!',
      };

      const result = SignupRequestSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('rejects invalid phone format', () => {
      const invalid = {
        name: 'Jane Doe',
        phone: '1234567890',
        email: 'jane@gmail.com',
        password: 'Password123!',
      };

      const result = SignupRequestSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });
  });

  describe('LoginRequestSchema hardening', () => {
    it('canonicalizes email on parse', () => {
      const valid = {
        email: 'Jane.Doe+promo@googlemail.com',
        password: 'Password123!',
      };

      const result = LoginRequestSchema.safeParse(valid);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.email).toBe('janedoe@gmail.com');
      }
    });

    it('rejects non-gmail login', () => {
      const result = LoginRequestSchema.safeParse({
        email: 'jane@yahoo.com',
        password: 'Password123!',
      });
      expect(result.success).toBe(false);
    });

    it('rejects cross-tenant and absolute returnUrl in LoginRequestSchema (ISSUE-28)', () => {
      // Cross-tenant absolute returnUrl
      expect(
        LoginRequestSchema.safeParse({
          email: 'janedoe@gmail.com',
          password: 'Password123!',
          returnUrl: 'https://jane.fbuploadpro.com/',
        }).success
      ).toBe(false);

      // Open-redirect external domain
      expect(
        LoginRequestSchema.safeParse({
          email: 'janedoe@gmail.com',
          password: 'Password123!',
          returnUrl: 'https://evil.com/phish',
        }).success
      ).toBe(false);

      // Protocol-relative URL
      expect(
        LoginRequestSchema.safeParse({
          email: 'janedoe@gmail.com',
          password: 'Password123!',
          returnUrl: '//evil.com/phish',
        }).success
      ).toBe(false);

      // Backslash evasion
      expect(
        LoginRequestSchema.safeParse({
          email: 'janedoe@gmail.com',
          password: 'Password123!',
          returnUrl: '/\\evil.com',
        }).success
      ).toBe(false);

      // Javascript/data schemes
      expect(
        LoginRequestSchema.safeParse({
          email: 'janedoe@gmail.com',
          password: 'Password123!',
          returnUrl: 'javascript:alert(1)',
        }).success
      ).toBe(false);
    });

    it('rejects banned dashboard route in returnUrl (ISSUE-28 / Principle 14)', () => {
      const bannedRoute = ['/', 'dashboard'].join('');
      expect(
        LoginRequestSchema.safeParse({
          email: 'janedoe@gmail.com',
          password: 'Password123!',
          returnUrl: bannedRoute,
        }).success
      ).toBe(false);

      expect(
        LoginRequestSchema.safeParse({
          email: 'janedoe@gmail.com',
          password: 'Password123!',
          returnUrl: `${bannedRoute}/media`,
        }).success
      ).toBe(false);
    });

    it('accepts safe relative paths in returnUrl (ISSUE-28 / Principle 12)', () => {
      const validPaths = ['/media', '/accounts', '/inapp-schedule', '/settings', '/publishing', '/'];
      for (const path of validPaths) {
        const result = LoginRequestSchema.safeParse({
          email: 'janedoe@gmail.com',
          password: 'Password123!',
          returnUrl: path,
        });
        expect(result.success).toBe(true);
      }
    });
  });

  describe('AuthSuccessResponseSchema hardening (ISSUE-29)', () => {
    it('accepts and canonicalizes valid Gmail address in auth success response', () => {
      const valid = {
        success: true,
        user: {
          id: '11111111-1111-4111-a111-111111111111',
          email: 'Jane.Doe+vip@googlemail.com',
          name: 'Jane Doe',
          subdomain: 'janedoe',
          role: 'user',
          status: 'active',
        },
        redirectUrl: 'https://janedoe.fbuploadpro.com/',
      };
      const result = AuthSuccessResponseSchema.safeParse(valid);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.user.email).toBe('janedoe@gmail.com');
      }
    });

    it('rejects non-gmail domains in AuthSuccessResponseSchema', () => {
      const invalid = {
        success: true,
        user: {
          id: '11111111-1111-4111-a111-111111111111',
          email: 'jane@example.com',
          name: 'Jane Doe',
          subdomain: 'janedoe',
          role: 'user',
          status: 'active',
        },
        redirectUrl: 'https://janedoe.fbuploadpro.com/',
      };
      const result = AuthSuccessResponseSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });
  });

  describe('SessionPayloadSchema hardening (ISSUE-29)', () => {
    it('accepts and canonicalizes valid Gmail address in session payload', () => {
      const valid = {
        userId: '11111111-1111-4111-a111-111111111111',
        email: 'John.Doe+promo@googlemail.com',
        name: 'John Doe',
        subdomain: 'johndoe',
        role: 'user',
        status: 'active',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
      const result = SessionPayloadSchema.safeParse(valid);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.email).toBe('johndoe@gmail.com');
      }
    });

    it('rejects non-gmail domains in SessionPayloadSchema', () => {
      const invalid = {
        userId: '11111111-1111-4111-a111-111111111111',
        email: 'user@yahoo.com',
        name: 'Yahoo User',
        subdomain: 'yahoouser',
        role: 'user',
        status: 'active',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
      const result = SessionPayloadSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });
  });
});
