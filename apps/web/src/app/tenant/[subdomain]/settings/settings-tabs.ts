/**
 * Settings tab contract — server-safe (no 'use client').
 *
 * The route's server component (page.tsx) resolves the active tab from
 * `searchParams` on the server, so `resolveSettingsTab` and the tab id
 * table must live outside the client island: a function exported from
 * a 'use client' module is a client reference and THROWS when called
 * from the server ("Attempted to call resolveSettingsTab() from the
 * server but resolveSettingsTab is on the client"). Extracted from
 * settings-shell.tsx in PR-135-2 after that error took the settings
 * route down in the production build; the shell re-exports these so
 * its existing importers are unchanged.
 *
 * Deep-link contract (spec 135 §5.6, as amended 2026-10-25): the 4 tab
 * ids, the legacy `byoc` value resolving to `facebook`, a
 * missing/unknown value landing on `general`. YouTube, X, and TikTok
 * were removed from the Settings tab row, so their ids now land on
 * `general` like any unknown value.
 */

export type SettingsTab =
  | 'general'
  | 'facebook'
  | 'instagram'
  | 'threads';

export const SETTINGS_TABS: ReadonlyArray<{ id: SettingsTab; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'facebook', label: 'Facebook App' },
  { id: 'instagram', label: 'Instagram' },
  { id: 'threads', label: 'Threads' },
];

const SETTINGS_TAB_IDS: readonly string[] = SETTINGS_TABS.map((tab) => tab.id);

/**
 * Resolve a `?tab=` value to a tab. The legacy `byoc` value keeps
 * landing on the Facebook tab so existing links (Accounts, Pages,
 * sign-in redirects) keep working unchanged.
 */
export function resolveSettingsTab(param: string | null | undefined): SettingsTab {
  if (param === 'byoc') return 'facebook';
  if (param && SETTINGS_TAB_IDS.includes(param)) {
    return param as SettingsTab;
  }
  return 'general';
}
