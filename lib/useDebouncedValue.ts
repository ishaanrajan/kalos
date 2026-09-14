/**
 * Delay a rapidly-changing value until it settles.
 *
 * The profile search in app/search.tsx deliberately doesn't do this -- it hits
 * our own Postgres, where a query per keystroke is cheap and the latency win is
 * worth it. The music catalog is a third-party API with a per-minute request
 * budget (see lib/music.ts), so there a keystroke-per-request would exhaust the
 * budget mid-word.
 */

import { useEffect, useState } from 'react';

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return settled;
}
