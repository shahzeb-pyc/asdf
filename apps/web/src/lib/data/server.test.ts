import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerBaseUrl } from '@/lib/data/server';

describe('getServerBaseUrl', () => {
  const originalVercelUrl = process.env.VERCEL_URL;
  const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;

  beforeEach(() => {
    delete process.env.VERCEL_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (originalVercelUrl !== undefined) {
      process.env.VERCEL_URL = originalVercelUrl;
    } else {
      delete process.env.VERCEL_URL;
    }
    if (originalAppUrl !== undefined) {
      process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
    } else {
      delete process.env.NEXT_PUBLIC_APP_URL;
    }
  });

  it('prefers VERCEL_URL over NEXT_PUBLIC_APP_URL (the current deployment wins)', () => {
    vi.stubEnv(
      'VERCEL_URL',
      'fbuploadpro-git-feat-pages-dedicated-redesign-velocta.vercel.app'
    );
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.fbuploadpro.com');
    expect(getServerBaseUrl()).toBe(
      'https://fbuploadpro-git-feat-pages-dedicated-redesign-velocta.vercel.app'
    );
  });

  it('uses VERCEL_URL alone as an https origin', () => {
    vi.stubEnv('VERCEL_URL', 'fbuploadpro-git-main-velocta.vercel.app');
    expect(getServerBaseUrl()).toBe('https://fbuploadpro-git-main-velocta.vercel.app');
  });

  it('falls back to NEXT_PUBLIC_APP_URL when VERCEL_URL is unset', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.fbuploadpro.com');
    expect(getServerBaseUrl()).toBe('https://app.fbuploadpro.com');
  });

  it('falls back to localhost when neither variable is set', () => {
    expect(getServerBaseUrl()).toBe('http://localhost:3000');
  });

  it('strips trailing slashes from both origins', () => {
    vi.stubEnv('VERCEL_URL', 'preview.example.vercel.app///');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.fbuploadpro.com///');
    expect(getServerBaseUrl()).toBe('https://preview.example.vercel.app');
    vi.unstubAllEnvs();
    delete process.env.VERCEL_URL;
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.fbuploadpro.com///');
    expect(getServerBaseUrl()).toBe('https://app.fbuploadpro.com');
  });
});
