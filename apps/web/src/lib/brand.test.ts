import { afterEach, describe, expect, it } from 'vitest';
import { buildBrandWhatsAppSupportUrl, getRequestBrandAppUrl } from './brand';

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
      'https://wa.me/923081311411?text=Hi!%20I%20need%20assistance%20with%20my%20NextRise%20account.'
    );
  });
});

/**
 * Brand app-host origin (spec 208).
 *
 * The magic-link generators and the magic outcome pages build their
 * URLs on the brand's app host. The white-label brand always
 * resolves to its gateway host — the deployment-wide
 * `NEXT_PUBLIC_APP_URL` is our app host, so a magic link built
 * from it would run the whole connect on fbuploadpro.com. Our
 * brand keeps the configured app URL, exactly as before.
 */
describe('getRequestBrandAppUrl', () => {
  const requestOn = (host: string) => ({
    headers: { get: (name: string) => (name === 'host' ? host : null) },
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_APP_URL;
  });

  it('returns the white-label gateway host for a white-label tenant host, ignoring NEXT_PUBLIC_APP_URL', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.fbuploadpro.com';
    expect(getRequestBrandAppUrl(requestOn('sajidali.sajidaliai.online'))).toBe(
      'https://app.sajidaliai.online'
    );
  });

  it('returns the white-label gateway host for a request already on the white-label app host', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.fbuploadpro.com';
    expect(getRequestBrandAppUrl(requestOn('app.sajidaliai.online'))).toBe(
      'https://app.sajidaliai.online'
    );
  });

  it('returns the configured app URL for our brand', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.fbuploadpro.com';
    expect(getRequestBrandAppUrl(requestOn('acme.fbuploadpro.com'))).toBe(
      'https://app.fbuploadpro.com'
    );
  });

  it('strips a trailing slash off the configured app URL for our brand', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.fbuploadpro.com/';
    expect(getRequestBrandAppUrl(requestOn('acme.fbuploadpro.com'))).toBe(
      'https://app.fbuploadpro.com'
    );
  });

  it('keeps the configured app URL on a localhost request for our brand', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.test';
    expect(getRequestBrandAppUrl(requestOn('localhost:3000'))).toBe(
      'https://app.example.test'
    );
  });

  it('falls back to localhost when no app URL is configured for our brand', () => {
    expect(getRequestBrandAppUrl(requestOn('localhost:3000'))).toBe(
      'http://localhost:3000'
    );
  });

  it('falls back to the configured app URL with no request at all', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.fbuploadpro.com';
    expect(getRequestBrandAppUrl(null)).toBe('https://app.fbuploadpro.com');
  });
});
