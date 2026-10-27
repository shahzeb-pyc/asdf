/**
 * Publisher-driven form + bulk-add absence.
 *
 * - A posting time must have at least one format picked: Add starts
 *   with none selected and the schema rejects an empty selection.
 * - Bulk-add is deleted entirely: its directory is gone and no live
 *   source file imports anything from a bulk path.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  getPostingTimeFormInitialState,
  ALL_POST_FORMATS,
} from '../../src/components/pages/dedicated/posting-times/posting-time-utils';
import { postingTimeFormSchema } from '../../src/components/pages/dedicated/posting-times/posting-time-form';

describe('posting-time form format requirement', () => {
  it('starts Add with no format selected, so saving requires a pick', () => {
    const initial = getPostingTimeFormInitialState(null);
    expect(initial.selectedFormats).toEqual([]);
    const parsed = postingTimeFormSchema.safeParse({
      timeInput: '09:00',
      selectedFormats: [],
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a save with one format picked', () => {
    const parsed = postingTimeFormSchema.safeParse({
      timeInput: '09:00',
      selectedFormats: ['text'],
    });
    expect(parsed.success).toBe(true);
  });

  it('keeps an edited slot formats, and normalises a legacy null list to all formats', () => {
    expect(
      getPostingTimeFormInitialState({ slotTime: '15:00', allowedFormats: ['image'] })
        .selectedFormats
    ).toEqual(['image']);
    expect(
      getPostingTimeFormInitialState({ slotTime: '15:00', allowedFormats: null })
        .selectedFormats
    ).toEqual(ALL_POST_FORMATS.map((format) => format.id));
  });
});

describe('bulk-add absence', () => {
  const dedicatedDir = path.resolve(
    __dirname,
    '../../src/components/pages/dedicated'
  );

  it('has no bulk directory anymore', () => {
    expect(existsSync(path.join(dedicatedDir, 'bulk'))).toBe(false);
  });

  it('has no live import from a bulk path', () => {
    const offenders: string[] = [];
    const bulkImport = /(?:from\s+['"]|import\s+['"])[^'"]*\/bulk\//;
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.(ts|tsx)$/.test(entry.name)) {
          continue;
        }
        const source = readFileSync(full, 'utf8');
        if (bulkImport.test(source)) offenders.push(full);
      }
    };
    walk(path.resolve(__dirname, '../../src'));
    expect(offenders).toEqual([]);
  });
});
