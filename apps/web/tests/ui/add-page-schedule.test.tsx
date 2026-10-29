/**
 * Behavioural tests for the Add Page steps 3–4 (timezone, then
 * posting times): step transitions, disabled states, the blank
 * timezone start, all-formats-default on a new time, at-least-1
 * time/format validation, back-navigation preserving state, and
 * the "nothing finish" failure behaviour (dialog stays open on
 * Step 4, retry re-sends the same schedule).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { AddPageModal } from '@/components/pages/add-page-modal';
import {
  createAddPagePostingTime,
  findFreeAddPagePostingTime,
  isAddPageScheduleValid,
  nextAddPagePostingTime,
  sortAddPageFormats,
} from '@/components/pages/add-page-helpers';
import type { FacebookAccountItem } from '@/components/accounts/account-card';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useParams: () => ({ subdomain: 'acme' }),
  useSearchParams: () => new URLSearchParams(),
}));

const activeAccount: FacebookAccountItem = {
  id: '11111111-1111-4111-8111-111111111111',
  fbAccountId: 'fb_user_1',
  displayName: 'Sarah Connor',
  profilePictureUrl: null,
  status: 'active',
  connectedPagesCount: 2,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Add Page schedule helpers', () => {
  it('a fresh time has every post type selected', () => {
    expect(createAddPagePostingTime().allowedFormats).toEqual([
      'reel',
      'image',
      'video',
      'story',
      'text',
    ]);
  });

  it('the schedule is invalid without a timezone, with no times, with an empty-format time, or with duplicate times', () => {
    const one = [createAddPagePostingTime()];
    expect(isAddPageScheduleValid(null, one)).toBe(false);
    expect(isAddPageScheduleValid('Asia/Karachi', [])).toBe(false);
    expect(
      isAddPageScheduleValid('Asia/Karachi', [
        { slotTime: '09:00', allowedFormats: [] },
      ])
    ).toBe(false);
    expect(
      isAddPageScheduleValid('Asia/Karachi', [
        createAddPagePostingTime('09:00'),
        createAddPagePostingTime('09:00'),
      ])
    ).toBe(false);
    expect(isAddPageScheduleValid('Asia/Karachi', one)).toBe(true);
  });

  it('a newly added time never starts as a duplicate', () => {
    expect(nextAddPagePostingTime([]).slotTime).toBe('09:00');
    expect(
      nextAddPagePostingTime([createAddPagePostingTime('09:00')]).slotTime
    ).toBe('12:00');
    expect(
      nextAddPagePostingTime([createAddPagePostingTime('09:00')])
        .allowedFormats
    ).toEqual(['reel', 'image', 'video', 'story', 'text']);
  });

  it('a fifth row after the four defaults is a genuinely free time, not a duplicate fallback', () => {
    const four = ['09:00', '12:00', '17:30', '20:00'].map(
      createAddPagePostingTime
    );
    const fifth = findFreeAddPagePostingTime(four);
    expect(fifth).not.toBeNull();
    expect(fifth?.slotTime).toBe('21:00');
    expect(
      four.some((time) => time.slotTime === fifth?.slotTime)
    ).toBe(false);
  });

  it('deselect-then-reselect keeps the canonical format order', () => {
    expect(sortAddPageFormats(['text', 'reel'])).toEqual(['reel', 'text']);
    expect(
      sortAddPageFormats(['story', 'text', 'reel', 'image', 'video'])
    ).toEqual(['reel', 'image', 'video', 'story', 'text']);
  });
});

describe('AddPageModal steps 3–4', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Step 3 starts blank, Continue enables on pick, and Step 4 shows the timezone with all formats selected by default', async () => {
    render(
      <AddPageModal
        subdomain="acme"
        open={true}
        onOpenChange={vi.fn()}
        accounts={[activeAccount]}
        initialStep="select-timezone"
        initialSelectedAccount={activeAccount}
        initialDiscoveredPages={[]}
        initialSelectedPageIds={['fb_page_201']}
      />
    );

    // Steps 3–4 are lazy-loaded: wait for the Step 3 body first.
    expect(await screen.findByText('Select timezone')).toBeTruthy();
    expect(await screen.findByText(/No timezone selected yet/)).toBeTruthy();
    const toPostingTimes = screen.getByTestId(
      'continue-to-posting-times-btn'
    ) as HTMLButtonElement;
    expect(toPostingTimes.disabled).toBe(true);

    fireEvent.click(
      await screen.findByTestId('add-page-timezone-option-Asia/Karachi')
    );
    await waitFor(() => expect(toPostingTimes.disabled).toBe(false));
    fireEvent.click(toPostingTimes);

    expect(screen.getByText('Set posting times')).toBeTruthy();
    expect(
      (await screen.findByTestId('add-page-selected-timezone-note'))
        .textContent
    ).toContain('Asia/Karachi');
    expect(
      (
        screen.getByTestId(
          'add-page-posting-time-input-0'
        ) as HTMLInputElement
      ).value
    ).toBe('09:00');
    expect(screen.getByText(/Posts will go out at 09:00 AM/)).toBeTruthy();
    for (const format of ['reel', 'image', 'video', 'story', 'text']) {
      expect(
        screen
          .getByTestId(`add-page-format-toggle-0-${format}`)
          .getAttribute('aria-pressed')
      ).toBe('true');
    }
  });

  it('Step 4 allows unlimited times, Remove only while more than one remains, and blocks Add when a time has no post type', async () => {
    render(
      <AddPageModal
        subdomain="acme"
        open={true}
        onOpenChange={vi.fn()}
        accounts={[activeAccount]}
        initialStep="select-posting-times"
        initialSelectedAccount={activeAccount}
        initialDiscoveredPages={[]}
        initialSelectedPageIds={['fb_page_201']}
        initialSelectedTimezone="Asia/Karachi"
      />
    );

    // Steps 3–4 are lazy-loaded: wait for the Step 4 body first.
    await screen.findByTestId('add-page-posting-time-0');
    // One time: no Remove, Add enabled.
    expect(screen.queryByTestId('remove-posting-time-0')).toBeNull();
    const confirm = screen.getByTestId(
      'confirm-add-pages-btn'
    ) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);

    fireEvent.click(screen.getByTestId('add-another-posting-time-btn'));
    expect(screen.getByTestId('add-page-posting-time-1')).toBeTruthy();
    expect(
      (
        screen.getByTestId(
          'add-page-posting-time-input-1'
        ) as HTMLInputElement
      ).value
    ).toBe('12:00');
    expect(screen.getByTestId('remove-posting-time-1')).toBeTruthy();

    // Deselect every format on the second time: Add blocks.
    for (const format of ['reel', 'image', 'video', 'story', 'text']) {
      fireEvent.click(screen.getByTestId(`add-page-format-toggle-1-${format}`));
    }
    expect(screen.getByText('Choose at least one post type.')).toBeTruthy();
    expect(confirm.disabled).toBe(true);

    // Removing the invalid time restores Add, and the sole remaining
    // time again has no Remove.
    fireEvent.click(screen.getByTestId('remove-posting-time-1'));
    expect(confirm.disabled).toBe(false);
    expect(screen.queryByTestId('remove-posting-time-0')).toBeNull();
  });

  it('back navigation preserves the page selection, timezone, and posting times', async () => {
    render(
      <AddPageModal
        subdomain="acme"
        open={true}
        onOpenChange={vi.fn()}
        accounts={[activeAccount]}
        initialStep="select-pages"
        initialSelectedAccount={activeAccount}
        initialDiscoveredPages={[
          {
            fbPageId: 'fb_page_201',
            pageName: 'Skynet AI Daily',
            profilePictureUrl: null,
            category: 'Automation',
            currentFollowers: 4300,
            isImported: false,
          },
        ]}
        initialSelectedPageIds={['fb_page_201']}
      />
    );

    fireEvent.click(screen.getByTestId('continue-to-timezone-btn'));
    fireEvent.click(
      await screen.findByTestId('add-page-timezone-option-Asia/Karachi')
    );
    fireEvent.click(screen.getByTestId('continue-to-posting-times-btn'));
    fireEvent.change(
      await screen.findByTestId('add-page-posting-time-input-0'),
      {
        target: { value: '17:30' },
      }
    );
    expect(screen.getByText(/Posts will go out at 05:30 PM/)).toBeTruthy();

    // Step 4 → Step 3 keeps the timezone; Step 3 → Step 4 keeps the time.
    fireEvent.click(screen.getByTestId('back-to-timezone-btn'));
    expect(
      screen.getByText(/Selected timezone: Karachi/)
    ).toBeTruthy();
    expect(
      screen.getByTestId('add-page-timezone-note').textContent
    ).toContain('Asia/Karachi');
    expect(
      (screen.getByTestId('continue-to-posting-times-btn') as HTMLButtonElement)
        .disabled
    ).toBe(false);
    fireEvent.click(screen.getByTestId('continue-to-posting-times-btn'));
    expect(
      (
        screen.getByTestId(
          'add-page-posting-time-input-0'
        ) as HTMLInputElement
      ).value
    ).toBe('17:30');

    // Step 4 → Step 3 → Step 2 keeps the page selection (Continue enabled).
    fireEvent.click(screen.getByTestId('back-to-timezone-btn'));
    fireEvent.click(screen.getByTestId('back-to-pages-btn'));
    expect(screen.getByText('Select Facebook Pages to Add')).toBeTruthy();
    expect(
      (screen.getByTestId('continue-to-timezone-btn') as HTMLButtonElement)
        .disabled
    ).toBe(false);
  });

  it('import failure stays open on Step 4 with the inline error, and retry re-sends the same schedule then succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 500))
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          importedCount: 1,
          pages: [
            {
              id: '44444444-4444-4444-8444-444444444444',
              fbPageId: 'fb_page_201',
              pageName: 'Skynet AI Daily',
            },
          ],
        })
      );

    const onSuccess = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <AddPageModal
        subdomain="acme"
        open={true}
        onOpenChange={onOpenChange}
        accounts={[activeAccount]}
        onSuccess={onSuccess}
        initialStep="select-posting-times"
        initialSelectedAccount={activeAccount}
        initialDiscoveredPages={[]}
        initialSelectedPageIds={['fb_page_201']}
        initialSelectedTimezone="Asia/Karachi"
      />
    );

    const confirm = screen.getByTestId('confirm-add-pages-btn');
    fireEvent.click(confirm);
    const error = await screen.findByTestId('add-page-error');
    expect(error.textContent).toContain("Couldn't add the selected pages.");
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByText('Set posting times')).toBeTruthy();

    fireEvent.click(confirm);
    await waitFor(() =>
      expect(onSuccess).toHaveBeenCalledWith({
        importedCount: 1,
        importedPageIds: ['44444444-4444-4444-8444-444444444444'],
      })
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
    const importCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith('/pages/import')
    );
    expect(importCalls).toHaveLength(2);
    expect(importCalls[0]?.[1]?.body).toBe(importCalls[1]?.[1]?.body);
    expect(JSON.parse(String(importCalls[1]?.[1]?.body))).toEqual({
      accountId: activeAccount.id,
      selectedPageIds: ['fb_page_201'],
      timezone: 'Asia/Karachi',
      postingTimes: [
        {
          slotTime: '09:00',
          allowedFormats: ['reel', 'image', 'video', 'story', 'text'],
        },
      ],
    });
  });

  it('a cleared time shows "Choose a time" instead of previewing 09:00 AM', () => {
    render(
      <AddPageModal
        subdomain="acme"
        open={true}
        onOpenChange={vi.fn()}
        accounts={[activeAccount]}
        initialStep="select-posting-times"
        initialSelectedAccount={activeAccount}
        initialDiscoveredPages={[]}
        initialSelectedPageIds={['fb_page_201']}
        initialSelectedTimezone="Asia/Karachi"
      />
    );

    fireEvent.change(screen.getByTestId('add-page-posting-time-input-0'), {
      target: { value: '' },
    });
    expect(screen.getByText('Choose a time.')).toBeTruthy();
    expect(screen.queryByText(/Posts will go out at 09:00 AM/)).toBeNull();
  });

  it('deselect-then-reselect sends formats in canonical order', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        importedCount: 1,
        pages: [
          {
            id: '44444444-4444-4444-8444-444444444444',
            fbPageId: 'fb_page_201',
            pageName: 'Skynet AI Daily',
          },
        ],
      })
    );
    render(
      <AddPageModal
        subdomain="acme"
        open={true}
        onOpenChange={vi.fn()}
        accounts={[activeAccount]}
        onSuccess={vi.fn()}
        initialStep="select-posting-times"
        initialSelectedAccount={activeAccount}
        initialDiscoveredPages={[]}
        initialSelectedPageIds={['fb_page_201']}
        initialSelectedTimezone="Asia/Karachi"
      />
    );

    fireEvent.click(screen.getByTestId('add-page-format-toggle-0-reel'));
    fireEvent.click(screen.getByTestId('add-page-format-toggle-0-reel'));
    fireEvent.click(screen.getByTestId('confirm-add-pages-btn'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const importCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith('/pages/import')
    );
    expect(
      JSON.parse(String(importCall?.[1]?.body)).postingTimes[0].allowedFormats
    ).toEqual(['reel', 'image', 'video', 'story', 'text']);
  });

  it('a schedule failure shows the distinct message in an alert banner and keeps the schedule', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error:
            "Couldn't save the posting times — try again, your timezone and times are kept",
          code: 'SCHEDULE_FAILED',
        },
        500
      )
    );
    render(
      <AddPageModal
        subdomain="acme"
        open={true}
        onOpenChange={vi.fn()}
        accounts={[activeAccount]}
        initialStep="select-posting-times"
        initialSelectedAccount={activeAccount}
        initialDiscoveredPages={[]}
        initialSelectedPageIds={['fb_page_201']}
        initialSelectedTimezone="Asia/Karachi"
      />
    );

    fireEvent.click(screen.getByTestId('confirm-add-pages-btn'));
    const error = await screen.findByTestId('add-page-error');
    expect(error.getAttribute('role')).toBe('alert');
    expect(error.textContent).toContain(
      "Couldn't save the posting times — try again, your timezone and times are kept"
    );
    expect(error.textContent).not.toContain(
      "Couldn't add the selected pages."
    );
    // The schedule is kept for retry.
    expect(screen.getByText('Set posting times')).toBeTruthy();
    expect(
      (
        screen.getByTestId(
          'add-page-posting-time-input-0'
        ) as HTMLInputElement
      ).value
    ).toBe('09:00');
  });

  it('entering Step 3 focuses the timezone search and entering Step 4 focuses the first time input', async () => {
    render(
      <AddPageModal
        subdomain="acme"
        open={true}
        onOpenChange={vi.fn()}
        accounts={[activeAccount]}
        initialStep="select-timezone"
        initialSelectedAccount={activeAccount}
        initialDiscoveredPages={[]}
        initialSelectedPageIds={['fb_page_201']}
      />
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByTestId('add-page-timezone-search-input')
      )
    );

    fireEvent.click(
      screen.getByTestId('add-page-timezone-option-Asia/Karachi')
    );
    fireEvent.click(screen.getByTestId('continue-to-posting-times-btn'));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByTestId('add-page-posting-time-input-0')
      )
    );
  });

  it('going back to accounts and picking an account again keeps the timezone and posting times', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/pages/discover')) {
        return jsonResponse({
          accountId: activeAccount.id,
          accountDisplayName: activeAccount.displayName,
          pages: [
            {
              fbPageId: 'fb_page_201',
              pageName: 'Skynet AI Daily',
              profilePictureUrl: null,
              category: 'Automation',
              currentFollowers: 4300,
              followersCount: 4300,
              tasks: [],
              isImported: false,
            },
          ],
          total: 1,
        });
      }
      return jsonResponse({ success: true, importedCount: 0, pages: [] });
    });
    render(
      <AddPageModal
        subdomain="acme"
        open={true}
        onOpenChange={vi.fn()}
        accounts={[activeAccount]}
        initialStep="select-pages"
        initialSelectedAccount={activeAccount}
        initialDiscoveredPages={[
          {
            fbPageId: 'fb_page_201',
            pageName: 'Skynet AI Daily',
            profilePictureUrl: null,
            category: 'Automation',
            currentFollowers: 4300,
            isImported: false,
          },
        ]}
        initialSelectedPageIds={['fb_page_201']}
      />
    );

    fireEvent.click(screen.getByTestId('continue-to-timezone-btn'));
    fireEvent.click(
      await screen.findByTestId('add-page-timezone-option-Asia/Karachi')
    );
    fireEvent.click(screen.getByTestId('continue-to-posting-times-btn'));
    fireEvent.change(
      await screen.findByTestId('add-page-posting-time-input-0'),
      {
        target: { value: '17:30' },
      }
    );

    // Back to pages, then back to accounts, then pick the account
    // again: the page selection resets, the schedule does not.
    fireEvent.click(screen.getByTestId('back-to-timezone-btn'));
    fireEvent.click(screen.getByTestId('back-to-pages-btn'));
    fireEvent.click(screen.getByTestId('change-account-btn'));
    expect(screen.getByText('Select a Facebook Account')).toBeTruthy();
    fireEvent.click(
      screen.getByTestId(`select-account-${activeAccount.id}`)
    );
    await screen.findByText('Select Facebook Pages to Add');
    fireEvent.click(
      screen.getByTestId('discovered-page-checkbox-fb_page_201')
    );
    fireEvent.click(screen.getByTestId('continue-to-timezone-btn'));
    expect(
      screen.getByTestId('add-page-timezone-note').textContent
    ).toContain('Asia/Karachi');
    fireEvent.click(screen.getByTestId('continue-to-posting-times-btn'));
    expect(
      (
        screen.getByTestId(
          'add-page-posting-time-input-0'
        ) as HTMLInputElement
      ).value
    ).toBe('17:30');
  });

  it('Cancel closes and resets the schedule', async () => {
    const onOpenChange = vi.fn();
    render(
      <AddPageModal
        subdomain="acme"
        open={true}
        onOpenChange={onOpenChange}
        accounts={[activeAccount]}
        initialStep="select-posting-times"
        initialSelectedAccount={activeAccount}
        initialDiscoveredPages={[]}
        initialSelectedPageIds={['fb_page_201']}
        initialSelectedTimezone="Asia/Karachi"
      />
    );
    fireEvent.click(screen.getByTestId('cancel-add-pages-btn'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('Add another is disabled at 24 posting times', () => {
    const times = Array.from({ length: 24 }, (_, i) => ({
      slotTime: `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 === 0 ? '00' : '30'}`,
      allowedFormats: ['reel', 'image', 'video', 'story', 'text'],
    }));
    render(
      <AddPageModal
        subdomain="acme"
        open={true}
        onOpenChange={vi.fn()}
        accounts={[activeAccount]}
        initialStep="select-posting-times"
        initialSelectedAccount={activeAccount}
        initialDiscoveredPages={[]}
        initialSelectedPageIds={['fb_page_201']}
        initialSelectedTimezone="Asia/Karachi"
        initialPostingTimes={times}
      />
    );
    expect(
      screen.getByTestId('add-another-posting-time-btn') as HTMLButtonElement
    ).toBeTruthy();
    expect(
      (
        screen.getByTestId(
          'add-another-posting-time-btn'
        ) as HTMLButtonElement
      ).disabled
    ).toBe(true);
    expect(
      screen.getByTestId('add-page-posting-times-cap-note')
    ).toBeTruthy();
  });
});
