// Run one shell command in its own process group: output to the log (and,
// with --verbose, to the terminal), a timeout that kills the whole group, and
// a final sweep of the group so nothing a check started outlives it.

import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync } from "node:fs";
import type { Env } from "./env.ts";

export interface CmdResult {
  exit: number | null;
  signal: string | null;
  timedOut: boolean;
  ms: number;
}

export interface CmdOptions {
  cmd: string;
  cwd: string;
  env: Env;
  log: string;
  timeoutS?: number;
  /** each output line as it arrives (--verbose) */
  onLine?: (line: string) => void;
}

const live = new Set<ChildProcess>();

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // group already gone
  }
}

/** Kill every running command's process group (gate is being interrupted). */
export function killAllCommands(): void {
  for (const c of live) killGroup(c, "SIGKILL");
}

export function runCommand(o: CmdOptions): Promise<CmdResult> {
  const start = performance.now();
  appendFileSync(o.log, `$ ${o.cmd}\n`);
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", o.cmd], { cwd: o.cwd, env: o.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    live.add(child);
    let timedOut = false;
    let partial = "";
    const onData = (d: Buffer): void => {
      appendFileSync(o.log, d);
      if (!o.onLine) return;
      partial += d.toString();
      const lines = partial.split("\n");
      partial = lines.pop() ?? "";
      for (const l of lines) o.onLine(l);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    let hardKill: ReturnType<typeof setTimeout> | undefined;
    const timer = o.timeoutS
      ? setTimeout(() => {
          timedOut = true;
          killGroup(child, "SIGTERM");
          hardKill = setTimeout(() => killGroup(child, "SIGKILL"), 2000);
        }, o.timeoutS * 1000)
      : undefined;

    let settled = false;
    const finish = (exit: number | null, signal: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardKill);
      // Whatever the check left running in its group (a server, a sleep) dies with it.
      killGroup(child, "SIGKILL");
      live.delete(child);
      // Let the pipes drain, but don't wait on a grandchild that escaped the group.
      const ended = (s: NodeJS.ReadableStream | null): Promise<void> =>
        !s || ("readableEnded" in s && s.readableEnded) ? Promise.resolve() : new Promise((r) => s.once("end", () => r()).once("close", () => r()));
      void Promise.race([Promise.all([ended(child.stdout), ended(child.stderr)]), Bun.sleep(1000)]).then(() => {
        if (partial && o.onLine) o.onLine(partial);
        resolve({ exit, signal, timedOut, ms: Math.round(performance.now() - start) });
      });
    };
    child.on("exit", (code, signal) => finish(code, signal));
    child.on("error", (err) => {
      appendFileSync(o.log, `gate: couldn't start /bin/sh: ${err.message}\n`);
      finish(127, null);
    });
  });
}
