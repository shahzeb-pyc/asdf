/**
 * Public Terms of Service document for FBUploadPro.
 *
 * Shared single source for the terms page copy: the root /terms route
 * renders this directly, and the middleware serves that route publicly on
 * every host (tenant subdomains included), so there is exactly one copy
 * of this text. The page requires no session, no workspace data, and no
 * app chrome (no sidebar/topbar) — it is a standalone public document.
 *
 * Plain-language draft, not legal advice: the final wording is the
 * product owner's to approve.
 */

import * as React from 'react';

export interface TermsOfServiceContentProps {
  /** Display date for the "Last updated" line (e.g. "27 October 2026"). */
  lastUpdated: string;
}

export function TermsOfServiceContent({ lastUpdated }: TermsOfServiceContentProps) {
  return (
    <article className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6">
      <h1 className="text-2xl font-semibold text-ink">Terms of Service</h1>
      <p className="mt-2 text-body text-ink-sub">
        FBUploadPro · Last updated: {lastUpdated}
      </p>

      <h2 className="mt-8 text-lg font-semibold text-ink">What FBUploadPro is</h2>
      <p className="mt-2 text-body leading-relaxed text-ink-sub">
        FBUploadPro helps you schedule and publish content to your connected social
        media accounts, including Facebook Pages, from one workspace.
      </p>

      <h2 className="mt-8 text-lg font-semibold text-ink">Your account</h2>
      <p className="mt-2 text-body leading-relaxed text-ink-sub">
        You are responsible for keeping your account credentials safe and for
        everything done under your account. You must provide accurate information
        when signing up.
      </p>

      <h2 className="mt-8 text-lg font-semibold text-ink">
        Your content and connected accounts
      </h2>
      <p className="mt-2 text-body leading-relaxed text-ink-sub">
        You keep ownership of your content. By connecting a social account, you
        authorize FBUploadPro to publish the content you schedule to that account,
        on your behalf. You are responsible for making sure your content follows
        the rules of each platform you publish to.
      </p>

      <h2 className="mt-8 text-lg font-semibold text-ink">Acceptable use</h2>
      <p className="mt-2 text-body leading-relaxed text-ink-sub">
        You must not use FBUploadPro to publish spam, misleading content, or anything
        illegal, or to abuse, interfere with, or attempt to break the service or
        anyone else&apos;s accounts.
      </p>

      <h2 className="mt-8 text-lg font-semibold text-ink">Availability</h2>
      <p className="mt-2 text-body leading-relaxed text-ink-sub">
        FBUploadPro is an early product and may change, pause, or stop features as it
        develops. We aim for reliability but do not guarantee uninterrupted service.
      </p>

      <h2 className="mt-8 text-lg font-semibold text-ink">Liability</h2>
      <p className="mt-2 text-body leading-relaxed text-ink-sub">
        The service is provided as is. To the extent allowed by law, FBUploadPro is
        not liable for losses arising from your content, your connected accounts, or
        platform actions (such as a platform restricting an account).
      </p>

      <h2 className="mt-8 text-lg font-semibold text-ink">Ending your use</h2>
      <p className="mt-2 text-body leading-relaxed text-ink-sub">
        You may stop using FBUploadPro at any time and disconnect your accounts. We
        may suspend or close an account that breaks these terms.
      </p>

      <h2 className="mt-8 text-lg font-semibold text-ink">Changes to these terms</h2>
      <p className="mt-2 text-body leading-relaxed text-ink-sub">
        If these terms change materially, we will update this page and the
        last-updated date. Continued use after a change means you accept the updated
        terms.
      </p>

      <h2 className="mt-8 text-lg font-semibold text-ink">Contact</h2>
      <p className="mt-2 text-body leading-relaxed text-ink-sub">
        Questions about these terms? Contact support inside the app, or message us on
        WhatsApp.
      </p>

      <p className="mt-10 border-t border-line pt-4 text-body text-ink-dim">
        This page is public — no sign-in needed — and is available on every workspace address, at /terms.
      </p>
    </article>
  );
}
