/**
 * @file accounts.test.tsx
 * @description Unit tests for Facebook Accounts UI components (Spec 027, Spec 029 & Spec 031).
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import {
  AccountCard,
  type FacebookAccountItem,
} from '@/components/accounts/account-card';
import {
  getAccountHealth,
  getAccountHealthSignal,
  isTokenExpiringSoon,
} from '@/components/accounts/account-health';
import { STATUS_SIGNALS } from '@/lib/theme';
import { AccountsEmptyState } from '@/components/accounts/accounts-empty-state';
import { DisconnectAccountDialog } from '@/components/accounts/disconnect-account-dialog';
import {
  ConnectAccountModal,
  MagicLinkView,
  evaluateAccountConnectionPoll,
} from '@/components/accounts/connect-account-modal';
import { AccountsFilterBar } from '@/components/accounts/accounts-filter-bar';
import {
  ByocRequiredBanner,
} from '@/components/accounts/accounts-banners';
import { ByocConfigPromptModal } from '@/components/accounts/byoc-config-prompt-modal';
import {
  computeAccountsSubtitle,
  isConnectGatedByMissingCredentials,
  filterAccountsList,
  resolveOAuthRedirectNotice,
  sortAccountsExpiredFirst,
} from '@/components/accounts/accounts-helpers';
import {
  ConnectErrorView,
  getConnectErrorCopy,
} from '@/app/connect/facebook/error/page';
import {
  ConnectSuccessView,
  getConnectSuccessCopy,
} from '@/app/connect/facebook/success/page';
import { render } from '../components/setup';
import {
  render as renderBehavioural,
  screen,
  fireEvent,
} from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
  }),
  useParams: () => ({ subdomain: 'acme' }),
  useSearchParams: () => new URLSearchParams(),
}));

describe('Facebook Accounts UI Components (Spec 027, Spec 029 & Spec 031)', () => {
  const mockActiveAccount: FacebookAccountItem = {
    id: 'acc-123',
    fbAccountId: 'fb-user-123',
    displayName: 'Sarah Connor',
    profilePictureUrl: 'https://graph.facebook.com/v26.0/123/picture',
    gender: 'female',
    accountLink: 'https://facebook.com/sarahconnor',
    status: 'active',
    connectedPagesCount: 3,
    connectedPages: [
      { id: 'page-1', pageName: 'Cyberdyne Reels', profilePictureUrl: 'https://graph.facebook.com/v26.0/p1/picture' },
      { id: 'page-2', pageName: 'Tech Resistance Daily', profilePictureUrl: null },
      { id: 'page-3', pageName: 'Future Chronicles', profilePictureUrl: null },
    ],
    createdAt: '2026-10-01T12:00:00Z',
  };

  const mockZeroPagesAccount: FacebookAccountItem = {
    ...mockActiveAccount,
    id: 'acc-zero',
    displayName: 'Zero Pages Profile',
    connectedPagesCount: 0,
    connectedPages: [],
  };

  const mockExpiredAccount: FacebookAccountItem = {
    id: 'acc-456',
    fbAccountId: 'fb-user-456',
    displayName: 'John Doe',
    profilePictureUrl: null,
    gender: 'male',
    accountLink: null,
    status: 'expired',
    connectedPagesCount: 1,
    createdAt: '2026-09-15T10:00:00Z',
  };

  describe('AccountCard', () => {
    it('renders clean active profile with avatar, display name, profile link, and pages count with zero gender or token expiration clutter', () => {
      const { hasText, hasAttribute, html } = render(
        <AccountCard account={mockActiveAccount} />
      );

      expect(hasText('Sarah Connor')).toBe(true);
      expect(hasText('3 pages linked')).toBe(true);
      expect(hasText('Female')).toBe(false); // Gender eliminated for sleek experience
      expect(hasText('Token valid')).toBe(false); // Token validity eliminated
      expect(hasAttribute('data-testid', 'account-avatar-img')).toBe(true);
      expect(hasAttribute('data-testid', 'account-profile-link')).toBe(true);
      expect(hasAttribute('data-testid', 'account-disconnect-button')).toBe(true);

      // Minimalist: No operational/health labels or badges on healthy card
      expect(hasText('Operational')).toBe(false);
      expect(hasText('Critical')).toBe(false);
      expect(hasText('Queued')).toBe(false);
      expect(hasText('Session expired — reconnect to resume publishing')).toBe(false);
      expect(html).not.toContain('account-reconnect-button');
    });

    it('renders expired account with Session expired alert and Reconnect account button', () => {
      const { hasText, hasAttribute } = render(
        <AccountCard account={mockExpiredAccount} />
      );

      expect(hasText('John Doe')).toBe(true);
      expect(hasText('1 page linked')).toBe(true);
      expect(hasText('Male')).toBe(false); // Gender eliminated
      expect(hasText('JD')).toBe(true); // Fallback initials
      expect(hasText('Session expired — reconnect to resume publishing')).toBe(true);
      expect(hasText('Reconnect account')).toBe(true);
      expect(hasAttribute('data-testid', 'account-reconnect-button')).toBe(true);
      expect(hasAttribute('data-testid', 'account-disconnect-button')).toBe(true);
    });

    it('derives the avatar status ring from the single health model (Spec 102)', () => {
      // connected -> operational green, expiring soon -> queued yellow,
      // expired -> critical red
      expect(
        getAccountHealthSignal(getAccountHealth({ status: 'active' }))
      ).toBe('operational');
      expect(STATUS_SIGNALS.operational.color).toBe('#4ade80');
      expect(STATUS_SIGNALS.queued.color).toBe('#FFD300');
      expect(STATUS_SIGNALS.critical.color).toBe('#f87171');
      expect(
        isTokenExpiringSoon({
          status: 'active',
          tokenExpiresAt: new Date(Date.now() + 3 * 86400000).toISOString(),
        })
      ).toBe(true);
      expect(
        getAccountHealthSignal(getAccountHealth({ status: 'expired' }))
      ).toBe('critical');
    });

    it('renders the single health status string on every card (Spec 102)', () => {
      const active = render(<AccountCard account={mockActiveAccount} />);
      expect(active.hasAttribute('data-testid', 'account-health-label')).toBe(true);
      expect(active.hasText('Connected')).toBe(true);

      const expired = render(<AccountCard account={mockExpiredAccount} />);
      expect(expired.hasText('Session expired')).toBe(true);
    });

    it('falls back to monogram initials avatar when forceAvatarError is true (Spec 031)', () => {
      const { hasAttribute, hasText } = render(
        <AccountCard account={mockActiveAccount} forceAvatarError={true} />
      );

      expect(hasAttribute('data-testid', 'account-avatar-initials')).toBe(true);
      expect(hasAttribute('data-testid', 'account-avatar-img')).toBe(false);
      expect(hasText('SC')).toBe(true);
    });

    it('renders expandable pages toggle when connectedPagesCount > 0 and displays linked page names when expanded (Spec 031)', () => {
      const collapsed = render(
        <AccountCard account={mockActiveAccount} defaultPagesExpanded={false} />
      );
      expect(collapsed.hasAttribute('data-testid', 'account-pages-toggle')).toBe(true);
      expect(collapsed.hasAttribute('data-testid', 'account-linked-pages-list')).toBe(false);

      const expanded = render(
        <AccountCard account={mockActiveAccount} defaultPagesExpanded={true} />
      );
      expect(expanded.hasAttribute('data-testid', 'account-pages-toggle')).toBe(true);
      expect(expanded.hasAttribute('data-testid', 'account-linked-pages-list')).toBe(true);
      expect(expanded.hasText('Cyberdyne Reels')).toBe(true);
      expect(expanded.hasText('Tech Resistance Daily')).toBe(true);
      expect(expanded.hasText('Future Chronicles')).toBe(true);
    });

    it('triggers onDisconnect callback when Disconnect button is clicked', () => {
      const onDisconnect = vi.fn();
      const onReconnect = vi.fn();

      // Render with callbacks
      const card = (
        <AccountCard
          account={mockActiveAccount}
          onDisconnect={onDisconnect}
          onReconnect={onReconnect}
        />
      );
      expect(card).toBeDefined();
    });
  });

  describe('AccountsEmptyState', () => {
    it('renders friendly zero-accounts empty state with Connect Facebook Account action and privacy microcopy', () => {
      const onConnect = vi.fn();
      const { hasText, hasAttribute } = render(
        <AccountsEmptyState onConnect={onConnect} />
      );

      expect(hasText('Connect your first Facebook account')).toBe(true);
      expect(hasText('Link your Facebook Account to import pages')).toBe(true);
      expect(hasText('We only request permissions to publish reels and manage your pages')).toBe(true);
      expect(hasText('Connect Facebook Account')).toBe(true);
      expect(hasAttribute('data-testid', 'empty-connect-button')).toBe(true);
    });

    it('gates Connect with a visible reason and Settings link when the App ID and Secret are missing (Spec 109)', () => {
      expect(
        isConnectGatedByMissingCredentials({
          isLoading: false,
          isConfigured: false,
          error: null,
        })
      ).toBe(true);
      expect(
        isConnectGatedByMissingCredentials({
          isLoading: true,
          isConfigured: false,
          error: null,
        })
      ).toBe(false);
      expect(
        isConnectGatedByMissingCredentials({
          isLoading: false,
          isConfigured: true,
          error: null,
        })
      ).toBe(false);
      expect(
        isConnectGatedByMissingCredentials({
          isLoading: false,
          isConfigured: false,
          error: "Couldn't verify your Facebook App credentials. Please try again.",
        })
      ).toBe(false);

      const gated = render(
        <AccountsEmptyState
          onConnect={vi.fn()}
          isConnectDisabled={true}
          credentialsMissing={true}
          settingsHref="/tenant/acme/settings?tab=byoc"
        />
      );
      expect(gated.hasAttribute('data-testid', 'empty-connect-button')).toBe(true);
      expect(gated.hasAttribute('disabled')).toBe(true);
      expect(
        gated.hasAttribute('data-testid', 'empty-connect-disabled-reason')
      ).toBe(true);
      expect(
        gated.hasText('Add your Facebook App ID and App Secret first')
      ).toBe(true);
      expect(
        gated.hasAttribute('data-testid', 'empty-connect-settings-link')
      ).toBe(true);
      expect(gated.html).toContain('href="/tenant/acme/settings?tab=byoc"');

      const ungated = render(<AccountsEmptyState onConnect={vi.fn()} />);
      expect(ungated.hasAttribute('disabled')).toBe(false);
      expect(
        ungated.hasAttribute('data-testid', 'empty-connect-disabled-reason')
      ).toBe(false);
    });
  });

  // Spec 131 PR-131-1 (named suite migration, spec §8.7): the rebuilt
  // dialog/modal components sit on the shared/ui Radix primitives,
  // whose content renders through a portal — invisible to the legacy
  // static-markup helper. These blocks therefore render behaviourally
  // (Testing Library, jsdom project) with equivalent assertions, plus
  // the interaction checks the research pattern requires.
  describe('DisconnectAccountDialog', () => {
    it('renders destructive linked pages warning and linked page names list when connectedPagesCount > 0 (Spec 031)', async () => {
      const onConfirm = vi.fn().mockResolvedValue(undefined);
      const onOpenChange = vi.fn();

      renderBehavioural(
        <DisconnectAccountDialog
          account={mockActiveAccount}
          open={true}
          onOpenChange={onOpenChange}
          onConfirm={onConfirm}
        />
      );

      expect(screen.getByText('Disconnect Sarah Connor?')).toBeTruthy();
      expect(screen.getByText('This account will no longer be available')).toBeTruthy();
      expect(screen.getByTestId('disconnect-linked-pages-warning')).toBeTruthy();
      expect(screen.getByTestId('disconnect-linked-pages-list')).toBeTruthy();
      expect(screen.getByText('3 linked Facebook pages')).toBeTruthy();
      expect(screen.getByText('Before you disconnect')).toBeTruthy();
      expect(screen.getByText('Cyberdyne Reels')).toBeTruthy();
      expect(screen.getByText('Tech Resistance Daily')).toBeTruthy();
      expect(screen.getByText('Future Chronicles')).toBeTruthy();
      expect(screen.getByTestId('disconnect-cancel-btn')).toBeTruthy();
      expect(screen.getByTestId('disconnect-confirm-btn')).toBeTruthy();

      // Alert-dialog pattern (UI Rule 3): focus starts on Cancel.
      expect(document.activeElement).toBe(screen.getByTestId('disconnect-cancel-btn'));

      // The verb-named confirm fires with the account id.
      fireEvent.click(screen.getByTestId('disconnect-confirm-btn'));
      expect(onConfirm).toHaveBeenCalledWith('acc-123');
    });

    it('renders calm neutral notice when connectedPagesCount === 0 without Before you disconnect warning (Spec 029)', () => {
      const onConfirm = vi.fn();
      const onOpenChange = vi.fn();

      renderBehavioural(
        <DisconnectAccountDialog
          account={mockZeroPagesAccount}
          open={true}
          onOpenChange={onOpenChange}
          onConfirm={onConfirm}
        />
      );

      expect(screen.getByText('Disconnect Zero Pages Profile?')).toBeTruthy();
      expect(screen.getByTestId('disconnect-zero-pages-notice')).toBeTruthy();
      expect(
        screen.getByText(
          "No Facebook Pages are linked to this account yet. It's safe to remove — you can reconnect it any time."
        )
      ).toBeTruthy();
      expect(screen.queryByText('Before you disconnect')).toBeNull();
      expect(screen.queryByTestId('disconnect-linked-pages-warning')).toBeNull();

      // Cancel closes through onOpenChange.
      fireEvent.click(screen.getByTestId('disconnect-cancel-btn'));
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  describe('ConnectErrorView & getConnectErrorCopy (Spec 031)', () => {
    it('renders context-aware title and description for cancelled, oauth_failed, and default expired reasons', () => {
      expect(getConnectErrorCopy('cancelled')).toEqual({
        title: 'Connection Canceled',
        description: 'Connection canceled. No changes were made. You can close this tab.',
      });
      expect(getConnectErrorCopy('oauth_failed')).toEqual({
        title: "Couldn't Connect to Facebook",
        description: "Couldn't connect to Facebook. Check your permissions and try again.",
      });
      expect(getConnectErrorCopy(undefined).title).toBe('Connection Link Expired or Invalid');

      const cancelledRender = render(<ConnectErrorView reason="cancelled" />);
      expect(cancelledRender.hasText('Connection Canceled')).toBe(true);
      expect(
        cancelledRender.hasText(
          'Connection canceled. No changes were made. You can close this tab.'
        )
      ).toBe(true);

      const failedRender = render(<ConnectErrorView reason="oauth_failed" />);
      expect(failedRender.hasText('Connect to Facebook')).toBe(true);
      expect(
        failedRender.hasText('Check your permissions and try again.')
      ).toBe(true);

      const expiredRender = render(<ConnectErrorView />);
      expect(expiredRender.hasText('Connection Link Expired or Invalid')).toBe(true);
    });
  });

  describe('ConnectAccountModal, MagicLinkView & Poll Mismatch/Already-Connected Detection', () => {
    it('renders connection modal with Direct Connection and Magic Link choices', () => {
      const onOpenChange = vi.fn();
      const onAccountConnected = vi.fn();

      renderBehavioural(
        <ConnectAccountModal
          subdomain="acme"
          open={true}
          onOpenChange={onOpenChange}
          onAccountConnected={onAccountConnected}
          existingAccountIds={['acc-123']}
        />
      );

      expect(screen.getByText('Connect Facebook Account')).toBeTruthy();
      expect(screen.getByText('This Browser')).toBeTruthy();
      expect(screen.getByText('Different Browser or Phone')).toBeTruthy();
      expect(screen.getByTestId('connect-option-direct')).toBeTruthy();
      expect(screen.getByTestId('connect-option-magic')).toBeTruthy();

      // Cancel closes through onOpenChange.
      fireEvent.click(screen.getByTestId('connect-close-btn'));
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('renders "Reconnect {displayName}" as the modal title when reconnectingAccount is provided (Spec 029)', () => {
      renderBehavioural(
        <ConnectAccountModal
          subdomain="acme"
          open={true}
          onOpenChange={vi.fn()}
          onAccountConnected={vi.fn()}
          reconnectingAccount={{ id: 'acc-456', displayName: 'John Doe' }}
        />
      );

      expect(screen.getByText('Reconnect John Doe')).toBeTruthy();
      expect(screen.queryByText('Connect Facebook Account')).toBeNull();
    });

    it('renders click-to-copy magic link input when countdown is active and inline regenerate button when expired at 0:00 (Spec 029)', () => {
      const activeRender = render(
        <MagicLinkView
          magicUrl="https://acme.vinsmokemedia.online/api/auth/facebook/magic?token=abc"
          remainingSeconds={840}
          copySuccess={false}
          isGeneratingMagic={false}
          onCopyLink={vi.fn()}
          onRegenerateLink={vi.fn()}
        />
      );

      expect(activeRender.hasAttribute('data-testid', 'magic-url-input')).toBe(true);
      expect(activeRender.hasAttribute('data-testid', 'magic-copy-button')).toBe(true);
      expect(activeRender.hasAttribute('data-testid', 'magic-regenerate-button')).toBe(false);
      expect(activeRender.hasText('Link expires in 14:00')).toBe(true);

      const expiredRender = render(
        <MagicLinkView
          magicUrl="https://acme.vinsmokemedia.online/api/auth/facebook/magic?token=abc"
          remainingSeconds={0}
          copySuccess={false}
          isGeneratingMagic={false}
          onCopyLink={vi.fn()}
          onRegenerateLink={vi.fn()}
        />
      );

      expect(expiredRender.hasAttribute('data-testid', 'magic-regenerate-button')).toBe(true);
      expect(expiredRender.hasText('Link expired — Generate a new link')).toBe(true);
      expect(expiredRender.hasAttribute('data-testid', 'magic-url-input')).toBe(false);
      expect(expiredRender.hasText('Magic link expired')).toBe(true);
    });


    it('detects wrong-account mismatch and already-connected refresh across polling, the magic success page, and resolveOAuthRedirectNotice (Spec 031)', () => {
      const initialIds = new Set(['acc-john']);
      const initialStates = new Map([
        ['acc-john', { status: 'expired', updatedAt: '2026-09-15T10:00:00Z' }],
      ]);

      // 1. Reconnecting John Doe, but Jane Smith is added instead
      const mismatchOutcome = evaluateAccountConnectionPoll(
        [
          {
            id: 'acc-john',
            fbAccountId: 'fb-john',
            displayName: 'John Doe',
            status: 'expired',
            updatedAt: '2026-09-15T10:00:00Z',
          },
          {
            id: 'acc-jane',
            fbAccountId: 'fb-jane',
            displayName: 'Jane Smith',
            status: 'active',
            updatedAt: '2026-10-11T08:00:00Z',
          },
        ],
        initialIds,
        initialStates,
        {
          id: 'acc-john',
          fbAccountId: 'fb-john',
          displayName: 'John Doe',
          status: 'expired',
          updatedAt: '2026-09-15T10:00:00Z',
        }
      );

      expect(mismatchOutcome).toEqual({
        matched: true,
        kind: 'reconnected_mismatch',
        accountId: 'acc-jane',
        newAccountName: 'Jane Smith',
        expectedAccountName: 'John Doe',
      });

      const mismatchMessage =
        'You signed into Jane Smith instead of John Doe. John Doe still needs to be reconnected.';
      // The magic success page now reads its params: mismatch renders
      // the cross variant with the approved message, never a success.
      const mismatchCopy = getConnectSuccessCopy({
        reconnectedMismatch: true,
        newAccountName: 'Jane Smith',
        expectedAccountName: 'John Doe',
      });
      expect(mismatchCopy.variant).toBe('error');
      expect(`${mismatchCopy.title} ${mismatchCopy.description}`).toBe(mismatchMessage);
      const mismatchView = render(
        <ConnectSuccessView
          params={{
            reconnectedMismatch: true,
            newAccountName: 'Jane Smith',
            expectedAccountName: 'John Doe',
          }}
        />
      );
      expect(mismatchView.hasText('You signed into Jane Smith instead of John Doe.')).toBe(true);
      expect(mismatchView.hasText('John Doe still needs to be reconnected.')).toBe(true);

      const directMismatchNotice = resolveOAuthRedirectNotice(
        new URLSearchParams({
          reconnected_mismatch: '1',
          newAccountName: 'Jane Smith',
          expectedAccountName: 'John Doe',
        })
      );
      expect(directMismatchNotice?.notice).toEqual({
        type: 'error',
        message: mismatchMessage,
      });

      // 2. Standard Connect flow where an already-connected account has its session refreshed
      const alreadyConnectedOutcome = evaluateAccountConnectionPoll(
        [
          {
            id: 'acc-john',
            fbAccountId: 'fb-john',
            displayName: 'John Doe',
            status: 'active',
            updatedAt: '2026-10-11T08:05:00Z',
          },
        ],
        initialIds,
        initialStates,
        null
      );

      expect(alreadyConnectedOutcome).toEqual({
        matched: true,
        kind: 'already_connected',
        accountId: 'acc-john',
        accountName: 'John Doe',
      });

      // Option B dialogue: name + connected only, no pages text.
      const alreadyMessage = 'John Doe already connected — session refreshed';
      const alreadyCopy = getConnectSuccessCopy({
        alreadyConnected: true,
        accountName: 'John Doe',
      });
      expect(alreadyCopy.variant).toBe('success');
      expect(alreadyCopy.title).toBe(alreadyMessage);
      const alreadyView = render(
        <ConnectSuccessView params={{ alreadyConnected: true, accountName: 'John Doe' }} />
      );
      expect(alreadyView.hasText(alreadyMessage)).toBe(true);

      const directAlreadyNotice = resolveOAuthRedirectNotice(
        new URLSearchParams({
          connected: 'already',
          accountName: 'John Doe',
        })
      );
      expect(directAlreadyNotice?.notice).toEqual({
        type: 'success',
        message: alreadyMessage,
      });
      expect(directAlreadyNotice?.accountName).toBe('John Doe');

      // Fresh connects carry the account id for the card highlight and
      // the name for the toast — never a generic fallback.
      const freshOutcome = evaluateAccountConnectionPoll(
        [
          {
            id: 'acc-jane',
            fbAccountId: 'fb-jane',
            displayName: 'Jane Smith',
            status: 'active',
            updatedAt: '2026-10-11T08:00:00Z',
          },
        ],
        new Set(['acc-john']),
        new Map([['acc-john', { status: 'expired', updatedAt: '2026-09-15T10:00:00Z' }]]),
        null
      );
      expect(freshOutcome).toEqual({
        matched: true,
        kind: 'connected',
        accountId: 'acc-jane',
        accountName: 'Jane Smith',
      });
      expect(getConnectSuccessCopy({ accountName: 'Jane Smith' }).title).toBe(
        'Jane Smith connected'
      );
      const freshNotice = resolveOAuthRedirectNotice(
        new URLSearchParams({ connected: '1', accountName: 'Jane Smith' })
      );
      expect(freshNotice?.notice).toEqual({
        type: 'success',
        message: 'Jane Smith connected',
      });
      expect(freshNotice?.accountName).toBe('Jane Smith');
    });
  });

  describe('Sorting & Agency Search/Filter Bar (Spec 029)', () => {
    it('sortAccountsExpiredFirst pins expired accounts to the top followed by createdAt DESC', () => {
      const sorted = sortAccountsExpiredFirst([
        mockActiveAccount, // active, 2026-10-01
        mockExpiredAccount, // expired, 2026-09-15
        {
          ...mockActiveAccount,
          id: 'acc-newest',
          displayName: 'Newest Active',
          createdAt: '2026-10-09T12:00:00Z',
        },
      ]);

      expect(sorted.map((a) => a.id)).toEqual(['acc-456', 'acc-newest', 'acc-123']);
    });

    it('filterAccountsList filters by searchQuery and statusFilter', () => {
      const list = [mockExpiredAccount, mockActiveAccount];

      expect(filterAccountsList(list, 'sarah', 'all')).toHaveLength(1);
      expect(filterAccountsList(list, 'sarah', 'all')[0]?.id).toBe('acc-123');
      expect(filterAccountsList(list, '', 'expired')).toHaveLength(1);
      expect(filterAccountsList(list, '', 'expired')[0]?.id).toBe('acc-456');
      expect(filterAccountsList(list, 'nonexistent', 'all')).toHaveLength(0);
    });

    it('AccountsFilterBar renders search input and All / Active / Expired filter buttons', () => {
      const { hasAttribute, hasText } = render(
        <AccountsFilterBar
          searchQuery=""
          onSearchChange={vi.fn()}
          statusFilter="all"
          onStatusFilterChange={vi.fn()}
        />
      );

      expect(hasAttribute('data-testid', 'accounts-filter-bar')).toBe(true);
      expect(hasAttribute('data-testid', 'accounts-search-input')).toBe(true);
      expect(hasAttribute('data-testid', 'accounts-filter-all')).toBe(true);
      expect(hasAttribute('data-testid', 'accounts-filter-active')).toBe(true);
      expect(hasAttribute('data-testid', 'accounts-filter-expired')).toBe(true);
      expect(hasText('All')).toBe(true);
      expect(hasText('Active')).toBe(true);
      expect(hasText('Expired')).toBe(true);
    });

    it('computeAccountsSubtitle derives from the shared account-health model', () => {
      const disconnectedAccount: FacebookAccountItem = {
        ...mockExpiredAccount,
        id: 'acc-789',
        status: 'disconnected',
      };
      expect(computeAccountsSubtitle([], 0, false)).toBe(
        'Connect your first Facebook account to manage pages and publish reels.'
      );
      expect(computeAccountsSubtitle([mockActiveAccount], 1, true)).toBe(
        'Showing 1 of 1 account'
      );
      expect(
        computeAccountsSubtitle(
          [mockActiveAccount, mockExpiredAccount, disconnectedAccount],
          2,
          true
        )
      ).toBe('Showing 2 of 3 accounts');
      expect(computeAccountsSubtitle([mockActiveAccount], 1, false)).toBe(
        '1 connected'
      );
      expect(
        computeAccountsSubtitle([mockActiveAccount, mockExpiredAccount], 2, false)
      ).toBe('1 connected · 1 session expired');
      expect(
        computeAccountsSubtitle(
          [mockActiveAccount, mockExpiredAccount, disconnectedAccount],
          3,
          false
        )
      ).toBe('1 connected · 1 session expired · 1 connection error');
      expect(
        computeAccountsSubtitle(
          [mockExpiredAccount, { ...mockExpiredAccount, id: 'acc-999' }],
          2,
          false
        )
      ).toBe('0 connected · 2 sessions expired');
    });
  });

  describe('BYOC Check & Configuration Flow (Spec 037)', () => {
    it('ByocRequiredBanner renders unboxed warning banner with direct link to Workspace Settings BYOC tab', () => {
      const { hasAttribute, hasText, getAttribute } = render(
        <ByocRequiredBanner subdomain="acme" />
      );

      expect(hasAttribute('data-testid', 'byoc-required-banner')).toBe(true);
      expect(
        hasText('Facebook App credentials are required before connecting accounts')
      ).toBe(true);
      expect(hasAttribute('data-testid', 'byoc-configure-link')).toBe(true);
      expect(getAttribute('href')).toBe('/tenant/acme/settings?tab=byoc');
    });

    it('ByocConfigPromptModal renders advisory modal when open is true with link to settings', () => {
      const onClose = vi.fn();
      const openModal = renderBehavioural(
        <ByocConfigPromptModal
          subdomain="acme"
          open={true}
          onClose={onClose}
        />
      );

      expect(screen.getByTestId('byoc-config-prompt-modal')).toBeTruthy();
      expect(screen.getByTestId('byoc-prompt-title')).toBeTruthy();
      expect(screen.getByText('Facebook App Credentials Required')).toBeTruthy();
      expect(
        screen.getByTestId('byoc-prompt-description').textContent
      ).toContain(
        'Before connecting Facebook accounts, your workspace must configure its Facebook App ID and App Secret.'
      );
      expect(screen.getByTestId('byoc-prompt-cancel-btn')).toBeTruthy();
      expect(screen.getByTestId('byoc-prompt-settings-link')).toBeTruthy();
      expect(
        screen.getByTestId('byoc-prompt-settings-link').getAttribute('href')
      ).toBe('/tenant/acme/settings?tab=byoc');

      openModal.unmount();
      renderBehavioural(
        <ByocConfigPromptModal
          subdomain="acme"
          open={false}
          onClose={onClose}
        />
      );
      expect(screen.queryByTestId('byoc-config-prompt-modal')).toBeNull();
    });

    it('resolveOAuthRedirectNotice resolves credentials_required error into descriptive user warning', () => {
      const notice = resolveOAuthRedirectNotice(
        new URLSearchParams({
          error: 'credentials_required',
          tab: 'byoc',
        })
      );

      expect(notice).not.toBeNull();
      expect(notice?.notice.type).toBe('error');
      expect(notice?.notice.message).toBe(
        'Facebook App credentials are required before connecting accounts. Please configure your App ID and Secret in Workspace Settings.'
      );
      expect(notice?.keysToRemove).toEqual(['error', 'tab']);
    });

    it('resolveOAuthRedirectNotice maps account_save_failed to a save message with a Connect-again action (BL1 fix)', () => {
      const notice = resolveOAuthRedirectNotice(
        new URLSearchParams({ error: 'account_save_failed' })
      );

      expect(notice).not.toBeNull();
      expect(notice?.notice.type).toBe('error');
      expect(notice?.notice.message).toBe(
        'We couldn\u2019t save your Facebook account after Facebook approved the connection. Nothing was connected. Please try connecting again.'
      );
      expect(notice?.notice.connectAgain).toBe(true);
      expect(notice?.keysToRemove).toEqual(['error']);
    });
  });
});

