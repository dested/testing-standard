// The clean copy: `git archive <sha>` into a fresh directory, the dependency
// caches (copy.keep) moved over from the previous copy, the gitignored env
// files copied from the working tree. `--dirty` overlays the working tree.

import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GateConfig } from "./config.ts";
import { broken, errMsg } from "./errors.ts";
import { archiveInto, uncommitted } from "./git.ts";

const KEEP_DEPTH = 4;

/** Kept directories under `root` (relative), depth ≤ 4, never inside another kept one. */
export function findKept(root: string, names: string[]): string[] {
  if (!names.length || !existsSync(root)) return [];
  const want = new Set(names);
  const found: string[] = [];
  const walk = (rel: string, depth: number): void => {
    let entries;
    try {
      entries = readdirSync(rel ? join(root, rel) : root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (want.has(e.name)) found.push(child);
      else if (depth < KEEP_DEPTH) walk(child, depth + 1);
    }
  };
  walk("", 1);
  return found;
}

/** Copy one working-tree path (file or symlink) into the copy, replacing what's there. */
function overlay(src: string, dest: string): void {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  const st = lstatSync(src);
  if (st.isSymbolicLink() || st.isDirectory()) cpSync(src, dest, { recursive: true, verbatimSymlinks: true });
  else copyFileSync(src, dest);
}

export interface CopyResult {
  /** files overlaid or removed by --dirty */
  dirtyFiles: number;
}

export async function makeCopy(opts: { top: string; sha: string; treeDir: string; run: string; cfg: GateConfig; dirty: boolean }): Promise<CopyResult> {
  const { top, sha, treeDir, run, cfg } = opts;
  const fresh = `${treeDir}.new-${run}`;
  try {
    rmSync(fresh, { recursive: true, force: true });
    mkdirSync(fresh, { recursive: true });
    await archiveInto(top, sha, fresh);

    // Dependency caches: a rename from the old copy, never a symlink into the working tree.
    for (const rel of findKept(treeDir, cfg.copy.keep)) {
      const parent = dirname(join(fresh, rel));
      if (!existsSync(parent) || !statSync(parent).isDirectory() || existsSync(join(fresh, rel))) continue;
      renameSync(join(treeDir, rel), join(fresh, rel));
    }
    rmSync(treeDir, { recursive: true, force: true });
    renameSync(fresh, treeDir);
  } catch (err) {
    rmSync(fresh, { recursive: true, force: true });
    throw broken(`couldn't make the clean copy in ${treeDir}: ${errMsg(err)}. Check disk space and that the work root is writable (gate doctor)`);
  }

  let dirtyFiles = 0;
  if (opts.dirty) {
    const u = uncommitted(top);
    for (const p of u.present) overlay(join(top, p), join(treeDir, p));
    for (const p of u.deleted) rmSync(join(treeDir, p), { recursive: true, force: true });
    dirtyFiles = u.present.length + u.deleted.length;
  }

  // Gitignored secrets, same relative path. Never printed.
  for (const f of cfg.copy.env) {
    const src = join(top, f);
    if (existsSync(src) && statSync(src).isFile()) {
      mkdirSync(dirname(join(treeDir, f)), { recursive: true });
      copyFileSync(src, join(treeDir, f));
    }
  }
  return { dirtyFiles };
}
