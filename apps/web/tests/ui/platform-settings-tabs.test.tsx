/**
 * @file platform-settings-tabs.test.tsx
 * @description Per-platform Settings tabs (spec 123 Part B).
 *
 * The Instagram/Threads credentials portions were migrated to
 * behavioural tests in spec 135 PR-135-3: the rebuilt views
 * (components/settings/platform/) are rendered into jsdom and driven
 * with user-event. The legacy `initial*` test-seam props and the
 * fetch-helper contract tests are deleted with the old files — these
 * tests seed through the React Query client (the same cache the
 * settings route dehydrates into) and stub `fetch` at the boundary
 * the typed API client calls, exactly like production traffic. Copy
 * and validation messages are spec §5.3/§5.4 verbatim (the §5.2
 * patterns with the platform's labels substituted).
 *
 * Spec 139 N3: the seeded payload carries a secret HINT, never the
 * secret — Show drives the reveal endpoint (stubbed below) and only
 * then does the value reach the screen.
 *
 * The page-level tab cases live in tests/ui/settings-shell.test.tsx
 * (PR-135-1). The plain-language (no-jargon) lint covers every
 * remaining tab. The YouTube/X/TikTok explanation tabs were removed
 * from Settings on 2026-10-25 (their views and this file's cases
 * for them were deleted with them); connecting still happens in
 * Accounts, which is what those cards pointed to.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { InstagramSettingsView } from '@/components/settings/instagram-settings-view';
import { ThreadsSettingsView } from '@/components/settings/threads-settings-view';
import { createPlatformConnectFormSchema } from '@/components/settings/platform/platform-connect-form';
import { formatPlatformConnectedDate } from '@/components/settings/platform/platform-credentials-helpers';
import {
  getPlatformCallbackUrl,
  getPlatformCallbackUrls,
} from '@/lib/platforms/callback-urls';
import { queryKeys } from '@/lib/data/query-keys';
import { Toast, toast } from '@/components/shared/ui/toast';

// userEvent interaction tests run long under coverage instrumentation;
// the per-test budget below replaces the 5s default for this file's
// interaction cases only (assertions and waits are unchanged).
const INTERACTION_TIMEOUT = 20_000;

const SUBDOMAIN = 'acme';
const WORKSPACE_ID = '11111111-1111-4111-a111-111111111111';

// Hoisted mutable search params for the next/navigation mock below.
const searchParamsState = vi.hoisted(() => ({
  current: new URLSearchParams(),
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ subdomain: 'acme' }),
  useSearchParams: () => searchParamsState.current,
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/tenant/acme/settings',
}));

interface PlatformPayload {
  workspaceId: string;
  subdomain: string;
  platform: string;
  appId: string;
  secretHint: string | null;
  hasSecret: boolean;
  status: 'unverified' | 'valid' | 'invalid';
  lastTestedAt: string | null;
  connectedAt: string | null;
}

interface PlatformCase {
  platform: 'instagram' | 'threads';
  displayName: string;
  appIdLabel: string;
  appSecretLabel: string;
  savedAppId: string;
  savedSecret: string;
  View: React.ComponentType<{ subdomain: string }>;
}

const PLATFORM_CASES: PlatformCase[] = [
  {
    platform: 'instagram',
    displayName: 'Instagram',
    appIdLabel: 'Instagram App ID',
    appSecretLabel: 'Instagram App Secret',
    savedAppId: '123456789012345',
    savedSecret: 'instagram-secret-value',
    View: InstagramSettingsView,
  },
  {
    platform: 'threads',
    displayName: 'Threads',
    appIdLabel: 'Threads App ID',
    appSecretLabel: 'Threads App Secret',
    savedAppId: '109876543210987',
    savedSecret: 'threads-secret-value',
    View: ThreadsSettingsView,
  },
];

function notConnectedPayload(platform: string): PlatformPayload {
  return {
    workspaceId: WORKSPACE_ID,
    subdomain: SUBDOMAIN,
    platform,
    appId: '',
    secretHint: null,
    hasSecret: false,
    status: 'unverified',
    lastTestedAt: null,
    connectedAt: null,
  };
}

function connectedPayload(c: PlatformCase): PlatformPayload {
  return {
    workspaceId: WORKSPACE_ID,
    subdomain: SUBDOMAIN,
    platform: c.platform,
    appId: c.savedAppId,
    secretHint: `••••${c.savedSecret.slice(-4)}`,
    hasSecret: true,
    status: 'valid',
    lastTestedAt: '2026-10-16T10:00:00.000Z',
    connectedAt: '2026-10-16T12:00:00.000Z',
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as Response;
}

/* Stateful fetch stub, keyed by platform: GET serves the platform's
 * current payload; the default PUT / DELETE responders flip it,
 * exactly like the real route. */
const currentPayloads = new Map<string, PlatformPayload>();
let putCalls: Array<{ platform: string; url: string; body: Record<string, unknown> }>;
let deleteCalls: string[];
let getResponders: Map<string, () => Promise<Response>>;
let revealResponders: Map<string, () => Promise<Response>>;
let putResponder: (platform: string, body: Record<string, unknown>) => Promise<Response>;
let deleteResponder: (platform: string) => Promise<Response>;

