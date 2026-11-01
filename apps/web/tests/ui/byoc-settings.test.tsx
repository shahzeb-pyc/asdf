/**
 * Facebook settings tab — behavioural tests (spec 135 PR-135-2, T15).
 *
 * Migrated from the legacy static-markup suite: the rebuilt
 * FacebookSettingsView (components/settings/facebook/) is rendered
 * into jsdom and driven with user-event. The legacy `initial*`
 * test-seam props are deleted with the old view — these tests seed
 * through the React Query client (the same cache the settings route
 * dehydrates into) and stub `fetch` at the boundary the typed API
 * client calls, exactly like production traffic.
 *
 * Copy and validation messages are spec §5.2 verbatim — the strings
 * asserted here are the finalized 2026-10-16 contract, not
 * decoration. The forbidden strings ("Permissions your app needs",
 * "last tested") are asserted absent in both states.
 *
 * Spec 139 N3: the seeded payload carries a secret HINT, never the
 * secret — Show drives the reveal endpoint (stubbed below) and only
 * then does the value reach the screen.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { FacebookSettingsView } from '@/components/settings/facebook/facebook-settings-view';
import { createFacebookConnectFormSchema } from '@/components/settings/facebook/facebook-connect-form';
import { formatConnectedDate } from '@/components/settings/facebook/facebook-connected-view';
import { queryKeys } from '@/lib/data/query-keys';
import { Toast, toast } from '@/components/shared/ui/toast';

// userEvent interaction tests run long under coverage instrumentation;
// the per-test budget below replaces the 5s default for this file's
// interaction cases only (assertions and waits are unchanged).
const INTERACTION_TIMEOUT = 20_000;

const SUBDOMAIN = 'acme';
const WORKSPACE_ID = '11111111-1111-4111-a111-111111111111';
const SAVED_APP_ID = '987654321098765';
const SAVED_SECRET = 'saved-secret-value';

// Hoisted mutable search params for the next/navigation mock below.
const searchParamsState = vi.hoisted(() => ({
  current: new URLSearchParams(),
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => searchParamsState.current,
}));

interface ByocPayload {
  workspaceId: string;
  subdomain: string;
  fbAppId: string;
  fbAppSecretHint: string | null;
  hasSecret: boolean;
  status: 'unverified' | 'valid' | 'invalid';
  lastTestedAt: string | null;
  fbAppName: string | null;
  connectedAt: string | null;
}

const NOT_CONNECTED: ByocPayload = {
  workspaceId: WORKSPACE_ID,
  subdomain: SUBDOMAIN,
  fbAppId: '',
  fbAppSecretHint: null,
  hasSecret: false,
  status: 'unverified',
  lastTestedAt: null,
  fbAppName: null,
  connectedAt: null,
};

const CONNECTED: ByocPayload = {
  workspaceId: WORKSPACE_ID,
  subdomain: SUBDOMAIN,
  fbAppId: SAVED_APP_ID,
  fbAppSecretHint: '••••alue',
  hasSecret: true,
  status: 'valid',
  lastTestedAt: '2026-10-16T10:00:00.000Z',
  fbAppName: 'Acme App',
  connectedAt: '2026-10-16T12:00:00.000Z',
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as Response;
}

/* Stateful fetch stub: GET serves `currentPayload`; the default PUT /
 * DELETE responders flip it, exactly like the real route pair. The
 * reveal POST serves the saved secret (spec 139 N3). */
let currentPayload: ByocPayload;
let putCalls: Array<{ url: string; body: Record<string, unknown> }>;
let deleteCalls: number;
let getResponder: () => Promise<Response>;
let putResponder: (body: Record<string, unknown>) => Promise<Response>;
let deleteResponder: () => Promise<Response>;
let revealResponder: () => Promise<Response>;

const clipboardWriteText = vi.fn().mockResolvedValue(undefined);

