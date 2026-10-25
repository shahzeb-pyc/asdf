/**
 * General settings — behavioural tests (spec 135 PR-135-1, T6).
 *
 * Migrated from the legacy static-markup suite: the rebuilt
 * GeneralSettingsView is rendered into jsdom and driven with
 * user-event. Without a QueryClient provider the view uses its
 * standalone adapter (name from props, rename through the same typed
 * client), so the fetch stub below serves `PATCH /api/workspaces`
 * exactly as the typed client calls it.
 *
 * Copy and validation messages are spec §5.1 verbatim — the strings
 * asserted here are the contract, not decoration.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

// userEvent interaction tests run long under coverage instrumentation;
// the per-test budget below replaces the 5s default for this file's
// interaction cases only (assertions and waits are unchanged).
const INTERACTION_TIMEOUT = 20_000;
import userEvent from '@testing-library/user-event';

import {
  formatWorkspaceCreatedAt,
  GeneralSettingsView,
  workspaceNameFormSchema,
} from '@/components/settings/general-settings-view';

const SUBDOMAIN = 'acme';
const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '00000000-0000-4000-8000-000000000001';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as Response;
}

interface PatchCall {
  url: string;
  body: unknown;
}

let patchCalls: PatchCall[] = [];
let patchResponder: (call: PatchCall) => Promise<Response>;

function installFetchStub() {
  patchCalls = [];
  patchResponder = async (call) =>
    jsonResponse({
      success: true,
      workspace: {
        id: WORKSPACE_ID,
        ownerId: OWNER_ID,
        name: (call.body as { name: string }).name,
        subdomain: SUBDOMAIN,
      },
    });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/api/workspaces') && method === 'PATCH') {
        const call: PatchCall = {
          url,
          body: init?.body ? JSON.parse(String(init.body)) : null,
        };
        patchCalls.push(call);
        return patchResponder(call);
      }
      throw new Error(`Unstubbed fetch: ${method} ${url}`);
    })
  );
}


/** The submit-failure summary, by its data-slot: the inline
 *  FormMessage also carries role="alert", so a role query is
 *  ambiguous exactly when both are present (the validation cases). */
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

beforeEach(() => {
  installFetchStub();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('workspace name schema (§5.1 messages verbatim)', () => {
  it('accepts names between 3 and 40 characters without edge spaces', () => {
    expect(workspaceNameFormSchema.safeParse({ name: 'My Workspace' }).success).toBe(true);
    expect(workspaceNameFormSchema.safeParse({ name: 'abc' }).success).toBe(true);
    expect(workspaceNameFormSchema.safeParse({ name: 'A'.repeat(40) }).success).toBe(true);
  });

  it('rejects short and long names with the exact §5.1 sentence', () => {
    for (const name of ['', 'ab', 'A'.repeat(41)]) {
      const result = workspaceNameFormSchema.safeParse({ name });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe(
          'Workspace name must be between 3 and 40 characters.'
        );
      }
    }
  });

  it('rejects leading/trailing spaces with the exact §5.1 sentence', () => {
    for (const name of [' workspace', 'workspace ', '  spaced  ']) {
      const result = workspaceNameFormSchema.safeParse({ name });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe(
          'Workspace name must not contain leading or trailing spaces.'
        );
      }
    }
  });
});

