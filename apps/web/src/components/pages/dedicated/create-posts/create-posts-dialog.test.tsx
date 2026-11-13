/**
 * Create Posts dialogue — slots pre-check path.
 *
 * Regression test for the PR #216 rename: the dialog's pre-queue
 * slots fetch was pointed at `/inapp-schedule/<pageId>/slots`, an API
 * path that does not exist (the route lives at
 * `/pages/<pageId>/slots`), so every Add to Queue attempt failed at
 * the pre-check with "Couldn't check posting times". This test types
 * a post, clicks Add all to Queue, and asserts the exact URL the
 * dialog calls — the previous coverage mocked `api.get` without
 * asserting its URL, which is why the wrong path slipped through.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { toast } from '@/components/shared/ui/toast';
import { CreatePostsDialog } from './create-posts-dialog';
import type { FacebookPageItem } from '@/components/pages/page-card';

const PAGE_ID = '22222222-2222-4222-a222-222222222222';
const USER_ID = '11111111-1111-4111-a111-111111111111';

const page: FacebookPageItem = {
  id: PAGE_ID,
  facebookAccountId: '33333333-3333-4333-a333-333333333333',
  fbPageId: '444444444444444',
  pageName: 'Test Page',
  startingFollowers: 0,
  currentFollowers: 0,
  followersGained: 0,
  status: 'active',
  createdAt: '2026-11-13T00:00:00.000Z',
};

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));
const apiGet = apiMocks.get;
const apiPost = apiMocks.post;

vi.mock('@/lib/api', () => ({
  api: apiMocks,
  buildTenantApiPath: (subdomain: string, path: string) =>
    `/api/tenant/${subdomain}${path}`,
  isApiError: () => false,
}));

vi.mock('@/components/shared/ui/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useParams: () => ({ subdomain: 'acme', pageId: PAGE_ID }),
  useSearchParams: () => ({
    get: () => null,
    toString: () => '',
  }),
}));

vi.mock('next/image', () => ({
  default: () => null,
}));

vi.mock('next/link', () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

// The composer blocks are covered by their own suite; here a stub
// textarea is enough to make a block ready for queueing.
vi.mock('./post-block', () => ({
  PostBlock: ({
    block,
    label,
    onTextChange,
  }: {
    block: { text: string };
    label: string;
    onTextChange: (text: string) => void;
  }) => (
    <textarea
      aria-label={label}
      value={block.text}
      onChange={(event) => onTextChange(event.target.value)}
    />
  ),
}));

vi.mock('./media-library-picker', () => ({
  MediaLibraryPicker: () => null,
}));

vi.mock('./bulk-text-dialog', () => ({
  BulkTextDialog: () => null,
}));

vi.mock('@/components/media/leave-page-guard-dialog', () => ({
  LeavePageGuardDialog: () => null,
}));

function renderDialog(onOpenChange = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return {
    onOpenChange,
    ...render(
      <CreatePostsDialog
        open
        onOpenChange={onOpenChange}
        subdomain="acme"
        page={page}
      />,
      { wrapper }
    ),
  };
}

describe('CreatePostsDialog slots pre-check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiGet.mockResolvedValue({
      slots: [
        {
          id: '55555555-5555-4555-a555-555555555555',
          userId: USER_ID,
          pageId: PAGE_ID,
          slotTime: '09:00',
          timezone: 'UTC',
          isActive: true,
          allowedFormats: ['text'],
        },
      ],
      total: 1,
    });
    apiPost.mockResolvedValue({});
  });

  it('checks posting times at /pages/<pageId>/slots and queues the post', async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();

    await user.type(screen.getByLabelText('New post'), 'Hello world');
    await user.click(
      screen.getByRole('button', { name: 'Add all to Queue (1 post)' })
    );

    await waitFor(() =>
      expect(apiGet).toHaveBeenCalledWith(
        `/api/tenant/acme/pages/${PAGE_ID}/slots`,
        expect.anything()
      )
    );
    expect(
      apiGet.mock.calls.some((call) =>
        String(call[0]).includes('inapp-schedule')
      )
    ).toBe(false);
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Post added to queue.')
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
