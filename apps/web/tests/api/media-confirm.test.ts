import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { signSessionToken } from '@fbuploadpro/contracts';
import {
  handleConfirmUpload,
  type MediaStorageVerifier,
} from '../../src/app/api/tenant/[subdomain]/media/confirm/route';
import type { DatabaseClient } from '@fbuploadpro/contracts';

const TEST_SECRET = 'super-secret-session-signing-key-minimum-32-chars-long';

describe('Media Upload Confirmation (POST /api/tenant/[subdomain]/media/confirm)', () => {
  const userId = '11111111-1111-4111-a111-111111111111';
  const mediaId = '22222222-2222-4222-a222-222222222222';
  const otherUserId = '99999999-9999-4999-a999-999999999999';
  const otherMediaId = '88888888-8888-4888-a888-888888888888';
  let validSessionCookie: string;

  beforeEach(async () => {
    process.env.SESSION_SECRET = TEST_SECRET;

    const token = await signSessionToken(
      {
        userId,
        email: 'alexander@gmail.com',
        name: 'Alex Acme',
        subdomain: 'acme',
        role: 'user',
        status: 'active',
      },
      TEST_SECRET
    );
    validSessionCookie = `fbup_session=${token}`;
  });

  function makeRequest(body: Record<string, unknown>): NextRequest {
    return new NextRequest('http://localhost:3000/api/tenant/acme/media/confirm', {
      method: 'POST',
      headers: { cookie: validSessionCookie },
      body: JSON.stringify(body),
    });
  }

  function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      mediaId,
      name: 'video.mp4',
      fileSize: 10485760,
      mimeType: 'video/mp4',
      mediaType: 'video',
      storageKey: `users/${userId}/media/${mediaId}/video.mp4`,
      url: `https://media.fbuploadpro.com/users/${userId}/media/${mediaId}/video.mp4`,
      ...overrides,
    };
  }

  /** Storage verifier fake: reports the given metadata for every key. */
  function makeVerifier(
    metadata: { contentLength: number; contentType?: string } | null
  ): MediaStorageVerifier & { headObject: ReturnType<typeof vi.fn> } {
    return {
      headObject: vi.fn().mockResolvedValue(metadata),
      getPublicUrl: (key: string) => `https://media.fbuploadpro.com/${key}`,
    };
  }

  /** DB fake that echoes the insert params back as the stored row. */
  function makeEchoDb(captured: { params: any[] }) {
    return {
      withTransaction: vi.fn().mockImplementation(async (callback: any) => {
        const txClient = {
          query: vi.fn().mockImplementation(async (sql: string, params: any[]) => {
            if (sql.includes('INSERT INTO media_items')) {
              captured.params = params;
              return {
                rows: [
                  {
                    id: params[0],
                    user_id: params[1],
                    folder_id: params[2],
                    name: params[3],
                    file_size: String(params[4]),
                    mime_type: params[5],
                    media_type: params[6],
                    storage_key: params[7],
                    url: params[8],
                    thumbnail_key: params[9],
                    thumbnail_url: params[10],
                    duration_seconds:
                      params[11] === null || params[11] === undefined
                        ? null
                        : String(params[11]),
                    aspect_ratio: params[12],
                    caption_text: params[13],
                    width: params[14],
                    height: params[15],
                    created_at: new Date('2026-10-07T12:00:00Z'),
                    updated_at: new Date('2026-10-07T12:00:00Z'),
                  },
                ],
                rowCount: 1,
              };
            }
            return { rows: [], rowCount: 0 };
          }),
        };
        return callback(txClient as any);
      }),
    } as unknown as Partial<DatabaseClient>;
  }

  it('rejects unauthenticated requests with 401 Unauthorized', async () => {
    const req = new NextRequest('http://localhost:3000/api/tenant/acme/media/confirm', {
      method: 'POST',
      body: JSON.stringify(validBody()),
    });
    const res = await handleConfirmUpload(req, 'acme');

    expect(res.status).toBe(401);
  });

  it('rejects cross-tenant requests with 403 Forbidden', async () => {
    const req = new NextRequest('http://localhost:3000/api/tenant/other-tenant/media/confirm', {
      method: 'POST',
      headers: { cookie: validSessionCookie },
      body: JSON.stringify(validBody()),
    });
    const res = await handleConfirmUpload(req, 'other-tenant');

    expect(res.status).toBe(403);
  });

  it('rejects invalid request payloads with 400 Bad Request', async () => {
    const req = makeRequest({ mediaId: 'not-a-uuid' });
    const res = await handleConfirmUpload(req, 'acme');

    expect(res.status).toBe(400);
  });

  it('persists media record and defaults captionText to filename with extension stripped when omitted', async () => {
    const captured = { params: [] as any[] };
    const mockDb = makeEchoDb(captured);
    const verifier = makeVerifier({ contentLength: 10485760, contentType: 'video/mp4' });

    const req = makeRequest(
      validBody({
        name: 'My Viral Reel.mp4',
        storageKey: `users/${userId}/media/${mediaId}/My_Viral_Reel.mp4`,
        url: `https://media.fbuploadpro.com/users/${userId}/media/${mediaId}/My_Viral_Reel.mp4`,
        thumbnailKey: `users/${userId}/thumbnails/${mediaId}.webp`,
        thumbnailUrl: `https://media.fbuploadpro.com/users/${userId}/thumbnails/${mediaId}.webp`,
        durationSeconds: 45.5,
        aspectRatio: '9:16',
      })
    );
    const res = await handleConfirmUpload(req, 'acme', mockDb as DatabaseClient, verifier);

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.id).toBe(mediaId);
    expect(data.userId).toBe(userId);
    expect(data.name).toBe('My Viral Reel.mp4');
    expect(data.fileSize).toBe(10485760);
    expect(data.mediaType).toBe('video');
    expect(data.durationSeconds).toBe(45.5);
    expect(verifier.headObject).toHaveBeenCalledWith(
      `users/${userId}/media/${mediaId}/My_Viral_Reel.mp4`
    );
    expect(captured.params[13]).toBe('My Viral Reel');
    expect(data.captionText).toBe('My Viral Reel');
    // Stored URL and thumbnail URL are derived from the verified keys.
    expect(captured.params[8]).toBe(
      `https://media.fbuploadpro.com/users/${userId}/media/${mediaId}/My_Viral_Reel.mp4`
    );
    expect(captured.params[10]).toBe(
      `https://media.fbuploadpro.com/users/${userId}/thumbnails/${mediaId}.webp`
    );
  });

  it('persists and returns width and height pixel dimensions (Spec 046)', async () => {
    const captured = { params: [] as any[] };
    const mockDb = makeEchoDb(captured);
    const verifier = makeVerifier({ contentLength: 5000000, contentType: 'video/mp4' });

    const req = makeRequest(
      validBody({
        name: 'dimension_test.mp4',
        fileSize: 5000000,
        storageKey: `users/${userId}/media/${mediaId}/dimension_test.mp4`,
        url: `https://media.fbuploadpro.com/users/${userId}/media/${mediaId}/dimension_test.mp4`,
        width: 1080,
        height: 1920,
        aspectRatio: '9:16',
      })
    );
    const res = await handleConfirmUpload(req, 'acme', mockDb as DatabaseClient, verifier);

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.width).toBe(1080);
    expect(data.height).toBe(1920);
    expect(captured.params[14]).toBe(1080);
    expect(captured.params[15]).toBe(1920);
  });

  it('rejects confirmation when the uploaded object does not exist in storage', async () => {
    const captured = { params: [] as any[] };
    const mockDb = makeEchoDb(captured);
    const verifier = makeVerifier(null);

    const res = await handleConfirmUpload(
      makeRequest(validBody()),
      'acme',
      mockDb as DatabaseClient,
      verifier
    );

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.message).toBe(
      'We could not verify this upload. Please try uploading the file again.'
    );
    // Nothing was saved.
    expect(mockDb.withTransaction).not.toHaveBeenCalled();
    expect(captured.params).toEqual([]);
  });

  it("rejects a storage key minted for another user without probing storage", async () => {
    const captured = { params: [] as any[] };
    const mockDb = makeEchoDb(captured);
    // The object exists in storage — ownership must still refuse it.
    const verifier = makeVerifier({ contentLength: 10485760, contentType: 'video/mp4' });

    const res = await handleConfirmUpload(
      makeRequest(
        validBody({
          storageKey: `users/${otherUserId}/media/${mediaId}/video.mp4`,
          url: `https://media.fbuploadpro.com/users/${otherUserId}/media/${mediaId}/video.mp4`,
        })
      ),
      'acme',
      mockDb as DatabaseClient,
      verifier
    );

    expect(res.status).toBe(400);
    expect(verifier.headObject).not.toHaveBeenCalled();
    expect(mockDb.withTransaction).not.toHaveBeenCalled();
  });

  it('rejects a storage key minted for a different media item', async () => {
    const captured = { params: [] as any[] };
    const mockDb = makeEchoDb(captured);
    const verifier = makeVerifier({ contentLength: 10485760, contentType: 'video/mp4' });

    const res = await handleConfirmUpload(
      makeRequest(
        validBody({
          storageKey: `users/${userId}/media/${otherMediaId}/video.mp4`,
          url: `https://media.fbuploadpro.com/users/${userId}/media/${otherMediaId}/video.mp4`,
        })
      ),
      'acme',
      mockDb as DatabaseClient,
      verifier
    );

    expect(res.status).toBe(400);
    expect(verifier.headObject).not.toHaveBeenCalled();
    expect(mockDb.withTransaction).not.toHaveBeenCalled();
  });

  it('rejects a composer post-staging key: staged uploads can never become library rows', async () => {
    const captured = { params: [] as any[] };
    const mockDb = makeEchoDb(captured);
    // The object exists in storage — the prefix check alone must
    // refuse it, so a staged composer upload can never be confirmed
    // into the Media Library by construction.
    const verifier = makeVerifier({ contentLength: 10485760, contentType: 'video/mp4' });

    const res = await handleConfirmUpload(
      makeRequest(
        validBody({
          storageKey: `users/${userId}/post-staging/${mediaId}/video.mp4`,
          url: `https://media.fbuploadpro.com/users/${userId}/post-staging/${mediaId}/video.mp4`,
        })
      ),
      'acme',
      mockDb as DatabaseClient,
      verifier
    );

    expect(res.status).toBe(400);
    expect(verifier.headObject).not.toHaveBeenCalled();
    expect(mockDb.withTransaction).not.toHaveBeenCalled();
  });

  it('stores the size and content type from storage, not the spoofed request values', async () => {
    const captured = { params: [] as any[] };
    const mockDb = makeEchoDb(captured);
    const verifier = makeVerifier({ contentLength: 10485760, contentType: 'video/mp4' });

    const res = await handleConfirmUpload(
      makeRequest(
        validBody({
          // Spoofed: a tiny claimed size, a different claimed type, and
          // an arbitrary external URL.
          fileSize: 123,
          mimeType: 'video/webm',
          url: 'https://evil.example.com/not-my-file.mp4',
        })
      ),
      'acme',
      mockDb as DatabaseClient,
      verifier
    );

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(captured.params[4]).toBe(10485760);
    expect(captured.params[5]).toBe('video/mp4');
    expect(captured.params[8]).toBe(
      `https://media.fbuploadpro.com/users/${userId}/media/${mediaId}/video.mp4`
    );
    expect(data.fileSize).toBe(10485760);
    expect(data.mimeType).toBe('video/mp4');
    expect(data.url).toBe(
      `https://media.fbuploadpro.com/users/${userId}/media/${mediaId}/video.mp4`
    );
  });
});
