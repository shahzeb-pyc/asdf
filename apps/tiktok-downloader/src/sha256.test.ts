import { describe, expect, it } from 'vitest';
import { Sha256, sha256Hex } from './sha256.js';

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('Sha256', () => {
  it('matches the empty-string vector', () => {
    expect(sha256Hex(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('matches the "abc" vector', () => {
    expect(sha256Hex(bytes('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('matches the million-"a" vector with chunked updates', () => {
    const h = new Sha256();
    const chunk = new Uint8Array(1000).fill(0x61);
    for (let i = 0; i < 1000; i++) {
      h.update(chunk);
    }
    expect([...h.digest()].map((b) => b.toString(16).padStart(2, '0')).join('')).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    );
  });

  it('matches real vectors at padding boundaries (55, 56, 64, 65, 119, 120 bytes)', () => {
    const expected: Record<number, string> = {
      55: '9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318',
      56: 'b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a',
      64: 'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb',
      65: '635361c48bb9eab14198e76ea8ab7f1a41685d6ad62aa9146d301d4f17eb0ae0',
      119: '31eba51c313a5c08226adf18d4a359cfdfd8d2e816b13f4af952f7ea6584dcfb',
      120: '2f3d335432c70b580af0e8e1b3674a7c020d683aa5f73aaaedfdc55af904c21c',
    };
    for (const [len, hash] of Object.entries(expected)) {
      expect(sha256Hex(new Uint8Array(Number(len)).fill(0x61))).toBe(hash);
    }
  });

  it('rejects update after digest', () => {
    const h = new Sha256();
    h.digest();
    expect(() => h.update(bytes('x'))).toThrow();
  });
});
