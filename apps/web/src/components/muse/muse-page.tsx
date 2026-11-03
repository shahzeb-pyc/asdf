'use client';

import React from 'react';
import type { MuseActivityResponse } from '@fbuploadpro/contracts';
import { Button } from '@/components/shared/ui/button';
import { EmptyState } from '@/components/shared/ui/empty-state';
import { Skeleton } from '@/components/shared/ui/skeleton';
import { StatusMark } from '@/components/shared/ui/status-mark';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/shared/ui/table';
import { apiGet, buildTenantApiPath, getErrorMessage } from '@/lib/api';
import { MuseActivityResponseSchema } from '@/lib/api/schemas/muse';
import { MuseConnectDialog } from '@/components/muse/muse-connect-dialog';

/**
 * Muse page — separated, plain-language copy.
 *
 * The key route is Media Library only: Today's work lists only
 * media Muse added with a key. The browser route is separate:
 * a user can also tell Muse to sign in to FBUploadPro in the
 * browser and do things on their behalf. This page never lists
 * posts, scheduled items, or published content.
 */
export function MusePage({
  subdomain,
}: Readonly<{ subdomain: string }>) {
  const [connectOpen, setConnectOpen] = React.useState(false);
  const [activity, setActivity] = React.useState<MuseActivityResponse | null>(
    null
  );
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiGet(
        buildTenantApiPath(subdomain, '/muse/activity'),
        { schema: MuseActivityResponseSchema }
      );
      setActivity(data);
      setError(null);
    } catch (err) {
      setError(getErrorMessage(err));
      setActivity(null);
    } finally {
      setLoading(false);
    }
  }, [subdomain]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const isSetupMissing =
    error === 'Muse activity is not set up yet' ||
    error === 'Muse keys are not set up yet';

  return (
    <div className="mx-auto box-border flex w-full max-w-300 flex-col gap-6 px-6 py-6">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="mb-1 text-xxl font-bold tracking-h1 text-ink">Muse</h1>
          <p className="m-0 max-w-2xl text-body text-ink-sub">
            Tell Muse what you want. Muse adds your media to your
            Media Library. You can also ask Muse how to use
            FBUploadPro, or tell Muse to sign in to FBUploadPro in
            your browser and do things for you, on your behalf —
            whatever you ask. This page only lists media Muse added.
            It does not list posts, scheduled items, or published
            content. To stop Muse&apos;s Media Library access, revoke
            its key in Connect Muse. To end its browser session, log
            out.
          </p>
        </div>
        <Button onClick={() => setConnectOpen(true)}>Connect Muse</Button>
      </div>

      <MuseConnectDialog
        subdomain={subdomain}
        open={connectOpen}
        onOpenChange={setConnectOpen}
      />

      <section aria-label="Example tasks">
        <h2 className="text-base font-semibold">Example tasks</h2>
        <ul className="mt-2 flex flex-col gap-1 text-ink-sub">
          <li>Add a new video to my Media Library.</li>
          <li>Show me how to schedule a post, step by step.</li>
          <li>
            Sign in to FBUploadPro in my browser and publish this post
            with Publish Now.
          </li>
          <li>Check my Page and tell me what needs attention.</li>
        </ul>
      </section>

      <section aria-label="Today's work">
        <h2 className="text-base font-semibold">Today&apos;s work</h2>
        {loading ? (
          <div className="mt-3 flex flex-col gap-2">
            <Skeleton className="h-4 w-64" />
            <Skeleton className="h-4 w-48" />
          </div>
        ) : error ? (
          <div className="mt-3">
            <p className="text-ink-sub">
              {isSetupMissing
                ? "Muse isn't set up for this workspace yet. Ask the workspace owner to finish setup, then try again."
                : "We couldn't load today's work. Try again."}
            </p>
            <Button
              variant="outline"
              className="mt-2"
              onClick={() => void load()}
            >
              Try again
            </Button>
          </div>
        ) : activity ? (
          <>
            <p className="mt-2 text-ink-sub">
              Today, Muse added {activity.today.videos}{' '}
              {activity.today.videos === 1 ? 'video' : 'videos'} and{' '}
              {activity.today.images}{' '}
              {activity.today.images === 1 ? 'image' : 'images'} to your
              Media Library.
            </p>
            {activity.days.length === 0 ? (
              <EmptyState
                type="no-results"
                className="mt-3"
                title="No uploads from Muse yet"
                description="Media Muse adds to your Media Library will appear here. To get started, connect Muse above."
              />
            ) : (
              activity.days.map((day) => (
                <div key={day.date} className="mt-4">
                  <h3 className="font-medium">{day.label}</h3>
                  <Table className="mt-2">
                    <TableHeader>
                      <TableRow>
                        <TableHead>File</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Folder</TableHead>
                        <TableHead>Time</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Open in Media Library</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {day.rows.map((row) => (
                        <TableRow key={row.id}>
                          <TableCell>{row.name}</TableCell>
                          <TableCell>
                            {row.mediaType === 'video' ? 'Video' : 'Image'}
                          </TableCell>
                          <TableCell>
                            {row.folderId ? 'Folder' : 'No folder'}
                          </TableCell>
                          <TableCell>
                            {new Date(row.createdAt).toLocaleTimeString(
                              'en-GB',
                              { hour: '2-digit', minute: '2-digit' }
                            )}
                          </TableCell>
                          <TableCell>
                            <StatusMark
                              kind="operational"
                              label="Added to Media Library"
                              testId={`muse-activity-status-${row.id}`}
                            />
                          </TableCell>
                          <TableCell>
                            <a
                              href={`/tenant/${subdomain}/media${
                                row.folderId
                                  ? `?folder=${row.folderId}`
                                  : ''
                              }`}
                              className="text-link underline"
                            >
                              Open in Media Library
                            </a>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ))
            )}
          </>
        ) : null}
      </section>
    </div>
  );
}
