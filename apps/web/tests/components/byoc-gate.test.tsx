/**
 * @file byoc-gate.test.tsx
 * @description Spec 123 Part C: point-of-need credentials gate (T7).
 * The gate blocks only when app details are known to be missing; it
 * renders the connect action while checking, when details are present,
 * and when the check itself failed (fail open, mirroring PR #641).
 */
import React from 'react';
import { describe, expect, it } from 'vitest';
import {
  ByocGate,
  checkByocCredentials,
  isByocGateBlocking,
  type ByocGateStatus,
} from '@/components/connect/byoc-gate';
import {
  connectNoticeMessage,
  mapProviderDenial,
} from '@/lib/connect/errors';
import {
  getPlatformConnectConfig,
  hasPlatformConnectConfig,
  isByocPlatform,
  listRegisteredPlatforms,
  PLATFORM_LABELS,
} from '@/lib/connect/registry';
import {
  socialStatusLabel,
  socialStatusSignal,
} from '@/components/accounts/social-accounts-list';
import {
  DestinationPicker,
  destinationSubtitle,
  findDuplicateDestinationNames,
  submitDestinationPick,
} from '@/components/connect/destination-picker';
import { loadSocialAccounts } from '@/components/accounts/social-accounts-list';
import { render } from './setup';

function fakeResponse(ok: boolean, body: unknown, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

describe('isByocGateBlocking (PR #641 semantics)', () => {
  it('blocks when the check finished and details are missing', () => {
    const status: ByocGateStatus = {
      isLoading: false,
      hasCredentials: false,
      error: null,
    };
    expect(isByocGateBlocking(status)).toBe(true);
  });

  it('does not block while the check is running', () => {
    expect(
      isByocGateBlocking({ isLoading: true, hasCredentials: false, error: null })
    ).toBe(false);
  });

  it('does not block when details are present', () => {
    expect(
      isByocGateBlocking({ isLoading: false, hasCredentials: true, error: null })
    ).toBe(false);
  });

  it('fails open when the check itself errored', () => {
    expect(
      isByocGateBlocking({
        isLoading: false,
        hasCredentials: false,
        error: "Couldn't verify your app details just now.",
      })
    ).toBe(false);
  });
});

describe('ByocGate rendering', () => {
  const child = <span>Connect Instagram now</span>;

  it('renders the point-of-need prompt with inline steps when details are missing', () => {
    const { html, hasText } = render(
      <ByocGate
        platform="instagram"
        platformName="Instagram"
        subdomain="acme"
        initialStatus={{ isLoading: false, hasCredentials: false, error: null }}
      >
        {child}
      </ByocGate>
    );
    expect(hasText('Add your Instagram app details first')).toBe(true);
    expect(hasText('Create a Meta app for your business.')).toBe(true);
    expect(hasText('Connect Instagram now')).toBe(false);
    expect(html).toContain('/tenant/acme/settings?tab=instagram');
    expect(html).toContain('data-testid="byoc-gate-prompt"');
  });

  it('names the Threads pair trap in the Threads gate steps', () => {
    const { hasText } = render(
      <ByocGate
        platform="threads"
        platformName="Threads"
        subdomain="acme"
        initialStatus={{ isLoading: false, hasCredentials: false, error: null }}
      >
        {child}
      </ByocGate>
    );
    expect(hasText('Add your Threads app details first')).toBe(true);
    expect(
      hasText('this pair is different from your main app pair')
    ).toBe(true);
  });

  it('renders children when details are present', () => {
    const { hasText } = render(
      <ByocGate
        platform="instagram"
        platformName="Instagram"
        subdomain="acme"
        initialStatus={{ isLoading: false, hasCredentials: true, error: null }}
      >
        {child}
      </ByocGate>
    );
    expect(hasText('Connect Instagram now')).toBe(true);
    expect(hasText('Add your Instagram app details first')).toBe(false);
  });

  it('renders children when the credentials check failed (fail open)', () => {
    const { hasText } = render(
      <ByocGate
        platform="instagram"
        platformName="Instagram"
        subdomain="acme"
        initialStatus={{
          isLoading: false,
          hasCredentials: false,
          error: "Couldn't verify your app details just now.",
        }}
      >
        {child}
      </ByocGate>
    );
    expect(hasText('Connect Instagram now')).toBe(true);
    expect(hasText('Add your Instagram app details first')).toBe(false);
  });

  it('uses no protocol jargon in the gate copy', () => {
    const { html } = render(
      <ByocGate
        platform="instagram"
        platformName="Instagram"
        subdomain="acme"
        initialStatus={{ isLoading: false, hasCredentials: false, error: null }}
      >
        {child}
      </ByocGate>
    );
    expect(html).not.toMatch(/oauth|scope|endpoint/i);
  });
});

describe('checkByocCredentials', () => {

  it('reports credentials present when the route returns an app ID and a saved secret', async () => {
    const fetcher = async () =>
      fakeResponse(true, { appId: 'app-123', hasSecret: true });
    const status = await checkByocCredentials(
      'acme',
      'instagram',
      fetcher as typeof fetch
    );
    expect(status).toEqual({
      isLoading: false,
      hasCredentials: true,
      error: null,
    });
  });

  it('reports credentials missing when the secret has not been saved', async () => {
    const fetcher = async () =>
      fakeResponse(true, { appId: 'app-123', hasSecret: false });
    const status = await checkByocCredentials(
      'acme',
      'threads',
      fetcher as typeof fetch
    );
    expect(status.hasCredentials).toBe(false);
    expect(status.error).toBeNull();
    expect(isByocGateBlocking(status)).toBe(true);
  });

  it('reports an error status on a failed request or a thrown fetch', async () => {
    const failing = async () => fakeResponse(false, {});
    const failedStatus = await checkByocCredentials(
      'acme',
      'instagram',
      failing as typeof fetch
    );
    expect(failedStatus.error).toBeTruthy();
    expect(isByocGateBlocking(failedStatus)).toBe(false);

    const throwing = async () => {
      throw new Error('offline');
    };
    const thrownStatus = await checkByocCredentials(
      'acme',
      'instagram',
      throwing as unknown as typeof fetch
    );
    expect(thrownStatus.error).toBeTruthy();
  });

  it('asks the frozen Part A credentials route for the platform', async () => {
    let requestedUrl = '';
    const fetcher = async (input: RequestInfo | URL) => {
      requestedUrl = String(input);
      return fakeResponse(true, { appId: null, hasSecret: false });
    };
    await checkByocCredentials('acme', 'threads', fetcher as typeof fetch);
    expect(requestedUrl).toBe(
      '/api/tenant/acme/settings/platform-credentials/threads'
    );
  });
});

describe('Connect helpers', () => {
  it('maps provider denials to plain-language notice codes', () => {
    expect(mapProviderDenial('access_denied')).toBe('denied');
    expect(mapProviderDenial('user_cancelled')).toBe('denied');
    expect(mapProviderDenial('server_error')).toBe('connect_failed');
    expect(mapProviderDenial(null)).toBe('connect_failed');
    expect(connectNoticeMessage('denied')).toBe(
      'Connection canceled. No changes were made.'
    );
    expect(connectNoticeMessage('something-unknown')).toBe(
      connectNoticeMessage('connect_failed')
    );
  });

  it('knows the BYOC platforms and labels every platform', () => {
    expect(isByocPlatform('instagram')).toBe(true);
    expect(isByocPlatform('threads')).toBe(true);
    expect(isByocPlatform('youtube')).toBe(false);
    expect(isByocPlatform('x')).toBe(false);
    expect(PLATFORM_LABELS.tiktok).toBe('TikTok');
    expect(hasPlatformConnectConfig('myspace')).toBe(false);
    expect(getPlatformConnectConfig('myspace')).toBeNull();
    expect(Array.isArray(listRegisteredPlatforms())).toBe(true);
  });

  it('labels social account and destination statuses in plain language', () => {
    expect(socialStatusSignal('active')).toBe('operational');
    expect(socialStatusSignal('expired')).toBe('queued');
    expect(socialStatusSignal('revoked')).toBe('critical');
    expect(socialStatusSignal('disconnected')).toBe('idle');
    expect(socialStatusLabel('active')).toBe('Connected');
    expect(socialStatusLabel('expired')).toContain('reconnect');
    expect(socialStatusLabel('disconnected')).toBe('Disconnected');
  });
});

describe('Connect data helpers', () => {

  it('submitDestinationPick returns the Accounts URL on success', async () => {
    const fetcher = async () =>
      fakeResponse(true, { accountsUrl: '/tenant/acme/accounts' });
    const result = await submitDestinationPick(
      'instagram',
      'acme',
      ['dest-1'],
      fetcher as typeof fetch
    );
    expect(result).toEqual({ ok: true, accountsUrl: '/tenant/acme/accounts' });
  });

  it('submitDestinationPick falls back to the Accounts path and reports failures plainly', async () => {
    const noUrl = async () => fakeResponse(true, {});
    const fallback = await submitDestinationPick(
      'x',
      'acme',
      ['dest-1'],
      noUrl as typeof fetch
    );
    // Per-platform framework fallback (Gap 2): platform 'x' falls back to
    // its own accounts page, not Facebook's, when the server returns no URL.
    expect(fallback).toEqual({ ok: true, accountsUrl: '/tenant/acme/x/accounts' });

    const failing = async () => fakeResponse(false, {}, 500);
    const failed = await submitDestinationPick(
      'x',
      'acme',
      ['dest-1'],
      failing as typeof fetch
    );
    expect(failed.ok).toBe(false);

    const throwing = async () => {
      throw new Error('offline');
    };
    const thrown = await submitDestinationPick(
      'x',
      'acme',
      ['dest-1'],
      throwing as unknown as typeof fetch
    );
    expect(thrown.ok).toBe(false);
  });

  it('loadSocialAccounts returns accounts, an empty list, or null on failure', async () => {
    const withData = async () =>
      fakeResponse(true, { accounts: [{ id: 'a1' }] });
    expect(
      await loadSocialAccounts('acme', withData as typeof fetch)
    ).toHaveLength(1);

    const empty = async () => fakeResponse(true, {});
    expect(await loadSocialAccounts('acme', empty as typeof fetch)).toEqual([]);

    const failing = async () => fakeResponse(false, {}, 500);
    expect(await loadSocialAccounts('acme', failing as typeof fetch)).toBeNull();

    const throwing = async () => {
      throw new Error('offline');
    };
    expect(
      await loadSocialAccounts('acme', throwing as unknown as typeof fetch)
    ).toBeNull();
  });
});

describe('Destination picker disambiguation (spec 109 behaviour)', () => {
  const destinations = [
    { externalDestinationId: 'dest-1001', name: 'My Brand', handle: 'mybrand.one' },
    { externalDestinationId: 'dest-2002', name: 'My Brand', handle: 'mybrand.two' },
    { externalDestinationId: 'dest-3003', name: 'Side Project', handle: 'sideproject' },
  ];

  it('flags only the names that appear more than once', () => {
    const duplicates = findDuplicateDestinationNames(destinations);
    expect(duplicates.has('my brand')).toBe(true);
    expect(duplicates.has('side project')).toBe(false);
  });

  it('distinguishes same-name rows by handle and ID suffix, unique names by handle only', () => {
    const duplicate = findDuplicateDestinationNames(destinations);
    const first = destinationSubtitle(
      destinations[0],
      duplicate.has('my brand')
    );
    expect(first).toContain('@mybrand.one');
    expect(first).toContain('ID …');
    const unique = destinationSubtitle(
      destinations[2],
      duplicate.has('side project')
    );
    expect(unique).toBe('@sideproject');
  });

  it('renders same-name destinations as separate rows, never merged', () => {
    const { html, hasText } = render(
      <DestinationPicker
        platform="instagram"
        subdomain="acme"
        destinations={destinations}
        mode="picker"
      />
    );
    expect(html).toContain('data-testid="destination-row-dest-1001"');
    expect(html).toContain('data-testid="destination-row-dest-2002"');
    expect(html).toContain('data-testid="destination-row-dest-3003"');
    expect(hasText('@mybrand.one')).toBe(true);
    expect(hasText('@mybrand.two')).toBe(true);
  });

  it('single-confirm mode shows the one destination with a confirm button', () => {
    const { html, hasText } = render(
      <DestinationPicker
        platform="x"
        subdomain="acme"
        destinations={[
          { externalDestinationId: 'x-1', name: 'Fixture X', handle: 'fixturex' },
        ]}
        mode="single-confirm"
      />
    );
    expect(hasText('Fixture X')).toBe(true);
    expect(hasText('Add this X destination')).toBe(true);
    expect(html).not.toContain('type="checkbox"');
  });
});
