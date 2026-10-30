'use client';

import React, { Suspense } from 'react';
import { useParams } from 'next/navigation';
import { ScheduleShell } from '@/components/instagram/schedule/schedule-shell';

/**
 * Instagram Schedule list — the Instagram equivalent of the Facebook
 * Pages list: only accounts the user added in this section appear,
 * with queued/posted/failed counts on each card.
 */
export default function InstagramSchedulePage() {
  const params = useParams();
  const subdomain = (params?.subdomain as string) || '';

  return (
    <Suspense>
      <ScheduleShell subdomain={subdomain} />
    </Suspense>
  );
}