function installFetchStub() {
  currentPayload = NOT_CONNECTED;
  putCalls = [];
  deleteCalls = 0;
  getResponder = async () => jsonResponse(currentPayload);
  putResponder = async (body) => {
    const savedSecret = String(body.fbAppSecret ?? SAVED_SECRET);
    currentPayload = {
      ...CONNECTED,
      fbAppId: String(body.fbAppId ?? ''),
      fbAppSecretHint: `••••${savedSecret.slice(-4)}`,
    };
    return jsonResponse({
      success: true,
      hasSecret: true,
      status: 'valid',
      connectedAt: CONNECTED.connectedAt,
    });
  };
  revealResponder = async () => jsonResponse({ fbAppSecret: SAVED_SECRET });
  deleteResponder = async () => {
    currentPayload = NOT_CONNECTED;
    return jsonResponse({ success: true, disconnected: true });
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/settings/byoc')) {
        if (method === 'GET') return getResponder();
        if (method === 'POST') return revealResponder();
        if (method === 'PUT') {
          const body = init?.body
            ? (JSON.parse(String(init.body)) as Record<string, unknown>)
            : {};
          putCalls.push({ url, body });
          return putResponder(body);
        }
        if (method === 'DELETE') {
          deleteCalls += 1;
          return deleteResponder();
        }
      }
      throw new Error(`Unstubbed fetch: ${method} ${url}`);
    })
  );
}

