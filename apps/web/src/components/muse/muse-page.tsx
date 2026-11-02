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
 * Muse page — Today's work is Media Library only (option B):
 * plain-text counts today by type from Muse-key uploads, plus a
 * table grouped by day from real upload records. No browser
 * actions and no queue/publish claims appear here, and a file in
 * the Library is never claimed to be published.
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

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Muse</h1>
          <p className="mt-2 max-w-2xl text-ink-sub">
            You tell Muse what you want. Muse puts your media in your
            Media Library, handles Pages, Publish Now, Queue and
            Schedule, Auto Download/Upload, and Auto Repost in your
            browser for you, and shows you each step as it goes, so
            you can follow along. It keeps working on what you asked
            until you stop it — revoke its key in Connect Muse, or log
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
              Couldn&apos;t load today&apos;s work: {error}
            </p>
            <Button
              variant="outline"
              className="mt-2"
              onClick={() => void load()}
            >
              Retry
            </Button>
          </div>
        ) : activity ? (
          <>
            <p className="mt-2 text-ink-sub">
              Today, Muse added {activity.today.videos} videos and{' '}
              {activity.today.images} images to your Media Library.
            </p>
            {activity.days.length === 0 ? (
              <EmptyState
                className="mt-3"
                title="No uploads by Muse yet"
                description="When Muse uploads media with your key, it will appear here."
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
                        <TableHead>Open</TableHead>
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
                              label="Added"
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
                              Open
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
