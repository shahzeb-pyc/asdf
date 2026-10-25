import { describe, it, expect } from 'vitest';
import { buildPrivacyPolicyUrl } from '../../src/lib/privacy-url';

describe('buildPrivacyPolicyUrl', () => {
  it('builds the workspace-subdomain URL for the production root domain', () => {
    expect(buildPrivacyPolicyUrl('shahzebpyc', 'fbuploadpro.com')).toBe(
      'https://shahzebpyc.fbuploadpro.com/privacy'
    );
  });

  it('normalizes subdomain and root domain casing/whitespace', () => {
    expect(buildPrivacyPolicyUrl(' ShahzebPYC ', ' FBUploadPro.COM ')).toBe(
      'https://shahzebpyc.fbuploadpro.com/privacy'
    );
  });

  it('uses http and keeps the port on localhost', () => {
    expect(buildPrivacyPolicyUrl('acme', 'localhost:3000')).toBe(
      'http://acme.localhost:3000/privacy'
    );
  });

  it('falls back to the relative path with no subdomain', () => {
    expect(buildPrivacyPolicyUrl('', 'fbuploadpro.com')).toBe('/privacy');
    expect(buildPrivacyPolicyUrl(null, 'fbuploadpro.com')).toBe('/privacy');
    expect(buildPrivacyPolicyUrl(undefined, 'fbuploadpro.com')).toBe('/privacy');
  });
});
