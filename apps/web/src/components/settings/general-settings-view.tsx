'use client';

/**
 * General tab — workspace name (spec 135 PR-135-1, spec §5.1/§6.3).
 *
 * Rebuilt clean-room on the shared/ui primitives and the form standard
 * (spec 137 §3.8): react-hook-form + zod, `onTouched` validation, the
 * FormErrorSummary on submit failure (focus moves to it, its entry
 * links to the field and matches the inline message exactly), input
 * never cleared by a failed save, and the submit button loading +
 * disabled while pending.
 *
 * Data (spec §6.2): the workspace list arrives server-first through
 * the settings route's dehydration (queryKeys.tenant(subdomain)
 * .workspaces.list) and is read here with React Query over the typed
 * API client — no fetch-on-mount, no raw fetch. The rename mutation
 * PATCHes `/api/workspaces` through the typed client with
 * `WorkspaceMutationResponseSchema`.
 *
 * Rename invalidation — the mechanism named per spec §6.2: on success
 * the mutation (1) writes the renamed workspace into the cached
 * workspace list (`setQueryData` on the list key, so this tab re-renders
 * with the new name at once), (2) invalidates the workspace-list key
 * (`queryKeys.tenant(subdomain).workspaces.list`) so every other
 * consumer of the list refetches the renamed workspace, and
 * (3) dispatches the app's existing `workspace-updated` window event
 * ({ subdomain, name }) — the mechanism the shell chrome (sidebar /
 * switcher footer) already listens to — so the shell-visible name
 * updates in the same tick. A rename that only updated this tab's
 * local state would fail spec §7 acceptance.
 *
 * Outcomes follow the interruption ladder: validation and save
 * failures stay at form scope (summary + inline, edit mode kept, text
 * intact); success is confirmed by the single shared/ui Toast system
 * ("Workspace name updated.") and by the updated name in place.
 *
 * Copy is spec §5.1 verbatim, including the validation messages (now
 * the zod schema's messages — the hand-rolled `validateWorkspaceName`
 * is deleted) and the save-failure sentence (a server-returned error
 * still takes precedence, as before). The label keeps sentence-case
 * source ("Workspace name") with the uppercase presentation applied
 * by utility, per the 2026-10-19 code-style decision.
 */

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  QueryClientContext,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { z } from 'zod';

import { api, getErrorMessage, isApiError } from '@/lib/api';
import {
  ListWorkspacesResponseSchema,
  WorkspaceMutationResponseSchema,
  type WorkspaceItem,
} from '@/lib/api/schemas/workspaces';
import { queryKeys } from '@/lib/data/query-keys';
import { Button } from '@/components/shared/ui/button';
import {
  Form,
  FormControl,
  FormErrorSummary,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  type FormErrorSummaryEntry,
} from '@/components/shared/ui/form';
import { Input } from '@/components/shared/ui/input';
import { Skeleton } from '@/components/shared/ui/skeleton';
import { toast } from '@/components/shared/ui/toast';

/* ------------------------------------------------------------------ */
/* Schema — the §5.1 validation messages, verbatim                      */
/* ------------------------------------------------------------------ */

export const workspaceNameFormSchema = z.object({
  name: z
    .string()
    .min(3, 'Workspace name must be between 3 and 40 characters.')
    .max(40, 'Workspace name must be between 3 and 40 characters.')
    .refine(
      (value) => value === value.trim(),
      'Workspace name must not contain leading or trailing spaces.'
    ),
});

export type WorkspaceNameFormValues = z.infer<typeof workspaceNameFormSchema>;

const SAVE_FAILURE_MESSAGE = "Couldn't update the workspace name. Please try again.";
const NAME_FIELD_ID = 'workspace-name-field';

/** The message a failed save presents: the server's own error text
 *  when the server returned one (HTTP failure), otherwise the fixed
 *  §5.1 sentence (network / unexpected failures). */
function saveFailureMessage(error: unknown): string {
  if (isApiError(error) && error.kind === 'http') {
    return getErrorMessage(error, SAVE_FAILURE_MESSAGE);
  }
  return SAVE_FAILURE_MESSAGE;
}

function notifyWorkspaceUpdated(subdomain: string, name: string) {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('workspace-updated', { detail: { subdomain, name } })
    );
  }
}

/* ------------------------------------------------------------------ */
/* Form — one presentation for both data adapters below                */
/* ------------------------------------------------------------------ */

/**
 * Format a workspace createdAt value as a readable date, e.g.
 * "24 October 2026". Returns null for a missing or unparseable
 * value, so the Created row is simply hidden rather than showing
 * a placeholder or invented date.
 */
export function formatWorkspaceCreatedAt(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date);
}

interface WorkspaceNameFormProps {
  currentName: string;
  createdAt?: string | undefined;
  isSaving: boolean;
  serverError: string | null;
  onSave: (name: string) => Promise<void>;
  onClearServerError: () => void;
}

