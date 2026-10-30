import * as React from 'react';

/**
 * Debounced search string (K9 — Pages search): the returned value
 * follows `value` after `delayMs`, so a list query does not refetch
 * on every keystroke. Clearing to '' applies immediately (no wait
 * to restore the unfiltered list), mirroring the media library's
 * 250ms / immediate-clear precedent.
 */
export function useDebouncedValue(value: string, delayMs = 250): string {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    if (value === '') {
      setDebounced(value);
      return;
    }
    const timeout = setTimeout(() => {
      setDebounced(value);
    }, delayMs);
    return () => {
      clearTimeout(timeout);
    };
  }, [value, delayMs]);
  return debounced;
}
