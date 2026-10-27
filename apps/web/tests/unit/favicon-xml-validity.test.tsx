/**
 * Favicon drift guard (PR #6 regression).
 *
 * The original bug was `--` inside XML comments in `icon.svg`, which
 * is illegal XML and broke the favicon. Both shipped copies must
 * therefore parse as valid XML and contain no XML comments at all —
 * these assertions fail if a comment (with or without `--`) ever
 * creeps back into either copy.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ICON_PATHS = ['public/icon.svg', 'src/app/icon.svg'] as const;

describe('favicon icon.svg copies (PR #6 regression)', () => {
  it.each(ICON_PATHS)('%s parses as valid XML and contains no comments', (rel) => {
    const text = readFileSync(path.resolve(process.cwd(), rel), 'utf8');
    expect(text).not.toContain('<!--');
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
    expect(doc.documentElement.tagName.toLowerCase()).toBe('svg');
  });
});
