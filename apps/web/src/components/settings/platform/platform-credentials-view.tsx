'use client';

/**
 * Platform credentials tab — container (spec 135 PR-135-3,
 * spec §5.3/§5.4 / §6.2 / §8.2).
 *
 * Replaces the 963-line `platform-credentials-view.tsx` and the
 * 410-line `platform-credentials-shared.tsx` (both deleted in this
 * PR) with the §8.2 decomposition: this container owns the data and
 * the state machine (loading / load error / not-connected /
 * connected / edit, plus the disconnect dialog's open state) for both
 * Instagram and Threads, driven by the per-platform config — platform
 * differences are copy/config only (UI Rule 11), exactly as the
 * Facebook tab's container (PR-135-2) established the pattern. The
 * form, the connected view, the "One more step" card, and the
 * disconnect dialog are the sibling modules in this folder.
 *
 * Data (spec §6.2): the platform payload arrives server-first through
 * the settings route's dehydration
 * (`queryKeys.settings.platformCredentials(platform)`) and is
 * read/refetched here with React Query over the typed API client,
 * validated by `PlatformCredentialsResponseSchema` — no raw fetch, no
 * fetch-on-mount for initial data. The legacy fetch helpers, their
 * `FetchFn` seam, and the `initial*` test-seam props are deleted with
 * the old files; tests seed through the query client / fetch mocks.
 * The payload is masked-by-default (spec 139 N3): it carries a secret
 * hint, never the secret — the value is fetched on demand by the
 * reveal action when the user chooses Show.
 *
 * Mutations and invalidation (named per spec §6.2): connect (PUT) and
 * disconnect (DELETE) both invalidate
 * `queryKeys.settings.platformCredentials(platform)` on success, so
 * the tab re-reads the saved state and lands on the state the server
 * reports — connect ends on the connected view, disconnect ends on
 * the not-connected form (UI Rule 26).
 *
 * Outcomes follow the interruption ladder (UI Rule 2): validation and
 * server save/test failures at form scope (§6.3), operation outcomes
 * and network failures as toasts from the single shared/ui Toast
 * system (the hand-rolled toast is deleted), the reconnect notice as
 * a persistent Banner, and the destructive decision as an
 * AlertDialog. The §5.2 sentences carry over with the platform's
 * labels substituted, including the fixed network-failure sentences.
 */

import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, buildTenantApiPath, getErrorMessage, isApiError } from '@/lib/api';
import {
  DeletePlatformCredentialsResponseSchema,
  PlatformCredentialsResponseSchema,
  RevealPlatformSecretResponseSchema,
  SaveCredentialsResponseSchema,
  type PlatformCredentialsResponse,
} from '@/lib/api/schemas/settings';
import { queryKeys } from '@/lib/data/query-keys';
import { Banner } from '@/components/shared/ui/banner';
import { Button } from '@/components/shared/ui/button';
import { Skeleton } from '@/components/shared/ui/skeleton';
import { StatusDot } from '@/components/shared/ui/status-dot';
import { toast } from '@/components/shared/ui/toast';

import {
  PlatformConnectForm,
  type PlatformConnectPayload,
} from './platform-connect-form';
import { PlatformConnectedView } from './platform-connected-view';
import { PlatformDisconnectDialog } from './platform-disconnect-dialog';
import { PlatformPrivacyUrlRow } from './platform-privacy-url-row';
import { PlatformStatusMark } from './platform-status-mark';
import type { PlatformCredentialsConfig } from './platform-credentials-helpers';

export interface PlatformCredentialsViewProps {
  subdomain: string;
  config: PlatformCredentialsConfig;
  /** The platform's setup guide, shown above the form in the not-connected state. */
  children?: React.ReactNode;
  /** Extra card shown under the main card in the form and edit states. */
  setupCard?: React.ReactNode;
  /**
   * Redesign variants (2026-10-25). `twoColumn`: left column =
   * section title + description + tick/cross status, right column =
   * ONE token panel with the privacy URL row (both states) and "One
   * more step" folded into the panel (add/edit only). `singleColumn`:
   * the same header (title + description + tick/cross status) and
   * the same panel, but stacked in one full-width column — header on
   * top, panel below — on desktop and mobile alike, never side by
   * side. Tabs that omit this keep the classic layout, dot status,
   * and separate setup card exactly as before.
   */
  variant?: 'classic' | 'twoColumn' | 'singleColumn';
  /** Privacy Policy URL shown in the panel in both states (redesign variants only). */
  privacyUrl?: string;
}

