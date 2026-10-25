/**
 * Public Privacy Policy document for FBUploadPro.
 *
 * Shared single source for the privacy page copy: the root /privacy route
 * renders this directly, and the middleware serves that route publicly on
 * every host (tenant subdomains included), so there is exactly one copy
 * of this text. The page requires no session, no workspace data, and no
 * app chrome (no sidebar/topbar) — it is a standalone public document.
 *
 * Plain-language draft, not legal advice: the final wording is the
 * product owner's to approve.
 */

import * as React from 'react';

export interface PrivacyPolicyContentProps {
  /** Display date for the "Last updated" line (e.g. "25 October 2026"). */
  lastUpdated: string;
}

export function PrivacyPolicyContent({ lastUpdated }: PrivacyPolicyContentProps) {
  return (
    <article className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6">
      <h1 className="text-2xl font-semibold text-ink">Privacy Policy</h1>
      <p className="mt-2 text-body text-ink-sub">
        FBUploadPro · Last updated: {lastUpdated}
      </p>

      <h2 className="mt-8 text-lg font-semibold text-ink">What FBUploadPro does</h2>
      <p className="mt-2 text-body leading-relaxed text-ink-sub">
        FBUploadPro helps you schedule and publish content to your own social media
        accounts — Facebook, Instagram, Threads, YouTube, X, and TikTok — from one
        dashboard. You connect your accounts, create posts, and we publish them at
        the times you choose.
      </p>

      <h2 className="mt-8 text-lg font-semibold text-ink">What we collect</h2>
      <ul className="mt-2 list-disc space-y-2 pl-5 text-body leading-relaxed text-ink-sub">
        <li>
          <span className="font-medium text-ink">Your account details:</span> your name,
          email address, and workspace name, so you can sign in and use the service.
        </li>
        <li>
          <span className="font-medium text-ink">Your connected social accounts:</span>{' '}
          the platform tokens needed to publish on your behalf, stored encrypted. Your
          platform passwords are never stored by us — you sign in through each platform
          directly.
        </li>
        <li>
          <span className="font-medium text-ink">Your content:</span> the posts, captions,
          images, and videos you upload or schedule, and when they were published.
        </li>
        <li>
          <span className="font-medium text-ink">Basic usage data:</span> publish success
          or failure, so we can show you what went live and what needs attention.
        </li>
      </ul>

      <h2 className="mt-8 text-lg font-semibold text-ink">What we do with it</h2>
      <p className="mt-2 text-body leading-relaxed text-ink-sub">
        We use your data only to run the service you asked for: to publish your posts,
        to show you your queue and history, and to keep your account secure. We do not
        sell your data, and we do not use your posts or your audience data for
        advertising.
      </p>

      <h2 className="mt-8 text-lg font-semibold text-ink">Who else sees it</h2>
      <p className="mt-2 text-body leading-relaxed text-ink-sub">
        Only the platforms you connect to, when you publish to them, and the service
        providers that run the infrastructure behind FBUploadPro (hosting, database,
        and storage). No other third party receives your data.
      </p>

      <h2 className="mt-8 text-lg font-semibold text-ink">How long we keep it</h2>
      <p className="mt-2 text-body leading-relaxed text-ink-sub">
        We keep your posts and connected accounts for as long as your workspace exists.
        When you disconnect an account, its token is removed. When you delete your
        workspace, your posts and account connections are deleted with it.
      </p>

      <h2 className="mt-8 text-lg font-semibold text-ink">Your choices</h2>
      <p className="mt-2 text-body leading-relaxed text-ink-sub">
        You can disconnect any connected account at any time from Accounts, and you can
        delete scheduled posts before they publish. To delete your workspace and all its
        data, contact support from inside the app.
      </p>

      <h2 className="mt-8 text-lg font-semibold text-ink">Contact</h2>
      <p className="mt-2 text-body leading-relaxed text-ink-sub">
        Questions about this policy: use the support button inside FBUploadPro, or write
        to us through the WhatsApp support link in the app.
      </p>

      <p className="mt-10 border-t border-line pt-4 text-body text-ink-dim">
        This page is public and does not require sign-in. It is available at{' '}
        https://<span className="italic">your-workspace</span>.fbuploadpro.com/privacy.
      </p>
    </article>
  );
}
