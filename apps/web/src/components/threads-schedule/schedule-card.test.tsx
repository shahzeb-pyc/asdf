/** @vitest-environment jsdom */
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ThreadsScheduleCard } from './schedule-card';
import type { ThreadsScheduleItem } from '@fbuploadpro/contracts';

vi.mock('next/image', () => ({
  default: (props: Record<string, unknown>) => {
    const { src, alt } = props as { src: string; alt: string };
    // Test double for next/image — a plain img is the point.
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={alt} />;
  },
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

function item(overrides: Partial<ThreadsScheduleItem> = {}): ThreadsScheduleItem {
  return {
    id: '33333333-3333-4333-a333-333333333333',
    accountId: '22222222-2222-4222-a222-222222222222',
    accountDisplayName: 'Test Account',
    threadsAccountId: 'threads-1',
    name: 'Test Threads',
    handle: 'testthreads',
    profilePictureUrl: null,
    accountLink: 'https://threads.com/@testthreads',
    timezone: 'UTC',
    status: 'active',
    queueCounts: { queued: 2, posted: 5, failed: 1 },
    addedAt: new Date('2026-01-01T00:00:00.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('ThreadsScheduleCard', () => {
  it('links to the detail page and shows name, handle, status and counts', () => {
    render(<ThreadsScheduleCard item={item()} subdomain="acme" />);
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe(
      '/tenant/acme/threads/schedule/33333333-3333-4333-a333-333333333333'
    );
    expect(screen.getByText('Test Threads')).toBeTruthy();
    expect(screen.getByText('@testthreads')).toBeTruthy();
    expect(screen.getByText('Active')).toBeTruthy();
    expect(screen.getByText('Queued 2 · Posted 5 · Failed 1')).toBeTruthy();
  });

  it('shows an expired account with the critical mark, never a bare dot', () => {
    render(<ThreadsScheduleCard item={item({ status: 'expired' })} subdomain="acme" />);
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Connection expired');
    expect(status.getAttribute('data-status')).toBe('critical');
  });

  it('shows dashes instead of counts when the counts failed to load', () => {
    render(
      <ThreadsScheduleCard
        item={item({ queueCountsError: true, queueCounts: { queued: 0, posted: 0, failed: 0 } })}
        subdomain="acme"
      />
    );
    expect(screen.getByText('Queued – · Posted – · Failed –')).toBeTruthy();
  });
});
