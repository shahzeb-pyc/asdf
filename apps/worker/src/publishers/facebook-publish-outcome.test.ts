/**
 * Facebook publisher failure outcomes carry a real reason, not `unknown`.
 *
 * A client error with no Graph error body (the prod reel signature: bare
 * HTTP 400, empty body) must settle with error code `http_<status>` and a
 * `detail` record holding the failing phase, HTTP status, raw body, and
 * both upload attempts — the consumer settles `detail` into
 * `publish_logs.detail`. A coded Graph error keeps its numeric code.
 */
import { describe, expect, it } from 'vitest';
import type {
  DatabaseDestinationRow,
  DatabaseUnifiedQueueItemRow,
  IFacebookPublishClient,
} from '@fbuploadpro/contracts';
import { FacebookGraphError } from '../fb-client.js';
import { FacebookPublisher } from './facebook.js';

function queueItem(overrides: Partial<DatabaseUnifiedQueueItemRow> = {}): DatabaseUnifiedQueueItemRow {
  return {
    id: '11111111-1111-4111-a111-111111111111',
    workspace_id: '33333333-3333-4333-a333-333333333333',
    destination_id: '22222222-2222-4222-a222-222222222222',
    platform: 'facebook',
    kind: 'video',
    platform_format: 'reel',
    caption: 'Windy Laundry',
    title: null,
    first_comment: null,
    media_item_id: null,
    media_url: 'https://media.test/windy-laundry.mp4',
    media_storage_key: null,
    link_url: null,
    platform_options: {},
    scheduled_time: '2026-11-02T08:30:00.000Z',
    slot_id: null,
    status: 'publishing',
    claimed_at: null,
    retry_count: 3,
    max_retries: 3,
    error_code: null,
    error_subcode: null,
    error_message: null,
    external_post_id: null,
    external_comment_id: null,
    created_at: '2026-11-02T08:30:00.000Z',
    updated_at: '2026-11-07T14:01:00.000Z',
    ...overrides,
  } as unknown as DatabaseUnifiedQueueItemRow;
}

function destination(): DatabaseDestinationRow {
  return {
    id: '22222222-2222-4222-a222-222222222222',
    external_destination_id: '110103338715385',
    status: 'active',
  } as unknown as DatabaseDestinationRow;
}

function failingClient(error: unknown): IFacebookPublishClient {
  return {
    publishReel: async () => {
      throw error;
    },
  } as unknown as IFacebookPublishClient;
}

