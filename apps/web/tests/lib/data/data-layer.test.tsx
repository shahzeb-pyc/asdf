/** @vitest-environment jsdom */
/**
 * Data-layer behavioural tests (spec 137 §3.4.3): dedupe, invalidation
 * via the key factory, optimistic update + rollback, server-data
 * hydration without a mount refetch, and the provider's 401-handler
 * registration (cache clear + exactly-once reaction).
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import {
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { createQueryClient } from '@/lib/data/query-client';
import { queryKeys } from '@/lib/data/query-keys';
import { DataHydration, DataProvider } from '@/lib/data/provider';
import { createServerQueryClient, prefetchServerQueries } from '@/lib/data/server';
import {
  handleSessionExpired,
  resetSessionExpiredGuard,
} from '@/lib/api/session-expired';

const tenant = queryKeys.tenant('acme');

let capturedClient: QueryClient | null = null;

function ClientProbe() {
  capturedClient = useQueryClient();
  return null;
}

function PagesConsumer({ queryFn }: { queryFn: () => Promise<string[]> }) {
  const query = useQuery({ queryKey: tenant.pages.list, queryFn });
  return (
    <div>
      <span data-testid="pages">{(query.data ?? []).join(',')}</span>
      <ClientProbe />
    </div>
  );
}

beforeEach(() => {
  capturedClient = null;
  resetSessionExpiredGuard();
});

afterEach(() => {
  cleanup();
  resetSessionExpiredGuard();
});

describe('request dedupe', () => {
  it('two consumers of the same key produce exactly one request', async () => {
    const client = createQueryClient('acme');
    const queryFn = vi.fn().mockResolvedValue(['p1', 'p2']);
    render(
      <QueryClientProvider client={client}>
        <PagesConsumer queryFn={queryFn} />
        <PagesConsumer queryFn={queryFn} />
      </QueryClientProvider>
    );
    await waitFor(() => {
      expect(screen.getAllByTestId('pages')[0].textContent).toBe('p1,p2');
    });
    expect(screen.getAllByTestId('pages')[1].textContent).toBe('p1,p2');
    expect(queryFn).toHaveBeenCalledTimes(1);
  });
});

describe('invalidation via query keys', () => {
  it('invalidating through the factory refetches the matching query only', async () => {
    const client = createQueryClient('acme');
    let pagesCalls = 0;
    const pagesFn = vi.fn(async () => {
      pagesCalls += 1;
      return [`page-v${pagesCalls}`];
    });
    const accountsFn = vi.fn().mockResolvedValue(['a1']);
    function AccountsConsumer() {
      const query = useQuery({ queryKey: tenant.accounts.list, queryFn: accountsFn });
      return <span data-testid="accounts">{(query.data ?? []).join(',')}</span>;
    }
    render(
      <QueryClientProvider client={client}>
        <PagesConsumer queryFn={pagesFn} />
        <AccountsConsumer />
      </QueryClientProvider>
    );
    await waitFor(() => {
      expect(screen.getByTestId('pages').textContent).toBe('page-v1');
    });
    await act(async () => {
      await client.invalidateQueries({ queryKey: tenant.pages.all });
    });
    await waitFor(() => {
      expect(screen.getByTestId('pages').textContent).toBe('page-v2');
    });
    expect(pagesFn).toHaveBeenCalledTimes(2);
    expect(accountsFn).toHaveBeenCalledTimes(1);
  });
});

describe('optimistic update + rollback', () => {
  it('applies the optimistic value immediately and rolls back on error', async () => {
    const client = createQueryClient('acme');
    client.setQueryData(tenant.queue.items('p1'), ['post-a']);

    let rejectMutation: ((error: Error) => void) | null = null;
    const mutationFn = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectMutation = reject;
        })
    );

    let mutate: (() => void) | null = null;
    function QueueConsumer() {
      const queryClient = useQueryClient();
      const query = useQuery({
        queryKey: tenant.queue.items('p1'),
        queryFn: async () => ['post-a'],
      });
      const mutation = useMutation({
        mutationFn,
        onMutate: async (newItem: string) => {
          await queryClient.cancelQueries({ queryKey: tenant.queue.items('p1') });
          const previous = queryClient.getQueryData<string[]>(tenant.queue.items('p1'));
          queryClient.setQueryData(tenant.queue.items('p1'), (old: string[] = []) => [
            ...old,
            newItem,
          ]);
          return { previous };
        },
        onError: (_error, _newItem, context) => {
          queryClient.setQueryData(tenant.queue.items('p1'), context?.previous);
        },
      });
      mutate = () => mutation.mutate('post-b');
      return <span data-testid="queue">{(query.data ?? []).join(',')}</span>;
    }

    render(
      <QueryClientProvider client={client}>
        <QueueConsumer />
      </QueryClientProvider>
    );
    expect(screen.getByTestId('queue').textContent).toBe('post-a');

    await act(async () => {
      mutate?.();
    });
    // Optimistic value is visible before the mutation settles.
    await waitFor(() => {
      expect(screen.getByTestId('queue').textContent).toBe('post-a,post-b');
    });
    expect(client.getQueryData(tenant.queue.items('p1'))).toEqual(['post-a', 'post-b']);

    await act(async () => {
      rejectMutation?.(new Error('publish failed'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('queue').textContent).toBe('post-a');
    });
    expect(client.getQueryData(tenant.queue.items('p1'))).toEqual(['post-a']);
    expect(mutationFn).toHaveBeenCalledTimes(1);
  });
});

describe('server-data hydration', () => {
  it('renders server-prefetched data without refetching on mount', async () => {
    const serverClient = createServerQueryClient('acme');
    const state = await prefetchServerQueries(serverClient, [
      { queryKey: tenant.pages.list, queryFn: async () => ['from-server'] },
    ]);

    const client = createQueryClient('acme');
    const mountFn = vi.fn().mockResolvedValue(['from-client']);
    render(
      <QueryClientProvider client={client}>
        <DataHydration state={state}>
          <PagesConsumer queryFn={mountFn} />
        </DataHydration>
      </QueryClientProvider>
    );
    expect(screen.getByTestId('pages').textContent).toBe('from-server');
    // Give any (incorrect) mount refetch a chance to fire, then assert none did.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(mountFn).not.toHaveBeenCalled();
    expect(screen.getByTestId('pages').textContent).toBe('from-server');
  });
});

describe('DataProvider 401-handler registration', () => {
  it('registers the handler on mount: a 401 clears the cache exactly once', async () => {
    render(
      <DataProvider subdomain="acme">
        <ClientProbe />
      </DataProvider>
    );
    const client = capturedClient;
    expect(client).not.toBeNull();
    client?.setQueryData(tenant.pages.list, ['cached']);
    expect(client?.getQueryData(tenant.pages.list)).toEqual(['cached']);

    let handled = false;
    await act(async () => {
      handled = await handleSessionExpired('/tenant/acme/inapp-schedule');
    });
    expect(handled).toBe(true);
    expect(client?.getQueryData(tenant.pages.list)).toBeUndefined();

    // Exactly once: a second racing 401 is suppressed by the latch.
    client?.setQueryData(tenant.pages.list, ['cached-again']);
    let handledAgain = true;
    await act(async () => {
      handledAgain = await handleSessionExpired('/tenant/acme/inapp-schedule');
    });
    expect(handledAgain).toBe(false);
    expect(client?.getQueryData(tenant.pages.list)).toEqual(['cached-again']);
  });

  it('unregisters the handler on unmount (default handler leaves the cache alone)', async () => {
    const view = render(
      <DataProvider subdomain="acme">
        <ClientProbe />
      </DataProvider>
    );
    const client = capturedClient;
    view.unmount();
    resetSessionExpiredGuard();

    client?.setQueryData(tenant.pages.list, ['still-here']);
    await act(async () => {
      await handleSessionExpired('/tenant/acme/inapp-schedule');
    });
    expect(client?.getQueryData(tenant.pages.list)).toEqual(['still-here']);
  });

  it('renders children inside the provider', () => {
    render(
      <DataProvider>
        <span data-testid="child">inside</span>
      </DataProvider>
    );
    expect(screen.getByTestId('child').textContent).toBe('inside');
  });
});

describe('DataProvider global session check', () => {
  let sessionStatus = 200;
  let sessionCalls = 0;

  beforeEach(() => {
    sessionStatus = 200;
    sessionCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        // Spec 152 O4: mount/focus re-prove the token only
        // (`?mode=token`); the 5-minute interval keeps the full check.
        // Both hit the same endpoint and count as a session check.
        if (url === '/api/auth/session' || url === '/api/auth/session?mode=token') {
          sessionCalls += 1;
          return new Response(JSON.stringify({ active: sessionStatus === 200 }), {
            status: sessionStatus,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('checks the session on mount', async () => {
    render(
      <DataProvider subdomain="acme">
        <ClientProbe />
      </DataProvider>
    );
    await waitFor(() => {
      expect(sessionCalls).toBe(1);
    });
  });

  it('a proven-dead session clears the cache through the existing handler', async () => {
    sessionStatus = 401;
    render(
      <DataProvider subdomain="acme">
        <ClientProbe />
      </DataProvider>
    );
    const client = capturedClient;
    expect(client).not.toBeNull();
    client?.setQueryData(tenant.pages.list, ['cached']);
    // The global check's dead verdict runs the registered handler:
    // cache cleared (the navigation itself is jsdom noise here).
    await waitFor(() => {
      expect(client?.getQueryData(tenant.pages.list)).toBeUndefined();
    });
  });

  it('a failed check is neutral: cache untouched, no bounce', async () => {
    sessionStatus = 503;
    render(
      <DataProvider subdomain="acme">
        <ClientProbe />
      </DataProvider>
    );
    const client = capturedClient;
    expect(client).not.toBeNull();
    client?.setQueryData(tenant.pages.list, ['cached']);
    await waitFor(() => {
      expect(sessionCalls).toBe(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(client?.getQueryData(tenant.pages.list)).toEqual(['cached']);
  });

  it('a focus event within the throttle does not re-check', async () => {
    render(
      <DataProvider subdomain="acme">
        <ClientProbe />
      </DataProvider>
    );
    await waitFor(() => {
      expect(sessionCalls).toBe(1);
    });
    window.dispatchEvent(new Event('focus'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sessionCalls).toBe(1);
  });

  it('re-checks on the 5-minute interval', async () => {
    vi.useFakeTimers();
    try {
      render(
        <DataProvider subdomain="acme">
          <ClientProbe />
        </DataProvider>
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(sessionCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(sessionCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips a re-check while one is already in flight', async () => {
    vi.useFakeTimers();
    try {
      let resolveFetch!: (response: Response) => void;
      const gatedFetch = new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
      let gatedCalls = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(() => {
          gatedCalls += 1;
          return gatedFetch;
        })
      );
      render(
        <DataProvider subdomain="acme">
          <ClientProbe />
        </DataProvider>
      );
      // Mount check starts and its fetch is still pending.
      expect(gatedCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(61_000);
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(0);
      // The focus re-check hit the in-flight guard: no second fetch.
      expect(gatedCalls).toBe(1);
      resolveFetch(new Response(JSON.stringify({ active: true }), { status: 200 }));
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-checks on focus after the throttle window', async () => {
    vi.useFakeTimers();
    try {
      render(
        <DataProvider subdomain="acme">
          <ClientProbe />
        </DataProvider>
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(sessionCalls).toBe(1);
      // 61s: past the 60s focus throttle, short of the 5-minute
      // interval, so only the focus handler fires the re-check.
      await vi.advanceTimersByTimeAsync(61_000);
      expect(sessionCalls).toBe(1);
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(0);
      expect(sessionCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
