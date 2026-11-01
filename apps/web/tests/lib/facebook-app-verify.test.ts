import { describe, expect, it, vi } from 'vitest';
import { verifyFacebookApp } from '@/lib/server/facebook-app-verify';

const APP_ID = '123456789012345';
const APP_SECRET = 'fake-app-secret-1234567890';

function graphResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('verifyFacebookApp', () => {
  it('returns the app name when Graph accepts the pair', async () => {
    let requestedUrl = '';
    const fetchMock = vi.fn(async (input: unknown) => {
      requestedUrl = String(input);
      return graphResponse(200, { name: 'Acme App', id: APP_ID });
    });
    const result = await verifyFacebookApp(APP_ID, APP_SECRET, fetchMock as any);

    expect(result).toEqual({ ok: true, appName: 'Acme App' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestedUrl).toContain('https://graph.facebook.com/v26.0/123456789012345');
    expect(requestedUrl).toContain('fields=name');
    // App token form: {app-id}|{app-secret}, URL-encoded.
    expect(requestedUrl).toContain(`access_token=${APP_ID}%7C${encodeURIComponent(APP_SECRET)}`);
  });

  it('reports rejection when Graph answers 400 with an auth error', async () => {
    const fetchMock = vi.fn(async () =>
      graphResponse(400, {
        error: { message: 'Invalid OAuth access token.', type: 'OAuthException', code: 190 },
      })
    );
    const result = await verifyFacebookApp(APP_ID, 'wrong-secret-value-123', fetchMock as any);
    expect(result).toEqual({ ok: false, kind: 'rejected' });
  });

  it('reports rejection for any 4xx answer', async () => {
    const fetchMock = vi.fn(async () => graphResponse(401, { error: { code: 104 } }));
    const result = await verifyFacebookApp(APP_ID, APP_SECRET, fetchMock as any);
    expect(result).toEqual({ ok: false, kind: 'rejected' });
  });

  it('reports unreachable when Graph answers 5xx', async () => {
    const fetchMock = vi.fn(async () => graphResponse(500, { error: 'boom' }));
    const result = await verifyFacebookApp(APP_ID, APP_SECRET, fetchMock as any);
    expect(result).toEqual({ ok: false, kind: 'unreachable' });
  });

  it('reports unreachable when the fetch throws (timeout, DNS, network)', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('fetch failed');
    });
    const result = await verifyFacebookApp(APP_ID, APP_SECRET, fetchMock as any);
    expect(result).toEqual({ ok: false, kind: 'unreachable' });
  });

  it('reports unreachable — never a rejection — when Graph answers 200 without a name', async () => {
    const fetchMock = vi.fn(async () => graphResponse(200, { id: APP_ID }));
    const result = await verifyFacebookApp(APP_ID, APP_SECRET, fetchMock as any);
    expect(result).toEqual({ ok: false, kind: 'unreachable' });
  });

  it('reports unreachable when the 200 body has an empty name', async () => {
    const fetchMock = vi.fn(async () => graphResponse(200, { name: '' }));
    const result = await verifyFacebookApp(APP_ID, APP_SECRET, fetchMock as any);
    expect(result).toEqual({ ok: false, kind: 'unreachable' });
  });
});