describe('FacebookPublisher failure outcomes', () => {
  it('stores http_400 + full diagnostic when both reel uploads fail body-less', async () => {
    const bothFailed = new FacebookGraphError(
      'Facebook Graph API error: HTTP 400 (reel-upload-stream)',
      undefined,
      undefined,
      {
        phase: 'reel-upload-stream',
        httpStatus: 400,
        rawBody: '',
        attempts: [
          { mode: 'file_url', success: false, httpStatus: 400, rawBody: '' },
          { mode: 'stream', success: false, httpStatus: 400, rawBody: '' },
        ],
      }
    );
    const publisher = new FacebookPublisher(failingClient(bothFailed));

    const outcome = await publisher.publish(queueItem(), destination(), {
      accessToken: 'user-token',
      destinationToken: 'page-token',
    });

    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('http_400');
    expect(outcome.error?.kind).toBe('retryable');
    expect(outcome.error?.message).toContain('(reel-upload-stream)');
    expect(outcome.detail).toEqual({
      phase: 'reel-upload-stream',
      httpStatus: 400,
      rawBody: '',
      attempts: [
        { mode: 'file_url', success: false, httpStatus: 400, rawBody: '' },
        { mode: 'stream', success: false, httpStatus: 400, rawBody: '' },
      ],
    });
  });

  it('stores http_400 when the file_url attempt threw and streaming then failed body-less', async () => {
    const thrownThenFailed = new FacebookGraphError(
      'Facebook Graph API error: HTTP 400 (reel-upload-stream)',
      undefined,
      undefined,
      {
        phase: 'reel-upload-stream',
        httpStatus: 400,
        rawBody: '',
        attempts: [
          { mode: 'file_url', success: false, message: 'The operation timed out' },
          { mode: 'stream', success: false, httpStatus: 400, rawBody: '' },
        ],
      }
    );
    const publisher = new FacebookPublisher(failingClient(thrownThenFailed));

    const outcome = await publisher.publish(queueItem(), destination(), {
      accessToken: 'user-token',
      destinationToken: 'page-token',
    });

    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('http_400');
    expect(outcome.error?.kind).toBe('retryable');
    expect(outcome.detail?.attempts).toEqual([
      { mode: 'file_url', success: false, message: 'The operation timed out' },
      { mode: 'stream', success: false, httpStatus: 400, rawBody: '' },
    ]);
  });

  it('keeps the numeric Graph code when Facebook returns one', async () => {
    const authError = new FacebookGraphError('Access token is invalid or revoked.', {
      code: 190,
      type: 'OAuthException',
    });
    const publisher = new FacebookPublisher(failingClient(authError));

    const outcome = await publisher.publish(queueItem(), destination(), {
      accessToken: 'user-token',
      destinationToken: 'page-token',
    });

    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('190');
    expect(outcome.error?.kind).toBe('auth');
    expect(outcome.detail).toBeUndefined();
    expect(outcome.targetAccountStatus).toBe('expired');
  });

  it('passes the queue item id to publishReel for console logging', async () => {
    let seenItemId: string | undefined;
    const client = {
      publishReel: async (params: { itemId?: string }) => {
        seenItemId = params.itemId;
        return { postId: 'post-123' };
      },
    } as unknown as IFacebookPublishClient;
    const publisher = new FacebookPublisher(client);

    const outcome = await publisher.publish(queueItem(), destination(), {
      accessToken: 'user-token',
      destinationToken: 'page-token',
    });

    expect(outcome.status).toBe('published');
    expect(outcome.externalPostId).toBe('post-123');
    expect(seenItemId).toBe('11111111-1111-4111-a111-111111111111');
  });
});

describe('FacebookPublisher content-code retry cap (100 / 1609005)', () => {
  function contentError(code: number): FacebookGraphError {
    return new FacebookGraphError(`Facebook Graph API error ${code}`, {
      code,
      type: 'OAuthException',
    });
  }

  it.each([100, 1609005])(
    'code %s retries at retry_count 0 and 1, then fails at 2',
    async (code) => {
      for (const [retryCount, expected] of [
        [0, 'retry'],
        [1, 'retry'],
        [2, 'failed'],
      ] as const) {
        const publisher = new FacebookPublisher(failingClient(contentError(code)));
        const outcome = await publisher.publish(
          queueItem({ retry_count: retryCount }),
          destination(),
          { accessToken: 'user-token', destinationToken: 'page-token' },
        );
        expect(outcome.status).toBe(expected);
        expect(outcome.error?.code).toBe(String(code));
        // `kind` stays the terminal classification; only the retry
        // disposition changes with the attempt count.
        expect(outcome.error?.kind).toBe('permanent');
      }
    },
  );

  it('app-bug code 190/2069032 fails immediately, never retries', async () => {
    const publisher = new FacebookPublisher(
      failingClient(
        new FacebookGraphError('Wrong token type.', {
          code: 190,
          error_subcode: 2069032,
          type: 'OAuthException',
        }),
      ),
    );
    const outcome = await publisher.publish(
      queueItem({ retry_count: 0 }),
      destination(),
      { accessToken: 'user-token', destinationToken: 'page-token' },
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('190');
    expect(outcome.error?.subcode).toBe('2069032');
  });

  it('app-bug code 3 fails immediately, never retries', async () => {
    const publisher = new FacebookPublisher(
      failingClient(
        new FacebookGraphError('API Method not supported.', {
          code: 3,
          type: 'OAuthException',
        }),
      ),
    );
    const outcome = await publisher.publish(
      queueItem({ retry_count: 0 }),
      destination(),
      { accessToken: 'user-token', destinationToken: 'page-token' },
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('3');
  });
});
