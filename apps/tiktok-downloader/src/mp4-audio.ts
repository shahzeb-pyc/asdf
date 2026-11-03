/**
 * MP4 audio-track probe, the ffprobe-free equivalent of the old
 * downloader's `verify_video_has_audio`.
 *
 * Semantics ported from the old code, in order:
 *  1. A successful structural probe that finds tracks but no audio track
 *     is POSITIVE PROOF of no audio -> 'no-audio' (reject).
 *  2. Byte markers (`soun` / `mp4a` / `esds`) in the window are proof of
 *     audio -> 'has-audio' (the old binary fallback).
 *  3. Anything inconclusive (no `moov` in the window, truncated `moov`)
 *     -> 'inconclusive' (accept). The old code explicitly avoided
 *     hard-blocking when both probes were inconclusive.
 */

export type AudioProbe = 'has-audio' | 'no-audio' | 'inconclusive';

interface Box {
  type: string;
  /** Offset of the box content (after the header). */
  contentStart: number;
  /** Offset just past the box, or null when the box runs past the window. */
  end: number | null;
  /** False when the box header itself is truncated. */
  headerComplete: boolean;
}

function readBox(data: Uint8Array, offset: number): Box | null {
  if (offset + 8 > data.length) {
    return null;
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let size = view.getUint32(offset);
  let headerSize = 8;
  if (size === 1) {
    // 64-bit largesize.
    if (offset + 16 > data.length) {
      return { type: '', contentStart: offset + 8, end: null, headerComplete: false };
    }
    const big = view.getBigUint64(offset + 8);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
      return { type: '', contentStart: offset + 16, end: null, headerComplete: false };
    }
    size = Number(big);
    headerSize = 16;
  }
  const type = String.fromCharCode(
    data[offset + 4],
    data[offset + 5],
    data[offset + 6],
    data[offset + 7],
  );
  if (size === 0) {
    // Box extends to end of file: past this window by definition.
    return { type, contentStart: offset + headerSize, end: null, headerComplete: true };
  }
  if (size < headerSize) {
    return { type, contentStart: offset + headerSize, end: null, headerComplete: false };
  }
  const end = offset + size;
  return {
    type,
    contentStart: offset + headerSize,
    end: end <= data.length ? end : null,
    headerComplete: true,
  };
}

function asciiAt(data: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += String.fromCharCode(data[offset + i]);
  }
  return out;
}

function containsMarker(data: Uint8Array, marker: string): boolean {
  const needle = new TextEncoder().encode(marker);
  outer: for (let i = 0; i + needle.length <= data.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (data[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Inspect one `trak` box: true when it carries an audio track, false when
 * it is a fully parsed non-audio track, null when it cannot be fully
 * parsed inside the window.
 */
function trakHasAudio(data: Uint8Array, trak: Box): boolean | null {
  if (trak.end === null) return null;
  let offset = trak.contentStart;
  while (offset + 8 <= trak.end) {
    const child = readBox(data, offset);
    if (child === null || child.end === null || child.end > trak.end) return null;
    if (child.type === 'mdia') {
      let mdiaOffset = child.contentStart;
      while (mdiaOffset + 8 <= child.end) {
        const mdiaChild = readBox(data, mdiaOffset);
        if (mdiaChild === null || mdiaChild.end === null || mdiaChild.end > child.end) {
          return null;
        }
        if (mdiaChild.type === 'hdlr') {
          // hdlr content: 4 version/flags + 4 pre_defined + 4 handler_type.
          if (mdiaChild.contentStart + 12 <= mdiaChild.end) {
            return asciiAt(data, mdiaChild.contentStart + 8, 4) === 'soun';
          }
          return null;
        }
        if (mdiaChild.type === 'minf') {
          // Second signal: an `mp4a` sample entry in stbl/stsd.
          let minfOffset = mdiaChild.contentStart;
          while (minfOffset + 8 <= mdiaChild.end) {
            const minfChild = readBox(data, minfOffset);
            if (minfChild === null || minfChild.end === null || minfChild.end > mdiaChild.end) {
              return null;
            }
            if (minfChild.type === 'stbl') {
              let stblOffset = minfChild.contentStart;
              while (stblOffset + 8 <= minfChild.end) {
                const stblChild = readBox(data, stblOffset);
                if (stblChild === null || stblChild.end === null || stblChild.end > minfChild.end) {
                  return null;
                }
                if (stblChild.type === 'stsd') {
                  // stsd content: 4 version/flags + 4 entry_count, then entries.
                  let entryOffset = stblChild.contentStart + 8;
                  while (entryOffset + 8 <= stblChild.end) {
                    const entry = readBox(data, entryOffset);
                    if (entry === null || entry.end === null || entry.end > stblChild.end) {
                      return null;
                    }
                    if (entry.type === 'mp4a') return true;
                    entryOffset = entry.end;
                  }
                  return false;
                }
                stblOffset = stblChild.end;
              }
              // No stsd in this stbl: cannot decide this track structurally.
              return null;
            }
            minfOffset = minfChild.end;
          }
          return null;
        }
        mdiaOffset = mdiaChild.end;
      }
      return null;
    }
    offset = child.end;
  }
  return null;
}

export function probeMp4Audio(window: Uint8Array): AudioProbe {
  let offset = 0;
  let moovFound = false;
  while (offset + 8 <= window.length) {
    const box = readBox(window, offset);
    if (box === null || !box.headerComplete || box.end === null) {
      break;
    }
    if (box.type === 'moov') {
      moovFound = true;
      let trackCount = 0;
      let audioTracks = 0;
      let truncated = false;
      let trakOffset = box.contentStart;
      while (trakOffset + 8 <= box.end) {
        const trak = readBox(window, trakOffset);
        if (trak === null || trak.end === null || trak.end > box.end) {
          truncated = true;
          break;
        }
        if (trak.type === 'trak') {
          trackCount += 1;
          const hasAudio = trakHasAudio(window, trak);
          if (hasAudio === null) {
            truncated = true;
            break;
          }
          if (hasAudio) audioTracks += 1;
        }
        trakOffset = trak.end;
      }
      if (!truncated && trackCount > 0) {
        return audioTracks > 0 ? 'has-audio' : 'no-audio';
      }
      // Truncated or trackless moov: inconclusive, fall through to markers.
      break;
    }
    offset = box.end;
  }
  if (!moovFound) {
    // No moov in the window at all: inconclusive unless a marker proves audio.
  }
  if (
    containsMarker(window, 'soun') ||
    containsMarker(window, 'mp4a') ||
    containsMarker(window, 'esds')
  ) {
    return 'has-audio';
  }
  return 'inconclusive';
}
