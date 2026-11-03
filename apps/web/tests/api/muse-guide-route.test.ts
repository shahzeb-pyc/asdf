/**
 * Muse guide route — behavioural tests.
 *
 * The guide is served as markdown, and
 * carries the acting rules the
 * Connect prompt promises: API for Media Library only, browser
 * for everything else, act without asking again until revoke or
 * log out. This test makes no claim about live public access,
 * which still needs a live check.
 */
import { describe, expect, it } from 'vitest';
import { GET } from '../../src/app/muse_guide.md/route';

describe('muse_guide.md route', () => {
  it('serves the guide publicly as markdown, with the acting rules', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/markdown');
    const text = await res.text();
    // The guide is served AT app.fbuploadpro.com/muse_guide.md; it
    // does not self-reference its own URL — the Connect prompt in
    // contracts (tested there) carries the link.
    expect(text).toContain('FBUploadPro — Muse guide');
    expect(text).toContain('Media Library');
    expect(text).toContain('Act without asking again');
    expect(text).toContain('revoke');
    expect(text).toContain('Publish Now');
    expect(text).toContain('Auto Repost');
    expect(text).toContain('Billing and Plan');
  });

  it('covers every sidebar section, workspaces, Settings/BYOC, and billing leaves in full detail', async () => {
    const res = await GET();
    const text = await res.text();
    // Two jobs: operate in your own browser AND explain FBUploadPro.
    expect(text).toContain('Answering questions about FBUploadPro');
    expect(text).toContain('do not guess and do not answer from general knowledge');
    expect(text).toContain('checked it in the app');
    // Sidebar order and labels, corrected.
    expect(text).toContain('Muse Assistant');
    expect(text).toContain('Fdola Studio is coming soon');
    expect(text).toContain('there is no Billing group');
    expect(text).toContain('In-app Schedule');
    expect(text).toContain('Being tested — not available for public use');
    // Workspaces and Settings/BYOC.
    expect(text).toContain('## Workspaces');
    expect(text).toContain('## Settings');
    expect(text).toContain('Facebook App — BYOC setup');
    expect(text).toContain('Instagram App — BYOC setup');
    expect(text).toContain('Threads App — BYOC setup');
    // Corrected feature facts.
    expect(text).toContain('Dashboard, Insights, Queue');
    expect(text).toContain('saved automatically');
    expect(text).toContain('There is no preview pane');
    // Billing leaves and verified numbers.
    expect(text).toContain('## My Plan');
    expect(text).toContain('## Purchase');
    expect(text).toContain('## Payments');
    expect(text).toContain('## Refund');
    expect(text).toContain('70 PKR per page or account');
    expect(text).toContain('Only your first purchase can be refunded, within 7 days');
    // BYOC walkthroughs: verify-before-save for Facebook/Instagram,
    // blank-secret-keeps for all three, setup alone never connects.
    expect(text).toContain('Facebook rejected this App ID and App Secret');
    expect(text).toContain("Couldn't reach Facebook to verify your app");
    expect(text).toContain('Meta rejected this App ID and App Secret');
    expect(text).toContain('Meta could not be reached to verify your app');
    expect(text).toContain('Your Threads app is connected and ready to publish');
    expect(text).toContain('blank secret keeps');
    expect(text).toContain('BYOC setup alone does not connect an account');
  });

  it('rewrites Workspaces accurately: manage properly, multiple owned workspaces, test-user BYOC workaround, no single-workspace framing', async () => {
    const res = await GET();
    const text = await res.text();
    // Purpose, in the owner's logic.
    expect(text).toContain('manage more properly');
    expect(text).toContain('can own more than one workspace');
    expect(text).toContain("exceeds the limit of their developer app's test users");
    expect(text).toContain('create another workspace and add another BYOC app');
    expect(text).toContain('BYOC settings are per-workspace');
    // Per-workspace vs per-user split.
    expect(text).toContain('does not appear in another workspace');
    expect(text).toContain('Media Library: storage, folders, and uploads belong to the user');
    expect(text).toContain('Billing and Plan: plan, payments, refunds, and storage quota are per user account');
    // Isolation, qualified by ownership and current workspace — never the
    // unqualified single-workspace framing of the previous draft.
    expect(text).toContain('Never work in a workspace the signed-in user does not own');
    expect(text).not.toContain('each user works in their own signed-in workspace');
    expect(text).not.toContain("never work in another user's workspace");
    // Create/switch as the UI shows it.
    expect(text).toContain('Create Workspace');
    expect(text).toContain('Workspace Name');
    // Two jobs, check-in-the-app rule, and no public-access claim.
    expect(text).toContain('Your two jobs');
    expect(text).toContain('Answering questions about FBUploadPro');
    expect(text).toContain('do not guess and do not answer from general knowledge');
    expect(text).toContain('checked it in the app');
    expect(text).not.toContain('no login required');
    // Living document: re-read fresh, never trust a stale copy.
    expect(text).toContain('This guide is a living document');
    expect(text).toContain('Re-read the full, current guide fresh again');
    expect(text).toContain('Note the version you last read');
    expect(text).toContain('do not assume a feature works the way it did before an update');
    // Version line at the very top, and version-change re-read rule.
    expect(text.startsWith('Guide version: 1.0')).toBe(true);
    expect(text).toContain('its version increases with each update and new feature');
    expect(text).toContain('a changed version means the guide has changed');
    expect(text).toContain('whenever the version there is different from the version you last read');
    expect(text).toContain('re-read the full guide fresh before helping or answering');
    // BYOC per platform, fresh wording.
    expect(text).toContain('All three are required before a connection can start');
    expect(text).toContain('No deauthorize or data-deletion addresses are given anywhere');
  });

  it('states Muse works in its own browser, and that Facebook Schedule is the in-app schedule', async () => {
    const res = await GET();
    const text = await res.text();
    // Own-browser correction: never the user's/device browser.
    expect(text).toContain('in your own browser');
    expect(text).toContain('Use FBUploadPro for the user, in your own browser');
    expect(text).toContain('in your own browser yourself');
    expect(text).not.toContain('in their browser');
    // Facebook Schedule is the in-app schedule, formerly named Pages.
    expect(text).toContain("Facebook's in-app schedule is the Schedule section");
    expect(text).toContain("for Facebook it was previously named Pages");
    expect(text).toContain("ARE Facebook's in-app schedule, in the Schedule section");
    expect(text).toContain('### Facebook — Schedule');
    // Leaves: Schedule (Facebook, formerly Pages), Schedule (Instagram), In-app Schedule (Threads).
    expect(text).toContain('Facebook leaves, in order: Accounts, Schedule, Publish Now');
    // Home quick links use the renamed label too (PR #162 renames the
    // app's Home link to Facebook Schedule, not Facebook Pages).
    expect(text).toContain('Facebook Accounts, Facebook Schedule, Billing');
    expect(text).not.toContain('Facebook Accounts, Facebook Pages, Billing');
  });
});
