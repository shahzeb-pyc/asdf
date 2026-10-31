import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  POSTHOG_DEFAULT_HOST,
  normalizePostHogHost,
} from '@/lib/posthog-host';

/**
 * Host-guard suite. The regression this pins: POSTHOG_HOST used to be
 * passed verbatim to posthog-js, so a bare region value ("US") became
 * request host `US` and every analytics call 404'd while the app
 * looked correctly configured. Every case below asserts the host
 * that would actually be requested.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe('normalizePostHogHost', () => {
  it('defaults when the value is missing or blank', () => {
    expect(normalizePostHogHost(undefined)).toBe(POSTHOG_DEFAULT_HOST);
    expect(normalizePostHogHost(null)).toBe(POSTHOG_DEFAULT_HOST);
    expect(normalizePostHogHost('')).toBe(POSTHOG_DEFAULT_HOST);
    expect(normalizePostHogHost('   ')).toBe(POSTHOG_DEFAULT_HOST);
  });

  it('maps bare region codes to the real ingest hosts', () => {
    expect(normalizePostHogHost('US')).toBe(POSTHOG_DEFAULT_HOST);
    expect(normalizePostHogHost('us')).toBe(POSTHOG_DEFAULT_HOST);
    expect(normalizePostHogHost('  US  ')).toBe(POSTHOG_DEFAULT_HOST);
    expect(normalizePostHogHost('EU')).toBe('https://eu.i.posthog.com');
    expect(normalizePostHogHost('eu')).toBe('https://eu.i.posthog.com');
  });

  it('prepends https to a bare hostname', () => {
    expect(normalizePostHogHost('us.i.posthog.com')).toBe(
      POSTHOG_DEFAULT_HOST
    );
    expect(normalizePostHogHost('eu.i.posthog.com')).toBe(
      'https://eu.i.posthog.com'
    );
  });

  it('passes a full ingest URL through, minus trailing slashes', () => {
    expect(normalizePostHogHost('https://us.i.posthog.com')).toBe(
      POSTHOG_DEFAULT_HOST
    );
    expect(normalizePostHogHost('https://us.i.posthog.com/')).toBe(
      POSTHOG_DEFAULT_HOST
    );
    expect(normalizePostHogHost('https://custom.example.com/ingest/')).toBe(
      'https://custom.example.com/ingest'
    );
  });

  it('falls back to the default host — loudly — for malformed values', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(normalizePostHogHost('://not-a-host')).toBe(POSTHOG_DEFAULT_HOST);
    // A non-http(s) scheme is malformed input, not a host to prefix.
    // (Deliberately an unknown scheme, not ftp/ws: those are real
    // clear-text protocols and Sonar flags their literals, S5332.)
    expect(normalizePostHogHost('bogus-scheme://us.i.posthog.com')).toBe(
      POSTHOG_DEFAULT_HOST
    );
    expect(normalizePostHogHost('not a url with spaces')).toBe(
      POSTHOG_DEFAULT_HOST
    );
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls[0][0]).toContain('malformed POSTHOG_HOST');
  });

  it('does not warn for valid values', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    normalizePostHogHost('US');
    normalizePostHogHost('https://us.i.posthog.com');
    normalizePostHogHost(undefined);
    expect(warn).not.toHaveBeenCalled();
  });
});
