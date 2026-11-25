// Where gate keeps things: its own state (~/.gate), each repo's work
// root (the clean copy, logs, lock), and the receipts/history in the git dir.

import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { junkTwin } from "../platform.ts";

/**
 * gate's own state: the machine key. `GATE_HOME` overrides (tests). Before gate
 * lived in testing-standard it kept this in `~/.destedtui/gate`; a machine that
 * still has that folder (and no `~/.gate`) keeps using it, so the receipts it
 * already signed still verify.
 */
export function gateHome(): string {
  if (process.env.GATE_HOME) return process.env.GATE_HOME;
  const home = join(homedir(), ".gate");
  const legacy = join(homedir(), ".destedtui", "gate");
  return !existsSync(home) && existsSync(legacy) ? legacy : home;
}

export function keyPath(): string {
  return join(gateHome(), "key");
}

/** The repo folder name lowercased, every character outside [a-z0-9] → `_`, cut to 20. */
export function slugOf(top: string): string {
  return basename(top).toLowerCase().replace(/[^a-z0-9]/g, "_").slice(0, 20);
}

/** `$GATE_WORK/<slug>`, else `/w/junk/<repo>/.gate` for a `/w/code/<repo>`, else `<tmp>/gate/<slug>`. */
export function workRoot(top: string): string {
  const env = process.env.GATE_WORK;
  if (env) return join(env, slugOf(top));
  const twin = junkTwin(top);
  if (twin) return join(twin, ".gate");
  return join(tmpdir(), "gate", slugOf(top));
}

export interface RepoPaths {
  work: string;
  tree: string;
  runs: string;
  lock: string;
  receipts: string;
  history: string;
}

export function repoPaths(top: string, gitCommonDir: string): RepoPaths {
  const work = workRoot(top);
  return {
    work,
    tree: join(work, "tree"),
    runs: join(work, "runs"),
    lock: join(work, "lock"),
    receipts: join(gitCommonDir, "gate", "receipts"),
    history: join(gitCommonDir, "gate", "history.jsonl"),
  };
}
