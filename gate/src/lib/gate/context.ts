// Which repo, which commit, which gate.json: shared by run, status and doctor.

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseConfig, type GateConfig } from "./config.ts";
import { usage } from "./errors.ts";
import { commitSha, commonDir, repoTop, showFile, treeSha } from "./git.ts";
import { repoPaths, slugOf, type RepoPaths } from "./paths.ts";
import { short } from "./output.ts";

export interface Repo {
  top: string;
  name: string;
  slug: string;
  gitDir: string;
  paths: RepoPaths;
}

export function findRepo(cwd: string): Repo {
  const top = repoTop(cwd);
  if (!top) throw usage(`not inside a git repo (${cwd}). cd into the repo, then run gate`);
  const gitDir = commonDir(top);
  return { top, name: basename(top), slug: slugOf(top), gitDir, paths: repoPaths(top, gitDir) };
}

export function resolveCommit(repo: Repo, rev: string): string {
  const sha = commitSha(repo.top, rev);
  if (!sha) throw usage(rev === "HEAD" ? `${repo.name} has no commits yet. Commit, then run gate` : `${rev} isn't a commit in ${repo.name}`);
  return sha;
}

export interface Target {
  sha: string;
  tree: string;
  cfg: GateConfig;
}

/** gate.json at a commit (or the working tree's, for --dirty). No gate.json → exit 2. */
export function loadTarget(repo: Repo, sha: string, fromWorkingTree = false): Target {
  const where = fromWorkingTree ? "gate.json in the working tree" : `gate.json at ${short(sha)}`;
  const wt = join(repo.top, "gate.json");
  const text = fromWorkingTree ? (existsSync(wt) ? readFileSync(wt, "utf8") : null) : showFile(repo.top, sha, "gate.json");
  if (text === null) {
    const hint = !fromWorkingTree && existsSync(wt) ? ` (there's an uncommitted gate.json: commit it)` : "";
    throw usage(`no gate.json in ${repo.name} at ${short(sha)}: run "gate init"${hint}`);
  }
  return { sha, tree: treeSha(repo.top, sha), cfg: parseConfig(text, where) };
}
