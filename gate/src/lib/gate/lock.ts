// One run per repo: `<work root>/lock` holds the pid and run id. A lock whose
// pid is dead is stale and taken over.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { broken } from "./errors.ts";

const LockSchema = z.object({ pid: z.number(), run: z.string(), at: z.string() });
export type LockInfo = z.infer<typeof LockSchema>;

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err instanceof Error && "code" in err && err.code === "EPERM";
  }
}

export function readLock(path: string): LockInfo | null {
  try {
    const parsed = LockSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The lock's holder when it's a live process, else null. */
export function liveLock(path: string): LockInfo | null {
  const l = readLock(path);
  return l && pidAlive(l.pid) ? l : null;
}

function tryTake(path: string, run: string): boolean {
  try {
    writeFileSync(path, JSON.stringify({ pid: process.pid, run, at: new Date().toISOString() }), { flag: "wx" });
    return true;
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "EEXIST") return false;
    throw broken(`couldn't write the lock ${path}: ${err instanceof Error ? err.message : String(err)}. Check the work root is writable (gate doctor)`);
  }
}

export interface LockOptions {
  wait: boolean;
  /** called once, when we start waiting on someone else's run */
  onWait: (holder: LockInfo) => void;
  repo: string;
}

/** Take the lock, waiting for (or refusing) a live holder. Returns the release function. */
export async function acquireLock(path: string, run: string, opts: LockOptions): Promise<() => void> {
  mkdirSync(dirname(path), { recursive: true });
  let told = false;
  for (;;) {
    if (tryTake(path, run)) {
      return () => {
        if (readLock(path)?.run === run) rmSync(path, { force: true });
      };
    }
    const holder = readLock(path);
    if (!holder || !pidAlive(holder.pid)) {
      // Stale (dead pid) or half-written: take it over. Only one taker wins the wx above.
      rmSync(path, { force: true });
      continue;
    }
    if (!opts.wait) {
      throw broken(`gate is already running in ${opts.repo} (run ${holder.run}, pid ${holder.pid}). Wait for it, or run gate without --no-wait to queue behind it`);
    }
    if (!told) {
      opts.onWait(holder);
      told = true;
    }
    await Bun.sleep(300);
  }
}
