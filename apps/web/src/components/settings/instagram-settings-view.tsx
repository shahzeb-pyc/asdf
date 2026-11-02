'use client';

/**
 * Instagram tab — dedicated Unified Login container.
 *
 * The tab is no longer a config over the shared platform pattern: it
 * renders the Instagram-owned container in
 * `components/settings/instagram/`, which owns the Meta App ID, App
 * Secret and Configuration ID triple, the Steps 1–4 form, the
 * connected view, and the disconnect dialog. Threads keeps the shared
 * container untouched.
 *
 * Single-column layout: title + description + tick/cross status on
 * top, full-width panel below, never split into side-by-side columns
 * on desktop. This section connects a developer app, not an account:
 * no account-eligibility facts appear here.
 */

import React from 'react';

import { InstagramByocView } from '@/components/settings/instagram/instagram-byoc-view';

export interface InstagramSettingsViewProps {
  subdomain: string;
}

export function InstagramSettingsView({ subdomain }: Readonly<InstagramSettingsViewProps>) {
  return <InstagramByocView subdomain={subdomain} />;
}
