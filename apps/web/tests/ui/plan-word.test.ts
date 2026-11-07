/**
 * @file plan-word.test.ts
 * @description Pure derivation for the sidebar header plan word:
 * the word under "FBUploadPro" is the user's plan, never a flashed
 * or failed-as-Free value. The word reads the explicit plan value
 * from the contract — expired is a real plan, never re-derived from
 * `active` + `hasPriorPeriod`.
 */

import { describe, it, expect } from 'vitest';
import { planWordFromEntitlement } from '@/components/workspace/plan-word';

describe('planWordFromEntitlement', () => {
  it('returns Admin for admins without needing an entitlement', () => {
    expect(planWordFromEntitlement(null, true)).toBe('Admin');
    expect(planWordFromEntitlement({ plan: 'free' }, true)).toBe('Admin');
  });

  it('returns Paid for a paid plan', () => {
    expect(planWordFromEntitlement({ plan: 'paid' }, false)).toBe('Paid');
  });

  it('returns Expired for an expired plan, never Free', () => {
    expect(planWordFromEntitlement({ plan: 'expired' }, false)).toBe('Expired');
  });

  it('returns Free for a free plan', () => {
    expect(planWordFromEntitlement({ plan: 'free' }, false)).toBe('Free');
  });

  it('returns null while the entitlement is unresolved or failed', () => {
    expect(planWordFromEntitlement(null, false)).toBeNull();
  });
});
