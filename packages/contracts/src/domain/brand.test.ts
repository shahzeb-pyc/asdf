import { describe, expect, it } from 'vitest';
import {
  BrandConfigSchema,
  NEXTRISE_BRAND_CONFIG,
  brandLoginMismatchMessage,
  getBrandFlags,
  getBrandGatewayHost,
  getBrandTenantRoot,
  isWhiteLabelBlockedApiPath,
  isWhiteLabelBlockedAuthPath,
  isWhiteLabelBlockedTenantPath,
  resolveBrandFromHost,
} from './brand.js';

describe('resolveBrandFromHost', () => {
  it('maps the white-label gateway host to nextrise', () => {
    expect(resolveBrandFromHost('app.nextrisehq.com')).toBe('nextrise');
  });

  it('maps white-label tenant hosts to nextrise', () => {
    expect(resolveBrandFromHost('student1.app.nextrisehq.com')).toBe('nextrise');
  });

  it('is case- and port-insensitive', () => {
    expect(resolveBrandFromHost('STUDENT1.App.NextriseHQ.com:443')).toBe('nextrise');
  });

  it('maps our gateway and tenant hosts to fbuploadpro', () => {
    expect(resolveBrandFromHost('app.fbuploadpro.com')).toBe('fbuploadpro');
    expect(resolveBrandFromHost('shahzeb.fbuploadpro.com')).toBe('fbuploadpro');
  });

  it('defaults to fbuploadpro for unknown hosts', () => {
    expect(resolveBrandFromHost('example.com')).toBe('fbuploadpro');
    expect(resolveBrandFromHost(null)).toBe('fbuploadpro');
    expect(resolveBrandFromHost(undefined)).toBe('fbuploadpro');
    expect(resolveBrandFromHost('')).toBe('fbuploadpro');
  });

  it('does NOT treat the bare white-label domain as the app', () => {
    expect(resolveBrandFromHost('nextrisehq.com')).toBe('fbuploadpro');
    expect(resolveBrandFromHost('www.nextrisehq.com')).toBe('fbuploadpro');
  });

  it('does NOT match a lookalike suffix', () => {
    expect(resolveBrandFromHost('app.nextrisehq.com.evil.com')).toBe('fbuploadpro');
    expect(resolveBrandFromHost('notapp.nextrisehq.com')).toBe('fbuploadpro');
  });
});

describe('getBrandTenantRoot / getBrandGatewayHost', () => {
  it('white-label root is always app.nextrisehq.com', () => {
    expect(getBrandTenantRoot('nextrise', 'fbuploadpro.com')).toBe('app.nextrisehq.com');
    expect(getBrandGatewayHost('nextrise', 'fbuploadpro.com')).toBe('app.nextrisehq.com');
  });

  it('our brand keeps the configured root verbatim', () => {
    expect(getBrandTenantRoot('fbuploadpro', 'fbuploadpro.com')).toBe('fbuploadpro.com');
    // The port is part of the root: stripping it broke localhost
    // login redirects (activecorp.localhost lost its :3000).
    expect(getBrandTenantRoot('fbuploadpro', 'localhost:3000')).toBe('localhost:3000');
    // An empty root stays empty: the OAuth helpers resolve locally
    // from the request URL when no root is configured.
    expect(getBrandTenantRoot('fbuploadpro', '')).toBe('');
    expect(getBrandGatewayHost('fbuploadpro', 'fbuploadpro.com')).toBe('app.fbuploadpro.com');
  });

  it('our brand keeps a localhost root with its port', () => {
    expect(getBrandGatewayHost('fbuploadpro', 'localhost:3000')).toBe('app.localhost:3000');
  });
});

describe('getBrandFlags', () => {
  it('hides signup, billing, password reset and Muse on the white-label brand', () => {
    expect(getBrandFlags('nextrise')).toEqual({
      allowSignup: false,
      showBilling: false,
      allowPasswordReset: false,
      showMuse: false,
      showTopbarDaysPill: true,
    });
  });

  it('keeps everything on our brand and hides the days pill', () => {
    expect(getBrandFlags('fbuploadpro')).toEqual({
      allowSignup: true,
      showBilling: true,
      allowPasswordReset: true,
      showMuse: true,
      showTopbarDaysPill: false,
    });
  });
});

describe('NEXTRISE_BRAND_CONFIG', () => {
  it('parses against the schema and names NextRise Digital', () => {
    const parsed = BrandConfigSchema.parse(NEXTRISE_BRAND_CONFIG);
    expect(parsed.displayName).toBe('NextRise Digital');
    expect(parsed.shortName).toBe('NextRise');
    expect(parsed.logoPath).toBe('/brand/nextrise-logo.svg');
    // The wa.me dial string is the international form, not the display form.
    expect(parsed.whatsappNumber).toBe('923429469500');
  });
});

