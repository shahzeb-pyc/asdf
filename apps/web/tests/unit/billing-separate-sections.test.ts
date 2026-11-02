import { describe, expect, it } from 'vitest';
import { quoteDowngrade } from '@fbuploadpro/contracts';
import { isFreePlanExemptRoute } from '@/components/billing/free-plan-gate';

/**
 * Separate-sections build (2026-11-02): downgrade quote math and
 * gate exemptions for the four new routes. Pure functions only —
 * the route-level behaviour (builder, checkout, confirmation) is
 * covered by the UI tests in tests/ui/billing-purchase.test.tsx.
 */
describe('quoteDowngrade', () => {
  const old = { facebook: 5, instagram: 3, threads: 0, x: 0, tiktok: 0, youtube: 0 };

  it('charges the new lower monthly total, with no credit', () => {
    const quote = quoteDowngrade(old, { ...old, facebook: 2 });
    expect(quote.oldMonthlyTotalPkr).toBe(560);
    expect(quote.newMonthlyTotalPkr).toBe(350);
    expect(quote.amountToPayPkr).toBe(350);
  });

  it('allows a per-platform decrease', () => {
    const quote = quoteDowngrade(old, { ...old, instagram: 0 });
    expect(quote.newMonthlyTotalPkr).toBe(350);
  });

  it('rejects any platform increase as an upgrade, not a downgrade', () => {
    expect(() =>
      quoteDowngrade(old, { ...old, facebook: 2, instagram: 4 })
    ).toThrow();
  });

  it('rejects an unchanged or higher total', () => {
    expect(() => quoteDowngrade(old, { ...old })).toThrow();
    expect(() => quoteDowngrade(old, { ...old, facebook: 6 })).toThrow();
  });

  it('rejects zero units', () => {
    expect(() =>
      quoteDowngrade(old, { facebook: 0, instagram: 0, threads: 0, x: 0, tiktok: 0, youtube: 0 })
    ).toThrow();
  });
});

describe('isFreePlanExemptRoute after the split', () => {
  it('exempts all four separate billing sections for a Free user', () => {
    for (const section of ['my-plan', 'purchase', 'payments', 'refund']) {
      expect(isFreePlanExemptRoute(`/tenant/acme/${section}`, 'acme')).toBe(true);
    }
    expect(isFreePlanExemptRoute('/tenant/acme/purchase/checkout', 'acme')).toBe(true);
    expect(
      isFreePlanExemptRoute('/tenant/acme/purchase/confirmation?payment=abc', 'acme')
    ).toBe(true);
  });

  it('still exempts home and prompts, and still gates other sections', () => {
    expect(isFreePlanExemptRoute('/tenant/acme/', 'acme')).toBe(true);
    expect(isFreePlanExemptRoute('/tenant/acme/prompts', 'acme')).toBe(true);
    expect(isFreePlanExemptRoute('/tenant/acme/pages', 'acme')).toBe(false);
    expect(isFreePlanExemptRoute('/tenant/acme/media', 'acme')).toBe(false);
  });
});
