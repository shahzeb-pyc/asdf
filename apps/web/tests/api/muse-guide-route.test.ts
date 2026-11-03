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
});
