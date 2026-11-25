// `gate guard push`: the check the agents' own guard (agent-guard, a PreToolUse
// hook) runs before it lets an agent's `git push` through. No git hook, no git
// config: Sal's call, 2026-11-20 ("you are the only thing writing code anymore
// on this computer. its just for you. dont mess with git").
//
// Read-only: only read-only git commands. Exit 0 allow, 1 deny (reason + next
// command), 2 couldn't parse (the guard allows and shows the note).

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parseConfig, type GateConfig } from "./config.ts";
import { findRepo, resolveCommit, type Repo } from "./context.ts";
import { EXIT, errMsg, usage } from "./errors.ts";
import { git, showFile, treeSha } from "./git.ts";
import { short } from "./output.ts";
import { lastFullRun, readHistory, readReceipt } from "./receipt.ts";

/** The `gate` entry a report-mode background run uses (bun + this file, no Node launcher). */
export const GATE_ENTRY = fileURLToPath(new URL("../../gate.ts", import.meta.url));

// ---- what `git push <args>` would push where ----

export interface PushTarget {
  /** the local name or rev as given (`main`, `HEAD`, `refs/heads/x`) */
  src: string;
  sha: string;
  /** destination branch name (only branch destinations are kept) */
  branch: string;
}

export interface PushPlan {
  remote: string;
  targets: PushTarget[];
  /** pushes the guard deliberately ignores (deletes, tags), for the note */
  skipped: string[];
}

// git push options that take a separate value (`-o x`, `--repo x`).
const VALUE_OPTS = new Set(["--repo", "--push-option", "-o", "--receive-pack", "--exec"]);
const FLAG_OPTS = new Set([
  "--set-upstream", "--force", "--dry-run", "--quiet", "--verbose", "--follow-tags", "--no-follow-tags", "--no-verify", "--verify",
  "--atomic", "--no-atomic", "--porcelain", "--progress", "--no-progress", "--prune", "--no-prune", "--thin", "--no-thin",
  "--ipv4", "--ipv6", "--force-if-includes", "--no-force-if-includes", "--no-force-with-lease", "--no-signed", "--no-recurse-submodules",
]);
// options that take a value only in `--x=value` form
const OPTIONAL_VALUE = new Set(["--force-with-lease", "--signed", "--recurse-submodules"]);
const SHORT_FLAGS = new Set(["u", "f", "n", "q", "v", "4", "6", "d"]);

interface ParsedArgs {
  positional: string[];
  all: boolean;
  mirror: boolean;
  del: boolean;
  tags: boolean;
  repo?: string;
}

/** Parse the arguments after `git push`. Anything unrecognized → exit 2. */
export function parseGitPushArgs(args: string[]): ParsedArgs {
  const p: ParsedArgs = { positional: [], all: false, mirror: false, del: false, tags: false };
  let opts = true;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (!opts || !a.startsWith("-") || a === "-") {
      p.positional.push(a);
      continue;
    }
    if (a === "--") {
      opts = false;
      continue;
    }
    if (a.startsWith("--")) {
      const [name = a, value] = a.split(/=(.*)/s, 2);
      if (name === "--all" || name === "--branches") p.all = true;
      else if (name === "--mirror") p.mirror = true;
      else if (name === "--delete") p.del = true;
      else if (name === "--tags") p.tags = true;
      else if (name === "--repo") p.repo = value ?? args[++i];
      else if (VALUE_OPTS.has(name)) {
        if (value === undefined && args[++i] === undefined) throw usage(`git push ${name} needs a value`);
      } else if (FLAG_OPTS.has(name) || OPTIONAL_VALUE.has(name)) {
        if (value !== undefined && !OPTIONAL_VALUE.has(name)) throw usage(`git push ${name} takes no value`);
      } else throw usage(`unknown git push option ${name}`);
      continue;
    }
    // short flags, possibly bundled: -uf, -o value
    const chars = a.slice(1);
    for (let j = 0; j < chars.length; j++) {
      const c = chars[j] ?? "";
      if (c === "o") {
        if (j === chars.length - 1 && args[++i] === undefined) throw usage("git push -o needs a value");
        break;
      }
      if (!SHORT_FLAGS.has(c)) throw usage(`unknown git push option -${c}`);
      if (c === "d") p.del = true;
    }
  }
  if (p.repo === undefined && args.includes("--repo")) throw usage("git push --repo needs a value");
  return p;
}

