/**
 * Flow — Media Library Download button → floating tray (spec 149).
 *
 * The old sidebar Downloader surface is gone: a Download button next
 * to Upload opens the download dialog, submitting starts server-side
 * jobs, and the app-wide tray tracks them — minimizable to a pill
 * while running, auto-dismissing on success, staying with Retry on
 * failure, and rendering as a full-width bottom sheet on phones.
 *
 * Hermetic, per the spec 137-A3 pattern: the shared fixture boundary
 * serves the library, and the downloader routes registered below —
 * after the shared fixtures, so they take precedence — serve job state
 * from mutable fixture state. No live network, no real download.
 */

import { test, expect } from '@playwright/test';
import { createFixtureState, installApiFixtures } from './fixtures/api';
import { SESSION_COOKIE, TENANT } from './fixtures/tenant';

const JOB_ID = '55555555-5555-4555-8555-555555555555';
const PASTED_LINK = 'https://www.tiktok.com/@creator/video/1234567890';

type JobState = {
  id: string;
  userId: string;
  sourceUrl: string;
  sourcePlatform: string;
  targetFolderId: string | null;
  status: string;
  progressPercent: number;
  totalBytes: number | null;
  downloadedBytes: number;
  mediaId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

function jobFixture(status: string, overrides: Partial<JobState> = {}): JobState {
  return {
    id: JOB_ID,
    userId: TENANT.userId,
    sourceUrl: PASTED_LINK,
    sourcePlatform: 'tiktok',
    targetFolderId: null,
    status,
    progressPercent: status === 'downloading' ? 45 : 0,
    totalBytes: null,
    downloadedBytes: 0,
    mediaId: null,
    errorCode: status === 'failed' ? 'DOWNLOAD_FAILED' : null,
    errorMessage: status === 'failed' ? 'The download failed. Please try again.' : null,
    createdAt: '2026-10-25T00:00:00.000Z',
    updatedAt: '2026-10-25T00:00:00.000Z',
    ...overrides,
  };
}

const OPEN_STATUSES = ['queued', 'resolving', 'downloading', 'failed'];

/** Serves the downloader endpoints from a mutable job list. */
async function installDownloaderFixtures(
  page: import('@playwright/test').Page,
  jobs: JobState[],
  onRetry?: () => void
) {
  await page.route(`**/api/tenant/${TENANT.subdomain}/downloader**`, (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (url.pathname.endsWith('/downloader/retry') && method === 'POST') {
      const body = route.request().postDataJSON() as { jobId?: string };
      const job = jobs.find((j) => j.id === body.jobId);
      if (job) {
        job.status = 'queued';
        job.errorCode = null;
        job.errorMessage = null;
        job.progressPercent = 0;
        onRetry?.();
      }
      return json({ job });
    }
    if (url.pathname.endsWith('/downloader/cancel') && method === 'POST') {
      const body = route.request().postDataJSON() as { jobId?: string };
      const job = jobs.find((j) => j.id === body.jobId);
      if (job) job.status = 'cancelled';
      return json({ job });
    }
    if (method === 'POST') {
      const body = route.request().postDataJSON() as { links?: string[] };
      const created = (body.links ?? []).map((link, i) =>
        jobFixture('queued', {
          id: `55555555-5555-4555-8555-55555555555${i}`,
          sourceUrl: link,
        })
      );
      jobs.push(...created);
      return json({ jobs: created, skippedDuplicates: 0, invalidLinks: [] }, 201);
    }
    // GET: only open jobs, like the real endpoint.
    return json({ jobs: jobs.filter((j) => OPEN_STATUSES.includes(j.status)) });
  });
}

async function openDownloadDialog(page: import('@playwright/test').Page) {
  await page.goto(`/tenant/${TENANT.subdomain}/media`);
  await expect(page.getByTestId('media-library-title')).toBeVisible();
  await page.getByTestId('download-files-btn').click();
  await expect(page.getByTestId('download-dialog')).toBeVisible();
}

test.describe('media library download tray', () => {
  test('submit → tray → minimize/pill → done flash → auto-dismiss', async ({
    page,
    context,
  }) => {
    await context.addCookies([SESSION_COOKIE]);
    const state = createFixtureState();
    await installApiFixtures(page, state);
    const jobs: JobState[] = [];
    await installDownloaderFixtures(page, jobs);

    await openDownloadDialog(page);
    await page.getByTestId('download-url-input').fill(PASTED_LINK);
    await page.getByTestId('download-submit-button').click();

    // The dialog closes at once; the tray appears on the next poll.
    await expect(page.getByTestId('download-dialog')).toBeHidden({ timeout: 10_000 });
    const tray = page.getByTestId('download-tray');
    await expect(tray).toBeVisible({ timeout: 10_000 });
    await expect(tray).toContainText('Downloading 1 file');
    await expect(page.locator('[data-testid^="download-job-row-"]')).toHaveCount(1);

    // Minimize → pill; pill click re-expands.
    await page.getByTestId('download-tray-minimize').click();
    await expect(page.getByTestId('download-tray-pill')).toBeVisible();
    await expect(tray).toBeHidden();
    await page.getByTestId('download-tray-pill').click();
    await expect(tray).toBeVisible();

    // The worker finishes: the next poll drops the job from the open
    // list, the tray flashes success, then slides away on its own.
    if (jobs[0]) jobs[0].status = 'done';
    await expect(tray).toContainText('Downloaded', { timeout: 10_000 });
    await expect(tray).toBeHidden({ timeout: 10_000 });
  });

  test('failed job stays with Retry, and retry re-queues it', async ({
    page,
    context,
  }) => {
    await context.addCookies([SESSION_COOKIE]);
    const state = createFixtureState();
    await installApiFixtures(page, state);
    const jobs: JobState[] = [jobFixture('failed')];
    let retryCalled = false;
    await installDownloaderFixtures(page, jobs, () => {
      retryCalled = true;
    });

    await page.goto(`/tenant/${TENANT.subdomain}/media`);
    const tray = page.getByTestId('download-tray');
    await expect(tray).toBeVisible({ timeout: 10_000 });
    await expect(tray).toContainText('1 failed');
    await page.getByTestId(`download-job-retry-${JOB_ID}`).click();
    await expect(tray).toContainText('Downloading 1 file', { timeout: 10_000 });
    expect(retryCalled).toBe(true);
  });

  test('the old sidebar Downloader entry and page are gone', async ({
    page,
    context,
  }) => {
    await context.addCookies([SESSION_COOKIE]);
    const state = createFixtureState();
    await installApiFixtures(page, state);
    await installDownloaderFixtures(page, []);

    await page.goto(`/tenant/${TENANT.subdomain}/media`);
    await expect(page.getByTestId('media-library-title')).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Downloader', exact: true })
    ).toHaveCount(0);

    const response = await page.goto(`/tenant/${TENANT.subdomain}/downloader`);
    expect(response?.status()).toBe(404);
  });
});

