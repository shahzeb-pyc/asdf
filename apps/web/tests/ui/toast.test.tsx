/**
 * @file toast.test.tsx
 * @description Behavioural tests for the shared Toast system: the Toaster
 * follows the app's own theme (documentElement `data-theme`, not
 * Sonner's light default and not the OS media query), and maps
 * Sonner's CSS variables to the app's semantic tokens — the fix for
 * white toasts in dark mode (a paused page's success toast rendered
 * white because Sonner defaulted to its light theme, whose
 * `--normal-bg` beat the `bg-panel` class). Success/error accent
 * slots keep their brand classes.
 */

import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { Toaster, toast } from '@/components/shared/ui/toast';

function setAppTheme(theme: 'light' | 'dark') {
  document.documentElement.dataset.theme = theme;
}

async function showSuccessToast() {
  act(() => {
    toast.success('Automation has been paused.');
  });
  return screen.findByText('Automation has been paused.');
}

function getToasterElement(): HTMLElement {
  const toastEl = document.querySelector('[data-sonner-toast]');
  expect(toastEl).not.toBeNull();
  const toaster = toastEl!.closest('[data-sonner-toaster]');
  expect(toaster).not.toBeNull();
  return toaster as HTMLElement;
}

describe('Shared Toast theme', () => {
  const originalTheme = document.documentElement.dataset.theme;

  beforeEach(() => {
    act(() => {
      toast.dismiss();
    });
  });

  afterEach(() => {
    act(() => {
      toast.dismiss();
    });
    if (originalTheme === undefined) {
      delete document.documentElement.dataset.theme;
    } else {
      document.documentElement.dataset.theme = originalTheme;
    }
  });

  it('renders dark Sonner theme when the app is in dark mode (no white toast)', async () => {
    setAppTheme('dark');
    render(<Toaster />);
    await showSuccessToast();
    expect(getToasterElement()).toHaveAttribute('data-sonner-theme', 'dark');
  });

  it('renders light Sonner theme when the app is in light mode', async () => {
    setAppTheme('light');
    render(<Toaster />);
    await showSuccessToast();
    expect(getToasterElement()).toHaveAttribute('data-sonner-theme', 'light');
  });

  it('follows a mid-session theme toggle', async () => {
    setAppTheme('dark');
    render(<Toaster />);
    await showSuccessToast();
    expect(getToasterElement()).toHaveAttribute('data-sonner-theme', 'dark');
    act(() => {
      setAppTheme('light');
    });
    await waitFor(() =>
      expect(getToasterElement()).toHaveAttribute('data-sonner-theme', 'light'),
    );
  });

  it('maps Sonner surface variables to the app panel tokens', async () => {
    setAppTheme('dark');
    render(<Toaster />);
    await showSuccessToast();
    const toasterStyle = getToasterElement().style;
    expect(toasterStyle.getPropertyValue('--normal-bg').trim()).toBe('var(--bg-panel)');
    expect(toasterStyle.getPropertyValue('--normal-text').trim()).toBe('var(--text-main)');
    expect(toasterStyle.getPropertyValue('--normal-border').trim()).toBe(
      'var(--border-subtle)',
    );
  });

  it('maps Sonner accent variables to the brand tokens', async () => {
    setAppTheme('dark');
    render(<Toaster />);
    await showSuccessToast();
    const toasterStyle = getToasterElement().style;
    expect(toasterStyle.getPropertyValue('--success-text').trim()).toBe(
      'var(--color-brand-emerald)',
    );
    expect(toasterStyle.getPropertyValue('--error-text').trim()).toBe(
      'var(--color-brand-rose)',
    );
    expect(toasterStyle.getPropertyValue('--warning-text').trim()).toBe(
      'var(--color-brand-gold)',
    );
  });

  it('keeps the success accent slot classes on a success toast', async () => {
    setAppTheme('dark');
    render(<Toaster />);
    const toastText = await showSuccessToast();
    const toastEl = toastText.closest('[data-sonner-toast]');
    expect(toastEl).not.toBeNull();
    expect(toastEl!.className).toContain('text-brand-emerald');
  });

  it('an explicit theme prop still wins over the app theme', async () => {
    setAppTheme('dark');
    render(<Toaster theme="light" />);
    await showSuccessToast();
    expect(getToasterElement()).toHaveAttribute('data-sonner-theme', 'light');
  });
});
