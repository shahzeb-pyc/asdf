'use client';

/**
 * Workspace switcher — actions list (spec 130 §5.3, PR-130-2b):
 * Settings, the Light Mode / Dark Mode toggle (the label names the
 * mode you switch TO, §4.1), and Sign Out — decomposed out of the
 * deleted `workspace-studio-footer.tsx`, rebuilt on token-backed
 * utilities. The signing-out state disables repeat activation and
 * carries its state in text (`Signing out...`), never colour alone.
 */

import React from 'react';
import { cn } from '@/lib/utils';

export interface SwitcherActionsListProps {
  currentSubdomain: string;
  isThemeDark: boolean;
  isSettingsActive: boolean;
  isSigningOut?: boolean;
  onOpenSettings: () => void;
  onToggleTheme: () => void;
  onSignOut: () => void;
}

const rowClassName =
  'flex min-h-11 w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-body text-ink outline-none transition-colors duration-base ease-standard hover:bg-hover focus-visible:outline-2 focus-visible:outline-link';

export function SwitcherActionsList({
  isThemeDark,
  isSettingsActive,
  isSigningOut = false,
  onOpenSettings,
  onToggleTheme,
  onSignOut,
}: Readonly<SwitcherActionsListProps>) {
  return (
    <div className="flex flex-col gap-0.5">
      <button
        type="button"
        role="menuitem"
        data-testid="workspace-settings-button"
        aria-current={isSettingsActive ? 'page' : undefined}
        onClick={onOpenSettings}
        className={cn(rowClassName, isSettingsActive && 'bg-active')}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
        <span>Settings</span>
      </button>

      <button
        type="button"
        role="menuitem"
        data-testid="theme-toggle-button"
        onClick={onToggleTheme}
        className={rowClassName}
      >
        {isThemeDark ? (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="5" />
            <line x1="12" y1="1" x2="12" y2="3" />
            <line x1="12" y1="21" x2="12" y2="23" />
            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
            <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
            <line x1="1" y1="12" x2="3" y2="12" />
            <line x1="21" y1="12" x2="23" y2="12" />
            <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
            <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
          </svg>
        ) : (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
        )}
        <span>{isThemeDark ? 'Light Mode' : 'Dark Mode'}</span>
      </button>

      <div aria-hidden="true" className="my-1 h-px bg-line" />

      <button
        type="button"
        role="menuitem"
        data-testid="logout-button"
        onClick={onSignOut}
        disabled={isSigningOut}
        aria-disabled={isSigningOut ? 'true' : undefined}
        className={cn(rowClassName, 'text-signal-critical hover:text-signal-critical-on-tint disabled:cursor-not-allowed disabled:opacity-60')}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
          <polyline points="16 17 21 12 16 7" />
          <line x1="21" y1="12" x2="9" y2="12" />
        </svg>
        <span>{isSigningOut ? 'Signing out...' : 'Sign Out'}</span>
      </button>
    </div>
  );
}
