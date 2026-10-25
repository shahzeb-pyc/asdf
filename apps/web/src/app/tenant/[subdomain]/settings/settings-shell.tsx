'use client';

/**
 * Settings shell — client island (spec 135 PR-135-1, spec §6.5).
 *
 * The route's server component (page.tsx) resolves the active tab from
 * `searchParams` and dehydrates that tab's initial data; this island
 * owns tab switching from there: the shared/ui Tabs primitive (Radix —
 * roving tabindex, arrow/Home/End keys, automatic activation), the
 * active tab kept in sync with `?tab=` in both directions via
 * `router.replace` (no history spam), and the per-tab panels.
 *
 * Deep-link contract (spec §5.6, preserved verbatim): the 7 tab ids,
 * the legacy `byoc` value resolving to `facebook`, a missing/unknown
 * value landing on `general`, and the `settings-tab-<id>` testids.
 * Credential panels keep reading `?notice=reconnect` themselves, as
 * they do today.
 *
 * Non-initial tab views are code-split per tab (React.lazy): only the
 * active tab's view chunk is requested, and a panel's chunk is fetched
 * the first time its tab is selected (spec 137 §4.1.5 bundle duty).
 * The General view — the default tab — ships with the shell.
 */

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import { GeneralSettingsView } from '@/components/settings/general-settings-view';
import { Skeleton } from '@/components/shared/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/shared/ui/tabs';

// The tab contract (ids, labels, `resolveSettingsTab`) lives in the
// server-safe `./settings-tabs` module — the route's server component
// calls the resolver, and a function exported from this 'use client'
// module cannot be called from the server. Re-exported here so this
// island's existing importers are unchanged.
export { resolveSettingsTab, SETTINGS_TABS } from './settings-tabs';
export type { SettingsTab } from './settings-tabs';
import { resolveSettingsTab, SETTINGS_TABS, type SettingsTab } from './settings-tabs';

const FacebookSettingsView = React.lazy(() =>
  import('@/components/settings/facebook/facebook-settings-view').then((m) => ({
    default: m.FacebookSettingsView,
  }))
);
const InstagramSettingsView = React.lazy(() =>
  import('@/components/settings/instagram-settings-view').then((m) => ({
    default: m.InstagramSettingsView,
  }))
);
const ThreadsSettingsView = React.lazy(() =>
  import('@/components/settings/threads-settings-view').then((m) => ({
    default: m.ThreadsSettingsView,
  }))
);
const YouTubeSettingsView = React.lazy(() =>
  import('@/components/settings/youtube-settings-view').then((m) => ({
    default: m.YouTubeSettingsView,
  }))
);
const XSettingsView = React.lazy(() =>
  import('@/components/settings/x-settings-view').then((m) => ({
    default: m.XSettingsView,
  }))
);
const TikTokSettingsView = React.lazy(() =>
  import('@/components/settings/tiktok-settings-view').then((m) => ({
    default: m.TikTokSettingsView,
  }))
);

function TabPanelFallback() {
  return (
    <div aria-busy="true" aria-label="Loading settings section" className="flex w-full max-w-2xl flex-col gap-4">
      <Skeleton className="h-6 w-48" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-32" />
    </div>
  );
}

export interface SettingsShellProps {
  subdomain: string;
  initialTab: SettingsTab;
}

export function SettingsShell({ subdomain, initialTab }: Readonly<SettingsShellProps>) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [activeTab, setActiveTab] = React.useState<SettingsTab>(initialTab);

  // URL → tab: an inbound deep link (or a back/forward landing on a
  // different ?tab=) moves the selection, exactly as the previous
  // client shell did. A missing param leaves the selection untouched.
  React.useEffect(() => {
    const tabParam = searchParams.get('tab');
    if (tabParam) {
      setActiveTab(resolveSettingsTab(tabParam));
    }
  }, [searchParams]);

  // Tab → URL: selection updates immediately (the press is acknowledged
  // at once), then the URL follows via replace — no history spam.
  const handleTabChange = (value: string) => {
    const tab = resolveSettingsTab(value);
    setActiveTab(tab);
    router.replace(`/tenant/${subdomain}/settings?tab=${tab}`);
  };

  return (
    <div className="flex min-h-screen flex-col gap-6 px-8 py-8">
      <h1 className="text-xxl font-bold tracking-h1 text-ink">Settings</h1>

      <Tabs value={activeTab} onValueChange={handleTabChange} className="gap-6">
        <TabsList variant="line" aria-label="Settings sections" className="flex-wrap">
          {SETTINGS_TABS.map((tab) => (
            <TabsTrigger
              key={tab.id}
              value={tab.id}
              variant="line"
              data-testid={`settings-tab-${tab.id}`}
              className="h-10 flex-none px-3"
            >
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="general">
          <GeneralSettingsView subdomain={subdomain} />
        </TabsContent>
        <TabsContent value="facebook">
          <React.Suspense fallback={<TabPanelFallback />}>
            <FacebookSettingsView subdomain={subdomain} />
          </React.Suspense>
        </TabsContent>
        <TabsContent value="instagram">
          <React.Suspense fallback={<TabPanelFallback />}>
            <InstagramSettingsView subdomain={subdomain} />
          </React.Suspense>
        </TabsContent>
        <TabsContent value="threads">
          <React.Suspense fallback={<TabPanelFallback />}>
            <ThreadsSettingsView subdomain={subdomain} />
          </React.Suspense>
        </TabsContent>
        <TabsContent value="youtube">
          <React.Suspense fallback={<TabPanelFallback />}>
            <YouTubeSettingsView subdomain={subdomain} />
          </React.Suspense>
        </TabsContent>
        <TabsContent value="x">
          <React.Suspense fallback={<TabPanelFallback />}>
            <XSettingsView subdomain={subdomain} />
          </React.Suspense>
        </TabsContent>
        <TabsContent value="tiktok">
          <React.Suspense fallback={<TabPanelFallback />}>
            <TikTokSettingsView subdomain={subdomain} />
          </React.Suspense>
        </TabsContent>
      </Tabs>

      {/* No Toast mount here (PR-135-4 close-out correction): the
          tenant layout mounts the single shell-level Toaster
          (spec 130), and this island's second mount made every
          settings toast render twice. Settings views fire toasts
          through the shared store, which the layout's Toaster
          renders — the single shared/ui Toast system (§6.4). */}
    </div>
  );
}
