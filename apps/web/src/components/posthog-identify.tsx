'use client';

import { useEffect } from 'react';
import { identifyUser } from '@/lib/posthog';

interface PostHogIdentifyProps {
  /**
   * Signed-in user id, from the tenant shell's server session — the
   * stable identify key. Never an email or name.
   */
  userId: string;
  /**
   * Tenant subdomain, from the tenant shell — the stable workspace
   * identifier attached to identify.
   */
  tenantId: string;
}

/**
 * Identifies the signed-in user to PostHog. Rendered by the tenant
 * shell (which already holds the session), not by the root layout:
 * the root layout must stay synchronous for the legacy static-markup
 * layout suite, and identify only matters on signed-in tenant pages
 * anyway. The effect fires when the tenant shell mounts (i.e. on the
 * post-login landing) and again if the user or workspace changes.
 * Renders nothing. A no-op when PostHog never initialized.
 */
export function PostHogIdentify({ userId, tenantId }: PostHogIdentifyProps) {
  useEffect(() => {
    identifyUser(userId, tenantId);
  }, [userId, tenantId]);

  return null;
}
