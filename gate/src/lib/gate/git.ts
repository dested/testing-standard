// The git calls gate makes. Plain `git` subprocesses, run in the repo.

import { spawn, spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { broken } from "./errors.ts";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function git(cwd: string, args: string[], input?: string): GitResult {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", input, maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw broken(`couldn't run git: ${r.error.message}. Install git, or put it on PATH`);
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

function out(cwd: string, args: string[]): string | null {
  const r = git(cwd, args);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** The repo's top-level folder, or null outside a git work tree. */
export function repoTop(cwd: string): string | null {
  return out(cwd, ["rev-parse", "--show-toplevel"]);
}

/** Absolute `<git common dir>` (shared by every worktree of the repo). */
export function commonDir(cwd: string): string {
  const dir = out(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!dir) throw broken(`couldn't find the git directory for ${cwd}`);
  return dir;
}

/** A commit's full sha, or null when the rev doesn't name a commit. */
export function commitSha(cwd: string, rev: string): string | null {
  return out(cwd, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
}

export function treeSha(cwd: string, sha: string): string {
  const t = out(cwd, ["rev-parse", `${sha}^{tree}`]);
  if (!t) throw broken(`couldn't read the tree of ${sha}`);
  return t;
}

/** A file's content at a commit, or null when it isn't there. */
export function showFile(cwd: string, sha: string, path: string): string | null {
  const r = git(cwd, ["show", `${sha}:${path}`]);
  return r.code === 0 ? r.stdout : null;
}



export interface Uncommitted {
  /** tracked-and-changed or untracked non-ignored files present in the working tree */
  present: string[];
  /** tracked files deleted from the working tree */
  deleted: string[];
}

function zlist(text: string): string[] {
  return text.split("\0").filter(Boolean);
}

/** What `--dirty` overlays on a copy of HEAD, relative to the repo top. */
export function uncommitted(top: string): Uncommitted {
  const changed = git(top, ["diff", "--name-only", "-z", "--no-renames", "HEAD"]);
  const untracked = git(top, ["ls-files", "-z", "--others", "--exclude-standard"]);
  if (changed.code !== 0 || untracked.code !== 0) throw broken(`couldn't list uncommitted files: ${changed.stderr}${untracked.stderr}`);
  const present: string[] = [];
  const deleted: string[] = [];
  for (const p of new Set([...zlist(changed.stdout), ...zlist(untracked.stdout)])) {
    let exists = true;
    try {
      lstatSync(join(top, p));
    } catch {
      exists = false;
    }
    (exists ? present : deleted).push(p);
  }
  return { present, deleted };
}

/** Extract `git archive <sha>` into `dest` (an existing, empty directory). */
export function archiveInto(top: string, sha: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const archive = spawn("git", ["archive", "--format=tar", sha], { cwd: top, stdio: ["ignore", "pipe", "pipe"] });
    const tar = spawn("tar", ["-xf", "-", "-C", dest], { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    archive.stderr.on("data", (d: Buffer) => (err += d.toString()));
    tar.stderr.on("data", (d: Buffer) => (err += d.toString()));
    archive.stdout.pipe(tar.stdin);
    let pending = 2;
    let failed = false;
    const done = (who: string) => (code: number | null) => {
      if (code !== 0 && !failed) {
        failed = true;
        reject(broken(`${who} failed (exit ${code}): ${err.trim()}`));
      }
      if (--pending === 0 && !failed) resolve();
    };
    archive.on("error", (e) => reject(broken(`couldn't run git archive: ${e.message}`)));
    tar.on("error", (e) => reject(broken(`couldn't run tar: ${e.message}. Install tar`)));
    archive.on("close", done("git archive"));
    tar.on("close", done("tar"));
  });
}
