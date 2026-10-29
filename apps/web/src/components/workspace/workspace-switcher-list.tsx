'use client';

/**
 * Workspace switcher — popover content modules (spec 130 §5.3,
 * PR-130-2b): the user header and the workspace list, decomposed out
 * of the deleted 856-line `workspace-studio-footer.tsx` and rebuilt
 * on token-backed utilities. Content and order are §4.1-verbatim:
 * user header (monogram, name, email) → workspace list (active one
 * marked with a check) → Create Workspace.
 *
 * Failure presentation (spec §6 duty 2 — today these failures were
 * silent): a list-load failure shows the current workspace plus a
 * plain-language message and a Retry action in place; a switch
 * failure shows its message here and clears the switching state (the
 * composition owns both states and passes them in).
 */

import React from 'react';
import { Button } from '@/components/shared/ui/button';
import { cn } from '@/lib/utils';
import type { WorkspaceItem } from '@/lib/api/schemas/workspaces';
import { getUserInitials } from '@/lib/user-initials';

interface SwitcherUserHeaderProps {
  displayName: string;
  displayEmail: string;
  userInitials: string;
}

export function SwitcherUserHeader({
  displayName,
  displayEmail,
  userInitials,
}: Readonly<SwitcherUserHeaderProps>) {
  return (
    <div className="flex items-center gap-2 px-2 py-1">
      <div
        data-testid="workspace-user-avatar"
        className="flex size-7 shrink-0 items-center justify-center rounded-sm border border-line bg-subtle text-metadata font-semibold text-ink"
      >
        {userInitials}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-body font-semibold text-ink">{displayName}</span>
        <span className="truncate text-metadata text-ink-dim">{displayEmail}</span>
      </div>
    </div>
  );
}

export interface SwitcherWorkspaceListProps {
  workspaces: WorkspaceItem[];
  currentSubdomain: string;
  isSwitching: boolean;
  isLoadingList: boolean;
  listError: string | null;
  switchError: string | null;
  onSelectWorkspace: (subdomain: string) => void;
  onRetryList: () => void;
  onOpenCreate: () => void;
}

export function SwitcherWorkspaceList({
  workspaces,
  currentSubdomain,
  isSwitching,
  isLoadingList,
  listError,
  switchError,
  onSelectWorkspace,
  onRetryList,
  onOpenCreate,
}: Readonly<SwitcherWorkspaceListProps>) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="px-2 py-1 text-metadata font-semibold tracking-caption text-ink-dim uppercase">
        Workspaces
      </div>

      {listError && (
        <div role="alert" className="px-2 py-1 text-body text-ink-sub">
          <p>{listError}</p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-1"
            onClick={onRetryList}
            data-testid="workspace-list-retry"
          >
            Retry
          </Button>
        </div>
      )}

      {switchError && (
        <p role="alert" className="px-2 py-1 text-body text-brand-rose">
          {switchError}
        </p>
      )}

      {workspaces.map((ws) => {
        const isActive = ws.subdomain.toLowerCase() === currentSubdomain.toLowerCase();
        return (
          <button
            key={ws.id || ws.subdomain}
            type="button"
            role="menuitem"
            data-testid={`workspace-option-${ws.subdomain}`}
            onClick={() => onSelectWorkspace(ws.subdomain)}
            disabled={isSwitching}
            className={cn(
              'flex min-h-11 w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-ink outline-none transition-colors duration-base ease-standard hover:bg-hover focus-visible:outline-2 focus-visible:outline-link disabled:cursor-not-allowed',
              isActive && 'bg-active'
            )}
          >
            <div
              className={cn(
                'flex size-5 shrink-0 items-center justify-center rounded-xs text-metadata font-bold',
                isActive ? 'bg-primary text-on-primary' : 'bg-subtle text-ink'
              )}
            >
              {getUserInitials(ws.name || ws.subdomain)}
            </div>
            <span className="flex-1 truncate text-body">{ws.name || ws.subdomain}</span>
            {isActive && (
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                className="shrink-0 text-primary"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
          </button>
        );
      })}

      {isLoadingList && workspaces.length <= 1 && (
        <p className="px-2 py-1 text-metadata text-ink-dim">Loading workspaces…</p>
      )}

      <button
        type="button"
        data-testid="create-workspace-button"
        onClick={onOpenCreate}
        className="flex min-h-11 w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-body text-ink-sub outline-none transition-colors duration-base ease-standard hover:bg-hover focus-visible:outline-2 focus-visible:outline-link"
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
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        <span>Create Workspace</span>
      </button>
    </div>
  );
}
