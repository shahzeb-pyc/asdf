'use client';

import React, { Suspense } from 'react';
import { useParams } from 'next/navigation';
import { ScheduleDetailShell } from '@/components/instagram/schedule/schedule-detail-shell';

/**
 * Instagram Schedule detail — Dashboard, Insights, Queue, Calendar
 * View, and Posting Times for one scheduled Instagram account.
 */
export default function InstagramScheduleDetailPage() {
  const params = useParams();
  const subdomain = (params?.subdomain as string) || '';
  const destinationId = (params?.destinationId as string) || '';

  return (
    <Suspense>
      <ScheduleDetailShell subdomain={subdomain} destinationId={destinationId} />
    </Suspense>
  );
}
