/**
 * @file media-library-browse.test.tsx
 * @description Behavioural tests for the rebuilt media browse surface
 * (spec 133 PR-133-2, spec §2.5 doctrine): header, 3-zone toolbar,
 * asset tiles, table rows, subfolder rows, the typed empty states, and
 * the shared selection model — rendered into jsdom with Testing
 * Library + user-event. Style-mechanism assertions from the legacy
 * static suite are superseded by these behaviour assertions (the
 * primitives' own suites carry the style guarantees).
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import type { MediaFolder, MediaItemResponse } from '@fbuploadpro/contracts';

import { createQueryClient } from '@/lib/data/query-client';
import { MediaLibraryHeader } from '@/components/media/media-library-header';
import { MediaToolbar } from '@/components/media/media-library-toolbar';
import { MediaAssetCard } from '@/components/media/media-asset-card';
import { MediaTableRow } from '@/components/media/media-table-row';
import { MediaCanvas } from '@/components/media/media-library-grid';
import { SubfolderRowsSection } from '@/components/media/media-library-subfolders';
import { MediaLibraryExplorer } from '@/components/media/media-library-explorer';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useParams: () => ({ subdomain: 'acme' }),
  usePathname: () => '/media',
}));

const FOLDER: MediaFolder = {
  id: '11111111-1111-4111-8111-111111111111',
  userId: '00000000-0000-4000-8000-000000000001',
  parentId: null,
  name: 'Campaign A',
  itemCount: 2,
  subfolderCount: 1,
  createdAt: '2026-10-10T10:00:00.000Z',
  updatedAt: '2026-10-10T10:00:00.000Z',
};

const VIDEO_ITEM: MediaItemResponse = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  userId: '00000000-0000-4000-8000-000000000001',
  folderId: null,
  name: 'Viral Launch Reel.mp4',
  mediaType: 'video',
  mimeType: 'video/mp4',
  fileSize: 15728640,
  storageKey: 'users/u1/media/m1.mp4',
  url: 'https://media.fbuploadpro.com/users/u1/media/m1.mp4',
  thumbnailKey: 'users/u1/thumbnails/m1.webp',
  thumbnailUrl: 'https://media.fbuploadpro.com/users/u1/thumbnails/m1.webp',
  durationSeconds: 45,
  aspectRatio: '9:16',
  captionText: 'Viral Launch Reel 🔥',
  createdAt: '2026-10-10T12:00:00.000Z',
  updatedAt: '2026-10-10T12:00:00.000Z',
};

const IMAGE_ITEM_NO_CAPTION: MediaItemResponse = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
  userId: '00000000-0000-4000-8000-000000000001',
  folderId: null,
  name: 'Product_Showcase_Banner.png',
  mediaType: 'image',
  mimeType: 'image/png',
  fileSize: 2097152,
  storageKey: 'users/u1/media/m2.png',
  url: 'https://media.fbuploadpro.com/users/u1/media/m2.png',
  thumbnailKey: null,
  thumbnailUrl: null,
  durationSeconds: null,
  aspectRatio: '1:1',
  captionText: '',
  createdAt: '2026-10-10T11:00:00.000Z',
  updatedAt: '2026-10-10T11:00:00.000Z',
};

function renderToolbar(overrides: Partial<React.ComponentProps<typeof MediaToolbar>> = {}) {
  const props: React.ComponentProps<typeof MediaToolbar> = {
    searchInput: '',
    onSearchChange: vi.fn(),
    scopeTagLabel: 'In: Library',
    mediaTypeFilter: 'all',
    onMediaTypeChange: vi.fn(),
    aspectRatioFilter: 'all',
    onAspectRatioChange: vi.fn(),
    captionStatusFilter: 'all',
    onCaptionStatusChange: vi.fn(),
    activeFilterCount: 0,
    onClearFilters: vi.fn(),
    sortOption: 'created_at:desc',
    onSortChange: vi.fn(),
    viewMode: 'grid',
    onChangeViewMode: vi.fn(),
    ...overrides,
  };
  render(<MediaToolbar {...props} />);
  return props;
}

describe('MediaLibraryHeader (PB-13)', () => {
  it('renders Upload Files as the single primary button; New Folder is a quiet action', async () => {
    const user = userEvent.setup();
    const onUploadClick = vi.fn();
    const onNewFolderClick = vi.fn();
    const onDownloadClick = vi.fn();
    render(
      <MediaLibraryHeader
        fileInputRef={{ current: null }}
        onFileInputChange={vi.fn()}
        onNewFolderClick={onNewFolderClick}
        onUploadClick={onUploadClick}
        onDownloadClick={onDownloadClick}
      />
    );

    const upload = screen.getByTestId('upload-files-btn');
    expect(upload).toHaveAttribute('data-variant', 'default');
    expect(screen.getByTestId('new-folder-link')).toHaveAttribute('data-variant', 'link');
    // Spec 149: Download sits beside Upload as a secondary button —
    // Upload stays the surface's single primary.
    const download = screen.getByTestId('download-files-btn');
    expect(download).toHaveAttribute('data-variant', 'outline');
    await user.click(download);
    expect(onDownloadClick).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { name: 'Media Library' })).toBeInTheDocument();
    expect(
      screen.getByText('Upload, organize, and caption your media for publishing queues.')
    ).toBeInTheDocument();

    await user.click(upload);
    expect(onUploadClick).toHaveBeenCalledTimes(1);
    await user.click(screen.getByTestId('new-folder-link'));
    expect(onNewFolderClick).toHaveBeenCalledTimes(1);
  });

  it('forwards picked files from the picker input and resets it', () => {
    const onFileInputChange = vi.fn();
    const { container } = render(
      <MediaLibraryHeader
        fileInputRef={{ current: null }}
        onFileInputChange={onFileInputChange}
        onNewFolderClick={vi.fn()}
        onUploadClick={vi.fn()}
        onDownloadClick={vi.fn()}
      />
    );
    const input = container.querySelector('input[type="file"]');
    expect(input).not.toBeNull();
    const file = new File(['data'], 'clip.mp4', { type: 'video/mp4' });
    Object.defineProperty(input!, 'files', { value: [file], configurable: true });
    fireEvent.change(input!);
    expect(onFileInputChange).toHaveBeenCalledWith([file]);
  });

  it('keeps the picker input rendered so showPicker() is honored (launch bug 2026-10-31)', () => {
    render(
      <MediaLibraryHeader
        fileInputRef={{ current: null }}
        onFileInputChange={vi.fn()}
        onNewFolderClick={vi.fn()}
        onUploadClick={vi.fn()}
        onDownloadClick={vi.fn()}
      />
    );
    // showPicker() silently no-ops on a display:none input in
    // spec-compliant browsers — and it does not throw, so the
    // click() fallback never runs and Upload Files looks completely
    // dead (no picker, no dialog, no toast). The input must stay
    // rendered (1px, transparent), never `hidden`. Fails on the old
    // markup (class "hidden", no testid) and passes on the fix.
    const input = screen.getByTestId('media-library-file-input');
    expect(input).not.toHaveClass('hidden');
    expect(input).toHaveClass('absolute');
    expect(input).toHaveClass('opacity-0');
  });
});

describe('MediaToolbar (PB-10/11)', () => {
  it('search input reports changes (zone 1 is search only)', async () => {
    const user = userEvent.setup();
    const props = renderToolbar();
    await user.type(screen.getByTestId('media-search-input'), 'sun');
    expect(props.onSearchChange).toHaveBeenCalled();
    expect(screen.getByTestId('media-scope-tag')).toHaveTextContent('In: Library');
  });

  it('a dropdown option applies on selection and the menu closes', async () => {
    const user = userEvent.setup();
    const props = renderToolbar();
    await user.click(screen.getByTestId('media-type-select'));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.click(screen.getByRole('menuitemradio', { name: 'Videos' }));
    expect(props.onMediaTypeChange).toHaveBeenCalledWith('video');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByTestId('media-type-select')).toHaveFocus();
  });

  it('sort dropdown applies on selection', async () => {
    const user = userEvent.setup();
    const props = renderToolbar();
    await user.click(screen.getByTestId('media-sort-select'));
    await user.click(screen.getByRole('menuitemradio', { name: 'Oldest first' }));
    expect(props.onSortChange).toHaveBeenCalledWith('created_at:asc');
  });

  it('shows the active-filter count with Clear, which keeps working when filters are set', async () => {
    const user = userEvent.setup();
    const props = renderToolbar({
      mediaTypeFilter: 'video',
      aspectRatioFilter: '9:16',
      activeFilterCount: 2,
    });
    expect(screen.getByTestId('media-type-select')).toHaveTextContent('Videos');
    const clear = screen.getByTestId('clear-filters-btn');
    expect(clear).toHaveTextContent('2 filters · Clear');
    await user.click(clear);
    expect(props.onClearFilters).toHaveBeenCalledTimes(1);
  });

  it('segmented view switch reports grid/table changes', async () => {
    const user = userEvent.setup();
    const props = renderToolbar();
    expect(screen.getByTestId('view-mode-grid-btn')).toHaveAttribute('data-state', 'active');
    await user.click(screen.getByTestId('view-mode-table-btn'));
    expect(props.onChangeViewMode).toHaveBeenCalledWith('table');
  });
});

describe('MediaAssetCard (PB-16)', () => {
  it('checkbox toggles selection; shift-click passes the range modifier', async () => {
    const user = userEvent.setup();
    const onToggleSelect = vi.fn();
    render(
      <MediaAssetCard
        item={VIDEO_ITEM}
        selected={false}
        onToggleSelect={onToggleSelect}
        onPreview={vi.fn()}
      />
    );
    const checkbox = screen.getByTestId(`select-media-${VIDEO_ITEM.id}`);
    await user.click(checkbox);
    expect(onToggleSelect).toHaveBeenCalledWith(VIDEO_ITEM.id, { shiftKey: false });

    onToggleSelect.mockClear();
    await user.keyboard('{Shift>}');
    await user.click(checkbox);
    await user.keyboard('{/Shift}');
    expect(onToggleSelect).toHaveBeenCalledWith(VIDEO_ITEM.id, { shiftKey: true });
  });

  it('overflow menu offers Move and Delete only (no Schedule, PB-9)', async () => {
    const user = userEvent.setup();
    const onMoveRequest = vi.fn();
    const onDeleteRequest = vi.fn();
    render(
      <MediaAssetCard
        item={VIDEO_ITEM}
        onPreview={vi.fn()}
        onMoveRequest={onMoveRequest}
        onDeleteRequest={onDeleteRequest}
      />
    );
    await user.click(screen.getByTestId(`overflow-menu-btn-${VIDEO_ITEM.id}`));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.queryByText('Schedule')).not.toBeInTheDocument();
    await user.click(screen.getByTestId(`menu-move-${VIDEO_ITEM.id}`));
    expect(onMoveRequest).toHaveBeenCalledWith(VIDEO_ITEM);

    await user.click(screen.getByTestId(`overflow-menu-btn-${VIDEO_ITEM.id}`));
    await user.click(screen.getByTestId(`menu-delete-${VIDEO_ITEM.id}`));
    expect(onDeleteRequest).toHaveBeenCalledWith(VIDEO_ITEM);
  });

  it('caption status is text, not colour alone: added vs missing', () => {
    const { unmount } = render(<MediaAssetCard item={VIDEO_ITEM} />);
    expect(screen.getByTestId(`media-caption-status-${VIDEO_ITEM.id}`)).toHaveTextContent(
      'Caption added'
    );
    unmount();
    render(<MediaAssetCard item={IMAGE_ITEM_NO_CAPTION} />);
    expect(
      screen.getByTestId(`media-caption-status-${IMAGE_ITEM_NO_CAPTION.id}`)
    ).toHaveTextContent('Missing caption');
  });
});

describe('MediaTableRow (PB-6, PB-20)', () => {
  function renderRow(item: MediaItemResponse, overrides = {}) {
    const props = {
      item,
      onNavigateFolder: vi.fn(),
      onToggleSelect: vi.fn(),
      onPreview: vi.fn(),
      onUpdateCaption: vi.fn(),
      onMoveRequest: vi.fn(),
      onDeleteRequest: vi.fn(),
      ...overrides,
    };
    render(
      <table>
        <tbody>
          <MediaTableRow {...props} />
        </tbody>
      </table>
    );
    return props;
  }

  it('renders file, caption, details, size, date and fires row actions', async () => {
    const user = userEvent.setup();
    const props = renderRow(VIDEO_ITEM);
    expect(screen.getByTestId(`row-name-${VIDEO_ITEM.id}`)).toHaveTextContent(
      'Viral Launch Reel.mp4'
    );
    expect(screen.getByTestId(`row-details-${VIDEO_ITEM.id}`)).toHaveTextContent('9:16 · 0:45');
    expect(screen.getByTestId(`row-size-${VIDEO_ITEM.id}`)).toHaveTextContent('15.0 MB');
    expect(screen.getByTestId(`row-date-${VIDEO_ITEM.id}`)).toHaveTextContent('Oct 10, 2026');

    await user.click(screen.getByTestId(`row-action-preview-${VIDEO_ITEM.id}`));
    expect(props.onPreview).toHaveBeenCalledWith(VIDEO_ITEM);
    await user.click(screen.getByTestId(`row-action-move-${VIDEO_ITEM.id}`));
    expect(props.onMoveRequest).toHaveBeenCalledWith(VIDEO_ITEM);
    // Delete sits in a TableRow whose hover/selected background changes
    // independently of the button, so it must use the on-tint colour
    // unconditionally — plain signal fails on row hover/selected.
    expect(
      screen.getByTestId(`row-action-delete-${VIDEO_ITEM.id}`).className.split(/\s+/)
    ).toContain('text-signal-critical-on-tint');
    expect(
      screen.getByTestId(`row-action-delete-${VIDEO_ITEM.id}`).className.split(/\s+/)
    ).not.toContain('text-signal-critical');
    await user.click(screen.getByTestId(`row-action-delete-${VIDEO_ITEM.id}`));
    expect(props.onDeleteRequest).toHaveBeenCalledWith(VIDEO_ITEM);
  });

  it('caption click-to-edit saves the new caption on Enter', async () => {
    const user = userEvent.setup();
    const props = renderRow(VIDEO_ITEM);
    await user.click(screen.getByTestId(`table-inline-caption-${VIDEO_ITEM.id}`));
    const input = screen.getByTestId(`table-caption-input-${VIDEO_ITEM.id}`);
    await user.clear(input);
    await user.type(input, 'A brand new caption');
    await user.keyboard('{Enter}');
    expect(props.onUpdateCaption).toHaveBeenCalledWith(VIDEO_ITEM.id, 'A brand new caption');
  });

  it('a missing caption shows the filename only as a marked fallback (PB-20)', () => {
    renderRow(IMAGE_ITEM_NO_CAPTION);
    const caption = screen.getByTestId(`table-inline-caption-${IMAGE_ITEM_NO_CAPTION.id}`);
    expect(caption).toHaveTextContent('Product_Showcase_Banner');
    expect(caption).toHaveAttribute('data-fallback', 'filename');
  });
});

describe('MediaCanvas empty states (spec §8.3)', () => {
  const baseProps: React.ComponentProps<typeof MediaCanvas> = {
    displayedMediaItems: [],
    viewMode: 'grid',
    isLoading: false,
    selectedIds: [],
    debouncedSearch: '',
    folders: [],
    activeSmartView: null,
    totalMediaCount: 0,
    onNavigateFolder: vi.fn(),
    onToggleSelect: vi.fn(),
    onPreview: vi.fn(),
    onUpdateCaption: vi.fn(),
    onMoveRequest: vi.fn(),
    onDeleteRequest: vi.fn(),
  };

  it('first use: one primary action, Upload Files', async () => {
    const user = userEvent.setup();
    const onUploadClick = vi.fn();
    render(<MediaCanvas {...baseProps} onUploadClick={onUploadClick} />);
    expect(screen.getByTestId('media-empty-state')).toHaveAttribute('data-type', 'first-use');
    expect(screen.getByText('Your media library is empty')).toBeInTheDocument();
    await user.click(screen.getByTestId('media-empty-upload-btn'));
    expect(onUploadClick).toHaveBeenCalledTimes(1);
  });

  it('folder empty: names the folder', () => {
    render(
      <MediaCanvas
        {...baseProps}
        folders={[FOLDER]}
        totalMediaCount={3}
        currentFolderName="Campaign A"
        onUploadClick={vi.fn()}
      />
    );
    expect(screen.getByText('No media in Campaign A')).toBeInTheDocument();
  });

  it('no results — search: echoes the query and offers Clear search', async () => {
    const user = userEvent.setup();
    const onClearSearch = vi.fn();
    render(
      <MediaCanvas
        {...baseProps}
        folders={[FOLDER]}
        totalMediaCount={3}
        debouncedSearch="zebra"
        onClearSearch={onClearSearch}
      />
    );
    expect(screen.getByTestId('media-empty-state')).toHaveAttribute('data-type', 'no-results');
    expect(screen.getByText(/zebra/)).toBeInTheDocument();
    await user.click(screen.getByTestId('media-empty-clear-search-btn'));
    expect(onClearSearch).toHaveBeenCalledTimes(1);
  });

  it('no results — filters: echoes the filters and offers Clear filters', async () => {
    const user = userEvent.setup();
    const onClearFilters = vi.fn();
    render(
      <MediaCanvas
        {...baseProps}
        folders={[FOLDER]}
        totalMediaCount={3}
        activeFilterCount={1}
        activeFilterLabels={['Type: Videos']}
        onClearFilters={onClearFilters}
      />
    );
    expect(screen.getByText('Active filters: Type: Videos')).toBeInTheDocument();
    await user.click(screen.getByTestId('media-empty-clear-filters-btn'));
    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });

  it('needs-caption cleared: positive state with no call to action', () => {
    render(
      <MediaCanvas
        {...baseProps}
        folders={[FOLDER]}
        totalMediaCount={3}
        activeSmartView="needs_caption"
      />
    );
    expect(screen.getByTestId('media-empty-state')).toHaveAttribute('data-type', 'cleared');
    expect(screen.getByText('All files have captions')).toBeInTheDocument();
    expect(within(screen.getByTestId('media-empty-state')).queryByRole('button')).toBeNull();
  });

  it('load error: section-scope error with Retry', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<MediaCanvas {...baseProps} isError onRetry={onRetry} />);
    expect(screen.getByTestId('media-error-state')).toBeInTheDocument();
    await user.click(screen.getByTestId('media-error-retry-btn'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('loading: skeleton at the grid geometry', () => {
    render(<MediaCanvas {...baseProps} isLoading />);
    expect(screen.getByTestId('media-loading-state')).toBeInTheDocument();
  });

  it('grid and table render the loaded/total relationship', () => {
    const { unmount } = render(
      <MediaCanvas {...baseProps} displayedMediaItems={[VIDEO_ITEM]} totalMediaCount={1} />
    );
    expect(screen.getByTestId('media-assets-grid')).toBeInTheDocument();
    expect(screen.getByTestId('media-loaded-count')).toHaveTextContent('Showing 1 of 1 file');
    unmount();

    render(
      <MediaCanvas
        {...baseProps}
        viewMode="table"
        displayedMediaItems={[VIDEO_ITEM]}
        totalMediaCount={1}
      />
    );
    expect(screen.getByTestId('media-table-view')).toBeInTheDocument();
    expect(screen.getByTestId(`media-row-${VIDEO_ITEM.id}`)).toBeInTheDocument();
  });
});

describe('SubfolderRowsSection (PB-15)', () => {
  it('row click navigates; action buttons fire without navigating', async () => {
    const user = userEvent.setup();
    const onSelectFolder = vi.fn();
    const onStartRename = vi.fn();
    const childFolder: MediaFolder = {
      ...FOLDER,
      id: '22222222-2222-4222-8222-222222222222',
      parentId: FOLDER.id,
      name: 'Reels',
    };
    render(
      <SubfolderRowsSection
        currentSubfolders={[FOLDER]}
        folders={[FOLDER, childFolder]}
        mediaItems={[]}
        isLocked={false}
        onSelectFolder={onSelectFolder}
        onStartRename={onStartRename}
        onStartMove={vi.fn()}
        onStartDelete={vi.fn()}
        onFilesDrop={vi.fn()}
      />
    );
    expect(screen.getByTestId(`folder-name-${FOLDER.id}`)).toHaveTextContent('Campaign A');
    expect(screen.getByTestId(`folder-row-${FOLDER.id}`)).toHaveTextContent(
      '1 subfolder · 2 files'
    );

    await user.click(screen.getByTestId(`rename-folder-${FOLDER.id}`));
    expect(onStartRename).toHaveBeenCalledWith(FOLDER);
    expect(onSelectFolder).not.toHaveBeenCalled();

    await user.click(screen.getByTestId(`folder-name-${FOLDER.id}`));
    expect(onSelectFolder).toHaveBeenCalledWith(FOLDER.id);
  });
});

describe('Explorer selection model (shared grid + table)', () => {
  it('Select all selects every displayed asset, and toggles back', async () => {
    const user = userEvent.setup();
    const client = createQueryClient('acme');
    render(
      <QueryClientProvider client={client}>
        <MediaLibraryExplorer
          subdomain="acme"
          initialFolders={[]}
          initialMediaItems={[VIDEO_ITEM, IMAGE_ITEM_NO_CAPTION]}
          initialCurrentFolderId={null}
        />
      </QueryClientProvider>
    );

    await user.click(screen.getByTestId('select-all-btn'));
    expect(screen.getByTestId(`select-media-${VIDEO_ITEM.id}`)).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.getByTestId(`select-media-${IMAGE_ITEM_NO_CAPTION.id}`)).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.getByTestId('select-all-btn')).toHaveTextContent('Deselect all');

    await user.click(screen.getByTestId('select-all-btn'));
    expect(screen.getByTestId(`select-media-${VIDEO_ITEM.id}`)).toHaveAttribute(
      'aria-checked',
      'false'
    );
  });
});
