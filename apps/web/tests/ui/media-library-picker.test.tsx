/**
 * @file media-library-picker.test.tsx
 * @description Behavioural tests for the Media Library picker's staged
 * device-upload flow (the Pages composer path): what happens when a
 * device upload succeeds, in single and multi mode, and when the Add
 * button appears. The real staged uploader is stubbed out here — its
 * own upload mechanics are covered by composer-staged-upload.test.tsx —
 * so these tests drive the picker's success/attach/button logic
 * directly: succeed, uploading/idle signals, and the Add tap.
 *
 * The behaviour under test: a single uploaded file in the composer
 * (confirmSingleStagedUpload) must show the Add button and attach
 * ONLY when it is tapped — never auto-attach-and-close — while every
 * other single-mode caller keeps auto-attach-and-close, and multi
 * mode is unchanged.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { MediaLibraryPicker } from '@/components/pages/dedicated/create-posts/media-library-picker';
import type { ComposerMedia } from '@fbuploadpro/contracts';

const apiGet = vi.fn();
const onOpenChange = vi.fn();
const onSingleAttach = vi.fn();
const onMultiAttach = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    post: vi.fn(),
  },
  buildTenantApiPath: (subdomain: string, path: string) =>
    `/api/tenant/${encodeURIComponent(subdomain)}${path.startsWith('/') ? path : `/${path}`}`,
  isApiError: (err: unknown) =>
    Boolean(err && typeof err === 'object' && 'code' in (err as Record<string, unknown>)),
}));

const FAKE_MEDIA: ComposerMedia = {
  id: '11111111-1111-4111-a111-111111111111',
  name: 'photo.jpg',
  mediaType: 'image',
  aspectRatio: '1:1',
  thumbnailUrl: null,
  url: 'https://example.test/photo.jpg',
  captionText: 'photo',
  source: 'staged',
  storageKey: 'post-staging/test/photo.jpg',
};

vi.mock('@/components/pages/dedicated/create-posts/composer-staged-upload', () => ({
  ComposerStagedUpload: ({
    onSuccess,
    onActiveChange,
  }: {
    onSuccess: (media: ComposerMedia) => void;
    onActiveChange?: (
      count: number,
      furthest: { name: string; progressPercent: number } | null
    ) => void;
  }) => (
    <div>
      <button type="button" data-testid="stub-staged-succeed" onClick={() => onSuccess(FAKE_MEDIA)}>
        succeed
      </button>
      <button
        type="button"
        data-testid="stub-staged-uploading"
        onClick={() => onActiveChange?.(1, { name: 'photo.jpg', progressPercent: 50 })}
      >
        uploading
      </button>
      <button
        type="button"
        data-testid="stub-staged-idle"
        onClick={() => onActiveChange?.(0, null)}
      >
        idle
      </button>
    </div>
  ),
}));

function renderPicker(props: {
  mode: 'single' | 'multi';
  confirmSingleStagedUpload?: boolean;
}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MediaLibraryPicker
        open
        onOpenChange={onOpenChange}
        subdomain="testws"
        pageName="Test"
        mode={props.mode}
        deviceUploads="staged"
        confirmSingleStagedUpload={props.confirmSingleStagedUpload}
        onSingleAttach={onSingleAttach}
        onMultiAttach={onMultiAttach}
      />
    </QueryClientProvider>
  );
}

async function openDeviceTab() {
  fireEvent.click(await screen.findByText('Upload from device'));
  await screen.findByTestId('stub-staged-succeed');
}

function addButton() {
  return screen.queryByTestId('media-library-picker-add-uploaded-btn');
}

beforeEach(() => {
  vi.clearAllMocks();
  apiGet.mockImplementation(async (path: string) => {
    if (path.includes('/media/folders')) return { folders: [] };
    if (path.includes('/media')) return { items: [] };
    return {};
  });
});

describe('MediaLibraryPicker staged device uploads', () => {
  it('single + confirm: success shows the Add button and attaches only on tap', async () => {
    renderPicker({ mode: 'single', confirmSingleStagedUpload: true });
    await openDeviceTab();

    fireEvent.click(screen.getByTestId('stub-staged-succeed'));

    // Nothing attached yet, dialog still open, Add button visible.
    expect(onSingleAttach).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    const button = addButton();
    expect(button).not.toBeNull();
    expect(button).toHaveTextContent('Add uploaded file');

    fireEvent.click(button!);

    expect(onSingleAttach).toHaveBeenCalledTimes(1);
    expect(onSingleAttach).toHaveBeenCalledWith(FAKE_MEDIA);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(addButton()).toBeNull();
  });

  it('single + confirm: no premature Add button while still uploading', async () => {
    renderPicker({ mode: 'single', confirmSingleStagedUpload: true });
    await openDeviceTab();

    fireEvent.click(screen.getByTestId('stub-staged-succeed'));
    expect(addButton()).not.toBeNull();

    // A second file still uploading hides the button again.
    fireEvent.click(screen.getByTestId('stub-staged-uploading'));
    expect(addButton()).toBeNull();

    fireEvent.click(screen.getByTestId('stub-staged-idle'));
    expect(addButton()).not.toBeNull();
  });

  it('single without confirm: success auto-attaches and closes, no Add button', async () => {
    renderPicker({ mode: 'single' });
    await openDeviceTab();

    fireEvent.click(screen.getByTestId('stub-staged-succeed'));

    expect(onSingleAttach).toHaveBeenCalledTimes(1);
    expect(onSingleAttach).toHaveBeenCalledWith(FAKE_MEDIA);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(addButton()).toBeNull();
  });

  it('multi: success shows the Add button and attaches only on tap', async () => {
    renderPicker({ mode: 'multi' });
    await openDeviceTab();

    fireEvent.click(screen.getByTestId('stub-staged-succeed'));

    expect(onMultiAttach).not.toHaveBeenCalled();
    const button = addButton();
    expect(button).not.toBeNull();
    expect(button).toHaveTextContent('Add 1 uploaded file as posts');

    fireEvent.click(button!);

    expect(onMultiAttach).toHaveBeenCalledTimes(1);
    expect(onMultiAttach).toHaveBeenCalledWith([FAKE_MEDIA]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
