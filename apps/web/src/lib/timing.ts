/** How long an inbox item stays open before it is marked read (Q31). One named constant to retune. */
export const INBOX_DWELL_MS = 1000;

/** How long a selection (an inbox row, a task peek) rests before its neighbours are prefetched: a j/k sweep fetches nothing. */
export const PREFETCH_REST_MS = 150;
