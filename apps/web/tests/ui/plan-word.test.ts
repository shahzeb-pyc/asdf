/**
 * @file plan-word.test.ts
 * @description Pure derivation for the sidebar header plan word:
 * the word under "FBUploadPro" is the user's plan, never a flashed
 * or failed-as-Free value.
 */

import { describe, it, expect } from 'vitest';
import { planWordFromEntitlement } from '@/components/workspace/plan-word';

describe('planWordFromEntitlement', () => {
  it('returns Admin for admins without needing an entitlement', () => {
    expect(planWordFromEntitlement(null, true)).toBe('Admin');
    expect(
      planWordFromEntitlement({ active: false, hasPriorPeriod: false }, true)
    ).toBe('Admin');
  });

  it('returns Paid for an active paid period', () => {
    expect(
      planWordFromEntitlement({ active: true, hasPriorPeriod: true }, false)
    ).toBe('Paid');
  });

  it('returns Expired when no period is active but one was held before', () => {
    expect(
      planWordFromEntitlement({ active: false, hasPriorPeriod: true }, false)
    ).toBe('Expired');
  });

  it('returns Free when no period was ever held', () => {
    expect(
      planWordFromEntitlement({ active: false, hasPriorPeriod: false }, false)
    ).toBe('Free');
  });

  it('returns null while the entitlement is unresolved or failed', () => {
    expect(planWordFromEntitlement(null, false)).toBeNull();
  });
});
