// A run id is 8 lowercase base36 characters: 6 of unix seconds, 2 random.
// The time half is what lets the start-of-run sweep tell a 6-hour-old
// abandoned database from a live one without asking Postgres when it was made.

import { randomInt } from "node:crypto";

export const RUN_ID = /^[a-z0-9]{8}$/;

export function newRunId(now = Date.now()): string {
  const secs = Math.floor(now / 1000).toString(36).padStart(6, "0").slice(-6);
  const rand = randomInt(0, 36 * 36).toString(36).padStart(2, "0");
  return secs + rand;
}

/** When a run id was made (ms), or null when it isn't one of ours. */
export function runIdTime(id: string): number | null {
  if (!RUN_ID.test(id)) return null;
  const secs = parseInt(id.slice(0, 6), 36);
  return Number.isFinite(secs) ? secs * 1000 : null;
}
