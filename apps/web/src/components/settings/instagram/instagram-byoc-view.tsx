'use client';

/**
 * Instagram App tab — dedicated container (Unified Login).
 *
 * Instagram-owned container, mirroring Facebook's: it owns the data
 * and the state machine (loading / load error / not-connected /
 * connected / edit, plus the disconnect dialog's open state) over the
 * platform-credentials API, validated by the typed API client. It does
 * NOT use the shared platform credentials view, so Threads behaviour
 * is untouched.
 *
 * State rules, per the confirmed mockup: the header (title +
 * description + tick/cross status) stacks above the full-width panel
 * at every width, never split. While editing, the app is still
 * connected — the status mark reflects the saved credentials, not the
 * edit mode. The Privacy Policy URL row lives inside the form states
 * only (Step 3), never in the connected state. A partial triple (any
 * of Meta App ID, App Secret, Configuration ID present without the
 * other two) shows the incomplete-details prompt above the form, and
 * the connect may not start until all three are present.
 *
 * Outcomes follow the interruption ladder: validation and server
 * save failures at form scope, operation outcomes and network
 * failures as toasts from the shared/ui Toast system, the
 * destructive decision as an AlertDialog.
 */

import * as React from 'react';
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
import { toast } from '@/components/shared/ui/toast';
import { PlatformStatusMark } from '@/components/settings/platform/platform-status-mark';
import { buildPrivacyPolicyUrl } from '@/lib/privacy-url';
import { buildSubdomainOAuthRedirectUriForCallback } from '@fbuploadpro/contracts';
import {
  InstagramConnectForm,
  type InstagramConnectPayload,
} from './instagram-connect-form';
import { InstagramConnectedView } from './instagram-connected-view';
import { InstagramDisconnectDialog } from './instagram-disconnect-dialog';

function isNetworkFailure(error: unknown): boolean {
  return (
    Boolean(error) &&
    typeof error === 'object' &&
    (error as { kind?: unknown }).kind === 'network'
  );
}

export interface InstagramByocViewProps {
  subdomain: string;
}

