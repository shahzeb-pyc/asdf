/**
 * Public Muse guide route — behavioural tests.
 *
 * The guide must be public (no login), served as markdown, and
 * carry the exact app-host guide link and the acting rules the
 * Connect prompt promises: API for Media Library only, browser
 * for everything else, act without asking again until revoke or
 * log out.
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
    // Two jobs: operate in the browser AND explain FBUploadPro.
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
});