function renderView(seed?: ByocPayload) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 60_000 },
      mutations: { retry: false },
    },
  });
  if (seed) {
    queryClient.setQueryData(queryKeys.tenant(SUBDOMAIN).settings.byoc, seed);
  }
  render(
    <QueryClientProvider client={queryClient}>
      <FacebookSettingsView subdomain={SUBDOMAIN} />
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

describe('connect form schema (§5.2 messages verbatim)', () => {
  it('rejects an empty App ID with the empty-field sentence', () => {
    const result = createFacebookConnectFormSchema(false).safeParse({
      appId: '',
      appSecret: 'some-secret',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe('Please enter your App ID.');
    }
  });

  it('rejects a non-numeric or out-of-range App ID with the numeric sentence', () => {
    for (const appId of ['abc', '12345', '123456789012345678901']) {
      const result = createFacebookConnectFormSchema(false).safeParse({
        appId,
        appSecret: 'some-secret',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe(
          'App ID must be numeric (10–20 digits).'
        );
      }
    }
  });

  it('requires the App Secret when none is saved, and allows blank when one is (edit mode keeps it)', () => {
    const missing = createFacebookConnectFormSchema(false).safeParse({
      appId: '123456789012345',
      appSecret: '',
    });
    expect(missing.success).toBe(false);
    if (!missing.success) {
      expect(missing.error.issues[0]?.message).toBe('Please enter your App Secret.');
    }

    const kept = createFacebookConnectFormSchema(true).safeParse({
      appId: '123456789012345',
      appSecret: '',
    });
    expect(kept.success).toBe(true);
  });

  it('accepts a 10–20 digit App ID with a secret', () => {
    expect(
      createFacebookConnectFormSchema(false).safeParse({
        appId: '123456789012345',
        appSecret: 'some-secret',
      }).success
    ).toBe(true);
  });
});

describe('formatConnectedDate', () => {
  it('formats the en-US short month, day, year as shipped', () => {
    expect(formatConnectedDate('2026-10-16T12:00:00.000Z')).toBe('Oct 16, 2026');
  });
});

describe('FacebookSettingsView — loading and load failure', () => {
  it('shows the Skeleton with the preserved loading text while details load', async () => {
    getResponder = () => new Promise<Response>(() => {});
    renderView();
    expect(screen.getByTestId('byoc-loading')).toBeTruthy();
    expect(screen.getByText('Loading your Facebook app details…')).toBeTruthy();
  });

  it('shows a load-failure state with a working retry instead of the form', async () => {
    getResponder = async () => jsonResponse({ error: 'Failed' }, 500);
    renderView();
    expect(
      await screen.findByText("Couldn't load your Facebook app details. Please try again.")
    ).toBeTruthy();
    expect(screen.queryByTestId('fb-connect-btn')).toBeNull();

    getResponder = async () => jsonResponse(currentPayload);
    const user = userEvent.setup();
    await user.click(screen.getByTestId('fb-load-retry-btn'));
    expect(await screen.findByTestId('fb-connect-btn')).toBeTruthy();
  }, INTERACTION_TIMEOUT);
});

describe('FacebookSettingsView — not connected', () => {
  it('renders the §5.2 header, status, and guided 2-step form verbatim', async () => {
    renderView(NOT_CONNECTED);

    expect(screen.getByRole('heading', { name: 'Facebook App' })).toBeTruthy();
    expect(screen.getByTestId('facebook-settings-card')).toBeTruthy();
    expect(screen.getByTestId('facebook-status-badge').textContent).toContain(
      'Not connected'
    );
    // The redesign's status mark is a tick/cross in a coloured circle —
    // never the shared StatusDot's dot.
    expect(
      screen.getByTestId('facebook-status-mark').getAttribute('data-status')
    ).toBe('not-connected');
    expect(document.querySelector('[data-slot="status-dot"]')).toBeNull();
    expect(
      screen.getByText('Link your Facebook app to start publishing from this workspace.')
    ).toBeTruthy();

    expect(screen.getByText('Find your app details')).toBeTruthy();
    const dashboardLink = screen.getByTestId('fb-meta-dashboard-link');
    expect(dashboardLink.getAttribute('href')).toBe('https://developers.facebook.com');
    expect(dashboardLink.textContent).toBe('Meta developer dashboard →');
    expect(
      screen.getByText(/and copy your App ID and App Secret from Settings → Basic\./)
    ).toBeTruthy();

    expect(screen.getByText('Add your app details here')).toBeTruthy();
    const appIdInput = screen.getByTestId('fb-app-id-input') as HTMLInputElement;
    expect(appIdInput.getAttribute('placeholder')).toBe('e.g. 123456789012345');
    expect(
      screen.getByText("You'll find this in your Meta app under Settings → Basic.")
    ).toBeTruthy();

    const secretInput = screen.getByTestId('fb-app-secret-input') as HTMLInputElement;
    expect(secretInput.getAttribute('placeholder')).toBe('Enter your App Secret');
    expect(secretInput.type).toBe('password');
    expect(screen.getByTestId('fb-app-secret-toggle').textContent).toBe('Show');
    expect(
      screen.getByText('Only you can see this — it stays hidden until you choose to show it.')
    ).toBeTruthy();

    expect(screen.getByTestId('fb-connect-btn').textContent).toContain('Connect Facebook');
    expect(
      screen.getByText('Your details are checked as soon as you connect.')
    ).toBeTruthy();

    // Privacy Policy URL row: workspace-subdomain address, both states.
    expect(screen.getByTestId('fb-privacy-url').textContent).toBe(
      'https://acme.fbuploadpro.com/privacy'
    );
  });

  it('renders the "One more step" card with the real Facebook OAuth callback address', async () => {
    renderView(NOT_CONNECTED);

    expect(screen.getByTestId('fb-one-more-step-card')).toBeTruthy();
    expect(screen.getByText('One more step')).toBeTruthy();
    expect(
      screen.getByText(
        'Add this address to your Meta app so Facebook can bring you back here after you sign in.'
      )
    ).toBeTruthy();
    expect(screen.getByText('Sign-in address')).toBeTruthy();
    const address = screen.getByTestId('fb-signin-address').textContent ?? '';
    // The address must match the redirect_uri the Facebook OAuth flow
    // actually sends (see buildSubdomainOAuthRedirectUri) — the generic
    // /api/connect/facebook/callback path is never used by that flow,
    // so Meta would reject it as unregistered. Scheme is not asserted
    // here: it follows the page origin (https in production, http in
    // this jsdom run); the host + path are what Meta matches.
    expect(address).toContain('acme.fbuploadpro.com/api/auth/facebook/callback');
    expect(address).not.toContain('/api/connect/facebook/callback');
    expect(
      screen.getByText('Paste this into the "Valid OAuth Redirect URIs" field in your Meta app.')
    ).toBeTruthy();

    const user = userEvent.setup();
    // userEvent.setup() installs its own clipboard stub over the
    // beforeEach mock — re-apply the mock so the write is observable.
    installClipboardMock();
    await user.click(screen.getByTestId('fb-copy-callback-btn'));
    expect(clipboardWriteText).toHaveBeenCalledWith(address);
    await waitFor(() =>
      expect(screen.getByTestId('fb-copy-callback-btn').textContent).toBe('Copied')
    );
  }, INTERACTION_TIMEOUT);

  it('never renders the removed sections (forbidden strings absent)', () => {
    renderView(NOT_CONNECTED);
    expect(document.body.textContent).not.toContain('Permissions your app needs');
    expect(document.body.textContent).not.toContain('last tested');
  });

  it('shows the reconnect notice as a banner only when ?notice=reconnect is present', () => {
    searchParamsState.current = new URLSearchParams('notice=reconnect');
    renderView(NOT_CONNECTED);
    const notice = screen.getByTestId('byoc-reconnect-notice');
    expect(notice.textContent).toContain(
      'To reconnect accounts, add your App ID and App Secret below, then reconnect.'
    );
  });

  it('hides the reconnect notice during a normal visit', () => {
    renderView(NOT_CONNECTED);
    expect(screen.queryByTestId('byoc-reconnect-notice')).toBeNull();
  });

  it('toggles the secret between hidden and visible with Show/Hide', async () => {
    const user = userEvent.setup();
    renderView(NOT_CONNECTED);
    const secretInput = screen.getByTestId('fb-app-secret-input') as HTMLInputElement;
    await user.type(secretInput, 'my-secret');
    expect(secretInput.type).toBe('password');
    await user.click(screen.getByTestId('fb-app-secret-toggle'));
    expect(secretInput.type).toBe('text');
    expect(screen.getByTestId('fb-app-secret-toggle').textContent).toBe('Hide');
    await user.click(screen.getByTestId('fb-app-secret-toggle'));
    expect(secretInput.type).toBe('password');
  }, INTERACTION_TIMEOUT);
});

describe('FacebookSettingsView — connect submit', () => {
  it('empty submit: summary + inline carry the exact §5.2 messages, focus moves to the summary', async () => {
    const user = userEvent.setup();
    renderView(NOT_CONNECTED);

    await user.click(screen.getByTestId('fb-connect-btn'));

    const summary = await findErrorSummary();
    expect(summary.textContent).toContain('Please enter your App ID.');
    expect(summary.textContent).toContain('Please enter your App Secret.');
    expect(screen.getByTestId('fb-app-id-error').textContent).toBe(
      'Please enter your App ID.'
    );
    expect(screen.getByTestId('fb-app-secret-error').textContent).toBe(
      'Please enter your App Secret.'
    );
    await waitFor(() => expect(document.activeElement).toBe(summary));
    expect(putCalls).toHaveLength(0);
  }, INTERACTION_TIMEOUT);

  it('non-numeric App ID fails with the numeric sentence and preserves the input', async () => {
    const user = userEvent.setup();
    renderView(NOT_CONNECTED);

    const appIdInput = screen.getByTestId('fb-app-id-input') as HTMLInputElement;
    await user.type(appIdInput, 'abc');
    await user.type(screen.getByTestId('fb-app-secret-input'), 'some-secret');
    await user.click(screen.getByTestId('fb-connect-btn'));

    const summary = await findErrorSummary();
    expect(summary.textContent).toContain('App ID must be numeric (10–20 digits).');
    expect(screen.getByTestId('fb-app-id-error').textContent).toBe(
      'App ID must be numeric (10–20 digits).'
    );
    expect(appIdInput.value).toBe('abc');
    expect(putCalls).toHaveLength(0);
  }, INTERACTION_TIMEOUT);

  it('valid submit PUTs through the typed client, toasts success, and lands on the connected state with the card hidden', async () => {
    const user = userEvent.setup();
    renderView(NOT_CONNECTED);

    await user.type(screen.getByTestId('fb-app-id-input'), '123456789012345');
    await user.type(screen.getByTestId('fb-app-secret-input'), 'brand-new-secret');
    await user.click(screen.getByTestId('fb-connect-btn'));

    expect(await screen.findByText('Your Facebook app is connected.')).toBeTruthy();
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0]?.body).toEqual({
      fbAppId: '123456789012345',
      fbAppSecret: 'brand-new-secret',
    });
    expect(putCalls[0]?.url).toContain('/api/tenant/acme/settings/byoc');

    expect(await screen.findByTestId('fb-saved-app-id')).toBeTruthy();
    expect(screen.getByTestId('fb-saved-app-id').textContent).toBe('123456789012345');
    expect(screen.queryByTestId('fb-one-more-step-card')).toBeNull();
    expect(screen.queryByTestId('fb-connect-btn')).toBeNull();
  }, INTERACTION_TIMEOUT);

  it('server failure surfaces the server message at form scope and preserves the input', async () => {
    putResponder = async () =>
      jsonResponse({ error: 'That App ID could not be checked. Try again.' }, 400);
    const user = userEvent.setup();
    renderView(NOT_CONNECTED);

    const appIdInput = screen.getByTestId('fb-app-id-input') as HTMLInputElement;
    await user.type(appIdInput, '123456789012345');
    await user.type(screen.getByTestId('fb-app-secret-input'), 'some-secret');
    await user.click(screen.getByTestId('fb-connect-btn'));

    const summary = await findErrorSummary();
    expect(summary.textContent).toContain('That App ID could not be checked. Try again.');
    expect(appIdInput.value).toBe('123456789012345');
    expect(screen.queryByText('Could not connect Facebook. Check your connection and try again.')).toBeNull();
  }, INTERACTION_TIMEOUT);

  it('network failure toasts the fixed §5.2 sentence, exactly', async () => {
    putResponder = async () => {
      throw new TypeError('fetch failed');
    };
    const user = userEvent.setup();
    renderView(NOT_CONNECTED);

    await user.type(screen.getByTestId('fb-app-id-input'), '123456789012345');
    await user.type(screen.getByTestId('fb-app-secret-input'), 'some-secret');
    await user.click(screen.getByTestId('fb-connect-btn'));

    expect(
      await screen.findByText('Could not connect Facebook. Check your connection and try again.')
    ).toBeTruthy();
    expect(screen.queryByTestId('fb-saved-app-id')).toBeNull();
  }, INTERACTION_TIMEOUT);
});

describe('FacebookSettingsView — connected state', () => {
  it('renders the §5.2 connected presentation verbatim', () => {
    renderView(CONNECTED);

    expect(screen.getByTestId('facebook-status-badge').textContent).toContain('Connected');
    expect(
      screen.getByTestId('facebook-status-mark').getAttribute('data-status')
    ).toBe('connected');
    expect(document.querySelector('[data-slot="status-dot"]')).toBeNull();
    expect(
      screen.getByText('Your Facebook app is connected and ready to publish.')
    ).toBeTruthy();

    expect(screen.getByTestId('fb-saved-app-id').textContent).toBe(SAVED_APP_ID);
    expect(screen.getByTestId('fb-copy-app-id-btn').textContent).toBe('Copy App ID');
    // Privacy Policy URL row is present in the connected state too.
    expect(screen.getByTestId('fb-privacy-url').textContent).toBe(
      'https://acme.fbuploadpro.com/privacy'
    );

    expect(screen.getByTestId('fb-saved-app-secret').textContent).toBe('•'.repeat(24));
    expect(screen.getByTestId('fb-state2-secret-toggle').textContent).toBe('Show');
    expect(
      screen.getByText('Only you can see this — it stays hidden until you choose to show it.')
    ).toBeTruthy();

    expect(screen.getByTestId('fb-edit-details-btn').textContent).toBe('Edit details');
    expect(screen.getByTestId('fb-disconnect-btn').textContent).toBe('Disconnect');
    expect(screen.getByTestId('fb-connected-date').textContent).toBe(
      'Connected on Oct 16, 2026.'
    );

    expect(screen.queryByTestId('fb-one-more-step-card')).toBeNull();
    expect(document.body.textContent).not.toContain('Permissions your app needs');
    expect(document.body.textContent).not.toContain('last tested');
  });

  it('shows the saved app name in the connected card', () => {
    renderView(CONNECTED);

    expect(screen.getByTestId('fb-saved-app-name').textContent).toBe('Acme App');
  });

  it('legacy rows without a name render as before, with no name block and no error', () => {
    renderView({ ...CONNECTED, fbAppName: null });

    expect(screen.queryByTestId('fb-saved-app-name')).toBeNull();
    expect(screen.getByTestId('fb-saved-app-id').textContent).toBe(SAVED_APP_ID);
    expect(
      screen.getByText('Your Facebook app is connected and ready to publish.')
    ).toBeTruthy();
  });

  it('Copy App ID writes to the clipboard and shows the "App ID copied" feedback', async () => {
    const user = userEvent.setup();
    // userEvent.setup() installs its own clipboard stub over the
    // beforeEach mock — re-apply the mock so the write is observable.
    installClipboardMock();
    renderView(CONNECTED);

    await user.click(screen.getByTestId('fb-copy-app-id-btn'));
    expect(clipboardWriteText).toHaveBeenCalledWith(SAVED_APP_ID);
    await waitFor(() =>
      expect(screen.getByTestId('fb-copy-app-id-btn').textContent).toBe('App ID copied')
    );
  }, INTERACTION_TIMEOUT);

  it('Show fetches the saved secret through the reveal action and Hide masks it again', async () => {
    const user = userEvent.setup();
    renderView(CONNECTED);

    // The value is not in the payload — it only arrives via reveal.
    expect(screen.getByTestId('fb-saved-app-secret').textContent).toBe('•'.repeat(24));

    await user.click(screen.getByTestId('fb-state2-secret-toggle'));
    await waitFor(() =>
      expect(screen.getByTestId('fb-saved-app-secret').textContent).toBe(SAVED_SECRET)
    );
    expect(screen.getByTestId('fb-state2-secret-toggle').textContent).toBe('Hide');

    await user.click(screen.getByTestId('fb-state2-secret-toggle'));
    expect(screen.getByTestId('fb-saved-app-secret').textContent).toBe('•'.repeat(24));
  }, INTERACTION_TIMEOUT);

  it('a failed reveal reports at the field and keeps the secret masked', async () => {
    revealResponder = async () => jsonResponse({ error: 'Failed' }, 500);
    const user = userEvent.setup();
    renderView(CONNECTED);

    await user.click(screen.getByTestId('fb-state2-secret-toggle'));

    expect(await screen.findByTestId('fb-secret-reveal-error')).toBeTruthy();
    expect(screen.getByTestId('fb-secret-reveal-error').textContent).toBe(
      "Couldn't show your App Secret. Please try again."
    );
    expect(screen.getByTestId('fb-saved-app-secret').textContent).toBe('•'.repeat(24));
    expect(screen.getByTestId('fb-state2-secret-toggle').textContent).toBe('Show');
  }, INTERACTION_TIMEOUT);
});

describe('FacebookSettingsView — edit mode', () => {
  it('Edit details re-opens the form with the App ID pre-filled, the secret blank, and the card back', async () => {
    const user = userEvent.setup();
    renderView(CONNECTED);

    await user.click(screen.getByTestId('fb-edit-details-btn'));

    expect(screen.getByText('Find your app details')).toBeTruthy();
    expect(screen.getByText('Add your app details here')).toBeTruthy();
    // While editing, the app is still connected: tick, not a cross.
    expect(
      screen.getByTestId('facebook-status-mark').getAttribute('data-status')
    ).toBe('connected');
    // "One more step" is its own panel below the main panel in the
    // single-column layout — a sibling, not nested inside the main card.
    expect(
      screen
        .getByTestId('fb-one-more-step-card')
        .closest('[data-testid="facebook-settings-card"]')
    ).toBeNull();
    expect(screen.getByTestId('fb-one-more-step-card')).toBeTruthy();
    expect((screen.getByTestId('fb-app-id-input') as HTMLInputElement).value).toBe(
      SAVED_APP_ID
    );
    expect((screen.getByTestId('fb-app-secret-input') as HTMLInputElement).value).toBe('');
    expect(screen.getByTestId('fb-cancel-edit-btn').textContent).toBe('Cancel');
    expect(screen.getByTestId('fb-one-more-step-card')).toBeTruthy();
  }, INTERACTION_TIMEOUT);

  it('a blank secret in edit mode keeps the existing secret (the PUT omits it)', async () => {
    const user = userEvent.setup();
    renderView(CONNECTED);

    await user.click(screen.getByTestId('fb-edit-details-btn'));
    await user.click(screen.getByTestId('fb-connect-btn'));

    expect(await screen.findByText('Your Facebook app is connected.')).toBeTruthy();
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0]?.body).toEqual({ fbAppId: SAVED_APP_ID });
    expect(await screen.findByTestId('fb-saved-app-id')).toBeTruthy();
  }, INTERACTION_TIMEOUT);

  it('Cancel returns to the connected view without saving', async () => {
    const user = userEvent.setup();
    renderView(CONNECTED);

    await user.click(screen.getByTestId('fb-edit-details-btn'));
    await user.click(screen.getByTestId('fb-cancel-edit-btn'));

    expect(screen.getByTestId('fb-saved-app-id')).toBeTruthy();
    expect(screen.queryByTestId('fb-one-more-step-card')).toBeNull();
    expect(putCalls).toHaveLength(0);
  }, INTERACTION_TIMEOUT);
});

