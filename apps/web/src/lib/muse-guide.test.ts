import { describe, expect, it } from 'vitest';
import { buildMuseGuide, MUSE_GUIDE_TEMPLATE } from './muse-guide';

/**
 * Brand-aware Muse guide (spec 191, owner reversal 2026-11-15).
 *
 * Our brand returns the template untouched. The white-label brand
 * gets the brand name and guide address, and the billing parts
 * replaced — so Muse never sends a NextRise student to a billing
 * page that does not exist, and never quotes the 70 PKR price
 * that does not apply to them.
 */
describe('buildMuseGuide', () => {
  it('returns the template byte-identical on our brand', () => {
    expect(buildMuseGuide('fbuploadpro')).toBe(MUSE_GUIDE_TEMPLATE);
    expect(buildMuseGuide('fbuploadpro')).toContain('# FBUploadPro — Muse guide');
    expect(buildMuseGuide('fbuploadpro')).toContain('## My Plan');
    expect(buildMuseGuide('fbuploadpro')).toContain('## Purchase');
    expect(buildMuseGuide('fbuploadpro')).toContain('## Refund');
    expect(buildMuseGuide('fbuploadpro')).toContain('70 PKR');
    expect(buildMuseGuide('fbuploadpro')).toContain(
      'https://app.fbuploadpro.com/muse_guide.md'
    );
    // Home still describes the billing buttons on our brand.
    expect(buildMuseGuide('fbuploadpro')).toContain('an Upgrade card');
    expect(buildMuseGuide('fbuploadpro')).toContain('with a Renew button only');
  });

  it('names NextRise Digital with its own guide address on nextrise', () => {
    const guide = buildMuseGuide('nextrise');
    expect(guide).toContain('# NextRise Digital — Muse guide');
    expect(guide).toContain('https://app.sajidaliai.online/muse_guide.md');
    expect(guide).toContain('There is no billing section in this app');
    expect(guide).toContain('## Plan');
    expect(guide).not.toContain('FBUploadPro');
    expect(guide).not.toContain('app.fbuploadpro.com');
  });

  it('has no billing sections or prices on nextrise', () => {
    const guide = buildMuseGuide('nextrise');
    expect(guide).not.toContain('## My Plan');
    expect(guide).not.toContain('## Purchase');
    expect(guide).not.toContain('## Payments');
    expect(guide).not.toContain('## Refund');
    expect(guide).not.toContain('70 PKR');
    expect(guide).not.toContain('Easypaisa');
    expect(guide).not.toContain('Nayapay');
    expect(guide).not.toContain('UBL bank');
    expect(guide).not.toContain('Binance');
    expect(guide).not.toContain('Billing leaves');
    expect(guide).not.toContain('Upgrade (to Purchase)');
    expect(guide).not.toContain('My Plan or Purchase actually shows');
    // The free-plan dialogue has no Upgrade exit on this brand.
    expect(guide).toContain('Its only exit is Back to Home');
    // Spec 191 Home buttons fix: Home has no Upgrade card and no
    // Renew button on this brand — the expired banner points at
    // WhatsApp support instead.
    expect(guide).not.toContain('an Upgrade card');
    expect(guide).not.toContain('with a Renew button only');
    expect(guide).toContain('with a Contact support button only');
    expect(guide).toContain('which opens WhatsApp support to renew the plan');
  });

  it('keeps the non-billing sections on nextrise', () => {
    const guide = buildMuseGuide('nextrise');
    expect(guide).toContain('## Muse Assistant');
    expect(guide).toContain('## Media Library');
    expect(guide).toContain('## Home');
    expect(guide).toContain('## Creator Finder');
    expect(guide).toContain('## Limits you must respect');
    // Spec 198: the notice is gone from the guide on both brands.
    expect(guide).not.toContain('banner for old');
  });
});
