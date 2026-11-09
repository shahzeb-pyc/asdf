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

describe('FacebookPublisher account-expiry follows the classifier only', () => {
  function authError(code: number, subcode?: number): FacebookGraphError {
    return new FacebookGraphError(`Facebook Graph API error ${code}`, {
      code,
      ...(subcode !== undefined ? { error_subcode: subcode } : {}),
      type: 'OAuthException',
    });
  }

  it.each([
    // [code, subcode, expected targetAccountStatus]
    [190, undefined, 'expired'],
    [190, 463, 'expired'],
    [190, 459, undefined],
    [190, 464, undefined],
    [190, 492, undefined],
    [190, 2069032, undefined],
    [102, undefined, 'expired'],
  ] as Array<[number, number | undefined, 'expired' | undefined]>)(
    'code %s subcode %s → targetAccountStatus %s',
    async (code, subcode, expected) => {
      const publisher = new FacebookPublisher(failingClient(authError(code, subcode)));
      const outcome = await publisher.publish(
        queueItem({ retry_count: 0 }),
        destination(),
        { accessToken: 'user-token', destinationToken: 'page-token' },
      );
      expect(outcome.status).toBe('failed');
      expect(outcome.error?.code).toBe(String(code));
      // The classifier is the single decision point: checkpoint
      // (459/464), missing-role (492) and app-bug (2069032) codes
      // keep the account active even though kind is 'auth'.
      expect(outcome.targetAccountStatus).toBe(expected);
    },
  );
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

describe('FacebookPublisher spec-155 outcome fb_status marker', () => {
  function graphError(
    message: string,
    code: number,
    subcode?: number,
  ): FacebookGraphError {
    return new FacebookGraphError(message, {
      code,
      ...(subcode !== undefined ? { error_subcode: subcode } : {}),
      type: 'OAuthException',
    });
  }

  async function publishOutcome(error: unknown) {
    const publisher = new FacebookPublisher(failingClient(error));
    return publisher.publish(
      queueItem({ retry_count: 0 }),
      destination(),
      { accessToken: 'user-token', destinationToken: 'page-token' },
    );
  }

  it.each([
    // [message, code, subcode, expected coarse status, expected marker]
    ['Missing role on the page.', 190, 492, 'error', 'missing_page_access'],
    ['The app is restricted.', 190, 2069031, 'error', 'check_developer_app'],
    ['Permissions error.', 10, 200, 'error', 'missing_permission'],
    ['API access blocked for this app.', 200, undefined, 'error', 'check_developer_app'],
    ['Permissions error.', 200, 299, 'error', 'missing_permission'],
    ['Account suspended.', 368, 1404112, 'error', 'account_suspended'],
    ['This account has been suspended.', 368, undefined, 'error', 'account_suspended'],
    ['Identity verification required.', 190, 459, 'error', 'checkpoint'],
    ['Invalid token.', 190, undefined, 'error', 'invalid_token'],
  ] as Array<[string, number, number | undefined, 'error', string]>)(
    '%s (%s/%s) → %s + fb_status %s',
    async (message, code, subcode, expectedStatus, expectedMarker) => {
      const outcome = await publishOutcome(graphError(message, code, subcode));
      expect(outcome.status).toBe('failed');
      expect(outcome.targetDestinationStatus).toBe(expectedStatus);
      expect(outcome.targetDestinationFbStatus).toBe(expectedMarker);
    },
  );

  it('368/1404112 fails fast as account_suspended instead of retrying as rate-limited', async () => {
    const outcome = await publishOutcome(
      graphError('Account suspended.', 368, 1404112),
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.kind).toBe('permanent');
  });

  it('rate-limited clears any stale detail marker (explicit null)', async () => {
    const outcome = await publishOutcome(graphError('Slow down.', 368, 1390008));
    expect(outcome.targetDestinationStatus).toBe('rate_limited');
    expect('targetDestinationFbStatus' in outcome).toBe(true);
    expect(outcome.targetDestinationFbStatus).toBeNull();
  });

  it('a body-less page-gone failure maps to page_not_accessible', async () => {
    const outcome = await publishOutcome(new Error('The page was not found.'));
    expect(outcome.targetDestinationStatus).toBe('error');
    expect(outcome.targetDestinationFbStatus).toBe('page_not_accessible');
    // Uncoded errors stay retryable by the old fallback; the
    // destination flip to `error` makes the retry defer instead of
    // re-publishing into a gone page.
    expect(outcome.status).toBe('retry');
  });

  it('a transient failure leaves both the status and the marker untouched', async () => {
    const outcome = await publishOutcome(graphError('Temporary failure.', 2));
    expect(outcome.status).toBe('retry');
    expect(outcome.targetDestinationStatus).toBeUndefined();
    expect(outcome.targetDestinationFbStatus).toBeUndefined();
  });
});