function out(top: string, args: string[]): string | null {
  const r = git(top, args);
  return r.code === 0 ? r.stdout.trim() : null;
}

function currentBranch(top: string): string | null {
  return out(top, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
}

function isRemote(top: string, name: string): boolean {
  return (out(top, ["remote"]) ?? "").split("\n").includes(name);
}

function localBranches(top: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of (out(top, ["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads"]) ?? "").split("\n")) {
    const [name, sha] = line.split(" ");
    if (name && sha) m.set(name, sha);
  }
  return m;
}

function commitOf(top: string, rev: string): string {
  const sha = out(top, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
  if (!sha) throw usage(`can't resolve ${rev} to a commit`);
  return sha;
}

function isTag(top: string, name: string): boolean {
  return name.startsWith("refs/tags/") || (!name.startsWith("refs/") && git(top, ["show-ref", "--verify", "--quiet", `refs/tags/${name}`]).code === 0 && git(top, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]).code !== 0);
}

/** Destination branch for a bare or full ref name, or null when it isn't a branch. */
function branchOf(dst: string): string | null {
  if (dst.startsWith("refs/heads/")) return dst.slice("refs/heads/".length);
  if (dst.startsWith("refs/")) return null;
  return dst;
}

export function planPush(top: string, args: string[]): PushPlan {
  const a = parseGitPushArgs(args);
  const cur = currentBranch(top);
  const cfg = (k: string): string | null => out(top, ["config", "--get", k]);
  const remote =
    a.repo ?? a.positional[0] ?? (cur ? (cfg(`branch.${cur}.pushRemote`) ?? cfg("remote.pushDefault") ?? cfg(`branch.${cur}.remote`)) : null) ?? "origin";
  const specs = a.positional.slice(a.repo !== undefined ? 0 : 1);
  const targets: PushTarget[] = [];
  const skipped: string[] = [];

  if (a.all || a.mirror) {
    if (specs.length) throw usage("--all/--mirror can't be combined with refspecs");
    for (const [name, sha] of localBranches(top)) targets.push({ src: name, sha, branch: name });
    return { remote, targets, skipped };
  }
  if (!specs.length) {
    if (a.tags) return { remote, targets, skipped: ["tags"] };
    if (a.del) throw usage("--delete needs a refspec");
    if (!cur) throw usage("HEAD is detached and no refspec was given");
    const push = out(top, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{push}"]);
    const branch = push && push.startsWith(`${remote}/`) ? push.slice(remote.length + 1) : cur;
    targets.push({ src: cur, sha: commitOf(top, cur), branch });
    return { remote, targets, skipped };
  }

  for (const raw of specs) {
    const spec = raw.startsWith("+") ? raw.slice(1) : raw;
    const colon = spec.indexOf(":");
    const src = colon === -1 ? spec : spec.slice(0, colon);
    const dst = colon === -1 ? null : spec.slice(colon + 1);
    if (a.del || src === "") {
      skipped.push(`delete ${dst ?? src}`);
      continue;
    }
    if (src.includes("*")) {
      if (!dst?.includes("*")) throw usage(`refspec ${raw}: a pattern needs a pattern on both sides`);
      const [pre = "", post = ""] = src.split("*");
      for (const [name, sha] of localBranches(top)) {
        const full = `refs/heads/${name}`;
        for (const cand of [full, name]) {
          if (cand.startsWith(pre) && cand.endsWith(post) && cand.length >= pre.length + post.length) {
            const mid = cand.slice(pre.length, cand.length - post.length);
            const b = branchOf(dst.replace("*", mid));
            if (b) targets.push({ src: name, sha, branch: b });
            break;
          }
        }
      }
      continue;
    }
    if (isTag(top, src)) {
      skipped.push(`tag ${src}`);
      continue;
    }
    const sha = commitOf(top, src);
    let branch: string | null;
    if (dst !== null) branch = branchOf(dst);
    else if (src === "HEAD" || src === "@") {
      if (!cur) throw usage(`git push ${remote} HEAD with a detached HEAD has no destination: name one (HEAD:main)`);
      branch = cur;
    } else branch = branchOf(src);
    if (!branch) {
      skipped.push(`${dst ?? src} (not a branch)`);
      continue;
    }
    targets.push({ src, sha, branch });
  }
  return { remote, targets, skipped };
}

// ---- the decision ----

/** What a pushed gate.json drops relative to the remote's block-mode one. */
export function weakening(remote: GateConfig, pushed: GateConfig | null, pushedError: string | null, branch: string): string[] {
  if (pushedError) return [`gate.json is invalid: ${pushedError.split("\n")[0]}`];
  if (!pushed) return ["deletes gate.json"];
  const w: string[] = [];
  if (pushed.mode !== "block") w.push(`mode block → ${pushed.mode}`);
  const now = new Map(pushed.checks.map((c) => [c.name, c]));
  for (const c of remote.checks) {
    const p = now.get(c.name);
    if (!p) w.push(`drops check ${c.name}`);
    else if ((p.skips ?? "fail") === "allow" && (c.skips ?? "fail") !== "allow") w.push(`check ${c.name} now allows skips`);
  }
  if (!pushed.branches.includes(branch)) w.push(`stops protecting ${branch}`);
  return w;
}

function readCfg(top: string, sha: string): { cfg: GateConfig | null; text: string | null; error: string | null } {
  const text = showFile(top, sha, "gate.json");
  if (text === null) return { cfg: null, text, error: null };
  try {
    return { cfg: parseConfig(text, `gate.json at ${short(sha)}`), text, error: null };
  } catch (err) {
    return { cfg: null, text, error: errMsg(err) };
  }
}

// ---- weakening allowances: <git common dir>/gate/allow.jsonl ----

const AllowSchema = z.object({ at: z.string(), sha: z.string(), why: z.string() });

function allowPath(repo: Repo): string {
  return join(repo.gitDir, "gate", "allow.jsonl");
}

export function allowWeaken(cwd: string, rev: string, why: string): { sha: string; path: string } {
  if (!why.trim()) throw usage(`gate allow-weaken needs --why "<the owner's words>"`);
  const repo = findRepo(cwd);
  const sha = resolveCommit(repo, rev);
  const path = allowPath(repo);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), sha, why: why.trim() })}\n`);
  return { sha, path };
}

function allowedShas(repo: Repo): Set<string> {
  const path = allowPath(repo);
  const set = new Set<string>();
  if (!existsSync(path)) return set;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    try {
      const p = AllowSchema.safeParse(JSON.parse(line));
      if (p.success) set.add(p.data.sha);
    } catch {
      // blank or torn line
    }
  }
  return set;
}

// ---- report mode: fill the history in without anyone waiting ----

const PENDING_MS = 6 * 60 * 60 * 1000;

/** Start `gate run --sha … --trigger push --quiet` detached, once per tree. Returns whether it started. */
function startBackgroundRun(repo: Repo, sha: string, tree: string): boolean {
  // Once per tree. A live run of another commit doesn't stop it: `gate run` queues behind the lock.
  const marker = join(repo.paths.work, "push-runs", tree);
  if (existsSync(marker) && Date.now() - statSync(marker).mtimeMs < PENDING_MS) return false;
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, `${new Date().toISOString()} ${sha}\n`);
  const fd = openSync(join(repo.paths.work, "push.log"), "a");
  const env = { ...process.env };
  for (const k of ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE", "GIT_PREFIX"]) delete env[k];
  spawn(process.execPath, [GATE_ENTRY, "run", "--sha", sha, "--trigger", "push", "--quiet"], {
    cwd: repo.top,
    detached: true,
    stdio: ["ignore", fd, fd],
    env,
  }).unref();
  return true;
}

export interface TargetVerdict {
  branch: string;
  sha: string;
  allow: boolean;
  reason: string;
}

export interface GuardResult {
  allow: boolean;
  remote: string;
  lines: string[];
  targets: TargetVerdict[];
  skipped: string[];
  /** the command that turns a deny into an allow */
  next?: string;
}

/** Decide one `git push` (its arguments after "push"), run in `cwd`. */
export function guardPush(cwd: string, args: string[]): GuardResult {
  const repo = findRepo(cwd);
  const plan = planPush(repo.top, args);
  const head = git(repo.top, ["rev-parse", "HEAD"]).stdout.trim();
  const history = readHistory(repo.paths.history);
  const tracking = isRemote(repo.top, plan.remote);
  let allowances: Set<string> | null = null;
  const lines: string[] = [];
  const targets: TargetVerdict[] = [];
  let next: string | undefined;
  const verdict = (t: PushTarget, allow: boolean, reason: string): void => void targets.push({ branch: t.branch, sha: t.sha, allow, reason });

  for (const t of plan.targets) {
    const remoteSha = tracking ? out(repo.top, ["rev-parse", "--verify", "--quiet", `refs/remotes/${plan.remote}/${t.branch}^{commit}`]) : null;
    if (remoteSha === t.sha) {
      verdict(t, true, "nothing new to push");
      continue;
    }
    const pushed = readCfg(repo.top, t.sha);

    const remote = remoteSha ? readCfg(repo.top, remoteSha).cfg : null;
    if (remote?.mode === "block" && remote.branches.includes(t.branch)) {
      const what = weakening(remote, pushed.cfg, pushed.error, t.branch).join("; ");
      if (what) {
        allowances ??= allowedShas(repo);
        if (allowances.has(t.sha)) {
          lines.push(`gate: this push weakens the gate (${what}); allowed for ${short(t.sha)} by gate allow-weaken`);
        } else {
          lines.push(
            `gate: this push weakens the gate (${what}). That is the repo owner's call. If the owner said so in this conversation: gate allow-weaken --sha ${short(t.sha)} --why "<their words>", then push again.`,
          );
          next ??= `cd ${repo.top} && gate allow-weaken --sha ${short(t.sha)} --why "<the owner's words>"`;
          verdict(t, false, `weakens the gate: ${what}`);
          continue;
        }
      }
    }

    if (pushed.text === null) {
      verdict(t, true, "no gate.json");
      continue;
    }
    if (!pushed.cfg) {
      lines.push(`gate: ${pushed.error ?? "gate.json is invalid"}`);
      verdict(t, true, "gate.json invalid");
      continue;
    }
    const cfg = pushed.cfg;
    if (!cfg.branches.includes(t.branch)) {
      verdict(t, true, `${t.branch} isn't protected`);
      continue;
    }

    const tree = treeSha(repo.top, t.sha);
    const receipt = readReceipt(repo.paths.receipts, tree);
    const last = receipt ? null : lastFullRun(history, tree);
    const failed = last && !last.ok ? (last.checks.find((c) => !c.ok)?.name ?? "interrupted") : null;
    const why = failed ? `last run failed at ${failed}` : "no receipt: gate hasn't passed this commit";
    const cmd = `cd ${repo.top} && gate${t.sha === head ? "" : ` --sha ${short(t.sha)}`}`;

    if (cfg.mode === "block") {
      if (receipt) {
        lines.push(`gate: ${short(t.sha)} passed (run ${receipt.run}) · push to ${t.branch} allowed`);
        verdict(t, true, "receipt");
      } else {
        lines.push(`gate: push to ${t.branch} denied · ${short(t.sha)} ${why}. Run gate, fix what fails, commit, then push again.`);
        lines.push(`next: ${cmd}`);
        next ??= cmd;
        verdict(t, false, why);
      }
    } else if (receipt) {
      lines.push(`gate: report mode · ${short(t.sha)} passed · push allowed`);
      verdict(t, true, "report mode, receipt");
    } else {
      const started = !last && startBackgroundRun(repo, t.sha, tree);
      lines.push(`gate: report mode · ${short(t.sha)}: ${why} · push allowed${started ? " · gate started in the background" : ""}`);
      verdict(t, true, `report mode: ${why}`);
    }
  }
  const allow = targets.every((t) => t.allow);
  return { allow, remote: plan.remote, lines, targets, skipped: plan.skipped, ...(next ? { next } : {}) };
}

export const GUARD_EXIT = { allow: EXIT.pass, deny: EXIT.red, unparsed: EXIT.usage } as const;
