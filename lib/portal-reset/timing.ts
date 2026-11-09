// The engine's clocks and limits (spec 0023). Plain values, all in
// milliseconds unless the name says otherwise. Safe on both sides.
import { ACCESS_LEAD_MS } from "@/lib/lab-access";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

export const START_DELAY = 5 * MINUTE;
// Spec 0029: lab end + 24 minutes, the latest a reset may finish between two
// back to back labs (START_DELAY + 19 minutes, up to START_MARGIN before the
// next start).
export const TARGET = 24 * MINUTE;
export const HARD_CAP = 2 * HOUR;
// Spec 0029 AC-3, AC-8: the reset stops this long before the next start, the
// lab access lead plus a safety margin for a write already in flight.
export const RESET_SAFETY_MS = MINUTE;
export const START_MARGIN = ACCESS_LEAD_MS + RESET_SAFETY_MS;
export const LOOKBACK = 45 * MINUTE;
export const LEASE = 90 * SECOND;
export const MAX_RESUMES = 3;
export const ATTEMPTS = 3;
export const BACKOFF: readonly number[] = [2 * SECOND, 6 * SECOND];
export const CALL_TIMEOUT = 20 * SECOND;
export const SIGN_IN_RETRY_DELAY = 20 * SECOND;
export const HELD_RETRY = 30 * MINUTE;
export const DISCOVERY_START_LIMIT = 15 * MINUTE;
export const DISCOVERY_BUDGET = 5 * MINUTE;
export const DISCOVERY_MAX_PAGES = 20;
export const RETENTION_DAYS = 30;
export const IDLE_PAUSE = 15 * SECOND;
export const MAX_REPLY_BYTES = 5 * 1024 * 1024;
