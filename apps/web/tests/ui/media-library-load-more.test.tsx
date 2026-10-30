/**
 * @file media-library-load-more.test.tsx
 * @description Behavioural test for the Media Library Load more
 * button (P1-15): the old library view fetched only the first 500
 * items and its Load more control was a hidden test-only anchor
 * that loaded nothing. The real button must page with
 * offset/limit, append the next page, and update its total text.
 * Rendered live (Testing Library, jsdom project).
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MediaItemResponse } from '@fbuploadpro/contracts';
import { MediaLibraryExplorer } from '@/components/media/media-library-explorer';
import { api } from '@/lib/api';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useParams: () => ({ subdomain: 'acme' }),
  usePathname: () => '/media',
  useSearchParams: () => new URLSearchParams(),
}));

function item(id: string, name: string): MediaItemResponse {
  return {
    id,
    userId: '00000000-0000-4000-8000-000000000001',
    folderId: null,
    name,
    mediaType: 'image',
    mimeType: 'image/png',
    fileSize: 1024,
    storageKey: `users/u1/media/${id}.png`,
    url: `https://media.example.com/users/u1/media/${id}.png`,
    thumbnailKey: null,
    thumbnailUrl: null,
    durationSeconds: null,
    aspectRatio: '1:1',
    captionText: '',
    createdAt: '2026-10-10T12:00:00.000Z',
    updatedAt: '2026-10-10T12:00:00.000Z',
  };
}

describe('Media Library Load more', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('loads the next page on tap and shows the appended item + updated total', async () => {
    const getSpy = vi.spyOn(api, 'get').mockResolvedValue({
      items: [
        {
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3',
          userId: '00000000-0000-4000-8000-000000000001',
          folderId: null,
          name: 'Loaded Page Two.png',
          mediaType: 'image',
          mimeType: 'image/png',
          fileSize: 2048,
          storageKey: 'users/u1/media/page2.png',
          url: 'https://media.example.com/users/u1/media/page2.png',
          thumbnailKey: null,
          thumbnailUrl: null,
          durationSeconds: null,
          aspectRatio: '1:1',
          captionText: '',
          createdAt: '2026-10-10T10:00:00.000Z',
          updatedAt: '2026-10-10T10:00:00.000Z',
        },
      ],
      total: 250,
      limit: 500,
      offset: 500,
      nextCursor: null,
    } as never);

    // No background refetch: the seeded first page must stick, so
    // the only network call in this test is the Load more tap.
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MediaLibraryExplorer
          subdomain="acme"
          initialFolders={[]}
          initialMediaItems={[
            item('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'First Page One.png'),
            item('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', 'First Page Two.png'),
          ]}
          initialTotalMediaCount={250}
          initialCurrentFolderId={null}
        />
      </QueryClientProvider>,
    );

    const button = await screen.findByTestId('load-more-media-btn');
    expect(button).toHaveTextContent('Load more (Showing 2 of 250)');

    fireEvent.click(button);

    await waitFor(() => {
      expect(getSpy).toHaveBeenCalledWith(
        expect.stringContaining('/media'),
        expect.objectContaining({
          query: { limit: 500, offset: 500 },
        }),
      );
    });
    await waitFor(() => {
      expect(screen.getByText('Loaded Page Two.png')).toBeInTheDocument();
    });
    expect(button).toHaveTextContent('Load more (Showing 3 of 250)');
  });
});
