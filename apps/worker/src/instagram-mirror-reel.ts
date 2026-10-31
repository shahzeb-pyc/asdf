import { InternalError } from '@fbuploadpro/contracts';
import {
  InstagramGraphError,
  InstagramPublishClient,
  type IInstagramPublishClient,
} from './instagram-client.js';

/**
 * Instagram reel publish for the mirror tick.
 *
 * Same container flow as the queue Instagram publisher, in the
 * mirror tick's shape: create a REELS container from the resolved
 * no-watermark TikTok URL (Meta fetches it — no bytes are streamed,
 * unlike the Facebook reel path), poll status_code until FINISHED,
 * then publish. An ambiguous publish failure re-reads the container:
 * PUBLISHED settles published with the container id, never a second
 * publish call — the mirror tick's claim guard plus this recheck are
 * the two layers that stop a double-post.
 *
 * Errors are plain-language by construction: an auth failure (190)
 * is the expired message, so processMirrorCheck's Facebook-only
 * restriction rewrite must never run over these messages.
 */

export const INSTAGRAM_MIRROR_REEL_EXPIRED_MESSAGE =
  'This Instagram account has expired. Reconnect the account and try again.';

export async function publishInstagramMirrorReel(params: {
  igUserId: string;
  accessToken: string;
  videoUrl: string;
  caption: string;
  coverUrl?: string | null;
  client?: IInstagramPublishClient;
  pollIntervalMs?: number;
  maxPolls?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<string> {
  const {
    igUserId,
    accessToken,
    videoUrl,
    caption,
    coverUrl,
    client = new InstagramPublishClient(),
    pollIntervalMs = 60_000,
    maxPolls = 5,
    sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = params;

  let containerId: string;
  try {
    const created = await client.createContainer({
      igUserId,
      accessToken,
      mediaType: 'REELS',
      videoUrl,
      caption,
      ...(coverUrl ? { coverUrl } : {}),
    });
    containerId = created.containerId;
  } catch (err) {
    throw toPlainError(err);
  }

  let statusCode = '';
  for (let attempt = 0; attempt < maxPolls; attempt++) {
    try {
      const status = await client.getContainerStatus({ containerId, accessToken });
      statusCode = status.statusCode;
    } catch (err) {
      throw toPlainError(err);
    }
    if (statusCode === 'FINISHED' || statusCode === 'PUBLISHED') break;
    if (statusCode === 'ERROR' || statusCode === 'EXPIRED') {
      throw new InternalError('Instagram could not prepare this reel. Check the video and try again.');
    }
    if (attempt < maxPolls - 1) await sleep(pollIntervalMs);
  }
  if (statusCode === 'PUBLISHED') return containerId;
  if (statusCode !== 'FINISHED') {
    throw new InternalError('Instagram is still preparing this reel. This post remains pending.');
  }

  try {
    const published = await client.publishContainer({ igUserId, accessToken, containerId });
    return published.mediaId;
  } catch (err) {
    // Ambiguous failure: re-read before deciding. PUBLISHED means
    // the reel is live despite the error.
    try {
      const recheck = await client.getContainerStatus({ containerId, accessToken });
      if (recheck.statusCode === 'PUBLISHED') return containerId;
    } catch {
      // A failed recheck leaves the original error standing.
    }
    throw toPlainError(err);
  }
}

function toPlainError(err: unknown): Error {
  if (err instanceof InstagramGraphError) {
    if (err.code === 190) return new Error(INSTAGRAM_MIRROR_REEL_EXPIRED_MESSAGE);
    return new Error(err.message);
  }
  return err instanceof Error ? err : new Error(String(err));
}