test.describe('media library download tray on phones', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('tray is a full-width bottom sheet, minimizable to a pill', async ({
    page,
    context,
  }) => {
    await context.addCookies([SESSION_COOKIE]);
    const state = createFixtureState();
    await installApiFixtures(page, state);
    const jobs: JobState[] = [];
    await installDownloaderFixtures(page, jobs);

    await openDownloadDialog(page);
    await page.getByTestId('download-url-input').fill(PASTED_LINK);
    await page.getByTestId('download-submit-button').click();

    const tray = page.getByTestId('download-tray');
    await expect(tray).toBeVisible({ timeout: 10_000 });
    const box = await tray.boundingBox();
    expect(box).not.toBeNull();
    // Full-width sheet: spans the viewport, anchored at the bottom.
    expect(Math.abs((box?.width ?? 0) - 390)).toBeLessThan(4);
    expect(Math.abs(box?.x ?? 1)).toBeLessThan(4);
    expect(Math.abs((box?.y ?? 0) + (box?.height ?? 0) - 844)).toBeLessThan(4);

    // While running it only minimizes — never fully closes.
    await page.getByTestId('download-tray-minimize').click();
    await expect(page.getByTestId('download-tray-pill')).toBeVisible();
    await expect(tray).toBeHidden();
  });
});
