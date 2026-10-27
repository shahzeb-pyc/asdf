export { DedicatedPageHeader, type DedicatedPageHeaderProps } from './page-header';
export { PageTabDashboard, type PageTabDashboardProps, type PageQueueItemSummary, type PageSlotSummary } from './tab-dashboard';
export { PageTabPostingTimes, type PageTabPostingTimesProps } from './posting-times/tab-posting-times';
export { PageTabInsights, type PageTabInsightsProps } from './insights-panel';
export { MODAL_BACKDROP_STYLE, MODAL_CONTAINER_STYLE } from './modal-styles';
export { IntentSelector, type IntentSelectorProps, type ComposerIntent } from './composer/intent-selector';
export { FormatSelector, type FormatSelectorProps } from './composer/format-selector';
export {
  ComposerMediaArea,
  type ComposerMediaAreaProps,
  type ComposerMediaItem,
  getMediaItemError,
  getMediaCapNotice,
} from './composer/composer-media-area';
export { ComposerLink, type ComposerLinkProps, isValidLink } from './composer/composer-link';
export { ComposerPreview, type ComposerPreviewProps } from './composer/composer-preview';
export {
  InstagramComposer,
  type InstagramComposerProps,
  type InstagramComposerDestination,
} from './composer/instagram/instagram-composer';
export {
  InstagramComposerSlot,
  type InstagramComposerSlotProps,
} from './composer/instagram/instagram-composer-slot';
export {
  ThreadsComposer,
  type ThreadsComposerProps,
  type ThreadsComposerDestination,
} from './composer/threads/threads-composer';
export {
  ThreadsComposerSlot,
  type ThreadsComposerSlotProps,
} from './composer/threads/threads-composer-slot';
export {
  PostingTimeQuickAdd,
  type PostingTimeQuickAddProps,
} from './composer/posting-time-quick-add';
export {
  getNextSlotForFormat,
  slotCoversFormat,
  getNextOccurrence,
  formatSlotLong,
  formatSlotShort,
  toDateTimeLocalValue,
  parseDateTimeLocalValue,
  hasRealCaption,
} from './composer/queue-slot-utils';
// Bulk-add is deleted entirely (product-owner decision): it was
// AI-made, not his, and its "schedule" destination was the one-off
// fixed-date path that publisher-driven scheduling removes. No
// bulk-* export remains here; the grep check in the publisher-driven
// tests pins that no live code imports bulk-* anymore.