function WorkspaceNameForm({
  currentName,
  createdAt,
  isSaving,
  serverError,
  onSave,
  onClearServerError,
}: Readonly<WorkspaceNameFormProps>) {
  const [isEditing, setIsEditing] = React.useState(false);
  const [submitAttempted, setSubmitAttempted] = React.useState(false);

  const form = useForm<WorkspaceNameFormValues>({
    resolver: zodResolver(workspaceNameFormSchema),
    mode: 'onTouched',
    shouldFocusError: false,
    defaultValues: { name: currentName },
  });

  const startEdit = () => {
    form.reset({ name: currentName });
    onClearServerError();
    setSubmitAttempted(false);
    setIsEditing(true);
  };

  const cancelEdit = () => {
    form.reset({ name: currentName });
    onClearServerError();
    setSubmitAttempted(false);
    setIsEditing(false);
  };

  const handleValidSubmit = async (values: WorkspaceNameFormValues) => {
    try {
      await onSave(values.name);
      setIsEditing(false);
      setSubmitAttempted(false);
      form.reset({ name: values.name });
    } catch {
      // The adapter has already surfaced the failure as `serverError`
      // (form scope). Edit mode stays open and the typed text stays —
      // a failed save never clears the input.
    }
  };

  const fieldError = form.formState.errors.name?.message;
  const summaryEntries: FormErrorSummaryEntry[] = [];
  if (submitAttempted && fieldError) {
    summaryEntries.push({ fieldId: NAME_FIELD_ID, message: fieldError });
  }
  if (serverError) {
    summaryEntries.push({ message: serverError });
  }

  const formattedCreated = formatWorkspaceCreatedAt(createdAt);
  const createdRow = formattedCreated ? (
    <div
      data-testid="workspace-created-row"
      className="flex items-center justify-between gap-4 border-t border-line pt-4"
    >
      <span className="text-metadata text-ink-sub">Created</span>
      <span className="text-body font-medium text-ink">{formattedCreated}</span>
    </div>
  ) : null;

  return (
    <div className="flex w-full flex-col gap-4">
      <div>
        <h2 id="workspace-about-heading" className="text-lg font-semibold text-ink">
          About this workspace
        </h2>
        <p className="mt-1 text-metadata text-ink-sub">
          The name of this workspace.
        </p>
      </div>

      <section
        data-testid="workspace-about-card"
        aria-labelledby="workspace-about-heading"
        className="flex flex-col gap-4 rounded-md border border-line bg-panel p-6 shadow-card"
      >
        <div className="flex flex-col gap-1">
          {!isEditing ? (
            <>
              <span className="text-metadata font-medium tracking-caption text-ink-dim uppercase">
                Workspace
              </span>
              <div className="flex items-center justify-between gap-4 max-sm:flex-col max-sm:items-stretch max-sm:gap-3">
                <div
                  data-testid="workspace-name-display"
                  className="text-body font-medium break-words text-ink"
                >
                  {currentName}
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  data-testid="workspace-name-edit-btn"
                  className="max-sm:w-full"
                  onClick={startEdit}
                >
                  Edit
                </Button>
              </div>
              {createdRow}
            </>
          ) : (
            <Form {...form}>
              <form
                noValidate
                onSubmit={(event) => {
                  setSubmitAttempted(true);
                  void form.handleSubmit(handleValidSubmit)(event);
                }}
                className="flex flex-col gap-2"
              >
                <FormErrorSummary errors={summaryEntries} />
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem id={NAME_FIELD_ID}>
                      <FormLabel className="text-metadata font-medium tracking-caption text-ink-dim uppercase">
                        Workspace name
                      </FormLabel>
                      <div className="flex items-start gap-3 max-sm:flex-col max-sm:items-stretch">
                        <FormControl>
                          <Input
                            {...field}
                            type="text"
                            data-testid="workspace-name-input"
                            disabled={isSaving}
                            onKeyDown={(event) => {
                              if (event.key === 'Escape') {
                                event.preventDefault();
                                cancelEdit();
                              }
                            }}
                          />
                        </FormControl>
                        <div className="flex items-center gap-2 max-sm:w-full">
                          <Button
                            type="submit"
                            data-testid="workspace-name-save-btn"
                            className="max-sm:flex-1"
                            loading={isSaving}
                            disabled={isSaving}
                          >
                            Save
                          </Button>
                          <Button
                            type="button"
                            variant="secondary"
                            data-testid="workspace-name-cancel-btn"
                            className="max-sm:flex-1"
                            onClick={cancelEdit}
                            disabled={isSaving}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                      <FormMessage data-testid="workspace-name-error" />
                    </FormItem>
                  )}
                />
              </form>
            </Form>
          )}
          {isEditing ? createdRow : null}
        </div>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Data adapters                                                       */
