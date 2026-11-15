import { describe, expect, it } from 'vitest';
import { buildBrandWhatsAppSupportUrl } from './brand';

/**
 * Brand WhatsApp support URL (spec 191 Home buttons fix).
 *
 * The expired banner and the paid plan card on the white-label brand
 * link renewals to the brand's WhatsApp support instead of the
 * billing pages, which do not exist there. The URL comes from the
 * brand config — never a hardcoded number in the page — so this
 * pins the exact link the Home buttons render on NextRise.
 */
describe('buildBrandWhatsAppSupportUrl', () => {
  it('returns the NextRise support link on the white-label brand', () => {
    expect(buildBrandWhatsAppSupportUrl('nextrise')).toBe(
      'https://wa.me/923429469500?text=Hi!%20I%20need%20assistance%20with%20my%20NextRise%20account.'
    );
  });
});
