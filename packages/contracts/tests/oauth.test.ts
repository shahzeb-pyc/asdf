import { describe, expect, it } from 'vitest';
import {
  FacebookOAuthCallbackQuerySchema,
  FacebookTokenExchangeResponseSchema,
  FacebookUserProfileResponseSchema,
  OAuthStatePayloadSchema,
  signOAuthState,
  verifyOAuthState,
  signMagicLinkToken,
  verifyMagicLinkToken,
} from '../src/domain/oauth';
import { UnauthorizedError } from '../src/errors/domain-error';

describe('Facebook OAuth Contracts & State Signing', () => {
  const secret = 'test-secret-key-for-oauth-state-signing-32chars';
  const validStatePayload = {
    tenantSubdomain: 'acme',
    userId: '123e4567-e89b-12d3-a456-426614174000',
    nonce: 'random_nonce_string_12345',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 600, // 10 minutes
  };

  it('should validate OAuthStatePayloadSchema correctly', () => {
    const parsed = OAuthStatePayloadSchema.parse(validStatePayload);
    expect(parsed.tenantSubdomain).toBe('acme');
    expect(parsed.userId).toBe('123e4567-e89b-12d3-a456-426614174000');
  });

  it('should validate and preserve redirectUri in OAuthStatePayloadSchema', () => {
    const withRedirectUri = {
      ...validStatePayload,
      redirectUri: 'https://acme.vinsmokemedia.online/api/auth/facebook/callback',
    };
    const parsed = OAuthStatePayloadSchema.parse(withRedirectUri);
    expect(parsed.redirectUri).toBe(
      'https://acme.vinsmokemedia.online/api/auth/facebook/callback'
    );
  });

  it('should sign and verify OAuth state with redirectUri', async () => {
    const withRedirectUri = {
      ...validStatePayload,
      redirectUri: 'https://acme.vinsmokemedia.online/api/auth/facebook/callback',
    };
    const signedToken = await signOAuthState(withRedirectUri, secret);
    const verified = await verifyOAuthState(signedToken, secret);
    expect(verified.redirectUri).toBe(
      'https://acme.vinsmokemedia.online/api/auth/facebook/callback'
    );
  });

  it('should sign and verify OAuth state successfully', async () => {
    const signedToken = await signOAuthState(validStatePayload, secret);
    expect(signedToken).toContain('.');

    const verified = await verifyOAuthState(signedToken, secret);
    expect(verified.tenantSubdomain).toBe('acme');
    expect(verified.userId).toBe(validStatePayload.userId);
    expect(verified.nonce).toBe(validStatePayload.nonce);
  });

  it('should reject tampered OAuth state tokens', async () => {
    const signedToken = await signOAuthState(validStatePayload, secret);
    const [payload, sig] = signedToken.split('.');
    const tampered = `${payload}.${sig.slice(0, -1)}${sig.endsWith('a') ? 'b' : 'a'}`;

    await expect(verifyOAuthState(tampered, secret)).rejects.toThrow(
      /signature/i
    );
  });

  it('should reject invalid hex formats with UnauthorizedError', async () => {
    const signedToken = await signOAuthState(validStatePayload, secret);
    const [payload] = signedToken.split('.');

    // Odd-length hex signature
    await expect(verifyOAuthState(`${payload}.abc`, secret)).rejects.toThrow(
      UnauthorizedError
    );

    // Non-hex characters in signature
    await expect(
      verifyOAuthState(`${payload}.zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz`, secret)
    ).rejects.toThrow(UnauthorizedError);
  });

  it('should sign and verify MagicLinkToken successfully', async () => {
    const magicPayload = {
      tenantSubdomain: 'agency',
      userId: '123e4567-e89b-12d3-a456-426614174000',
      nonce: 'magic_nonce_12345678',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 900,
    };
    const signedMagic = await signMagicLinkToken(magicPayload, secret);
    const verifiedMagic = await verifyMagicLinkToken(signedMagic, secret);
    expect(verifiedMagic.tenantSubdomain).toBe('agency');
    expect(verifiedMagic.userId).toBe(magicPayload.userId);

    // Tampered magic link
    const [payload, sig] = signedMagic.split('.');
    const tampered = `${payload}.${sig.slice(0, -1)}${sig.endsWith('0') ? '1' : '0'}`;
    await expect(verifyMagicLinkToken(tampered, secret)).rejects.toThrow(
      UnauthorizedError
    );
  });

  it('should round-trip an Instagram magic-link token with the expected account hint', async () => {
    const now = Math.floor(Date.now() / 1000);
    const magicPayload = {
      tenantSubdomain: 'agency',
      userId: '123e4567-e89b-12d3-a456-426614174000',
      nonce: 'instagram_magic_nonce_1234',
      iat: now,
      exp: now + 900,
      expectedInstagramAccountId: 'ig_user_123',
      expectedDisplayName: 'Sunset Bakery',
    };
    const signedMagic = await signMagicLinkToken(magicPayload, secret);
    const verifiedMagic = await verifyMagicLinkToken(signedMagic, secret);
    expect(verifiedMagic.expectedInstagramAccountId).toBe('ig_user_123');
    expect(verifiedMagic.expectedDisplayName).toBe('Sunset Bakery');
    // Reusable within the window: verifying the same token twice succeeds.
    const verifiedAgain = await verifyMagicLinkToken(signedMagic, secret);
    expect(verifiedAgain.nonce).toBe('instagram_magic_nonce_1234');

    const state = await signOAuthState(
      {
        tenantSubdomain: 'agency',
        userId: '123e4567-e89b-12d3-a456-426614174000',
        nonce: 'instagram_state_nonce_1234',
        iat: now,
        exp: now + 600,
        isMagic: true,
        expectedInstagramAccountId: 'ig_user_123',
        expectedDisplayName: 'Sunset Bakery',
      },
      secret
    );
    const verifiedState = await verifyOAuthState(state, secret);
    expect(verifiedState.isMagic).toBe(true);
    expect(verifiedState.expectedInstagramAccountId).toBe('ig_user_123');
  });

  it('should reject expired OAuth state tokens', async () => {
    const expiredPayload = {
      ...validStatePayload,
      iat: Math.floor(Date.now() / 1000) - 1000,
      exp: Math.floor(Date.now() / 1000) - 100, // Expired 100s ago
    };
    const signedToken = await signOAuthState(expiredPayload, secret);

    await expect(verifyOAuthState(signedToken, secret)).rejects.toThrow(
      /expired/i
    );
  });

  it('should validate callback query parameters', () => {
    const validQuery = {
      code: 'AQB...mock_code',
      state: 'valid_state_token',
    };
    expect(FacebookOAuthCallbackQuerySchema.parse(validQuery)).toEqual(
      validQuery
    );
  });

  it('should validate token exchange response schema targeting Graph API v26.0', () => {
    const exchange = {
      access_token: 'EAAB...long_lived_token',
      token_type: 'bearer',
      expires_in: 5184000,
    };
    expect(FacebookTokenExchangeResponseSchema.parse(exchange)).toEqual(
      exchange
    );
  });

  it('should validate user profile response schema with and without picture.data.url, gender, and link', () => {
    const profile = {
      id: '1000123456789',
      name: 'Taylor Mark',
    };
    expect(FacebookUserProfileResponseSchema.parse(profile)).toEqual(profile);

    const profileWithMetadata = {
      id: '1000123456789',
      name: 'Taylor Mark',
      gender: 'male',
      link: 'https://www.facebook.com/app_scoped_user_id/1000123456789/',
      picture: {
        data: {
          url: 'https://platform-lookaside.fbsbx.com/platform/profilepic/taylor.jpg',
        },
      },
    };
    expect(FacebookUserProfileResponseSchema.parse(profileWithMetadata)).toEqual(
      profileWithMetadata
    );
  });
});
