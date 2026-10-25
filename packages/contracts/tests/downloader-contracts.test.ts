import { describe, it, expect } from 'vitest';
import {
  MAX_MEDIA_DOWNLOAD_BYTES,
  detectSourcePlatform,
  validateSafeRemoteUrl,
  deduplicateBatchUrls,
  DownloaderIngestRequestSchema,
  DownloaderIngestResponseSchema,
} from '../src/index.js';

describe('Cloud Media Downloader Contracts (Spec 031)', () => {
  describe('detectSourcePlatform', () => {
    it('classifies social, cloud drive, direct media, and generic web URLs accurately', () => {
      expect(detectSourcePlatform('https://www.tiktok.com/@creator/video/7123456789')).toBe('tiktok');
      expect(detectSourcePlatform('https://vm.tiktok.com/ZM12345/')).toBe('tiktok');
      expect(detectSourcePlatform('https://www.facebook.com/reel/123456789')).toBe('facebook');
      expect(detectSourcePlatform('https://fb.watch/abcDEF123/')).toBe('facebook');
      expect(detectSourcePlatform('https://www.instagram.com/reel/C123456789/')).toBe('instagram');
      expect(detectSourcePlatform('https://x.com/creator/status/1800000000000000000')).toBe('x');
      expect(detectSourcePlatform('https://twitter.com/creator/status/1800000000000000000')).toBe('x');
      expect(detectSourcePlatform('https://www.youtube.com/shorts/abc123xyz')).toBe('youtube');
      expect(detectSourcePlatform('https://youtu.be/abc123xyz')).toBe('youtube');
      expect(
        detectSourcePlatform('https://drive.google.com/file/d/1ABCdefGHIjkl/view?usp=sharing')
      ).toBe('google_drive');
      expect(
        detectSourcePlatform('https://www.dropbox.com/s/abc123xyz/promo_reel.mp4?dl=0')
      ).toBe('dropbox');
      expect(detectSourcePlatform('https://cdn.example.com/assets/launch_video.mp4')).toBe('direct');
      expect(detectSourcePlatform('https://cdn.example.com/assets/poster.webp?v=2')).toBe('direct');
      expect(detectSourcePlatform('https://blog.example.com/articles/featured-post')).toBe('web');
      expect(detectSourcePlatform('not-a-valid-url')).toBe('web');
    });
  });

  describe('validateSafeRemoteUrl (SSRF & Protocol Guards)', () => {
    it('accepts valid public HTTP and HTTPS URLs', () => {
      const httpsRes = validateSafeRemoteUrl('https://cdn.example.com/media/reel.mp4');
      expect(httpsRes.valid).toBe(true);
      expect(httpsRes.url?.hostname).toBe('cdn.example.com');

      const publicIpRes = validateSafeRemoteUrl('https://93.184.216.34/video.mp4');
      expect(publicIpRes.valid).toBe(true);

      const nonPrivate172 = validateSafeRemoteUrl('https://172.32.0.1/video.mp4');
      expect(nonPrivate172.valid).toBe(true);
    });

    it('rejects empty, malformed, non-HTTP(S), or credential-bearing URLs', () => {
      expect(validateSafeRemoteUrl('').valid).toBe(false);
      expect(validateSafeRemoteUrl('   ').valid).toBe(false);
      expect(validateSafeRemoteUrl('ftp://files.example.com/video.mp4').valid).toBe(false);
      expect(validateSafeRemoteUrl('file:///etc/passwd').valid).toBe(false);
      expect(validateSafeRemoteUrl('javascript:alert(1)').valid).toBe(false);
      expect(validateSafeRemoteUrl('https://admin:secret@example.com/video.mp4').valid).toBe(false);
      expect(validateSafeRemoteUrl('http://intranet-host/video.mp4').valid).toBe(false);
    });

    it('rejects localhost, .local, .internal, and IPv4 loopback/private/link-local ranges', () => {
      expect(validateSafeRemoteUrl('http://localhost:3000/api/health').valid).toBe(false);
      expect(validateSafeRemoteUrl('http://sub.localhost/secret').valid).toBe(false);
      expect(validateSafeRemoteUrl('http://printer.local/stream.mp4').valid).toBe(false);
      expect(validateSafeRemoteUrl('http://metadata.google.internal/computeMetadata/v1/').valid).toBe(
        false
      );
      expect(validateSafeRemoteUrl('http://127.0.0.1:8080/video.mp4').valid).toBe(false);
      expect(validateSafeRemoteUrl('http://127.255.255.254/video.mp4').valid).toBe(false);
      expect(validateSafeRemoteUrl('http://2130706433/video.mp4').valid).toBe(false); // 127.0.0.1 decimal
      expect(validateSafeRemoteUrl('http://0.0.0.0/video.mp4').valid).toBe(false);
      expect(validateSafeRemoteUrl('http://10.0.0.15/video.mp4').valid).toBe(false);
      expect(validateSafeRemoteUrl('http://172.16.0.1/video.mp4').valid).toBe(false);
      expect(validateSafeRemoteUrl('http://172.31.255.255/video.mp4').valid).toBe(false);
      expect(validateSafeRemoteUrl('http://192.168.1.100/video.mp4').valid).toBe(false);
      expect(validateSafeRemoteUrl('http://169.254.169.254/latest/meta-data/').valid).toBe(false);
      expect(validateSafeRemoteUrl('http://100.64.0.1/video.mp4').valid).toBe(false);
      expect(validateSafeRemoteUrl('http://224.0.0.1/video.mp4').valid).toBe(false);
    });

    it('rejects IPv6 loopback, unspecified, unique-local, link-local, and IPv4-mapped private addresses', () => {
      expect(validateSafeRemoteUrl('http://[::1]:3000/video.mp4').valid).toBe(false);
      expect(validateSafeRemoteUrl('http://[::]/video.mp4').valid).toBe(false);
      expect(validateSafeRemoteUrl('http://[fc00::1]/video.mp4').valid).toBe(false);
      expect(validateSafeRemoteUrl('http://[fd12:3456:789a::1]/video.mp4').valid).toBe(false);
      expect(validateSafeRemoteUrl('http://[fe80::1]/video.mp4').valid).toBe(false);
      expect(validateSafeRemoteUrl('http://[ff02::1]/video.mp4').valid).toBe(false);
      expect(validateSafeRemoteUrl('http://[::ffff:127.0.0.1]/video.mp4').valid).toBe(false);
      expect(validateSafeRemoteUrl('http://[::ffff:10.0.0.1]/video.mp4').valid).toBe(false);
      expect(validateSafeRemoteUrl('http://[::ffff:192.168.1.1]/video.mp4').valid).toBe(false);
      expect(validateSafeRemoteUrl('http://[::ffff:169.254.169.254]/video.mp4').valid).toBe(false);
      expect(validateSafeRemoteUrl('http://[::ffff:93.184.216.34]/video.mp4').valid).toBe(true);
    });
  });

  describe('deduplicateBatchUrls', () => {
    it('deduplicates identical URLs, preserves order, and separates invalid lines', () => {
      const rawBatch = [
        '  https://www.tiktok.com/@creator/video/111  ',
        '',
        'https://cdn.example.com/clip-a.mp4',
        'https://www.tiktok.com/@creator/video/111',
        'http://127.0.0.1/internal.mp4',
        'https://cdn.example.com/clip-b.mp4',
        'https://cdn.example.com/clip-a.mp4',
        'not_a_url',
      ].join('\r\n');

      const result = deduplicateBatchUrls(rawBatch);
      expect(result.urls).toEqual([
        'https://www.tiktok.com/@creator/video/111',
        'https://cdn.example.com/clip-a.mp4',
        'https://cdn.example.com/clip-b.mp4',
      ]);
      expect(result.duplicateCount).toBe(2);
      expect(result.invalidUrls).toEqual(['http://127.0.0.1/internal.mp4', 'not_a_url']);
      expect(result.invalidLines).toEqual(['http://127.0.0.1/internal.mp4', 'not_a_url']);
    });
  });

  describe('DownloaderIngestRequestSchema & DownloaderIngestResponseSchema', () => {
    it('exports MAX_MEDIA_DOWNLOAD_BYTES = 524,288,000 (500 MB)', () => {
      expect(MAX_MEDIA_DOWNLOAD_BYTES).toBe(524_288_000);
    });

    it('validates DownloaderIngestRequestSchema with optional folderId', () => {
      const validWithFolder = DownloaderIngestRequestSchema.safeParse({
        url: '  https://www.tiktok.com/@creator/video/12345  ',
        folderId: '11111111-1111-4111-a111-111111111111',
      });
      expect(validWithFolder.success).toBe(true);
      if (validWithFolder.success) {
        expect(validWithFolder.data.url).toBe('https://www.tiktok.com/@creator/video/12345');
      }

      const validRoot = DownloaderIngestRequestSchema.safeParse({
        url: 'https://cdn.example.com/video.mp4',
        folderId: null,
      });
      expect(validRoot.success).toBe(true);

      const invalidEmpty = DownloaderIngestRequestSchema.safeParse({
        url: '   ',
      });
      expect(invalidEmpty.success).toBe(false);
    });

    it('validates DownloaderIngestResponseSchema with single and multi-item carousel outputs', () => {
      const nowIso = new Date().toISOString();
      const validResponse = DownloaderIngestResponseSchema.safeParse({
        sourceUrl: 'https://x.com/creator/status/1800000000000000000',
        platform: 'x',
        items: [
          {
            id: '11111111-1111-4111-a111-111111111111',
            userId: '22222222-2222-4222-a222-222222222222',
            folderId: '33333333-3333-4333-a333-333333333333',
            name: 'carousel_1.mp4',
            fileSize: 4200000,
            mimeType: 'video/mp4',
            mediaType: 'video',
            storageKey: 'users/222/media/111/carousel_1.mp4',
            url: 'https://media.fbuploadpro.com/users/222/media/111/carousel_1.mp4',
            thumbnailKey: 'users/222/thumbnails/111.jpeg',
            thumbnailUrl: 'https://media.fbuploadpro.com/users/222/thumbnails/111.jpeg',
            durationSeconds: 18,
            aspectRatio: '9:16',
            captionText: 'Thread highlight reel #launch',
            createdAt: nowIso,
            updatedAt: nowIso,
          },
        ],
      });
      expect(validResponse.success).toBe(true);

      const emptyItemsResponse = DownloaderIngestResponseSchema.safeParse({
        sourceUrl: 'https://x.com/creator/status/1800000000000000000',
        platform: 'x',
        items: [],
      });
      expect(emptyItemsResponse.success).toBe(false);
    });
  });

});

