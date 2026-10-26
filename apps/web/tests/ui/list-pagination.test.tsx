import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ListPagination } from '../../src/components/shared/ui/list-pagination';

describe('ListPagination', () => {
  it('renders nothing on a single page or zero items', () => {
    const { container } = render(
      <ListPagination
        page={1}
        totalPages={1}
        total={30}
        limit={30}
        onPageChange={() => {}}
      />
    );
    expect(container.querySelector('[data-testid="list-pagination"]')).toBeNull();
    const { container: empty } = render(
      <ListPagination
        page={1}
        totalPages={0}
        total={0}
        limit={30}
        onPageChange={() => {}}
      />
    );
    expect(empty.querySelector('[data-testid="list-pagination"]')).toBeNull();
  });

  it('disables Prev on page 1 and Next on the last page', () => {
    render(
      <ListPagination
        page={1}
        totalPages={3}
        total={65}
        limit={30}
        onPageChange={() => {}}
      />
    );
    expect(screen.getByTestId('pagination-prev')).toBeDisabled();
    expect(screen.getByTestId('pagination-next')).not.toBeDisabled();
    expect(screen.getByTestId('pagination-showing')).toHaveTextContent(
      'Showing 1–30 of 65'
    );
    expect(screen.getByRole('button', { name: 'Go to page 1' })).toHaveAttribute(
      'aria-current',
      'page'
    );
  });

  it('shows the last-page window and disables Next', async () => {
    const onPageChange = vi.fn();
    const user = userEvent.setup();
    render(
      <ListPagination
        page={3}
        totalPages={3}
        total={65}
        limit={30}
        onPageChange={onPageChange}
      />
    );
    expect(screen.getByTestId('pagination-next')).toBeDisabled();
    expect(screen.getByTestId('pagination-showing')).toHaveTextContent(
      'Showing 61–65 of 65'
    );
    await user.click(screen.getByTestId('pagination-prev'));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it('renders ellipsis for many pages and reports number clicks', async () => {
    const onPageChange = vi.fn();
    const user = userEvent.setup();
    render(
      <ListPagination
        page={5}
        totalPages={20}
        total={600}
        limit={30}
        onPageChange={onPageChange}
      />
    );
    expect(screen.getAllByTestId('pagination-ellipsis')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Go to page 6' }));
    expect(onPageChange).toHaveBeenCalledWith(6);
  });
});
