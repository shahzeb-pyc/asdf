'use client';

/**
 * Facebook tab — container (spec 135 PR-135-2, spec §5.2 / §6.2 / §8.1).
 *
 * Replaces the 1,268-line `byoc-settings-view.tsx` (deleted in this
 * PR) with the §8.1 decomposition: this container owns the data and
 * the state machine (loading / load error / not-connected /
 * connected / edit, plus the disconnect dialog's open state); the
 * form, the connected view, the "One more step" card, and the
 * disconnect dialog are the sibling modules in this folder.
 *
 * Data (spec §6.2): the BYOC payload arrives server-first through
 * the settings route's dehydration (`queryKeys.settings.byoc`) and
 * is read/refetched here with React Query over the typed API client,
 * validated by `ByocSettingsResponseSchema` — no raw fetch, no
 * fetch-on-mount for initial data. The legacy `initial*` test-seam
 * props are deleted with the old file; tests seed through the query
 * client / fetch mocks. The payload is masked-by-default (spec 139
 * N3): it carries a secret hint, never the secret — the value is
 * fetched on demand by the reveal action when the user chooses Show.
 *
 * Mutations and invalidation (named per spec §6.2): connect (PUT)
 * and disconnect (DELETE) both invalidate `queryKeys.settings.byoc`
 * on success, so the tab re-reads the saved state and lands on the
 * state the server reports — connect ends on the connected view,
 * disconnect ends on the not-connected form (UI Rule 26).
 *
 * Outcomes follow the interruption ladder (UI Rule 2): validation
 * and server save/test failures at form scope (§6.3), operation
 * outcomes and network failures as toasts from the single shared/ui
 * Toast system (the hand-rolled toast is deleted), the reconnect
 * notice as a persistent Banner, and the destructive decision as an
 * AlertDialog. §5.2's sentences are verbatim throughout, including
 * the fixed network-failure sentences.
 */

import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, buildTenantApiPath, getErrorMessage, isApiError } from '@/lib/api';
import {
  ByocSettingsResponseSchema,
  DeleteByocResponseSchema,
  RevealByocSecretResponseSchema,
  SaveCredentialsResponseSchema,
  type ByocSettingsResponse,
} from '@/lib/api/schemas/settings';
import { queryKeys } from '@/lib/data/query-keys';
import { Banner } from '@/components/shared/ui/banner';
import { Button } from '@/components/shared/ui/button';
import { Skeleton } from '@/components/shared/ui/skeleton';
import { FacebookStatusMark } from './facebook-status-mark';
import { FacebookPrivacyUrlRow } from './facebook-privacy-url-row';
import { getWorkspacePrivacyUrl } from './facebook-privacy-url';
import { toast } from '@/components/shared/ui/toast';

import {
  FacebookConnectForm,
  type FacebookConnectPayload,
} from './facebook-connect-form';
import { FacebookConnectedView } from './facebook-connected-view';
import { FacebookDisconnectDialog } from './facebook-disconnect-dialog';
import { FacebookSetupCard } from './facebook-setup-card';

const SAVE_FAILURE_MESSAGE = "Couldn't save your Facebook app details. Please try again.";
const DISCONNECT_FAILURE_MESSAGE = "Couldn't disconnect Facebook. Please try again.";
const CONNECT_NETWORK_MESSAGE = 'Could not connect Facebook. Check your connection and try again.';
const DISCONNECT_NETWORK_MESSAGE = 'Could not disconnect Facebook. Try again.';

export interface FacebookSettingsViewProps {
  subdomain: string;
}

function isNetworkFailure(error: unknown): boolean {
  return isApiError(error) && error.kind === 'network';
}

/** Loading state: a Skeleton at the card's final geometry; the
 *  shipped loading text is preserved as the accessible name (§5.2). */
function FacebookSettingsLoading() {
  return (
    <div
      data-testid="byoc-loading"
      aria-busy="true"
      aria-label="Loading your Facebook app details…"
      className="flex w-full max-w-3xl flex-col gap-6"
    >
      <span className="sr-only">Loading your Facebook app details…</span>
      <div className="flex flex-col gap-6 rounded-md border border-line bg-panel p-6">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-6 w-44" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
        <Skeleton className="h-4 w-56" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-11 w-36" />
      </div>
    </div>
  );
}