describe('FacebookSettingsView — disconnect dialog (OD-135-2a)', () => {
  it('opens with the §5.2 copy and focus on "Keep connected"; Esc does not dismiss it', async () => {
    const user = userEvent.setup();
    renderView(CONNECTED);

    await user.click(screen.getByTestId('fb-disconnect-btn'));

    expect(await screen.findByTestId('fb-disconnect-modal')).toBeTruthy();
    expect(screen.getByTestId('fb-disconnect-title').textContent).toBe(
      'Disconnect Facebook?'
    );
    expect(
      screen.getByText(
        /We'll remove your App ID and App Secret from this workspace\. Your connected accounts and posting will keep working, but you won't be able to reconnect or add new accounts until you add new details\./
      )
    ).toBeTruthy();
    expect(screen.getByTestId('fb-disconnect-keep-btn').textContent).toBe(
      'Keep connected'
    );
    expect(screen.getByTestId('fb-disconnect-confirm-btn').textContent).toBe('Disconnect');

    const keepButton = screen.getByTestId('fb-disconnect-keep-btn');
    await waitFor(() => expect(document.activeElement).toBe(keepButton));

    await user.keyboard('{Escape}');
    expect(screen.getByTestId('fb-disconnect-modal')).toBeTruthy();
    expect(deleteCalls).toBe(0);
  }, INTERACTION_TIMEOUT);

  it('"Keep connected" closes the dialog and returns focus to the Disconnect button', async () => {
    const user = userEvent.setup();
    renderView(CONNECTED);

    const disconnectButton = screen.getByTestId('fb-disconnect-btn');
    await user.click(disconnectButton);
    expect(await screen.findByTestId('fb-disconnect-modal')).toBeTruthy();

    await user.click(screen.getByTestId('fb-disconnect-keep-btn'));
    await waitFor(() =>
      expect(screen.queryByTestId('fb-disconnect-modal')).toBeNull()
    );
    await waitFor(() => expect(document.activeElement).toBe(disconnectButton));
    expect(deleteCalls).toBe(0);
    expect(screen.getByTestId('fb-saved-app-id')).toBeTruthy();
  }, INTERACTION_TIMEOUT);

  it('confirm disconnects: DELETE runs, the success toast shows, and the tab returns to the not-connected form', async () => {
    const user = userEvent.setup();
    renderView(CONNECTED);

    await user.click(screen.getByTestId('fb-disconnect-btn'));
    expect(await screen.findByTestId('fb-disconnect-modal')).toBeTruthy();
    await user.click(screen.getByTestId('fb-disconnect-confirm-btn'));

    expect(
      await screen.findByText('Your Facebook app has been disconnected.')
    ).toBeTruthy();
    expect(deleteCalls).toBe(1);
    expect(await screen.findByTestId('fb-connect-btn')).toBeTruthy();
    expect(screen.getByTestId('fb-one-more-step-card')).toBeTruthy();
    expect(screen.queryByTestId('fb-disconnect-modal')).toBeNull();
  }, INTERACTION_TIMEOUT);

  it('a failed disconnect toasts the §5.2 failure sentence and keeps the dialog open', async () => {
    deleteResponder = async () => jsonResponse({ error: 'Failed' }, 500);
    const user = userEvent.setup();
    renderView(CONNECTED);

    await user.click(screen.getByTestId('fb-disconnect-btn'));
    expect(await screen.findByTestId('fb-disconnect-modal')).toBeTruthy();
    await user.click(screen.getByTestId('fb-disconnect-confirm-btn'));

    expect(
      await screen.findByText("Couldn't disconnect Facebook. Please try again.")
    ).toBeTruthy();
    expect(screen.getByTestId('fb-disconnect-modal')).toBeTruthy();
    expect(screen.getByTestId('fb-saved-app-id')).toBeTruthy();
  }, INTERACTION_TIMEOUT);

  it('a disconnect network failure toasts the fixed network sentence', async () => {
    deleteResponder = async () => {
      throw new TypeError('fetch failed');
    };
    const user = userEvent.setup();
    renderView(CONNECTED);

    await user.click(screen.getByTestId('fb-disconnect-btn'));
    expect(await screen.findByTestId('fb-disconnect-modal')).toBeTruthy();
    await user.click(screen.getByTestId('fb-disconnect-confirm-btn'));

    expect(
      await screen.findByText('Could not disconnect Facebook. Try again.')
    ).toBeTruthy();
    expect(screen.getByTestId('fb-disconnect-modal')).toBeTruthy();
  }, INTERACTION_TIMEOUT);
});
