export { DedicatedPageHeader, type DedicatedPageHeaderProps } from './page-header';
export { PageTabDashboard, type PageTabDashboardProps, type PageQueueItemSummary, type PageSlotSummary } from './tab-dashboard';
export { PageTabPostingTimes, type PageTabPostingTimesProps } from './posting-times/tab-posting-times';
export { PageTabInsights, type PageTabInsightsProps } from './insights-panel';
// Nit: MODAL_BACKDROP_STYLE / MODAL_CONTAINER_STYLE were deleted
// with modal-styles.ts — grep proved zero consumers (only this
// re-export referenced them).
// Bulk-add is deleted entirely (product-owner decision): it was
// AI-made, not his, and its "schedule" destination was the one-off
// fixed-date path that publisher-driven scheduling removes. No
// bulk-* export remains here; the grep check in the publisher-driven
// tests pins that no live code imports bulk-* anymore.