export function FacebookSettingsView({ subdomain }: Readonly<FacebookSettingsViewProps>) {
  const queryClient = useQueryClient();
  const tenant = queryKeys.tenant(subdomain);
  const byocPath = buildTenantApiPath(subdomain, '/settings/byoc');

  const searchParams = useSearchParams();
  const showReconnectNotice = searchParams.get('notice') === 'reconnect';

  const [isEditMode, setIsEditMode] = React.useState(false);
  const [disconnectOpen, setDisconnectOpen] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);

  const byocQuery = useQuery({
    queryKey: tenant.settings.byoc,
    queryFn: ({ signal }) =>
      api.get(byocPath, { schema: ByocSettingsResponseSchema, signal }),
  });

  const connectMutation = useMutation({
    mutationFn: (payload: FacebookConnectPayload) =>
      api.put(byocPath, payload, { schema: SaveCredentialsResponseSchema }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: tenant.settings.byoc });
      setIsEditMode(false);
      toast.success('Your Facebook app is connected.');
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: () => api.delete(byocPath, { schema: DeleteByocResponseSchema }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: tenant.settings.byoc });
      setDisconnectOpen(false);
      setIsEditMode(false);
      toast.success('Your Facebook app has been disconnected.');
    },
  });

  const handleConnect = async (payload: FacebookConnectPayload): Promise<void> => {
    setServerError(null);
    try {
      await connectMutation.mutateAsync(payload);
    } catch (error) {
      if (isNetworkFailure(error)) {
        // §5.2's fixed sentence — a network failure never borrows a
        // server message, so the two failure paths stay distinct.
        toast.error(CONNECT_NETWORK_MESSAGE);
      } else if (isApiError(error) && error.kind === 'http') {
        // The server's own plain-language message takes precedence,
        // at form scope (spec §6.3); the fixed §5.2 sentence is the
        // fallback when the server returned none.
        setServerError(getErrorMessage(error, SAVE_FAILURE_MESSAGE));
      } else {
        setServerError(SAVE_FAILURE_MESSAGE);
      }
      throw error;
    }
  };

  // Spec 139 N3: the GET payload is masked-by-default — the secret
  // itself is fetched only when the user chooses Show, through the
  // dedicated reveal action. The connected view owns the reveal's
  // loading/error states; this callback is the data path.
  const handleRevealSecret = React.useCallback(async (): Promise<string> => {
    const result = await api.post(`${byocPath}/reveal`, {}, {
      schema: RevealByocSecretResponseSchema,
    });
    return result.fbAppSecret;
  }, [byocPath]);

  const handleDisconnect = async (): Promise<void> => {
    try {
      await disconnectMutation.mutateAsync();
    } catch (error) {
      // Fully handled here: the failure is toasted and the dialog
      // stays open (the container closes it only on success). Nothing
      // awaits this handler's rejection — the dialog fires it and
      // forgets — so it must not rethrow.
      toast.error(
        isNetworkFailure(error) ? DISCONNECT_NETWORK_MESSAGE : DISCONNECT_FAILURE_MESSAGE
      );
    }
  };

  if (byocQuery.isPending && !byocQuery.data) {
    return <FacebookSettingsLoading />;
  }

  const credentials: ByocSettingsResponse | undefined = byocQuery.data;

  if (!credentials) {
    // Load failure is a state, not a silent fall-through to the form:
    // the ladder's error rung, with the recovery action in place.
    return (
      <div className="flex w-full max-w-3xl flex-col gap-6">
        <Banner
          variant="critical"
          title="Couldn't load your Facebook app details. Please try again."
          action={
            <Button
              type="button"
              variant="secondary"
              data-testid="fb-load-retry-btn"
              onClick={() => void byocQuery.refetch()}
            >
              Try again
            </Button>
          }
        />
      </div>
    );
  }

  const hasSavedCredentials = Boolean(credentials.fbAppId && credentials.hasSecret);
  const isConnectedState = hasSavedCredentials && !isEditMode;

  // Single-column layout (2026-10-25 correction to the two-column
  // redesign): heading + description + status stacked on TOP, panels
  // below at full content width — no left column with cards on the
  // right at any width. The status mark reflects the saved
  // credentials, not the edit mode — while editing, the app is still
  // connected (mockup screen 3), even though the form is showing. The
  // description follows the mockup per state: edit mode gets its own
  // line; every other state keeps the §5.2 sentences verbatim.
  const headerDescription = isEditMode
    ? 'Edit your saved Facebook app details.'
    : isConnectedState
      ? 'Your Facebook app is connected and ready to publish.'
      : 'Link your Facebook app to start publishing from this workspace.';

  return (
    <div className="flex w-full max-w-4xl flex-col gap-6">
      {showReconnectNotice && (
        <Banner
          variant="warning"
          data-testid="byoc-reconnect-notice"
          title="To reconnect accounts, add your App ID and App Secret below, then reconnect."
        />
      )}

      <div>
        <h2 id="facebook-settings-heading" className="text-lg font-semibold text-ink">
          Facebook App
        </h2>
        <p className="mt-1 text-body text-ink-sub">{headerDescription}</p>
        <div data-testid="facebook-status-badge" className="mt-3">
          <FacebookStatusMark connected={hasSavedCredentials} />
        </div>
      </div>

      <section
        data-testid="facebook-settings-card"
        aria-labelledby="facebook-settings-heading"
        className="flex flex-col gap-6 rounded-md border border-line bg-panel p-6 shadow-card"
      >
        {isConnectedState ? (
          <FacebookConnectedView
            fbAppId={credentials.fbAppId}
            connectedAt={credentials.connectedAt}
            onRevealSecret={handleRevealSecret}
            onEditDetails={() => {
              setServerError(null);
              setIsEditMode(true);
            }}
            onDisconnectClick={() => setDisconnectOpen(true)}
          />
        ) : (
          <FacebookConnectForm
            key={isEditMode ? 'edit' : 'connect'}
            initialAppId={credentials.fbAppId}
            hasExistingSecret={credentials.hasSecret}
            isEditMode={isEditMode}
            isConnecting={connectMutation.isPending}
            serverError={serverError}
            onConnect={handleConnect}
            onCancelEdit={() => {
              setServerError(null);
              setIsEditMode(false);
            }}
          />
        )}
      </section>

      {/* "One more step" — its own panel below the main panel,
          add/edit only, never in the connected state (§5.2). */}
      {(!hasSavedCredentials || isEditMode) && (
        <section className="flex flex-col gap-6 rounded-md border border-line bg-panel p-6 shadow-card">
          <FacebookSetupCard />
        </section>
      )}

      {/* Privacy Policy URL — its own panel, both states: Facebook
          needs this address regardless of connection state. */}
      <section className="flex flex-col gap-6 rounded-md border border-line bg-panel p-6 shadow-card">
        <FacebookPrivacyUrlRow privacyUrl={getWorkspacePrivacyUrl(subdomain)} />
      </section>

      <FacebookDisconnectDialog
        open={disconnectOpen}
        isDisconnecting={disconnectMutation.isPending}
        onOpenChange={setDisconnectOpen}
        onConfirm={handleDisconnect}
      />
    </div>
  );
}