describe('brandLoginMismatchMessage', () => {
  it('points a NextRise account at the white-label login', () => {
    expect(brandLoginMismatchMessage('nextrise')).toBe(
      'This account belongs to NextRise. Please log in at app.nextrisehq.com.'
    );
  });

  it('points our account at our login', () => {
    expect(brandLoginMismatchMessage('fbuploadpro')).toBe(
      'This account belongs to FBUploadPro. Please log in at app.fbuploadpro.com.'
    );
  });
});

describe('isWhiteLabelBlockedTenantPath', () => {
  it.each(['/billing', '/my-plan', '/purchase', '/payments', '/refund', '/muse'])(
    'blocks %s on nextrise',
    (path) => {
      expect(isWhiteLabelBlockedTenantPath('nextrise', path)).toBe(true);
    }
  );

  it('blocks the /tenant/<subdomain>/… form too', () => {
    expect(isWhiteLabelBlockedTenantPath('nextrise', '/tenant/student1/billing')).toBe(true);
    expect(isWhiteLabelBlockedTenantPath('nextrise', '/tenant/student1/muse')).toBe(true);
  });

  it('does not block ordinary sections', () => {
    expect(isWhiteLabelBlockedTenantPath('nextrise', '/schedule')).toBe(false);
    expect(isWhiteLabelBlockedTenantPath('nextrise', '/')).toBe(false);
    expect(isWhiteLabelBlockedTenantPath('nextrise', '/media-library')).toBe(false);
  });

  it('never blocks on our brand', () => {
    expect(isWhiteLabelBlockedTenantPath('fbuploadpro', '/billing')).toBe(false);
    expect(isWhiteLabelBlockedTenantPath('fbuploadpro', '/muse')).toBe(false);
  });
});

describe('isWhiteLabelBlockedAuthPath', () => {
  it.each(['/signup', '/forgot-password', '/reset-password', '/verify-otp'])(
    'blocks %s on nextrise',
    (path) => {
      expect(isWhiteLabelBlockedAuthPath('nextrise', path)).toBe(true);
    }
  );

  it('keeps /login open on nextrise', () => {
    expect(isWhiteLabelBlockedAuthPath('nextrise', '/login')).toBe(false);
  });

  it('never blocks on our brand', () => {
    expect(isWhiteLabelBlockedAuthPath('fbuploadpro', '/signup')).toBe(false);
  });
});

describe('isWhiteLabelBlockedApiPath', () => {
  it('blocks signup and password-reset APIs on nextrise', () => {
    expect(isWhiteLabelBlockedApiPath('nextrise', '/api/auth/signup')).toBe(true);
    expect(isWhiteLabelBlockedApiPath('nextrise', '/api/auth/signup/verify-otp')).toBe(true);
    expect(isWhiteLabelBlockedApiPath('nextrise', '/api/auth/forgot-password')).toBe(true);
    expect(isWhiteLabelBlockedApiPath('nextrise', '/api/auth/reset-password')).toBe(true);
  });

  it('blocks tenant billing APIs on nextrise', () => {
    expect(isWhiteLabelBlockedApiPath('nextrise', '/api/tenant/student1/billing')).toBe(true);
    expect(
      isWhiteLabelBlockedApiPath('nextrise', '/api/tenant/student1/billing/payments')
    ).toBe(true);
  });

  it('blocks tenant Muse APIs on nextrise (keys + activity)', () => {
    expect(isWhiteLabelBlockedApiPath('nextrise', '/api/tenant/student1/muse/keys')).toBe(
      true
    );
    expect(
      isWhiteLabelBlockedApiPath('nextrise', '/api/tenant/student1/muse/keys/abc-123')
    ).toBe(true);
    expect(isWhiteLabelBlockedApiPath('nextrise', '/api/tenant/student1/muse/activity')).toBe(
      true
    );
  });

  it('keeps login, session and logout open on nextrise', () => {
    expect(isWhiteLabelBlockedApiPath('nextrise', '/api/auth/login')).toBe(false);
    expect(isWhiteLabelBlockedApiPath('nextrise', '/api/auth/session')).toBe(false);
    expect(isWhiteLabelBlockedApiPath('nextrise', '/api/auth/logout')).toBe(false);
  });

  it('never blocks on our brand', () => {
    expect(isWhiteLabelBlockedApiPath('fbuploadpro', '/api/auth/signup')).toBe(false);
    expect(
      isWhiteLabelBlockedApiPath('fbuploadpro', '/api/tenant/student1/billing')
    ).toBe(false);
    expect(isWhiteLabelBlockedApiPath('fbuploadpro', '/api/tenant/student1/muse/keys')).toBe(
      false
    );
  });
});
