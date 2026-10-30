import { describe, it, expect } from 'vitest';
import {
  deriveFileNameFromUrl,
  extractFilenameFromContentDisposition,
  resolveAllowedMimeType,
  sanitizeFileNameWithExtension,
} from '../src/index.js';

describe('resolveAllowedMimeType', () => {
  it('accepts the six allowed types from the content-type header', () => {
    expect(resolveAllowedMimeType('video/mp4', 'https://cdn.example.com/x')).toBe('video/mp4');
    expect(resolveAllowedMimeType('video/quicktime', 'https://cdn.example.com/x')).toBe(
      'video/quicktime'
    );
    expect(resolveAllowedMimeType('video/webm', 'https://cdn.example.com/x')).toBe('video/webm');
    expect(resolveAllowedMimeType('image/jpeg', 'https://cdn.example.com/x')).toBe('image/jpeg');
    expect(resolveAllowedMimeType('image/png', 'https://cdn.example.com/x')).toBe('image/png');
    expect(resolveAllowedMimeType('image/webp', 'https://cdn.example.com/x')).toBe('image/webp');
  });

  it('normalizes legacy aliases and strips header parameters', () => {
    expect(resolveAllowedMimeType('image/jpg', 'https://cdn.example.com/x')).toBe('image/jpeg');
    expect(resolveAllowedMimeType('video/x-m4v', 'https://cdn.example.com/x')).toBe('video/mp4');
    expect(resolveAllowedMimeType('video/mp4; charset=utf-8', 'https://cdn.example.com/x')).toBe(
      'video/mp4'
    );
    expect(resolveAllowedMimeType('VIDEO/MP4', 'https://cdn.example.com/x')).toBe('video/mp4');
  });

  it('rejects page/document types outright, never inferring from the URL', () => {
    expect(resolveAllowedMimeType('text/html', 'https://cdn.example.com/clip.mp4')).toBeNull();
    expect(resolveAllowedMimeType('application/json', 'https://cdn.example.com/pic.png')).toBeNull();
    expect(resolveAllowedMimeType('text/plain', 'https://cdn.example.com/pic.png')).toBeNull();
    expect(
      resolveAllowedMimeType('application/xhtml+xml', 'https://cdn.example.com/pic.png')
    ).toBeNull();
  });

  it('falls back to the filename hint, then the URL extension', () => {
    expect(
      resolveAllowedMimeType('application/octet-stream', 'https://cdn.example.com/dl', 'clip.mov')
    ).toBe('video/quicktime');
    expect(
      resolveAllowedMimeType('application/octet-stream', 'https://cdn.example.com/photo.webp', null)
    ).toBe('image/webp');
    expect(
      resolveAllowedMimeType('application/octet-stream', 'https://cdn.example.com/dl?x=1', null)
    ).toBeNull();
  });

  it('uses the media-type hint only for empty/generic bodies', () => {
    expect(resolveAllowedMimeType('', 'https://cdn.example.com/dl', null, 'video')).toBe('video/mp4');
    expect(
      resolveAllowedMimeType('application/octet-stream', 'https://cdn.example.com/dl', null, 'image')
    ).toBe('image/jpeg');
    expect(
      resolveAllowedMimeType('application/pdf', 'https://cdn.example.com/dl', null, 'video')
    ).toBeNull();
  });
});

describe('extractFilenameFromContentDisposition', () => {
  it('prefers the RFC 5987 encoded name, then quoted, then plain', () => {
    expect(
      extractFilenameFromContentDisposition(
        "attachment; filename*=UTF-8''my%20clip.mp4; filename=\"other.mp4\""
      )
    ).toBe('my clip.mp4');
    expect(extractFilenameFromContentDisposition('attachment; filename="clip.mp4"')).toBe(
      'clip.mp4'
    );
    expect(extractFilenameFromContentDisposition('attachment; filename=clip.mp4')).toBe('clip.mp4');
  });

  it('returns null for missing headers or headers without a filename', () => {
    expect(extractFilenameFromContentDisposition(null)).toBeNull();
    expect(extractFilenameFromContentDisposition('attachment')).toBeNull();
  });
});

describe('sanitizeFileNameWithExtension', () => {
  it('cleans unsafe characters and appends the mime extension', () => {
    expect(sanitizeFileNameWithExtension('my clip: part 1', 'video/mp4', 'fallback')).toBe(
      'my_clip_part_1.mp4'
    );
    expect(sanitizeFileNameWithExtension('already.mp4', 'video/mp4', 'fallback')).toBe(
      'already.mp4'
    );
    expect(sanitizeFileNameWithExtension(null, 'image/png', 'fallback')).toBe('fallback.png');
    expect(sanitizeFileNameWithExtension('  ', 'image/jpeg', 'fallback')).toBe('fallback.jpg');
  });

  it('keeps an existing valid extension instead of double-appending', () => {
    expect(sanitizeFileNameWithExtension('photo.PNG', 'image/png', 'fallback')).toBe('photo.PNG');
  });
});

describe('deriveFileNameFromUrl', () => {
  it('takes the last path segment, decoded', () => {
    expect(deriveFileNameFromUrl('https://cdn.example.com/a/my%20clip.mp4', 0)).toBe(
      'my clip.mp4'
    );
    expect(deriveFileNameFromUrl('https://cdn.example.com/a/', 0)).toBe('cloud_media');
    expect(deriveFileNameFromUrl('https://cdn.example.com/a/', 2)).toBe('cloud_media_3');
    expect(deriveFileNameFromUrl('not a url', 0)).toBe('cloud_media');
  });
});
