/**
 * Mapper unit tests — one per row of the spec §3.1 table. The
 * previously-misrouted codes each have a regression test asserting
 * the NEW behaviour (and explicitly asserting NOT the old behaviour,
 * so reintroducing the old routing fails the test).
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateAduPublishError,
  type AduPublishErrorDecision,
} from './adu-health.js';

function decide(
  code: string | number | null | undefined,
  subcode?: string | number | null,
  message?: string,
  httpStatus?: number,
): AduPublishErrorDecision {
  return evaluateAduPublishError({ code, subcode, message, httpStatus });
}

describe('evaluateAduPublishError — invalid token', () => {
  it('generic 190 flips invalid_token with the full cascade', () => {
    expect(decide(190)).toEqual({
      aduStatus: 'invalid_token',
      cascadeInvalidToken: true,
      destinationStatus: 'error',
      accountStatus: 'expired',
      userMessage: 'real',
    });
  });

  it.each([458, 460, 463, 467])('190/%s is invalid_token', (subcode) => {
    const result = decide(190, subcode);
    expect(result.aduStatus).toBe('invalid_token');
    expect(result.cascadeInvalidToken).toBe(true);
    expect(result.accountStatus).toBe('expired');
    expect(result.destinationStatus).toBe('error');
  });

  it('102 (session invalid) is invalid_token', () => {
    expect(decide(102).aduStatus).toBe('invalid_token');
    expect(decide(102).cascadeInvalidToken).toBe(true);
  });

  it('190/483 (uncertain, no documented meaning) falls to generic 190', () => {
    expect(decide(190, 483).aduStatus).toBe('invalid_token');
  });

  it('string codes parse the same as numeric codes', () => {
    expect(decide('190', '463').aduStatus).toBe('invalid_token');
    expect(decide('190', '459').aduStatus).toBe('fb_verification_required');
  });
});

describe('evaluateAduPublishError — verification required (regressions)', () => {
  it.each([
    [368, 4854002],
    [400, 4854002],
    [190, 459],
    [190, 464],
    [368, 1404078],
  ] as const)('%s/%s is fb_verification_required, account kept', (code, subcode) => {
    const result = decide(code, subcode);
    expect(result.aduStatus).toBe('fb_verification_required');
    expect(result.accountStatus).toBeNull();
    expect(result.destinationStatus).toBe('error');
    expect(result.cascadeInvalidToken).toBe(false);
    expect(result.userMessage).toBe('real');
  });

  it('190/459 is NOT invalid_token and does NOT expire the account (old misroute)', () => {
    const result = decide(190, 459);
    expect(result.aduStatus).not.toBe('invalid_token');
    expect(result.accountStatus).not.toBe('expired');
  });

  it('368/1404078 is NOT rate limited (old misroute)', () => {
    const result = decide(368, 1404078);
    expect(result.aduStatus).not.toBe('fb_rate_limited');
    expect(result.destinationStatus).not.toBe('rate_limited');
  });

  it('400/4854002 is NOT a generic 400 (old misroute)', () => {
    expect(decide(400, 4854002).aduStatus).toBe('fb_verification_required');
  });
});

describe('evaluateAduPublishError — rate limited', () => {
  it('default 368 is fb_rate_limited with a rate_limited destination', () => {
    const result = decide(368);
    expect(result).toEqual({
      aduStatus: 'fb_rate_limited',
      cascadeInvalidToken: false,
      destinationStatus: 'rate_limited',
      accountStatus: null,
      userMessage: 'real',
    });
  });

  it('368/1390008 is fb_rate_limited', () => {
    expect(decide(368, 1390008).aduStatus).toBe('fb_rate_limited');
  });
});

describe('evaluateAduPublishError — account suspended / check developer app', () => {
  it('368 with suspended/disabled text is account_suspended, no destination flip', () => {
    for (const message of [
      'Your account has been suspended.',
      'This account is disabled.',
    ]) {
      const result = decide(368, undefined, message);
      expect(result.aduStatus).toBe('account_suspended');
      expect(result.destinationStatus).toBeNull();
      expect(result.accountStatus).toBeNull();
    }
  });

  it('368/1404112 is account_suspended', () => {
    expect(decide(368, 1404112).aduStatus).toBe('account_suspended');
  });

  it('368 with developer-app text is check_developer_app', () => {
    for (const message of [
      'The developer app is restricted.',
      'This app is restricted from posting.',
    ]) {
      expect(decide(368, undefined, message).aduStatus).toBe('check_developer_app');
    }
  });

  it('200 "API access blocked" is check_developer_app', () => {
    expect(
      decide(200, undefined, 'API access blocked for this Page.').aduStatus,
    ).toBe('check_developer_app');
  });

  it.each([
    [200, 2069030],
    [200, 2069031],
    [200, 2069033],
    [190, 2069031],
  ] as const)('%s/%s is check_developer_app (regression: was invalid token / rate limited)', (code, subcode) => {
    const result = decide(code, subcode);
    expect(result.aduStatus).toBe('check_developer_app');
    expect(result.accountStatus).toBeNull();
    expect(result.destinationStatus).toBeNull();
  });
});

describe('evaluateAduPublishError — page not accessible', () => {
  it('HTTP 404 (httpStatus) is page_not_accessible', () => {
    expect(decide(null, null, 'Facebook Graph API error: HTTP 404', 404).aduStatus).toBe(
      'page_not_accessible',
    );
  });

  it('http_404 code is page_not_accessible', () => {
    expect(decide('http_404').aduStatus).toBe('page_not_accessible');
  });

  it('page-gone text is page_not_accessible', () => {
    expect(decide(null, null, 'The page does not exist.').aduStatus).toBe(
      'page_not_accessible',
    );
    expect(decide(null, null, 'Page not found.').aduStatus).toBe('page_not_accessible');
  });
});

describe('evaluateAduPublishError — missing page access / missing permission (regressions)', () => {
  it('190/492 is missing_page_access, NOT invalid_token (old misroute)', () => {
    const result = decide(190, 492);
    expect(result.aduStatus).toBe('missing_page_access');
    expect(result.accountStatus).toBeNull();
    expect(result.cascadeInvalidToken).toBe(false);
    expect(result.destinationStatus).toBeNull();
  });

  it.each([[10], [200], [250]] as const)(
    'code %s is missing_permission, NOT invalid_token (old misroute)',
    (code) => {
      const result = decide(code);
      expect(result.aduStatus).toBe('missing_permission');
      expect(result.accountStatus).toBeNull();
      expect(result.cascadeInvalidToken).toBe(false);
    },
  );

  it('200–299 without the developer-app subcodes is missing_permission', () => {
    expect(decide(299, 1234).aduStatus).toBe('missing_permission');
  });
});

describe('evaluateAduPublishError — no status, post fails, real reason', () => {
  it.each([506, 382, 1363040])('content code %s leaves the page active', (code) => {
    expect(decide(code)).toEqual({
      aduStatus: null,
      cascadeInvalidToken: false,
      destinationStatus: null,
      accountStatus: null,
      userMessage: 'real',
    });
  });

  it.each([
    [368, 1404102],
    [368, 1404082],
  ] as const)('%s/%s leaves the page active (was misrouted to rate limited)', (code, subcode) => {
    const result = decide(code, subcode);
    expect(result.aduStatus).toBeNull();
    expect(result.destinationStatus).toBeNull();
  });

  it.each([100, 1609005])('content code %s (retry ×2) leaves the page active', (code) => {
    expect(decide(code).aduStatus).toBeNull();
  });
});

describe('evaluateAduPublishError — retryable, no status', () => {
  it.each([1, 2, 17, 500, 502, 503])('transient code %s leaves the page active', (code) => {
    expect(decide(code).aduStatus).toBeNull();
  });

  it.each(['http_400', 'http_401', 'http_403', 'http_413', 'http_429'] as const)(
    'body-less %s leaves the page active',
    (code) => {
      expect(decide(code).aduStatus).toBeNull();
    },
  );

  it.each([4, 17, 32, 341, 613, 80001, 80005])(
    'volume rate-limit code %s leaves the page active',
    (code) => {
      expect(decide(code).aduStatus).toBeNull();
    },
  );
});

describe('evaluateAduPublishError — app bugs (regressions)', () => {
  it('190/2069032 is generic-backend with no status and no flip (was invalid_token)', () => {
    const result = decide(190, 2069032);
    expect(result).toEqual({
      aduStatus: null,
      cascadeInvalidToken: false,
      destinationStatus: null,
      accountStatus: null,
      userMessage: 'generic-backend',
    });
  });

  it('code 3 is generic-backend with no status (was unclassified / retried)', () => {
    const result = decide(3);
    expect(result.aduStatus).toBeNull();
    expect(result.userMessage).toBe('generic-backend');
  });
});

describe('evaluateAduPublishError — unknown / missing error facts', () => {
  it('unknown codes and missing facts leave the page active with the real message', () => {
    expect(decide('publisher_threw').aduStatus).toBeNull();
    expect(decide(null).aduStatus).toBeNull();
    expect(decide(undefined).userMessage).toBe('real');
    expect(decide(99999).aduStatus).toBeNull();
  });
});