/* ------------------------------------------------------------------ */

export interface GeneralSettingsViewProps {
  subdomain: string;
  /**
   * Display name to show before/without query data (e.g. a caller that
   * already resolved it). Inside the app the name comes from the
   * workspace-list query, hydrated server-first by the settings route.
   */
  workspaceName?: string | undefined;
  /**
   * Fallback created date for standalone renders without a query
   * provider; inside the app it comes from the workspace-list query.
   */
  workspaceCreatedAt?: string | undefined;
}

function GeneralSettingsWithQuery({
  subdomain,
  workspaceName,
  workspaceCreatedAt,
}: Readonly<GeneralSettingsViewProps>) {
  const queryClient = useQueryClient();
  const tenant = queryKeys.tenant(subdomain);
  const [serverError, setServerError] = React.useState<string | null>(null);

  const workspacesQuery = useQuery({
    queryKey: tenant.workspaces.list,
    queryFn: ({ signal }) =>
      api.get('/api/workspaces', { schema: ListWorkspacesResponseSchema, signal }),
  });

  const workspace = workspacesQuery.data?.workspaces.find(
    (item: WorkspaceItem) => item.subdomain.toLowerCase() === subdomain.toLowerCase()
  );
  const currentName = workspace?.name ?? workspaceName ?? subdomain;

  const renameMutation = useMutation({
    mutationFn: (name: string) =>
      api.patch(
        '/api/workspaces',
        { subdomain, name },
        { schema: WorkspaceMutationResponseSchema }
      ),
    onSuccess: (data) => {
      const updatedName = data.workspace.name;
      queryClient.setQueryData<ListWorkspacesResponse>(
        tenant.workspaces.list,
        (previous) =>
          previous
            ? {
                workspaces: previous.workspaces.map((item) =>
                  item.subdomain.toLowerCase() === subdomain.toLowerCase()
                    ? { ...item, name: updatedName }
                    : item
                ),
              }
            : previous
      );
      void queryClient.invalidateQueries({ queryKey: tenant.workspaces.list });
      notifyWorkspaceUpdated(subdomain, updatedName);
      toast.success('Workspace name updated.');
    },
  });

  if (workspacesQuery.isPending && !workspacesQuery.data) {
    return (
      <div aria-busy="true" aria-label="Loading workspace settings" className="flex w-full max-w-2xl flex-col gap-4">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-32" />
      </div>
    );
  }

  return (
    <WorkspaceNameForm
      currentName={currentName}
      createdAt={workspace?.createdAt ?? workspaceCreatedAt}
      isSaving={renameMutation.isPending}
      serverError={serverError}
      onClearServerError={() => setServerError(null)}
      onSave={async (name) => {
        setServerError(null);
        try {
          await renameMutation.mutateAsync(name);
        } catch (error) {
          setServerError(saveFailureMessage(error));
          throw error;
        }
      }}
    />
  );
}

type ListWorkspacesResponse = z.infer<typeof ListWorkspacesResponseSchema>;

/**
 * Standalone adapter for callers that render the view outside the
 * app's data provider (unit renders): the name comes from props and
 * the rename goes through the same typed client + event + toast —
 * the presentation and behaviour are identical, only the cache
 * hand-off is absent because there is no cache in that tree.
 */
function GeneralSettingsStandalone({
  subdomain,
  workspaceName,
  workspaceCreatedAt,
}: Readonly<GeneralSettingsViewProps>) {
  const [currentName, setCurrentName] = React.useState(workspaceName ?? subdomain);
  const [isSaving, setIsSaving] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);

  return (
    <WorkspaceNameForm
      currentName={currentName}
      createdAt={workspaceCreatedAt}
      isSaving={isSaving}
      serverError={serverError}
      onClearServerError={() => setServerError(null)}
      onSave={async (name) => {
        setServerError(null);
        setIsSaving(true);
        try {
          const data = await api.patch(
            '/api/workspaces',
            { subdomain, name },
            { schema: WorkspaceMutationResponseSchema }
          );
          const updatedName = data.workspace.name;
          setCurrentName(updatedName);
          notifyWorkspaceUpdated(subdomain, updatedName);
          toast.success('Workspace name updated.');
        } catch (error) {
          setServerError(saveFailureMessage(error));
          throw error;
        } finally {
          setIsSaving(false);
        }
      }}
    />
  );
}

export function GeneralSettingsView(props: Readonly<GeneralSettingsViewProps>) {
  // Inside the app the tenant layout always mounts the data provider,
  // so the query adapter is the production path. The context check
  // (not a hook-order branch — both adapters are components) keeps the
  // view renderable in standalone unit trees without a provider.
  const queryClient = React.useContext(QueryClientContext);
  return queryClient ? (
    <GeneralSettingsWithQuery {...props} />
  ) : (
    <GeneralSettingsStandalone {...props} />
  );
}
