'use client';

import React from 'react';
import { ChevronDownIcon, LayoutGridIcon, ListIcon, SearchIcon } from 'lucide-react';

import { Button } from '@/components/shared/ui/button';
import { Input } from '@/components/shared/ui/input';
import {
  Menu,
  MenuContent,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from '@/components/shared/ui/menu';
import { Tabs, TabsList, TabsTrigger } from '@/components/shared/ui/tabs';
import { Tag } from '@/components/shared/ui/tag';
import { cn } from '@/lib/utils';
import type {
  MediaViewMode,
  MediaTypeFilterKey,
  AspectRatioFilterKey,
  CaptionStatusFilterKey,
  SortOptionKey,
} from './media-types';
import {
  MEDIA_TYPE_LABELS,
  ASPECT_RATIO_SHORT_VALUES,
  CAPTION_STATUS_SHORT_VALUES,
  SORT_OPTION_SHORT_VALUES,
} from './media-library-filters';

/**
 * The 3-zone toolbar (spec 133 §6.3 / PB-10, PB-11), rebuilt on the
 * shared/ui primitives. Zone 1 (global): the library-wide search Input
 * only. Zone 2 (local): the scope Tag, then labelled Type / Ratio /
 * Captions dropdowns on the Menu primitive — labels always visible,
 * non-default values carry the active (gold-underline) treatment, and
 * "N filters · Clear" appears whenever a local filter is set. Zone 3:
 * the labelled Sort dropdown and the grid/table segmented switch
 * (Tabs). Zones are separated by hairline dividers; there are no
 * bordered boxes around zones or controls (PB-1), and the hand-rolled
 * dropdown/popover code is deleted — Menu owns focus return, Esc, and
 * apply-on-selection.
 */

export const TYPE_DROPDOWN_OPTIONS = [
  { key: 'all', label: 'All' },
  { key: 'video', label: 'Videos' },
  { key: 'image', label: 'Images' },
] as const;

export const RATIO_DROPDOWN_OPTIONS = [
  { key: 'all', label: 'All ratios' },
  { key: '9:16', label: '9:16 Vertical' },
  { key: '16:9', label: '16:9 Landscape' },
  { key: '1:1', label: '1:1 Square' },
  { key: '4:5', label: '4:5 Portrait' },
] as const;

export const CAPTION_DROPDOWN_OPTIONS = [
  { key: 'all', label: 'All captions' },
  { key: 'has_caption', label: 'Has caption' },
  { key: 'empty_caption', label: 'Missing caption' },
] as const;

export const SORT_DROPDOWN_OPTIONS = [
  { key: 'created_at:desc', label: 'Newest first' },
  { key: 'created_at:asc', label: 'Oldest first' },
  { key: 'name:asc', label: 'Name (A–Z)' },
  { key: 'file_size:desc', label: 'Largest size' },
] as const;

interface ToolbarMenuProps<T extends string> {
  testId: string;
  label: string;
  displayValue: string;
  isActive?: boolean;
  options: readonly { key: T; label: string }[];
  selectedKey: T;
  optionTestIdPrefix: string;
  onSelect: (key: T) => void;
  /**
   * Stacking layer for the portalled menu panel. Default (undefined) keeps
   * the current z-popover behaviour. Pass "overlayTop" when the menu lives
   * inside a dialog (z-dialog 9500 > z-popover 9000), otherwise the panel
   * renders underneath the dialog and is invisible/unclickable — the same
   * layer convention as the shared Popover's overlayTop variant.
   */
  layer?: "popover" | "overlayTop";
}

export function ToolbarMenu<T extends string>({
  testId,
  label,
  displayValue,
  isActive = false,
  options,
  selectedKey,
  optionTestIdPrefix,
  onSelect,
  layer,
}: Readonly<ToolbarMenuProps<T>>) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          data-testid={testId}
          data-active={isActive || undefined}
          className="h-11 gap-1.5 px-2 text-body text-ink-sub hover:text-ink md:h-10"
        >
          <span>{label}</span>
          <span
            className={cn(
              'font-medium',
              isActive
                ? 'text-ink underline decoration-primary decoration-2 underline-offset-4'
                : 'text-ink'
            )}
          >
            {displayValue}
          </span>
          <ChevronDownIcon className="opacity-50" aria-hidden />
        </Button>
      </MenuTrigger>
      <MenuContent align="start" layer={layer}>
        <MenuRadioGroup value={selectedKey} onValueChange={(value) => onSelect(value as T)}>
          {options.map((opt) => (
            <MenuRadioItem
              key={opt.key}
              value={opt.key}
              data-testid={`${optionTestIdPrefix}-option-${opt.key}`}
            >
              {opt.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}

export interface MediaToolbarProps {
  searchInput: string;
  onSearchChange: (value: string) => void;
  scopeTagLabel: string;
  mediaTypeFilter: MediaTypeFilterKey;
  onMediaTypeChange: (type: MediaTypeFilterKey) => void;
  aspectRatioFilter: AspectRatioFilterKey;
  onAspectRatioChange: (ratio: AspectRatioFilterKey) => void;
  captionStatusFilter: CaptionStatusFilterKey;
  onCaptionStatusChange: (status: CaptionStatusFilterKey) => void;
  activeFilterCount: number;
  onClearFilters: () => void;
  sortOption: SortOptionKey;
  onSortChange: (sort: SortOptionKey) => void;
  viewMode: MediaViewMode;
  onChangeViewMode: (mode: MediaViewMode) => void;
}

export function MediaToolbar({
  searchInput,
  onSearchChange,
  scopeTagLabel,
  mediaTypeFilter,
  onMediaTypeChange,
  aspectRatioFilter,
  onAspectRatioChange,
  captionStatusFilter,
  onCaptionStatusChange,
  activeFilterCount,
  onClearFilters,
  sortOption,
  onSortChange,
  viewMode,
  onChangeViewMode,
}: Readonly<MediaToolbarProps>) {
  return (
    <div
      data-testid="media-explorer-toolbar"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line pb-4"
    >
      {/* Zone 1 — GLOBAL (left): the search field only */}
      <div
        data-testid="media-toolbar-zone-1"
        className="flex w-full min-w-0 items-center gap-2 sm:w-80 sm:flex-none"
      >
        <SearchIcon className="size-4 shrink-0 text-ink-dim" aria-hidden />
        <Input
          type="search"
          data-testid="media-search-input"
          value={searchInput}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search files and captions…"
          aria-label="Search files and captions"
          className="h-11 md:h-10"
        />
      </div>

      {/* Divider 1: Between Zone 1 (Global Search) and Zone 2 (Local Scoped Controls) */}
      <hr
        data-testid="media-toolbar-divider-1"
        aria-orientation="vertical"
        className="m-0 hidden h-4 w-px shrink-0 border-0 bg-line sm:block"
      />

      {/* Zone 2 — LOCAL (middle): controls that apply ONLY to the current view */}
      <div
        data-testid="media-toolbar-zone-2"
        className="flex flex-wrap items-center gap-x-2 gap-y-1"
      >
        {/* Scope Tag Anchor */}
        <Tag variant="ghost" data-testid="media-scope-tag" className="px-1 text-body font-medium text-ink-dim">
          {scopeTagLabel}
        </Tag>

        {/* Labelled Dropdown 1: Type */}
        <ToolbarMenu
          testId="media-type-select"
          label="Type:"
          displayValue={MEDIA_TYPE_LABELS[mediaTypeFilter]}
          isActive={mediaTypeFilter !== 'all'}
          options={TYPE_DROPDOWN_OPTIONS}
          selectedKey={mediaTypeFilter}
          optionTestIdPrefix="type"
          onSelect={onMediaTypeChange}
        />

        {/* Labelled Dropdown 2: Ratio */}
        <ToolbarMenu
          testId="media-aspect-ratio-select"
          label="Ratio:"
          displayValue={ASPECT_RATIO_SHORT_VALUES[aspectRatioFilter]}
          isActive={aspectRatioFilter !== 'all'}
          options={RATIO_DROPDOWN_OPTIONS}
          selectedKey={aspectRatioFilter}
          optionTestIdPrefix="aspect-ratio"
          onSelect={onAspectRatioChange}
        />

        {/* Labelled Dropdown 3: Captions */}
        <ToolbarMenu
          testId="media-caption-status-select"
          label="Captions:"
          displayValue={CAPTION_STATUS_SHORT_VALUES[captionStatusFilter]}
          isActive={captionStatusFilter !== 'all'}
          options={CAPTION_DROPDOWN_OPTIONS}
          selectedKey={captionStatusFilter}
          optionTestIdPrefix="caption-status"
          onSelect={onCaptionStatusChange}
        />

        {/* Dynamic Filter Clear Badge */}
        {activeFilterCount > 0 && (
          <Button
            type="button"
            variant="ghost"
            data-testid="clear-filters-btn"
            onClick={onClearFilters}
            className="h-11 px-2 text-metadata text-ink-dim hover:text-ink md:h-10"
          >
            <span>
              {activeFilterCount} {activeFilterCount === 1 ? 'filter' : 'filters'} · Clear
            </span>
          </Button>
        )}
      </div>

      {/* Divider 2: Between Zone 2 (Local Filters) and Zone 3 (Sort & View Mode) */}
      <hr
        data-testid="media-toolbar-divider-2"
        aria-orientation="vertical"
        className="m-0 hidden h-4 w-px shrink-0 border-0 bg-line lg:block"
      />

      {/* Zone 3 — SORT + VIEW (right) */}
      <div data-testid="media-toolbar-zone-3" className="flex items-center gap-2">
        {/* Labelled Sort Dropdown */}
        <ToolbarMenu
          testId="media-sort-select"
          label="Sort:"
          displayValue={SORT_OPTION_SHORT_VALUES[sortOption]}
          options={SORT_DROPDOWN_OPTIONS}
          selectedKey={sortOption}
          optionTestIdPrefix="sort"
          onSelect={onSortChange}
        />

        {/* Segmented Grid/Table view switch */}
        <Tabs
          value={viewMode}
          onValueChange={(value) => onChangeViewMode(value as MediaViewMode)}
          className="gap-0"
        >
          <TabsList aria-label="View mode" className="h-11 md:h-10">
            <TabsTrigger
              value="grid"
              data-testid="view-mode-grid-btn"
              aria-label="Grid view"
              className="h-9 min-w-11 md:h-8"
            >
              <LayoutGridIcon aria-hidden />
            </TabsTrigger>
            <TabsTrigger
              value="table"
              data-testid="view-mode-table-btn"
              aria-label="Table view"
              className="h-9 min-w-11 md:h-8"
            >
              <ListIcon aria-hidden />
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
    </div>
  );
}