export function InstagramByocView({ subdomain }: Readonly<InstagramByocViewProps>) {
  const queryClient = useQueryClient();
  const tenant = queryKeys.tenant(subdomain);
  const credentialsPath = buildTenantApiPath(
    subdomain,
    '/settings/platform-credentials/instagram'
  );
  const credentialsQueryKey = tenant.settings.platformCredentials('instagram');

  const [isEditMode, setIsEditMode] = React.useState(false);
  const [disconnectOpen, setDisconnectOpen] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);

  const credentialsQuery = useQuery({
    queryKey: credentialsQueryKey,
    queryFn: ({ signal }) =>
      api.get(credentialsPath, { schema: PlatformCredentialsResponseSchema, signal }),
  });

  const connectMutation = useMutation({
    mutationFn: (payload: InstagramConnectPayload) =>
      api.put(credentialsPath, payload, { schema: SaveCredentialsResponseSchema }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: credentialsQueryKey });
      setIsEditMode(false);
      toast.success('Your Instagram app is connected.');
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: () =>
      api.delete(credentialsPath, { schema: DeletePlatformCredentialsResponseSchema }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: credentialsQueryKey });
      setDisconnectOpen(false);
      setIsEditMode(false);
      toast.success('Your Instagram app has been disconnected.');
    },
  });

  const handleConnect = async (payload: InstagramConnectPayload): Promise<void> => {
    setServerError(null);
    try {
      await connectMutation.mutateAsync(payload);
    } catch (error) {
      if (isNetworkFailure(error)) {
        toast.error('Could not connect Instagram. Check your connection and try again.');
      } else if (isApiError(error) && error.kind === 'http') {
        setServerError(
          getErrorMessage(error, 'Your Instagram app details could not be saved. Please try again.')
        );
      } else {
        setServerError('Your Instagram app details could not be saved. Please try again.');
      }
      // Surfaced above (form-scope error or toast): do not rethrow.
      // The form takes no action after onConnect, and a rethrow would
      // surface as an unhandled rejection with no user-visible effect.
    }
  };

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
      toast.error(
        isNetworkFailure(error)
          ? 'Could not disconnect Instagram. Try again.'
          : 'Your Instagram app could not be disconnected. Please try again.'
      );
    }
  };

  // The sign-in address shown here is built with the SAME builder the
  // real Instagram OAuth initiate uses, so the address shown can never
  // drift from the address the connect flow actually sends to Meta.
  const signInCallback = buildSubdomainOAuthRedirectUriForCallback(
    subdomain,
    '/api/auth/instagram/callback',
    typeof window !== 'undefined' ? window.location.origin : null,
    process.env.NEXT_PUBLIC_ROOT_DOMAIN || 'fbuploadpro.com',
    process.env.NEXT_PUBLIC_APP_URL
  );

  if (credentialsQuery.isPending && !credentialsQuery.data) {
    return (
      <div className="flex w-full max-w-3xl flex-col gap-6" aria-label="Loading Instagram app details">
        <span className="sr-only">Loading Instagram app details</span>
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

  const credentials: PlatformCredentialsResponse | undefined = credentialsQuery.data;

  if (!credentials) {
    return (
      <div className="flex w-full max-w-3xl flex-col gap-6">
        <Banner
          variant="critical"
          title="Your Instagram app details could not be loaded. Please try again."
          action={
            <Button
              type="button"
              variant="secondary"
              data-testid="instagram-load-retry-btn"
              onClick={() => void credentialsQuery.refetch()}
            >
              Try again
            </Button>
          }
        />
      </div>
    );
  }

  const hasSavedCredentials = Boolean(
    credentials.appId && credentials.hasSecret && credentials.configId
  );
  const isConnectedState = hasSavedCredentials && !isEditMode;
  const isPartialTriple =
    !hasSavedCredentials &&
    Boolean(credentials.appId || credentials.hasSecret || credentials.configId);

  const headerDescription = isEditMode
    ? 'Edit your saved Instagram app details.'
    : isConnectedState
      ? 'Your Instagram app is connected.'
      : 'Link your Instagram app to start publishing from this workspace.';

  return (
    <div className="flex w-full max-w-4xl flex-col gap-6">
      <div>
        <h2 id="instagram-settings-heading" className="text-lg font-semibold text-ink">
          Instagram App
        </h2>
        <p className="mt-1 text-body text-ink-sub">{headerDescription}</p>
        {!isConnectedState && (
          <p className="mt-1 text-body text-ink-sub">
            Next step: Connect an Instagram account to start publishing.
          </p>
        )}
        <div data-testid="instagram-status-badge" className="mt-3">
          <PlatformStatusMark testIdPrefix="instagram" connected={hasSavedCredentials} />
        </div>
      </div>

      {isPartialTriple && !isEditMode && (
        <Banner
          variant="warning"
          title="Complete all three details before you connect."
          description="To connect an Instagram account, add your Meta App ID, App Secret and Configuration ID below. A workspace with only some of the three details cannot start a connection."
        />
      )}

      <section
        data-testid="instagram-settings-card"
        aria-labelledby="instagram-settings-heading"
        className="flex flex-col gap-6 rounded-md border border-line bg-panel p-6 shadow-card"
      >
        {isConnectedState ? (
          <InstagramConnectedView
            appId={credentials.appId}
            configId={credentials.configId ?? null}
            appName={credentials.appName ?? null}
            connectedAt={credentials.connectedAt}
            onRevealSecret={handleRevealSecret}
            onEditDetails={() => {
              setServerError(null);
              setIsEditMode(true);
            }}
            onDisconnectClick={() => setDisconnectOpen(true)}
          />
        ) : (
          <>
            {isEditMode && (
              <p className="text-body text-ink-sub">
                Unsaved changes. Your previously saved app remains connected until you save.
              </p>
            )}
            <InstagramConnectForm
              key={isEditMode ? 'edit' : 'connect'}
              signInCallback={signInCallback}
              privacyUrl={buildPrivacyPolicyUrl(subdomain)}
              initialAppId={credentials.appId}
              initialConfigId={credentials.configId ?? ''}
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
          </>
        )}
      </section>

      <InstagramDisconnectDialog
        open={disconnectOpen}
        isDisconnecting={disconnectMutation.isPending}
        onOpenChange={setDisconnectOpen}
        onConfirm={handleDisconnect}
      />
    </div>
  );
}
