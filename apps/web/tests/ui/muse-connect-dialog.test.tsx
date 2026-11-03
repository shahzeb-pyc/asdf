/**
 * Connect Muse dialogue — behavioural tests.
 *
 * Create + show-once + copy, prompt copy, keys list (active only,
 * never a Revoked row), revoke confirm + row removal, keys-load
 * failure, and empty-name validation. The key value itself is
 * generated in-test and never a real credential.
 */
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MUSE_CONNECT_PROMPT } from '@fbuploadpro/contracts';

import { MuseConnectDialog } from '@/components/muse/muse-connect-dialog';

const mockedApiGet = vi.fn();
const mockedApiPost = vi.fn();
const mockedApiDelete = vi.fn();
const mockedToast = vi.fn();
const clipboardWriteText = vi.fn().mockResolvedValue(undefined);

vi.mock('@/lib/api', () => ({
  apiGet: (...args: unknown[]) => mockedApiGet(...args),
  apiPost: (...args: unknown[]) => mockedApiPost(...args),
  apiDelete: (...args: unknown[]) => mockedApiDelete(...args),
  buildTenantApiPath: (subdomain: string, path: string) =>
    `/api/tenant/${subdomain}${path}`,
  getErrorMessage: (err: unknown) =>
    err instanceof Error ? err.message : 'Something went wrong. Please try again.',
}));

vi.mock('@/components/shared/ui/toast', () => ({
  toast: (...args: unknown[]) => mockedToast(...args),
}));

const KEY_ID = '44444444-4444-4444-8444-444444444444';
const KEYS = [
  {
    id: KEY_ID,
    name: 'My Muse',
    keyPrefix: 'fbu_…abcd',
    scopes: ['media:read', 'media:write'],
    expiresAt: null,
    createdAt: '2026-11-03T09:00:00.000Z',
    lastUsedAt: '2026-11-03T10:00:00.000Z',
  },
];

function installClipboardMock() {
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText: clipboardWriteText },
    configurable: true,
  });
}

function renderDialog() {
  return render(
    <MuseConnectDialog subdomain="creatorstack" open onOpenChange={vi.fn()} />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  clipboardWriteText.mockClear();
  installClipboardMock();
  mockedApiGet.mockResolvedValue({ keys: KEYS });
  mockedApiPost.mockResolvedValue({
    id: '55555555-5555-4555-8555-555555555555',
    name: 'Second Muse',
    keyPrefix: 'fbu_…wxyz',
    scopes: ['media:read', 'media:write'],
    expiresAt: null,
    createdAt: '2026-11-03T12:00:00.000Z',
    lastUsedAt: null,
    key: 'fbu_0123456789abcdef0123456789abcdef',
  });
  mockedApiDelete.mockResolvedValue({ success: true, keyId: KEY_ID });
});

describe('MuseConnectDialog', () => {
  it('lists active keys with their prefix and never shows a Revoked row', async () => {
    renderDialog();
    expect(await screen.findByText('My Muse')).toBeTruthy();
    expect(screen.getByText('fbu_…abcd')).toBeTruthy();
    expect(screen.getByText('Active')).toBeTruthy();
    expect(screen.queryByText('Revoked')).toBeNull();
    expect(screen.queryByText(/Muse can only add media to, and view, your Media Library/)).toBeNull();
  });

  it('shows "No keys yet" when the list is empty', async () => {
    mockedApiGet.mockResolvedValue({ keys: [] });
    renderDialog();
    expect(await screen.findByText(/You haven't created a key yet/)).toBeTruthy();
  });

  it('shows the keys-load failure instead of an empty list', async () => {
    mockedApiGet.mockRejectedValue(new Error('Keys failed'));
    renderDialog();
    expect(await screen.findByText(/We couldn't load your keys/)).toBeTruthy();
  });

  it('creates a key, shows it once, and copies it', async () => {
    const user = userEvent.setup();
    installClipboardMock();
    renderDialog();
    await screen.findByText('My Muse');
    await user.type(screen.getByLabelText('Key name'), 'Second Muse');
    await user.click(screen.getByText('Create key'));
    expect(await screen.findByText('New key — shown once')).toBeTruthy();
    expect(screen.getByText('fbu_0123456789abcdef0123456789abcdef')).toBeTruthy();
    expect(mockedApiPost).toHaveBeenCalledWith(
      expect.stringContaining('/muse/keys'),
      { name: 'Second Muse' },
      expect.anything()
    );
    installClipboardMock();
    await user.click(screen.getByText('Copy key'));
    expect(clipboardWriteText).toHaveBeenCalledWith(
      'fbu_0123456789abcdef0123456789abcdef'
    );
  });

  it('does not call create with an empty key name', async () => {
    const user = userEvent.setup();
    renderDialog();
    await screen.findByText('My Muse');
    await user.click(screen.getByText('Create key'));
    expect(mockedApiPost).not.toHaveBeenCalled();
    expect(mockedToast).toHaveBeenCalledWith('Please enter a name for the key.');
  });

  it('copies the exact prompt, with the app-host guide link and key-first order', async () => {
    const user = userEvent.setup();
    installClipboardMock();
    renderDialog();
    await screen.findByText('My Muse');
    expect(screen.getByText(/Connect to my FBUploadPro account, in this order/)).toBeTruthy();
    await user.click(screen.getByText('Copy prompt'));
    expect(clipboardWriteText).toHaveBeenCalledWith(MUSE_CONNECT_PROMPT);
    expect(MUSE_CONNECT_PROMPT).toContain('https://app.fbuploadpro.com/muse_guide.md');
    expect(MUSE_CONNECT_PROMPT).toContain('FBUploadPro sign-in');
  });

  it('revoke asks for confirmation and then removes the row entirely', async () => {
    const user = userEvent.setup();
    renderDialog();
    await screen.findByText('My Muse');
    await user.click(screen.getByText('Revoke'));
    expect(await screen.findByText('Revoke this key?')).toBeTruthy();
    // Two "Revoke" buttons exist now (row + confirm action); the
    // confirm action is rendered last, in the AlertDialog portal.
    const revokeButtons = screen.getAllByText('Revoke');
    await user.click(revokeButtons[revokeButtons.length - 1]);
    await waitFor(() => expect(screen.queryByText('My Muse')).toBeNull());
    expect(mockedApiDelete).toHaveBeenCalledWith(
      expect.stringContaining(`/muse/keys/${KEY_ID}`)
    );
    expect(mockedToast).toHaveBeenCalledWith('Key revoked and removed.');
  });
});
