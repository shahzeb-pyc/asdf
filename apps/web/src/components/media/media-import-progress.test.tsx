/** @vitest-environment jsdom */
import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  ImportProgressHeader,
  resolveCompleteTitle,
} from './media-import-progress';

/**
 * Spec 215 — the completion header must never claim success it did not
 * get. Shahzeb's 12.6 MB upload failed on its only file and the dialog
 * still read "Import complete — 0 of 1 uploaded" at 100%.
 */

describe('resolveCompleteTitle', () => {
  it('says Import failed when nothing uploaded', () => {
    expect(resolveCompleteTitle(0, 1, false)).toBe('Import failed');
    expect(resolveCompleteTitle(0, 3, false)).toBe('Import failed');
  });

  it('says Import finished for a partial batch', () => {
    expect(resolveCompleteTitle(1, 2, false)).toBe('Import finished');
    expect(resolveCompleteTitle(2, 3, false)).toBe('Import finished');
  });

  it('says Import complete only when everything uploaded', () => {
    expect(resolveCompleteTitle(1, 1, false)).toBe('Import complete');
    expect(resolveCompleteTitle(3, 3, false)).toBe('Import complete');
  });

  it('says Import canceled when everything was cancelled', () => {
    expect(resolveCompleteTitle(0, 2, true)).toBe('Import canceled');
  });
});

function renderHeader(props: {
  step: 'progress' | 'complete';
  completedCount: number;
  totalCount: number;
  isAllCancelled: boolean;
  overallProgressPercent: number;
  uploadedBytes: number;
  totalBytes: number;
}) {
  render(
    <ImportProgressHeader
      destinationFolderName="Library"
      {...props}
    />
  );
}

describe('ImportProgressHeader at complete', () => {
  it('never shows 100% / complete when 0 of 1 uploaded', () => {
    // Shahzeb's case: 129.4 KB of 12.6 MB arrived before the drop.
    renderHeader({
      step: 'complete',
      completedCount: 0,
      totalCount: 1,
      isAllCancelled: false,
      overallProgressPercent: 1,
      uploadedBytes: 129400,
      totalBytes: 12582912,
    });

    expect(
      screen.getByTestId('import-progress-subtext')
    ).toHaveTextContent('Import failed — 0 of 1 uploaded');
    expect(screen.getByTestId('overall-progress-percentage')).toHaveTextContent('1%');
    expect(screen.getByTestId('aggregate-progress-bar')).toHaveStyle({ width: '1%' });
    expect(screen.queryByText(/Import complete/)).toBeNull();
    expect(screen.getByTestId('overall-progress-percentage')).toHaveAttribute(
      'aria-label',
      'Import failed: 1%'
    );
  });

  it('shows the real percent and "Import finished" for a partial batch', () => {
    renderHeader({
      step: 'complete',
      completedCount: 1,
      totalCount: 2,
      isAllCancelled: false,
      overallProgressPercent: 55,
      uploadedBytes: 5500,
      totalBytes: 10000,
    });

    expect(
      screen.getByTestId('import-progress-subtext')
    ).toHaveTextContent('Import finished — 1 of 2 uploaded');
    expect(screen.getByTestId('overall-progress-percentage')).toHaveTextContent('55%');
    expect(screen.getByTestId('aggregate-progress-bar')).toHaveStyle({ width: '55%' });
    expect(screen.queryByText(/Import complete/)).toBeNull();
  });

  it('still shows 100% / complete when everything uploaded', () => {
    renderHeader({
      step: 'complete',
      completedCount: 2,
      totalCount: 2,
      isAllCancelled: false,
      overallProgressPercent: 100,
      uploadedBytes: 10000,
      totalBytes: 10000,
    });

    expect(
      screen.getByTestId('import-progress-subtext')
    ).toHaveTextContent('Import complete — 2 of 2 uploaded');
    expect(screen.getByTestId('overall-progress-percentage')).toHaveTextContent('100%');
    expect(screen.getByTestId('aggregate-progress-bar')).toHaveStyle({ width: '100%' });
  });

  it('keeps the canceled wording when everything was cancelled', () => {
    renderHeader({
      step: 'complete',
      completedCount: 0,
      totalCount: 2,
      isAllCancelled: true,
      overallProgressPercent: 0,
      uploadedBytes: 0,
      totalBytes: 10000,
    });

    expect(
      screen.getByTestId('import-progress-subtext')
    ).toHaveTextContent('Import canceled — nothing was uploaded');
    expect(screen.getByTestId('overall-progress-percentage')).toHaveTextContent('0%');
  });

  it('shows the live percent while still importing', () => {
    renderHeader({
      step: 'progress',
      completedCount: 0,
      totalCount: 1,
      isAllCancelled: false,
      overallProgressPercent: 37,
      uploadedBytes: 3700,
      totalBytes: 10000,
    });

    expect(
      screen.getByTestId('import-progress-subtext')
    ).toHaveTextContent('Adding to Library');
    expect(screen.getByTestId('overall-progress-percentage')).toHaveTextContent('37%');
    expect(screen.getByTestId('aggregate-progress-bar')).toHaveStyle({ width: '37%' });
  });
});
