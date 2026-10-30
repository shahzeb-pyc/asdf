import { describe, expect, it } from 'vitest';
import {
  FACEBOOK_ACCOUNT_RESTRICTION_SUBCODES,
  isFacebookAccountRestricted,
  MIRROR_FACEBOOK_RESTRICTED_MESSAGE,
} from '../src/domain/facebook-restriction.js';

describe('isFacebookAccountRestricted', () => {
  it('matches both known restriction subcodes under Graph code 1', () => {
    for (const subcode of FACEBOOK_ACCOUNT_RESTRICTION_SUBCODES) {
      expect(isFacebookAccountRestricted({ code: 1, subcode })).toBe(true);
    }
  });

  it('accepts the error_subcode / errorSubcode field spellings', () => {
    expect(isFacebookAccountRestricted({ code: 1, error_subcode: 2424009 })).toBe(true);
    expect(isFacebookAccountRestricted({ code: 1, errorSubcode: 1404078 })).toBe(true);
  });

  it('rejects other subcodes under code 1 and restriction subcodes under other codes', () => {
    expect(isFacebookAccountRestricted({ code: 1, subcode: 190 })).toBe(false);
    expect(isFacebookAccountRestricted({ code: 368, subcode: 2424009 })).toBe(false);
    expect(isFacebookAccountRestricted({ code: 190, subcode: 2424009 })).toBe(false);
  });

  it('falls back to the restriction phrase when only free text survives', () => {
    expect(
      isFacebookAccountRestricted(
        new Error(
          'For security reasons, your account has limited access to the site for a few days.'
        )
      )
    ).toBe(true);
  });

  it('does not remap unrelated failures', () => {
    expect(isFacebookAccountRestricted(new Error('Graph exploded'))).toBe(false);
    expect(isFacebookAccountRestricted({ code: 190, message: 'Session expired' })).toBe(false);
    expect(isFacebookAccountRestricted(null)).toBe(false);
    expect(isFacebookAccountRestricted(undefined)).toBe(false);
  });

  it('keeps Publish Now semantics exact with messageFallback disabled', () => {
    expect(
      isFacebookAccountRestricted(
        new Error('For security reasons, your account has limited access.'),
        { messageFallback: false }
      )
    ).toBe(false);
    expect(
      isFacebookAccountRestricted(
        { code: 1, subcode: 2424009 },
        { messageFallback: false }
      )
    ).toBe(true);
  });
});

describe('MIRROR_FACEBOOK_RESTRICTED_MESSAGE', () => {
  it('is the approved Auto Repost wording', () => {
    expect(MIRROR_FACEBOOK_RESTRICTED_MESSAGE).toBe(
      "This Facebook page can't post right now because the connected account is temporarily restricted on Facebook. It should work again once the restriction lifts — check Facebook Account Status for details."
    );
  });
});