describe('GeneralSettingsView — display state', () => {
  it('renders the workspace name without the removed sentences', () => {
    render(<GeneralSettingsView subdomain={SUBDOMAIN} workspaceName="Acme Studio" />);

    expect(screen.getByRole('heading', { name: 'About this workspace' })).toBeTruthy();
    expect(screen.getByTestId('workspace-name-display').textContent).toBe('Acme Studio');
    expect(screen.queryByText('Name your workspace.')).toBeNull();
    expect(
      screen.queryByText('Rename it any time — the new name shows up everywhere.')
    ).toBeNull();
    expect(screen.getByTestId('workspace-name-edit-btn').textContent).toBe('Edit');
  });

  it('shows the Created row formatted from createdAt', () => {
    render(
      <GeneralSettingsView
        subdomain={SUBDOMAIN}
        workspaceName="Acme Studio"
        workspaceCreatedAt="2026-10-24T00:00:00.000Z"
      />
    );

    expect(screen.getByTestId('workspace-created-row').textContent).toContain(
      '24 October 2026'
    );
  });

  it('hides the Created row when createdAt is missing', () => {
    render(<GeneralSettingsView subdomain={SUBDOMAIN} workspaceName="Acme Studio" />);

    expect(screen.queryByTestId('workspace-created-row')).toBeNull();
  });

  it('stacks heading above panel in a single column (no two-column split)', () => {
    render(<GeneralSettingsView subdomain={SUBDOMAIN} workspaceName="Acme Studio" />);

    const card = screen.getByTestId('workspace-about-card');
    const wrapper = card.parentElement as HTMLElement;
    // Single column: flex-col, and no grid two-column split class.
    expect(wrapper.className).toContain('flex-col');
    expect(wrapper.className).not.toContain('grid-cols');
    expect(wrapper.className).not.toContain('grid');
    // Heading block is the first child, panel second — stacked, not side by side.
    expect(wrapper.children[0].textContent).toContain('About this workspace');
    expect(wrapper.children[1]).toBe(card);
  });
});

describe('formatWorkspaceCreatedAt', () => {
  it('formats a valid date in day-month-year form and returns null otherwise', () => {
    expect(formatWorkspaceCreatedAt('2026-10-24T00:00:00.000Z')).toBe('24 October 2026');
    expect(formatWorkspaceCreatedAt(undefined)).toBeNull();
    expect(formatWorkspaceCreatedAt('not-a-date')).toBeNull();
  });
});