function isNetworkFailure(error: unknown): boolean {
  return isApiError(error) && error.kind === 'network';
}

/** Loading state: a Skeleton at the card's final geometry; the
 *  shipped loading text is preserved as the accessible name. */
function PlatformCredentialsLoading({
  config,
}: Readonly<{ config: PlatformCredentialsConfig }>) {
  const { displayName, testIdPrefix } = config;
  const loadingText = `Loading your ${displayName} app details…`;
  return (
    <div
      data-testid={`${testIdPrefix}-loading`}
      aria-busy="true"
      aria-label={loadingText}
      className="flex w-full max-w-3xl flex-col gap-6"
    >
      <span className="sr-only">{loadingText}</span>
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

export function PlatformCredentialsView({
  subdomain,
  config,
  children,
  setupCard,
  variant = 'classic',
  privacyUrl,
}: Readonly<PlatformCredentialsViewProps>) {
  const { platform, displayName, appIdLabel, appSecretLabel, testIdPrefix } = config;
  const queryClient = useQueryClient();
  const tenant = queryKeys.tenant(subdomain);
  const credentialsPath = buildTenantApiPath(
    subdomain,
    `/settings/platform-credentials/${platform}`
  );
  const credentialsQueryKey = tenant.settings.platformCredentials(platform);

  const saveFailureMessage = `Couldn't save your ${displayName} app details. Please try again.`;
  const disconnectFailureMessage = `Couldn't disconnect ${displayName}. Please try again.`;
  const connectNetworkMessage = `Network error while connecting ${displayName}.`;
  const disconnectNetworkMessage = `Network error while disconnecting ${displayName}.`;

  const searchParams = useSearchParams();
  const showReconnectNotice = searchParams.get('notice') === 'reconnect';

  const [isEditMode, setIsEditMode] = React.useState(false);
  const [disconnectOpen, setDisconnectOpen] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);

  const credentialsQuery = useQuery({
    queryKey: credentialsQueryKey,
    queryFn: ({ signal }) =>
      api.get(credentialsPath, { schema: PlatformCredentialsResponseSchema, signal }),
  });

  const connectMutation = useMutation({
    mutationFn: (payload: PlatformConnectPayload) =>
      api.put(credentialsPath, payload, { schema: SaveCredentialsResponseSchema }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: credentialsQueryKey });
      setIsEditMode(false);
      toast.success(`Your ${displayName} app is connected.`);
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: () =>
      api.delete(credentialsPath, { schema: DeletePlatformCredentialsResponseSchema }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: credentialsQueryKey });
      setDisconnectOpen(false);
      setIsEditMode(false);
      toast.success(`Your ${displayName} app has been disconnected.`);
    },
  });

  const handleConnect = async (payload: PlatformConnectPayload): Promise<void> => {
    setServerError(null);
    try {
      await connectMutation.mutateAsync(payload);
    } catch (error) {
      if (isNetworkFailure(error)) {
        // The platform's fixed sentence — a network failure never
        // borrows a server message, so the two failure paths stay
        // distinct (§5.3/§5.4).
        toast.error(connectNetworkMessage);
      } else if (isApiError(error) && error.kind === 'http') {
        // The server's own plain-language message takes precedence,
        // at form scope (spec §6.3); the fixed sentence is the
        // fallback when the server returned none.
        setServerError(getErrorMessage(error, saveFailureMessage));
      } else {
        setServerError(saveFailureMessage);
      }
      throw error;
    }
  };

  // Spec 139 N3: the GET payload is masked-by-default — the secret
  // itself is fetched only when the user chooses Show, through the
  // dedicated reveal action. The connected view owns the reveal's
  // loading/error states; this callback is the data path.
  const handleRevealSecret = React.useCallback(async (): Promise<string> => {
    const result = await api.post(`${credentialsPath}/reveal`, {}, {
      schema: RevealPlatformSecretResponseSchema,
    });
    return result.appSecret;
  }, [credentialsPath]);

  const handleDisconnect = async (): Promise<void> => {
    try {
      await disconnectMutation.mutateAsync();
    } catch (error) {
      // Fully handled here: the failure is toasted and the dialog
      // stays open (the container closes it only on success). Nothing
      // awaits this handler's rejection — the dialog fires it and
      // forgets — so it must not rethrow.
      toast.error(isNetworkFailure(error) ? disconnectNetworkMessage : disconnectFailureMessage);
    }
  };

  if (credentialsQuery.isPending && !credentialsQuery.data) {
    return <PlatformCredentialsLoading config={config} />;
  }

  const credentials: PlatformCredentialsResponse | undefined = credentialsQuery.data;

  if (!credentials) {
    // Load failure is a state, not a silent fall-through to the form:
    // the ladder's error rung, with the recovery action in place.
    return (
      <div className="flex w-full max-w-3xl flex-col gap-6">
        <Banner
          variant="critical"
          title={`Couldn't load your ${displayName} app details. Please try again.`}
          action={
            <Button
              type="button"
              variant="secondary"
              data-testid={`${testIdPrefix}-load-retry-btn`}
              onClick={() => void credentialsQuery.refetch()}
            >
              Try again
            </Button>
          }
        />
      </div>
    );
  }

  const hasSavedCredentials = Boolean(credentials.appId && credentials.hasSecret);
  const isConnectedState = hasSavedCredentials && !isEditMode;

  if (variant === 'twoColumn' || variant === 'singleColumn') {
    // Shared redesign branch: the header (title + description +
    // tick/cross status) and the panel are identical in both
    // variants — only their arrangement differs. `twoColumn` puts
    // them side by side on desktop; `singleColumn` stacks them in
    // one full-width column (header on top, panel below) at every
    // width, never split. The status mark reflects the saved
    // credentials, not the edit mode — while editing, the app is
    // still connected, even though the form is showing. The
    // description follows the classic sentences verbatim, with an
    // edit-mode line of its own.
    const isSingleColumn = variant === 'singleColumn';
    const headerDescription = isEditMode
      ? `Edit your saved ${displayName} app details.`
      : isConnectedState
        ? `Your ${displayName} app is linked and publishing is ready to go.`
        : `Link your ${displayName} app to start publishing from this workspace.`;

    const headerBlock = (
      <div>
        <h2
          id={`${testIdPrefix}-settings-heading`}
          className="text-lg font-semibold text-ink"
        >
          {`${displayName} App`}
        </h2>
        <p className="mt-1 text-body text-ink-sub">{headerDescription}</p>
        <div data-testid={`${testIdPrefix}-status-badge`} className="mt-3">
          <PlatformStatusMark
            testIdPrefix={testIdPrefix}
            connected={hasSavedCredentials}
          />
        </div>
      </div>
    );

    const mainPanel = (
      <section
        data-testid={`${testIdPrefix}-settings-card`}
        aria-labelledby={`${testIdPrefix}-settings-heading`}
        className="flex flex-col gap-6 rounded-md border border-line bg-panel p-6 shadow-card"
      >
        {isConnectedState ? (
          <PlatformConnectedView
            config={config}
            appId={credentials.appId}
            connectedAt={credentials.connectedAt}
            onRevealSecret={handleRevealSecret}
            onEditDetails={() => {
              setServerError(null);
              setIsEditMode(true);
            }}
            onDisconnectClick={() => setDisconnectOpen(true)}
          />
        ) : (
          <PlatformConnectForm
            key={isEditMode ? 'edit' : 'connect'}
            config={config}
            initialAppId={credentials.appId}
            hasExistingSecret={credentials.hasSecret}
            isEditMode={isEditMode}
            isConnecting={connectMutation.isPending}
            serverError={serverError}
            onConnect={handleConnect}
            showStepBadge={false}
            onCancelEdit={() => {
              setServerError(null);
              setIsEditMode(false);
            }}
          >
            {children}
          </PlatformConnectForm>
        )}

        {/* Privacy Policy URL — both states: Meta needs this
            address regardless of connection state. */}
        {privacyUrl && (
          <PlatformPrivacyUrlRow testIdPrefix={testIdPrefix} privacyUrl={privacyUrl} />
        )}

        {/* "One more step" — folded into this panel as a step
            below the main content, add/edit only, never in the
            connected state. It is no longer a separate floating
            card in these variants. */}
        {(!hasSavedCredentials || isEditMode) && (
          <div className="border-t border-line pt-6">{setupCard}</div>
        )}
      </section>
    );

    return (
      <div className="flex w-full max-w-4xl flex-col gap-6">
        {showReconnectNotice && (
          <Banner
            variant="warning"
            data-testid={`${testIdPrefix}-reconnect-notice`}
            title={`${displayName} requires an app to reconnect accounts. Add your ${appIdLabel} and ${appSecretLabel} below, then reconnect.`}
          />
        )}

        {isSingleColumn ? (
          <>
            {headerBlock}
            {mainPanel}
          </>
        ) : (
          <div className="grid w-full gap-7 md:grid-cols-[220px_minmax(0,1fr)]">
            {headerBlock}
            {mainPanel}
          </div>
        )}

        <PlatformDisconnectDialog
          config={config}
          open={disconnectOpen}
          isDisconnecting={disconnectMutation.isPending}
          onOpenChange={setDisconnectOpen}
          onConfirm={handleDisconnect}
        />
      </div>
    );
  }

  return (
    <div className="flex w-full max-w-3xl flex-col gap-6">
      {showReconnectNotice && (
        <Banner
          variant="warning"
          data-testid={`${testIdPrefix}-reconnect-notice`}
          title={`${displayName} requires an app to reconnect accounts. Add your ${appIdLabel} and ${appSecretLabel} below, then reconnect.`}
        />
      )}

      <section
        data-testid={`${testIdPrefix}-settings-card`}
        aria-labelledby={`${testIdPrefix}-settings-heading`}
        className="flex flex-col gap-6 rounded-md border border-line bg-panel p-6 shadow-card"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2
              id={`${testIdPrefix}-settings-heading`}
              className="text-lg font-semibold text-ink"
            >
              {`Connect ${displayName}`}
            </h2>
            <p className="mt-1 text-body text-ink-sub">
              {isConnectedState
                ? `Your ${displayName} app is linked and publishing is ready to go.`
                : `Link your ${displayName} app to start publishing from this workspace.`}
            </p>
          </div>
          <div data-testid={`${testIdPrefix}-status-badge`} className="shrink-0">
            <StatusDot
              status={isConnectedState ? 'operational' : 'idle'}
              label={isConnectedState ? 'Connected' : 'Not connected'}
            />
          </div>
        </div>

        {isConnectedState ? (
          <PlatformConnectedView
            config={config}
            appId={credentials.appId}
            connectedAt={credentials.connectedAt}
            onRevealSecret={handleRevealSecret}
            onEditDetails={() => {
              setServerError(null);
              setIsEditMode(true);
            }}
            onDisconnectClick={() => setDisconnectOpen(true)}
          />
        ) : (
          <PlatformConnectForm
            key={isEditMode ? 'edit' : 'connect'}
            config={config}
            initialAppId={credentials.appId}
            hasExistingSecret={credentials.hasSecret}
            isEditMode={isEditMode}
            isConnecting={connectMutation.isPending}
            serverError={serverError}
            onConnect={handleConnect}
            onCancelEdit={() => {
              setServerError(null);
              setIsEditMode(false);
            }}
          >
            {children}
          </PlatformConnectForm>
        )}
      </section>

      {/* "One more step" — add/edit only, never in the connected state (§5.3/§5.4). */}
      {(!hasSavedCredentials || isEditMode) && setupCard}

      <PlatformDisconnectDialog
        config={config}
        open={disconnectOpen}
        isDisconnecting={disconnectMutation.isPending}
        onOpenChange={setDisconnectOpen}
        onConfirm={handleDisconnect}
      />
    </div>
  );
}