const clipboardWriteText = vi.fn().mockResolvedValue(undefined);

function installFetchStub() {
  currentPayloads.clear();
  for (const c of PLATFORM_CASES) {
    currentPayloads.set(c.platform, notConnectedPayload(c.platform));
  }
  putCalls = [];
  deleteCalls = [];
  getResponders = new Map();
  revealResponders = new Map();
  putResponder = async (platform, body) => {
    const c = PLATFORM_CASES.find((entry) => entry.platform === platform) as PlatformCase;
    const savedSecret = String(body.appSecret ?? c.savedSecret);
    currentPayloads.set(platform, {
      ...connectedPayload(c),
      appId: String(body.appId ?? ''),
      secretHint: `••••${savedSecret.slice(-4)}`,
    });
    return jsonResponse({
      success: true,
      hasSecret: true,
      status: 'valid',
      connectedAt: '2026-10-16T12:00:00.000Z',
    });
  };
  deleteResponder = async (platform) => {
    currentPayloads.set(platform, notConnectedPayload(platform));
    return jsonResponse({ success: true, disconnected: true });
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const match = /\/settings\/platform-credentials\/(instagram|threads)/.exec(url);
      if (match) {
        const platform = match[1] as string;
        if (method === 'GET') {
          const responder = getResponders.get(platform);
          return responder ? responder() : jsonResponse(currentPayloads.get(platform));
        }
        if (method === 'POST') {
          // The reveal action (spec 139 N3) — the URL extends the
          // credentials path, so it matches the same regex.
          const responder = revealResponders.get(platform);
          const c = PLATFORM_CASES.find(
            (entry) => entry.platform === platform
          ) as PlatformCase;
          return responder ? responder() : jsonResponse({ appSecret: c.savedSecret });
        }
        if (method === 'PUT') {
          const body = init?.body
            ? (JSON.parse(String(init.body)) as Record<string, unknown>)
            : {};
          putCalls.push({ platform, url, body });
          return putResponder(platform, body);
        }
        if (method === 'DELETE') {
          deleteCalls.push(platform);
          return deleteResponder(platform);
        }
      }
      throw new Error(`Unstubbed fetch: ${method} ${url}`);
    })
  );
}

function renderView(c: PlatformCase, seed?: PlatformPayload) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 60_000 },
      mutations: { retry: false },
    },
  });
  if (seed) {
    queryClient.setQueryData(
      queryKeys.tenant(SUBDOMAIN).settings.platformCredentials(c.platform),
      seed
    );
  }
  const View = c.View;
  render(
    <QueryClientProvider client={queryClient}>
      <View subdomain={SUBDOMAIN} />
      <Toast />
    </QueryClientProvider>
  );
  return queryClient;
}

/** The submit-failure summary, by its data-slot (inline FormMessages
 *  also carry role="alert", so a role query is ambiguous). */
async function findErrorSummary(): Promise<HTMLElement> {
  let el: HTMLElement | null = null;
  await waitFor(
    () => {
      el = document.querySelector<HTMLElement>('[data-slot="form-error-summary"]');
      expect(el).not.toBeNull();
    },
    { timeout: 10_000 }
  );
  return el as unknown as HTMLElement;
}

function installClipboardMock() {
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText: clipboardWriteText },
    configurable: true,
  });
}

beforeEach(() => {
  searchParamsState.current = new URLSearchParams();
  installFetchStub();
  clipboardWriteText.mockClear();
  installClipboardMock();
});

afterEach(() => {
  // Sonner's store is global: a toast left alive at unmount would be
  // re-rendered by the next test's Toaster and duplicate its assertions.
  toast.dismiss();
  cleanup();
  vi.unstubAllGlobals();
});

