import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { MediaStorageMeter } from '@/components/media/media-storage-meter';
import { MediaLibraryHeader } from '@/components/media/media-library-header';
import type { MediaStorageDisplay } from '@/lib/billing/storage-quota';

const GIB = 1073741824;

function display(usedGiB: number, quotaGiB: number): MediaStorageDisplay {
  const quotaBytes = quotaGiB * GIB;
  const usedBytes = usedGiB * GIB;
  const state =
    quotaGiB <= 0
      ? null
      : usedBytes > quotaBytes
        ? 'over'
        : usedBytes >= quotaBytes
          ? 'full'
          : usedBytes >= 0.8 * quotaBytes
            ? 'near'
            : 'normal';
  return {
    quotaBytes,
    usedBytes,
    remainingBytes: Math.max(0, quotaBytes - usedBytes),
    overBytes: Math.max(0, usedBytes - quotaBytes),
    state,
  };
}

/**
 * Storage meter display states + the read-only header controls.
 * The meter itself is presentational: the numbers arrive from GET
 * billing/storage, which shares the enforcement computation.
 */
describe('MediaStorageMeter', () => {
  it('shows used, total, and remaining in the normal state', () => {
    render(<MediaStorageMeter display={display(10, 25)} />);
    expect(screen.getByTestId('media-storage-meter')).toHaveTextContent(
      'Storage: 10 GB of 25 GB · 15 GB remaining'
    );
    expect(screen.queryByTestId('media-storage-near-warning')).toBeNull();
    expect(screen.queryByTestId('media-storage-full-message')).toBeNull();
    expect(screen.queryByTestId('media-storage-readonly-banner')).toBeNull();
  });

  it('warns at 80% and not below it', () => {
    const { rerender } = render(<MediaStorageMeter display={display(19, 25)} />);
    expect(screen.queryByTestId('media-storage-near-warning')).toBeNull();
    rerender(<MediaStorageMeter display={display(20, 25)} />);
    expect(screen.getByTestId('media-storage-near-warning')).toHaveTextContent(
      'You are reaching your storage limit.'
    );
  });

  it('shows the full message at 100%', () => {
    render(<MediaStorageMeter display={display(25, 25)} />);
    expect(screen.getByTestId('media-storage-full-message')).toHaveTextContent(
      'Media Library full'
    );
  });

  it('shows the read-only banner with overage when over', () => {
    render(<MediaStorageMeter display={display(26, 25)} />);
    expect(screen.getByTestId('media-storage-readonly-banner')).toHaveTextContent(
      'Media Library is read-only — remove media to be able to use it again.'
    );
    expect(screen.getByTestId('media-storage-meter')).toHaveTextContent('1 GB over limit');
  });

  it('renders nothing with no active period', () => {
    const { container } = render(<MediaStorageMeter display={display(0, 0)} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('MediaLibraryHeader read-only controls', () => {
  function renderHeader(props: { uploadDisabled?: boolean; newFolderDisabled?: boolean }) {
    return render(
      <MediaLibraryHeader
        fileInputRef={React.createRef<HTMLInputElement>()}
        onFileInputChange={() => undefined}
        onNewFolderClick={() => undefined}
        onUploadClick={() => undefined}
        onDownloadClick={() => undefined}
        {...props}
      />
    );
  }

  it('enables upload and new folder by default', () => {
    renderHeader({});
    expect(screen.getByTestId('upload-files-btn')).toBeEnabled();
    expect(screen.getByTestId('new-folder-link')).toBeEnabled();
    expect(screen.getByTestId('download-files-btn')).toBeEnabled();
  });

  it('disables upload and new folder when read-only, but not download', () => {
    renderHeader({ uploadDisabled: true, newFolderDisabled: true });
    expect(screen.getByTestId('upload-files-btn')).toBeDisabled();
    expect(screen.getByTestId('new-folder-link')).toBeDisabled();
    expect(screen.getByTestId('download-files-btn')).toBeEnabled();
  });
});
