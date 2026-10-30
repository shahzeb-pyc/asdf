/**
 * useDebouncedValue (K9 — Pages search debounce): the debounced
 * value follows only after the delay, so a list query does not
 * refetch on every keystroke; clearing to '' applies immediately.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { useDebouncedValue } from '@/lib/use-debounced-value';

function Probe({ value }: { value: string }) {
  const debounced = useDebouncedValue(value);
  return <div data-testid="debounced-output">{debounced}</div>;
}

describe('useDebouncedValue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('holds the old value until the delay elapses, then follows', () => {
    const { rerender } = render(<Probe value="alp" />);
    expect(screen.getByTestId('debounced-output').textContent).toBe('alp');
    rerender(<Probe value="alpha" />);
    expect(screen.getByTestId('debounced-output').textContent).toBe('alp');
    act(() => {
      vi.advanceTimersByTime(249);
    });
    expect(screen.getByTestId('debounced-output').textContent).toBe('alp');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByTestId('debounced-output').textContent).toBe('alpha');
  });

  it('applies a clear immediately, without waiting out the delay', () => {
    const { rerender } = render(<Probe value="alpha" />);
    rerender(<Probe value="" />);
    expect(screen.getByTestId('debounced-output').textContent).toBe('');
  });

  it('restarts the delay on each keystroke', () => {
    const { rerender } = render(<Probe value="a" />);
    rerender(<Probe value="ab" />);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    rerender(<Probe value="abc" />);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByTestId('debounced-output').textContent).toBe('a');
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(screen.getByTestId('debounced-output').textContent).toBe('abc');
  });
});
