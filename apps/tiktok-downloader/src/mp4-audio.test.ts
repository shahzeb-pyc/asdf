import { describe, expect, it } from 'vitest';
import { probeMp4Audio } from './mp4-audio.js';

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function box(type: string, ...children: Uint8Array[]): Uint8Array {
  const payload = concat(...children);
  return concat(u32(8 + payload.length), new TextEncoder().encode(type), payload);
}

function hdlr(handler: string): Uint8Array {
  // version/flags (4) + pre_defined (4) + handler_type (4) + reserved + name.
  return box(
    'hdlr',
    concat(
      new Uint8Array(8),
      new TextEncoder().encode(handler),
      new Uint8Array(12),
    ),
  );
}

function stsd(...entryTypes: string[]): Uint8Array {
  const entries = entryTypes.map((t) =>
    box(t, new Uint8Array(4)),
  );
  return box('stsd', concat(new Uint8Array(4), u32(entryTypes.length), ...entries));
}

function trak(handler: string | null, stsdEntries: string[] = []): Uint8Array {
  const mdiaChildren: Uint8Array[] = [];
  if (handler !== null) mdiaChildren.push(hdlr(handler));
  if (stsdEntries.length > 0) {
    mdiaChildren.push(box('minf', box('stbl', stsd(...stsdEntries))));
  }
  return box('trak', box('mdia', ...mdiaChildren));
}

function moov(...traks: Uint8Array[]): Uint8Array {
  return box('moov', ...traks);
}

describe('probeMp4Audio', () => {
  it('rejects a moov with only a video track (positive proof of no audio)', () => {
    const file = concat(box('ftyp', new Uint8Array(8)), moov(trak('vide')));
    expect(probeMp4Audio(file)).toBe('no-audio');
  });

  it('accepts a moov with an audio track', () => {
    const file = concat(box('ftyp', new Uint8Array(8)), moov(trak('vide'), trak('soun')));
    expect(probeMp4Audio(file)).toBe('has-audio');
  });

  it('accepts an mp4a stsd entry even without an hdlr', () => {
    const file = concat(box('ftyp', new Uint8Array(8)), moov(trak(null, ['mp4a'])));
    expect(probeMp4Audio(file)).toBe('has-audio');
  });

  it('treats a file with no moov as inconclusive', () => {
    const file = concat(box('ftyp', new Uint8Array(8)), box('mdat', new Uint8Array(64)));
    expect(probeMp4Audio(file)).toBe('inconclusive');
  });

  it('treats a truncated moov as inconclusive', () => {
    const full = moov(trak('vide'));
    // Claim a moov larger than the bytes present.
    const truncated = full.subarray(0, full.length - 4);
    expect(probeMp4Audio(truncated)).toBe('inconclusive');
  });

  it('accepts on marker bytes even without a moov', () => {
    const file = concat(
      box('ftyp', new Uint8Array(8)),
      box('free', new TextEncoder().encode('xxmp4axx')),
    );
    expect(probeMp4Audio(file)).toBe('has-audio');
  });

  it('treats an empty window as inconclusive', () => {
    expect(probeMp4Audio(new Uint8Array(0))).toBe('inconclusive');
  });
});