describe('GeneralSettingsView — rename flow', () => {
  it('Edit opens the form pre-filled; Cancel returns to the display untouched', async () => {
    const user = userEvent.setup();
    render(<GeneralSettingsView subdomain={SUBDOMAIN} workspaceName="Acme Studio" />);

    await user.click(screen.getByTestId('workspace-name-edit-btn'));
    const input = screen.getByTestId('workspace-name-input') as HTMLInputElement;
    expect(input.value).toBe('Acme Studio');
    expect(screen.getByTestId('workspace-name-save-btn')).toBeTruthy();
    expect(screen.getByTestId('workspace-name-cancel-btn')).toBeTruthy();

    await user.clear(input);
    await user.type(input, 'Something Else');
    await user.click(screen.getByTestId('workspace-name-cancel-btn'));

    expect(screen.getByTestId('workspace-name-display').textContent).toBe('Acme Studio');
    expect(patchCalls).toHaveLength(0);
  }, INTERACTION_TIMEOUT);

  it('invalid submit: summary + inline carry the same exact message, input is preserved, focus moves to the summary', async () => {
    const user = userEvent.setup();
    render(<GeneralSettingsView subdomain={SUBDOMAIN} workspaceName="Acme Studio" />);

    await user.click(screen.getByTestId('workspace-name-edit-btn'));
    const input = screen.getByTestId('workspace-name-input') as HTMLInputElement;
    await user.clear(input);
    await user.type(input, 'ab');
    await user.click(screen.getByTestId('workspace-name-save-btn'));

    const summary = await findErrorSummary();
    expect(summary.textContent).toContain(
      'Workspace name must be between 3 and 40 characters.'
    );
    expect(screen.getByTestId('workspace-name-error').textContent).toBe(
      'Workspace name must be between 3 and 40 characters.'
    );
    expect(input.value).toBe('ab');
    await waitFor(() => expect(document.activeElement).toBe(summary));
    expect(patchCalls).toHaveLength(0);
  }, INTERACTION_TIMEOUT);

  it('trailing-space name fails with the spaces sentence, not the length sentence', async () => {
    const user = userEvent.setup();
    render(<GeneralSettingsView subdomain={SUBDOMAIN} workspaceName="Acme Studio" />);

    await user.click(screen.getByTestId('workspace-name-edit-btn'));
    const input = screen.getByTestId('workspace-name-input') as HTMLInputElement;
    await user.clear(input);
    await user.type(input, 'Acme ');
    await user.click(screen.getByTestId('workspace-name-save-btn'));

    const summary = await findErrorSummary();
    expect(summary.textContent).toContain(
      'Workspace name must not contain leading or trailing spaces.'
    );
    expect(input.value).toBe('Acme ');
  }, INTERACTION_TIMEOUT);

  it('successful save: PATCHes through the typed client, shows the new name in place, fires workspace-updated', async () => {
    const user = userEvent.setup();
    const updatedEvents: Array<{ subdomain: string; name: string }> = [];
    const listener = (event: Event) => {
      updatedEvents.push((event as CustomEvent).detail);
    };
    window.addEventListener('workspace-updated', listener);
    try {
      render(<GeneralSettingsView subdomain={SUBDOMAIN} workspaceName="Acme Studio" />);

      await user.click(screen.getByTestId('workspace-name-edit-btn'));
      const input = screen.getByTestId('workspace-name-input') as HTMLInputElement;
      await user.clear(input);
      await user.type(input, 'Acme Renamed');
      await user.click(screen.getByTestId('workspace-name-save-btn'));

      await waitFor(() => {
        expect(screen.getByTestId('workspace-name-display').textContent).toBe('Acme Renamed');
      });
      expect(patchCalls).toHaveLength(1);
      expect(patchCalls[0]?.body).toEqual({ subdomain: SUBDOMAIN, name: 'Acme Renamed' });
      expect(updatedEvents).toEqual([{ subdomain: SUBDOMAIN, name: 'Acme Renamed' }]);
    } finally {
      window.removeEventListener('workspace-updated', listener);
    }
  }, INTERACTION_TIMEOUT);

  it('failed save: the server message surfaces in the summary, edit mode and text survive', async () => {
    const user = userEvent.setup();
    patchResponder = async () => jsonResponse({ error: 'That workspace name is taken.' }, 500);
    render(<GeneralSettingsView subdomain={SUBDOMAIN} workspaceName="Acme Studio" />);

    await user.click(screen.getByTestId('workspace-name-edit-btn'));
    const input = screen.getByTestId('workspace-name-input') as HTMLInputElement;
    await user.clear(input);
    await user.type(input, 'Taken Name');
    await user.click(screen.getByTestId('workspace-name-save-btn'));

    const summary = await findErrorSummary();
    expect(summary.textContent).toContain('That workspace name is taken.');
    expect((screen.getByTestId('workspace-name-input') as HTMLInputElement).value).toBe(
      'Taken Name'
    );
  }, INTERACTION_TIMEOUT);

  it('failed save without a server message falls back to the fixed §5.1 sentence', async () => {
    const user = userEvent.setup();
    patchResponder = async () => {
      throw new Error('network down');
    };
    render(<GeneralSettingsView subdomain={SUBDOMAIN} workspaceName="Acme Studio" />);

    await user.click(screen.getByTestId('workspace-name-edit-btn'));
    const input = screen.getByTestId('workspace-name-input') as HTMLInputElement;
    await user.clear(input);
    await user.type(input, 'Any Name');
    await user.click(screen.getByTestId('workspace-name-save-btn'));

    const summary = await findErrorSummary();
    expect(summary.textContent).toContain(
      "Couldn't update the workspace name. Please try again."
    );
    expect((screen.getByTestId('workspace-name-input') as HTMLInputElement).value).toBe(
      'Any Name'
    );
  }, INTERACTION_TIMEOUT);
});
