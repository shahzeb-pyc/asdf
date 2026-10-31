import { describe, expect, it } from 'vitest';
import { MediaStorageResponseSchema } from '@fbuploadpro/contracts';
import {
  STORAGE_BYTES_PER_UNIT,
  deriveMediaStorageState,
  formatStorageGbOneDecimal,
  isMediaStorageOver,
  toMediaStorageDisplay,
} from '../../src/lib/billing/storage-quota';

/**
 * Media Library storage display states: one derivation shared by the
 * meter and the upload enforcement, so the two cannot disagree.
 * 1 GiB = 1,073,741,824 bytes; 1 unit = 5 GiB.
 */
const GIB = 1073741824;

describe('deriveMediaStorageState', () => {
  it('returns null with no active period (quota 0), whatever is stored', () => {
    expect(deriveMediaStorageState(0, 0)).toBeNull();
    expect(deriveMediaStorageState(10 * GIB, 0)).toBeNull();
  });

  it('is normal below the 80% near threshold', () => {
    expect(deriveMediaStorageState(19 * GIB, 25 * GIB)).toBe('normal');
    expect(deriveMediaStorageState(0, 25 * GIB)).toBe('normal');
  });

  it('warns at exactly 80% and stays near below 100%', () => {
    expect(deriveMediaStorageState(20 * GIB, 25 * GIB)).toBe('near');
    expect(deriveMediaStorageState(24 * GIB, 25 * GIB)).toBe('near');
  });

  it('is full at exactly 100%, over above it', () => {
    expect(deriveMediaStorageState(25 * GIB, 25 * GIB)).toBe('full');
    expect(deriveMediaStorageState(26 * GIB, 25 * GIB)).toBe('over');
  });

  it('derives the downgrade case from live numbers, not a stored flag', () => {
    // Renewed at 4 units (20 GiB) while 25 GiB is stored: over, with
    // no upload happening — the comparison alone engages read-only.
    expect(deriveMediaStorageState(25 * GIB, 20 * GIB)).toBe('over');
  });
});

describe('toMediaStorageDisplay', () => {
  it('computes 5 purchased units as a 25 GB total with remaining', () => {
    const display = toMediaStorageDisplay({
      quotaBytes: 5 * STORAGE_BYTES_PER_UNIT,
      usedBytes: 10 * GIB,
    });
    expect(display.quotaBytes).toBe(25 * GIB);
    expect(display.usedBytes).toBe(10 * GIB);
    expect(display.remainingBytes).toBe(15 * GIB);
    expect(display.overBytes).toBe(0);
    expect(display.state).toBe('normal');
  });

  it('reports overage with zero remaining when over', () => {
    const display = toMediaStorageDisplay({
      quotaBytes: 25 * GIB,
      usedBytes: 26 * GIB,
    });
    expect(display.remainingBytes).toBe(0);
    expect(display.overBytes).toBe(1 * GIB);
    expect(display.state).toBe('over');
  });

  it('shapes a valid billing/storage API response', () => {
    const display = toMediaStorageDisplay({
      quotaBytes: 25 * GIB,
      usedBytes: 20 * GIB,
    });
    const parsed = MediaStorageResponseSchema.safeParse({
      ...display,
      hasActivePeriod: true,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.state).toBe('near');
  });
});

describe('formatStorageGbOneDecimal', () => {
  it('formats whole and fractional GB with one decimal', () => {
    expect(formatStorageGbOneDecimal(0)).toBe('0 GB');
    expect(formatStorageGbOneDecimal(25 * GIB)).toBe('25 GB');
    expect(formatStorageGbOneDecimal(12.5 * GIB)).toBe('12.5 GB');
    expect(formatStorageGbOneDecimal(0.5 * GIB)).toBe('0.5 GB');
  });
});

describe('isMediaStorageOver (write gate)', () => {
  it('is true only when used strictly exceeds allowed', () => {
    expect(isMediaStorageOver({ quotaBytes: 25 * GIB, usedBytes: 25 * GIB })).toBe(false);
    expect(isMediaStorageOver({ quotaBytes: 25 * GIB, usedBytes: 26 * GIB })).toBe(true);
    expect(isMediaStorageOver({ quotaBytes: 0, usedBytes: 0 })).toBe(false);
    // Fail-closed for a no-period user who still holds files.
    expect(isMediaStorageOver({ quotaBytes: 0, usedBytes: 1 * GIB })).toBe(true);
  });
});