describe('connect form schema (§5.3/§5.4 messages verbatim)', () => {
  it('Instagram: rejects an empty App ID with the empty-field sentence', () => {
    const result = createPlatformConnectFormSchema(
      { appIdLabel: 'Instagram App ID', appSecretLabel: 'Instagram App Secret' },
      false
    ).safeParse({ appId: '', appSecret: 'some-secret' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe('Please enter your Instagram App ID.');
    }
  });

  it('Instagram: rejects a non-numeric App ID with the numeric sentence', () => {
    const result = createPlatformConnectFormSchema(
      { appIdLabel: 'Instagram App ID', appSecretLabel: 'Instagram App Secret' },
      false
    ).safeParse({ appId: 'abc', appSecret: 'some-secret' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(
        'Instagram App ID must be numeric (10–20 digits).'
      );
    }
  });

  it('Threads: requires the Threads App Secret when none is saved, allows blank when one is', () => {
    const labels = { appIdLabel: 'Threads App ID', appSecretLabel: 'Threads App Secret' };
    const missing = createPlatformConnectFormSchema(labels, false).safeParse({
      appId: '123456789012345',
      appSecret: '',
    });
    expect(missing.success).toBe(false);
    if (!missing.success) {
      expect(missing.error.issues[0]?.message).toBe('Please enter your Threads App Secret.');
    }
    const kept = createPlatformConnectFormSchema(labels, true).safeParse({
      appId: '123456789012345',
      appSecret: '',
    });
    expect(kept.success).toBe(true);
  });
});

describe('formatPlatformConnectedDate', () => {
  it('formats the en-US short month, day, year as shipped', () => {
    expect(formatPlatformConnectedDate('2026-10-16T12:00:00.000Z')).toBe('Oct 16, 2026');
  });
});

for (const c of PLATFORM_CASES) {
  const p = c.platform;

  describe(`${c.displayName} credentials view — loading and load failure`, () => {
    it('shows the Skeleton with the preserved loading text while details load', async () => {
      getResponders.set(p, () => new Promise<Response>(() => {}));
      renderView(c);
      expect(screen.getByTestId(`${p}-loading`)).toBeTruthy();
      expect(screen.getByText(`Loading your ${c.displayName} app details…`)).toBeTruthy();
    });

    it('shows a load-failure state with a working retry instead of the form', async () => {
      getResponders.set(p, async () => jsonResponse({ error: 'Failed' }, 500));
      renderView(c);
      expect(
        await screen.findByText(
          `Couldn't load your ${c.displayName} app details. Please try again.`
        )
      ).toBeTruthy();
      expect(screen.queryByTestId(`${p}-connect-btn`)).toBeNull();

      getResponders.delete(p);
      const user = userEvent.setup();
      await user.click(screen.getByTestId(`${p}-load-retry-btn`));
      expect(await screen.findByTestId(`${p}-connect-btn`)).toBeTruthy();
    }, INTERACTION_TIMEOUT);
  });

  describe(`${c.displayName} credentials view — not connected`, () => {
    it('renders the header, status, and form verbatim (§5.3/§5.4)', () => {
      renderView(c, notConnectedPayload(p));

      // 2026-10-25 redesign: Instagram's single-column heading is
      // "Instagram App" and its guide is removed; Threads keeps the
      // classic "Connect Threads" heading and its guide.
      expect(
        screen.getByRole('heading', {
          name: p === 'instagram' ? 'Instagram App' : `Connect ${c.displayName}`,
        })
      ).toBeTruthy();
      expect(screen.getByTestId(`${p}-settings-card`)).toBeTruthy();
      expect(screen.getByTestId(`${p}-status-badge`).textContent).toContain('Not connected');
      expect(
        screen.getByText(
          `Link your ${c.displayName} app to start publishing from this workspace.`
        )
      ).toBeTruthy();

      if (p === 'instagram') {
        expect(screen.queryByTestId(`${p}-setup-guide`)).toBeNull();
      } else {
        expect(screen.getByTestId(`${p}-setup-guide`)).toBeTruthy();
      }
      expect(screen.getByText('Add them here')).toBeTruthy();
      expect(screen.getByText(c.appIdLabel)).toBeTruthy();
      expect(screen.getByText(c.appSecretLabel)).toBeTruthy();
      const appIdInput = screen.getByTestId(`${p}-app-id-input`) as HTMLInputElement;
      expect(appIdInput.getAttribute('placeholder')).toBe('e.g. 123456789012345');
      const secretInput = screen.getByTestId(`${p}-app-secret-input`) as HTMLInputElement;
      expect(secretInput.getAttribute('placeholder')).toBe(`Enter your ${c.appSecretLabel}`);
      expect(secretInput.type).toBe('password');
      expect(screen.getByTestId(`${p}-app-secret-toggle`).textContent).toBe('Show');
      expect(
        screen.getByText('Only you can see this — it stays hidden until you choose to show it.')
      ).toBeTruthy();
      expect(screen.getByTestId(`${p}-connect-btn`).textContent).toContain(
        `Connect ${c.displayName}`
      );
      expect(
        screen.getByText('We check everything works the moment you connect.')
      ).toBeTruthy();
    });

    it('shows the "One more step" card and copying an address gives "Copied" feedback', async () => {
      renderView(c, notConnectedPayload(p));

      expect(screen.getByTestId(`${p}-one-more-step-card`)).toBeTruthy();
      expect(screen.getByText('One more step')).toBeTruthy();
      const address = screen.getByTestId(`${p}-setup-address-signin`).textContent ?? '';
      expect(address.endsWith(`/api/connect/${p}/callback`)).toBe(true);

      const user = userEvent.setup();
      // userEvent.setup() installs its own clipboard stub over the
      // beforeEach mock — re-apply the mock so the write is observable.
      installClipboardMock();
      await user.click(screen.getByTestId(`${p}-copy-signin-btn`));
      expect(clipboardWriteText).toHaveBeenCalledWith(address);
      await waitFor(() =>
        expect(screen.getByTestId(`${p}-copy-signin-btn`).textContent).toBe('Copied')
      );
    }, INTERACTION_TIMEOUT);

    it('shows the reconnect notice as a banner only when ?notice=reconnect is present', () => {
      searchParamsState.current = new URLSearchParams('notice=reconnect');
      renderView(c, notConnectedPayload(p));
      const notice = screen.getByTestId(`${p}-reconnect-notice`);
      expect(notice.textContent).toContain(
        `${c.displayName} requires an app to reconnect accounts. Add your ${c.appIdLabel} and ${c.appSecretLabel} below, then reconnect.`
      );
    });

    it('hides the reconnect notice during a normal visit', () => {
      renderView(c, notConnectedPayload(p));
      expect(screen.queryByTestId(`${p}-reconnect-notice`)).toBeNull();
    });

    it('toggles the secret between hidden and visible with Show/Hide', async () => {
      const user = userEvent.setup();
      renderView(c, notConnectedPayload(p));
      const secretInput = screen.getByTestId(`${p}-app-secret-input`) as HTMLInputElement;
      await user.type(secretInput, 'my-secret');
      expect(secretInput.type).toBe('password');
      await user.click(screen.getByTestId(`${p}-app-secret-toggle`));
      expect(secretInput.type).toBe('text');
      expect(screen.getByTestId(`${p}-app-secret-toggle`).textContent).toBe('Hide');
    }, INTERACTION_TIMEOUT);
  });

  describe(`${c.displayName} credentials view — connect submit`, () => {
    it('empty submit: summary + inline carry the exact messages, focus moves to the summary', async () => {
      const user = userEvent.setup();
      renderView(c, notConnectedPayload(p));

      await user.click(screen.getByTestId(`${p}-connect-btn`));

      const summary = await findErrorSummary();
      expect(summary.textContent).toContain(`Please enter your ${c.appIdLabel}.`);
      expect(summary.textContent).toContain(`Please enter your ${c.appSecretLabel}.`);
      expect(screen.getByTestId(`${p}-app-id-error`).textContent).toBe(
        `Please enter your ${c.appIdLabel}.`
      );
      expect(screen.getByTestId(`${p}-app-secret-error`).textContent).toBe(
        `Please enter your ${c.appSecretLabel}.`
      );
      await waitFor(() => expect(document.activeElement).toBe(summary));
      expect(putCalls).toHaveLength(0);
    }, INTERACTION_TIMEOUT);

    it('non-numeric App ID fails with the numeric sentence and preserves the input', async () => {
      const user = userEvent.setup();
      renderView(c, notConnectedPayload(p));

      const appIdInput = screen.getByTestId(`${p}-app-id-input`) as HTMLInputElement;
      await user.type(appIdInput, 'abc');
      await user.type(screen.getByTestId(`${p}-app-secret-input`), 'some-secret');
      await user.click(screen.getByTestId(`${p}-connect-btn`));

      const summary = await findErrorSummary();
      expect(summary.textContent).toContain(
        `${c.appIdLabel} must be numeric (10–20 digits).`
      );
      expect(appIdInput.value).toBe('abc');
      expect(putCalls).toHaveLength(0);
    }, INTERACTION_TIMEOUT);

    it('valid submit PUTs the frozen body shape, toasts success, and lands on the connected state with the card hidden', async () => {
      const user = userEvent.setup();
      renderView(c, notConnectedPayload(p));

      await user.type(screen.getByTestId(`${p}-app-id-input`), '123456789012345');
      await user.type(screen.getByTestId(`${p}-app-secret-input`), 'brand-new-secret');
      await user.click(screen.getByTestId(`${p}-connect-btn`));

      expect(
        await screen.findByText(`Your ${c.displayName} app is connected.`)
      ).toBeTruthy();
      expect(putCalls).toHaveLength(1);
      expect(putCalls[0]?.platform).toBe(p);
      expect(putCalls[0]?.body).toEqual({
        appId: '123456789012345',
        appSecret: 'brand-new-secret',
      });
      expect(putCalls[0]?.url).toContain(
        `/api/tenant/acme/settings/platform-credentials/${p}`
      );

      expect(await screen.findByTestId(`${p}-saved-app-id`)).toBeTruthy();
      expect(screen.getByTestId(`${p}-saved-app-id`).textContent).toBe('123456789012345');
      expect(screen.queryByTestId(`${p}-one-more-step-card`)).toBeNull();
      expect(screen.queryByTestId(`${p}-connect-btn`)).toBeNull();
    }, INTERACTION_TIMEOUT);

    it('server failure surfaces the server message at form scope and preserves the input', async () => {
      putResponder = async () =>
        jsonResponse({ error: 'That App ID could not be checked. Try again.' }, 400);
      const user = userEvent.setup();
      renderView(c, notConnectedPayload(p));

      const appIdInput = screen.getByTestId(`${p}-app-id-input`) as HTMLInputElement;
      await user.type(appIdInput, '123456789012345');
      await user.type(screen.getByTestId(`${p}-app-secret-input`), 'some-secret');
      await user.click(screen.getByTestId(`${p}-connect-btn`));

      const summary = await findErrorSummary();
      expect(summary.textContent).toContain('That App ID could not be checked. Try again.');
      expect(appIdInput.value).toBe('123456789012345');
      expect(
        screen.queryByText(`Network error while connecting ${c.displayName}.`)
      ).toBeNull();
    }, INTERACTION_TIMEOUT);

    it('network failure toasts the fixed sentence for the platform, exactly', async () => {
      putResponder = async () => {
        throw new TypeError('fetch failed');
      };
      const user = userEvent.setup();
      renderView(c, notConnectedPayload(p));

      await user.type(screen.getByTestId(`${p}-app-id-input`), '123456789012345');
      await user.type(screen.getByTestId(`${p}-app-secret-input`), 'some-secret');
      await user.click(screen.getByTestId(`${p}-connect-btn`));

      expect(
        await screen.findByText(`Network error while connecting ${c.displayName}.`)
      ).toBeTruthy();
      expect(screen.queryByTestId(`${p}-saved-app-id`)).toBeNull();
    }, INTERACTION_TIMEOUT);
  });

  describe(`${c.displayName} credentials view — connected state`, () => {
    it('renders the connected presentation verbatim', () => {
      renderView(c, connectedPayload(c));

      expect(screen.getByTestId(`${p}-status-badge`).textContent).toContain('Connected');
      expect(
        screen.getByText(
          `Your ${c.displayName} app is linked and publishing is ready to go.`
        )
      ).toBeTruthy();
      expect(screen.getByTestId(`${p}-saved-app-id`).textContent).toBe(c.savedAppId);
      expect(screen.getByTestId(`${p}-copy-app-id-btn`).textContent).toBe('Copy App ID');
      expect(screen.getByTestId(`${p}-saved-app-secret`).textContent).toBe('•'.repeat(24));
      expect(screen.getByTestId(`${p}-state2-secret-toggle`).textContent).toBe('Show');
      expect(screen.getByTestId(`${p}-edit-details-btn`).textContent).toBe('Edit details');
      expect(screen.getByTestId(`${p}-disconnect-btn`).textContent).toBe('Disconnect');
      expect(screen.getByTestId(`${p}-connected-date`).textContent).toBe(
        'Connected on Oct 16, 2026.'
      );
      expect(screen.queryByTestId(`${p}-one-more-step-card`)).toBeNull();
      expect(screen.queryByTestId(`${p}-setup-guide`)).toBeNull();
    });

    it('Copy App ID writes to the clipboard and shows the "App ID copied" feedback', async () => {
      const user = userEvent.setup();
      installClipboardMock();
      renderView(c, connectedPayload(c));

      await user.click(screen.getByTestId(`${p}-copy-app-id-btn`));
      expect(clipboardWriteText).toHaveBeenCalledWith(c.savedAppId);
      await waitFor(() =>
        expect(screen.getByTestId(`${p}-copy-app-id-btn`).textContent).toBe('App ID copied')
      );
    }, INTERACTION_TIMEOUT);

    it('Show fetches the saved secret through the reveal action and Hide masks it again', async () => {
      const user = userEvent.setup();
      renderView(c, connectedPayload(c));

      // The value is not in the payload — it only arrives via reveal.
      expect(screen.getByTestId(`${p}-saved-app-secret`).textContent).toBe('•'.repeat(24));

      await user.click(screen.getByTestId(`${p}-state2-secret-toggle`));
      await waitFor(() =>
        expect(screen.getByTestId(`${p}-saved-app-secret`).textContent).toBe(c.savedSecret)
      );
      expect(screen.getByTestId(`${p}-state2-secret-toggle`).textContent).toBe('Hide');

      await user.click(screen.getByTestId(`${p}-state2-secret-toggle`));
      expect(screen.getByTestId(`${p}-saved-app-secret`).textContent).toBe('•'.repeat(24));
    }, INTERACTION_TIMEOUT);

    it('a failed reveal reports at the field and keeps the secret masked', async () => {
      revealResponders.set(c.platform, async () => jsonResponse({ error: 'Failed' }, 500));
      const user = userEvent.setup();
      renderView(c, connectedPayload(c));

      await user.click(screen.getByTestId(`${p}-state2-secret-toggle`));

      expect(await screen.findByTestId(`${p}-secret-reveal-error`)).toBeTruthy();
      expect(screen.getByTestId(`${p}-secret-reveal-error`).textContent).toBe(
        "Couldn't show your App Secret. Please try again."
      );
      expect(screen.getByTestId(`${p}-saved-app-secret`).textContent).toBe('•'.repeat(24));
      expect(screen.getByTestId(`${p}-state2-secret-toggle`).textContent).toBe('Show');
    }, INTERACTION_TIMEOUT);
  });

  describe(`${c.displayName} credentials view — edit mode`, () => {
    it('Edit details re-opens the form with the App ID pre-filled, the secret blank, and the card back', async () => {
      const user = userEvent.setup();
      renderView(c, connectedPayload(c));

      await user.click(screen.getByTestId(`${p}-edit-details-btn`));

      expect(screen.getByText('Add them here')).toBeTruthy();
      expect((screen.getByTestId(`${p}-app-id-input`) as HTMLInputElement).value).toBe(
        c.savedAppId
      );
      expect((screen.getByTestId(`${p}-app-secret-input`) as HTMLInputElement).value).toBe(
        ''
      );
      expect(screen.getByTestId(`${p}-cancel-edit-btn`).textContent).toBe('Cancel');
      expect(screen.getByTestId(`${p}-one-more-step-card`)).toBeTruthy();
    }, INTERACTION_TIMEOUT);

    it('a blank secret in edit mode keeps the existing secret (the PUT omits it)', async () => {
      const user = userEvent.setup();
      renderView(c, connectedPayload(c));

      await user.click(screen.getByTestId(`${p}-edit-details-btn`));
      await user.click(screen.getByTestId(`${p}-connect-btn`));

      expect(
        await screen.findByText(`Your ${c.displayName} app is connected.`)
      ).toBeTruthy();
      expect(putCalls).toHaveLength(1);
      expect(putCalls[0]?.body).toEqual({ appId: c.savedAppId });
      expect(await screen.findByTestId(`${p}-saved-app-id`)).toBeTruthy();
    }, INTERACTION_TIMEOUT);

    it('Cancel returns to the connected view without saving', async () => {
      const user = userEvent.setup();
      renderView(c, connectedPayload(c));

      await user.click(screen.getByTestId(`${p}-edit-details-btn`));
      await user.click(screen.getByTestId(`${p}-cancel-edit-btn`));

      expect(screen.getByTestId(`${p}-saved-app-id`)).toBeTruthy();
      expect(screen.queryByTestId(`${p}-one-more-step-card`)).toBeNull();
      expect(putCalls).toHaveLength(0);
    }, INTERACTION_TIMEOUT);
  });

  describe(`${c.displayName} credentials view — disconnect dialog (OD-135-2a)`, () => {
    it('opens with the platform copy and focus on "Keep connected"; Esc does not dismiss it', async () => {
      const user = userEvent.setup();
      renderView(c, connectedPayload(c));

      await user.click(screen.getByTestId(`${p}-disconnect-btn`));

      expect(await screen.findByTestId(`${p}-disconnect-modal`)).toBeTruthy();
      expect(screen.getByTestId(`${p}-disconnect-title`).textContent).toBe(
        `Disconnect ${c.displayName}?`
      );
      expect(
        screen.getByText(
          new RegExp(
            `We'll remove your ${c.appIdLabel} and ${c.appSecretLabel} from this workspace\\. Your connected accounts and posting will keep working as normal — but you won't be able to reconnect or connect new accounts until you add new details\\.`
          )
        )
      ).toBeTruthy();
      expect(screen.getByTestId(`${p}-disconnect-keep-btn`).textContent).toBe(
        'Keep connected'
      );
      expect(screen.getByTestId(`${p}-disconnect-confirm-btn`).textContent).toBe(
        'Disconnect'
      );

      const keepButton = screen.getByTestId(`${p}-disconnect-keep-btn`);
      await waitFor(() => expect(document.activeElement).toBe(keepButton));

      await user.keyboard('{Escape}');
      expect(screen.getByTestId(`${p}-disconnect-modal`)).toBeTruthy();
      expect(deleteCalls).toHaveLength(0);
    }, INTERACTION_TIMEOUT);

    it('"Keep connected" closes the dialog and returns focus to the Disconnect button', async () => {
      const user = userEvent.setup();
      renderView(c, connectedPayload(c));

      const disconnectButton = screen.getByTestId(`${p}-disconnect-btn`);
      await user.click(disconnectButton);
      expect(await screen.findByTestId(`${p}-disconnect-modal`)).toBeTruthy();

      await user.click(screen.getByTestId(`${p}-disconnect-keep-btn`));
      await waitFor(() => expect(screen.queryByTestId(`${p}-disconnect-modal`)).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(disconnectButton));
      expect(deleteCalls).toHaveLength(0);
      expect(screen.getByTestId(`${p}-saved-app-id`)).toBeTruthy();
    }, INTERACTION_TIMEOUT);

    it('confirm disconnects: DELETE runs, the success toast shows, and the tab returns to the not-connected form', async () => {
      const user = userEvent.setup();
      renderView(c, connectedPayload(c));

      await user.click(screen.getByTestId(`${p}-disconnect-btn`));
      expect(await screen.findByTestId(`${p}-disconnect-modal`)).toBeTruthy();
      await user.click(screen.getByTestId(`${p}-disconnect-confirm-btn`));

      expect(
        await screen.findByText(`Your ${c.displayName} app has been disconnected.`)
      ).toBeTruthy();
      expect(deleteCalls).toEqual([p]);
      expect(await screen.findByTestId(`${p}-connect-btn`)).toBeTruthy();
      expect(screen.getByTestId(`${p}-one-more-step-card`)).toBeTruthy();
      expect(screen.queryByTestId(`${p}-disconnect-modal`)).toBeNull();
    }, INTERACTION_TIMEOUT);

    it('a failed disconnect toasts the failure sentence and keeps the dialog open', async () => {
      deleteResponder = async () => jsonResponse({ error: 'Failed' }, 500);
      const user = userEvent.setup();
      renderView(c, connectedPayload(c));

      await user.click(screen.getByTestId(`${p}-disconnect-btn`));
      expect(await screen.findByTestId(`${p}-disconnect-modal`)).toBeTruthy();
      await user.click(screen.getByTestId(`${p}-disconnect-confirm-btn`));

      expect(
        await screen.findByText(`Couldn't disconnect ${c.displayName}. Please try again.`)
      ).toBeTruthy();
      expect(screen.getByTestId(`${p}-disconnect-modal`)).toBeTruthy();
      expect(screen.getByTestId(`${p}-saved-app-id`)).toBeTruthy();
    }, INTERACTION_TIMEOUT);

    it('a disconnect network failure toasts the fixed network sentence', async () => {
      deleteResponder = async () => {
        throw new TypeError('fetch failed');
      };
      const user = userEvent.setup();
      renderView(c, connectedPayload(c));

      await user.click(screen.getByTestId(`${p}-disconnect-btn`));
      expect(await screen.findByTestId(`${p}-disconnect-modal`)).toBeTruthy();
      await user.click(screen.getByTestId(`${p}-disconnect-confirm-btn`));

      expect(
        await screen.findByText(`Network error while disconnecting ${c.displayName}.`)
      ).toBeTruthy();
      expect(screen.getByTestId(`${p}-disconnect-modal`)).toBeTruthy();
    }, INTERACTION_TIMEOUT);
  });
}

describe('Instagram redesign (2026-10-25)', () => {
  it('shows NO setup guide in the not-connected state — the guide is removed', () => {
    const c = PLATFORM_CASES[0] as PlatformCase;
    renderView(c, notConnectedPayload('instagram'));

    expect(screen.queryByTestId('instagram-setup-guide')).toBeNull();
    expect(screen.queryByText('Create your Meta app')).toBeNull();
    expect(screen.queryByText('Add Instagram to your app')).toBeNull();
    expect(screen.queryByText('Finish the Instagram sign-in setup')).toBeNull();
    expect(screen.queryByText('Add the sign-in address we show')).toBeNull();
    expect(screen.queryByTestId('instagram-meta-dashboard-link')).toBeNull();
    // The form itself (and its helper) is still there.
    expect(screen.getByText('Add them here')).toBeTruthy();
    expect(
      screen.getByText("You'll find this in your Meta app under Settings → Basic.")
    ).toBeTruthy();
  });

  it('shows the sign-in address step with the §5.3 description, label, and helper', () => {
    const c = PLATFORM_CASES[0] as PlatformCase;
    renderView(c, notConnectedPayload('instagram'));

    expect(
      screen.getByText(
        'Add this address to your Meta app so Instagram can bring you back here after you sign in.'
      )
    ).toBeTruthy();
    expect(screen.getByText('Sign-in address')).toBeTruthy();
    expect(
      screen.getByText(
        'Paste this into the address field in the Instagram sign-in settings in your Meta app.'
      )
    ).toBeTruthy();
    expect(screen.getByTestId('instagram-copy-signin-btn')).toBeTruthy();
    // Callback address uses the connect path (never the old /api/auth
    // path); its origin is window.location.origin in production, i.e.
    // the workspace subdomain when the user is in their workspace —
    // jsdom's origin is localhost here, so only the path is asserted.
    const address = screen.getByTestId('instagram-setup-address-signin').textContent ?? '';
    expect(address.endsWith('/api/connect/instagram/callback')).toBe(true);
    expect(address).not.toContain('/api/auth/');
  });

  it('renders single-column: header stacked above the panel, never split side by side', () => {
    const c = PLATFORM_CASES[0] as PlatformCase;
    renderView(c, notConnectedPayload('instagram'));

    // No two-column grid anywhere in the Instagram tab: the header
    // (title + description + status) sits above the full-width
    // panel, on desktop and mobile alike.
    expect(document.querySelector('[class*="grid-cols"]')).toBeNull();
    const heading = screen.getByRole('heading', { name: 'Instagram App' });
    const card = screen.getByTestId('instagram-settings-card');
    expect(
      Boolean(heading.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING)
    ).toBe(true);
    // Status still travels with the header, not the panel.
    expect(screen.getByTestId('instagram-status-badge').textContent).toContain(
      'Not connected'
    );
  });

  it('shows the tick/cross status mark (never a dot) in both states', () => {
    const c = PLATFORM_CASES[0] as PlatformCase;
    renderView(c, notConnectedPayload('instagram'));
    expect(screen.getByTestId('instagram-status-mark').getAttribute('data-status')).toBe(
      'not-connected'
    );
    expect(screen.getByTestId('instagram-status-badge').textContent).toContain('Not connected');

    cleanup();
    renderView(c, connectedPayload(c));
    expect(screen.getByTestId('instagram-status-mark').getAttribute('data-status')).toBe(
      'connected'
    );
    expect(screen.getByTestId('instagram-status-badge').textContent).toContain('Connected');
  });

  it('shows the Privacy Policy URL row in both states, with Copy feedback', async () => {
    const c = PLATFORM_CASES[0] as PlatformCase;
    renderView(c, notConnectedPayload('instagram'));
    expect(screen.getByTestId('instagram-privacy-url').textContent).toBe(
      'https://acme.fbuploadpro.com/privacy'
    );

    cleanup();
    renderView(c, connectedPayload(c));
    expect(screen.getByTestId('instagram-privacy-url').textContent).toBe(
      'https://acme.fbuploadpro.com/privacy'
    );

    const user = userEvent.setup();
    installClipboardMock();
    await user.click(screen.getByTestId('instagram-copy-privacy-url-btn'));
    expect(clipboardWriteText).toHaveBeenCalledWith('https://acme.fbuploadpro.com/privacy');
    await waitFor(() =>
      expect(screen.getByTestId('instagram-copy-privacy-url-btn').textContent).toBe('Copied')
    );
  }, INTERACTION_TIMEOUT);
});

describe('Threads guide (§5.4 verbatim)', () => {
  it('renders all five guide steps, with the pair warning at full strength', () => {
    const c = PLATFORM_CASES[1] as PlatformCase;
    renderView(c, notConnectedPayload('threads'));

    expect(screen.getByText('Create your Meta app')).toBeTruthy();
    expect(screen.getByText(/choose the option for connecting a Threads account/)).toBeTruthy();
    expect(screen.getByText('Add Threads to your app')).toBeTruthy();
    expect(screen.getByText('Use the Threads pair, not the main pair')).toBeTruthy();
    expect(screen.getByText(/Threads has its own App ID and App Secret/)).toBeTruthy();
    expect(
      screen.getByText(
        /You will find the Threads pair in the Threads settings of your app — not under Settings → Basic\./
      )
    ).toBeTruthy();
    expect(
      screen.getByText(/Using the main pair is the most common reason connecting/)
    ).toBeTruthy();
    expect(screen.getByText('Add the three addresses we show')).toBeTruthy();
    expect(
      screen.getByText('Copy your Threads App ID and Threads App Secret')
    ).toBeTruthy();
    expect(
      screen.getByText(
        "You'll find this in the Threads settings of your Meta app — not under Settings → Basic."
      )
    ).toBeTruthy();
  });

  it('shows all three callback addresses with their labels and helpers', () => {
    const c = PLATFORM_CASES[1] as PlatformCase;
    renderView(c, notConnectedPayload('threads'));

    expect(
      screen.getByText(
        'Add these three addresses to the Threads settings in your Meta app. Threads needs all three before it will save your sign-in address.'
      )
    ).toBeTruthy();

    expect(screen.getByText('Sign-in callback address')).toBeTruthy();
    expect(
      screen.getByTestId('threads-setup-address-signin').textContent ?? ''
    ).toContain('/api/connect/threads/callback');
    expect(
      screen.getByText(
        'Paste this into the sign-in callback field in the Threads settings of your app.'
      )
    ).toBeTruthy();

    expect(screen.getByText('Deauthorize callback address')).toBeTruthy();
    expect(
      screen.getByTestId('threads-setup-address-deauthorize').textContent ?? ''
    ).toContain('/api/connect/threads/deauthorize');
    expect(
      screen.getByText(
        'Paste this into the deauthorize callback field in the Threads settings of your app. Threads uses this address if someone removes your app.'
      )
    ).toBeTruthy();

    expect(screen.getByText('Data deletion callback address')).toBeTruthy();
    expect(
      screen.getByTestId('threads-setup-address-data-deletion').textContent ?? ''
    ).toContain('/api/connect/threads/data-deletion');
    expect(
      screen.getByText(
        'Paste this into the data deletion callback field in the Threads settings of your app. Threads uses this address if someone asks for their information to be deleted.'
      )
    ).toBeTruthy();

    expect(screen.getByTestId('threads-copy-signin-btn')).toBeTruthy();
    expect(screen.getByTestId('threads-copy-deauthorize-btn')).toBeTruthy();
    expect(screen.getByTestId('threads-copy-data-deletion-btn')).toBeTruthy();
  });
});

describe('Spec 123 Part B: shared callback addresses', () => {
  it('builds the three addresses on the given origin', () => {
    expect(getPlatformCallbackUrls('threads', 'https://app.example.com')).toEqual({
      signInCallback: 'https://app.example.com/api/connect/threads/callback',
      deauthorizeCallback: 'https://app.example.com/api/connect/threads/deauthorize',
      dataDeletionCallback: 'https://app.example.com/api/connect/threads/data-deletion',
    });
    expect(getPlatformCallbackUrl('instagram', 'signIn', 'https://app.example.com')).toBe(
      'https://app.example.com/api/connect/instagram/callback'
    );
  });

  it('resolves against the current origin when no origin is given', () => {
    // This suite runs in jsdom (it migrated with the behavioural
    // rebuild in PR-135-3), so the no-argument form resolves against
    // the window origin — the production-origin fallback applies only
    // outside the browser, in the untouched lib helper.
    expect(getPlatformCallbackUrls('threads').signInCallback).toBe(
      `${window.location.origin}/api/connect/threads/callback`
    );
  });
});

function stripToVisibleText(html: string): string {
  const withoutTags = html
    .split('<')
    .map((chunk) => {
      const closeIdx = chunk.indexOf('>');
      return closeIdx >= 0 ? chunk.slice(closeIdx + 1) : chunk;
    })
    .join(' ');
  return withoutTags
    .split(/\s+/)
    .filter((word) => !word.startsWith('http://') && !word.startsWith('https://'))
    .join(' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&#x27;', "'")
    .replaceAll('&quot;', '"')
    .toLowerCase();
}

describe('plain-language lint over user-facing copy (§5.3/§5.4)', () => {
  const BANNED = ['oauth', 'scope', 'endpoint', 'api key', 'token'];

  it('no banned terms appear in any tab copy', () => {
    const htmls: string[] = [];

    for (const c of PLATFORM_CASES) {
      const notConnected = renderView(c, notConnectedPayload(c.platform));
      htmls.push(document.body.innerHTML);
      cleanup();
      renderView(c, connectedPayload(c));
      htmls.push(document.body.innerHTML);
      cleanup();
      void notConnected;
    }

    for (const html of htmls) {
      const text = stripToVisibleText(html);
      for (const term of BANNED) {
        expect(text).not.toContain(term);
      }
      expect(text).not.toMatch(/\bapi\b/);
    }
  });
});
