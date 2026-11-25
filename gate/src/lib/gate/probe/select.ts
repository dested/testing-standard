// Which bugs a probe plants: candidates from gate.json `probe`, narrowed by
// --since / --only-files, sampled stratified across operators and areas with a
// seeded RNG; or explicit bugs from a --from file, resolved against the commit.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { GateConfig } from "../config.ts";
import { usage } from "../errors.ts";
import { git } from "../git.ts";
import { isOpName, mutableLines, mutationsOf, stored, variantsOf } from "./operators.ts";

export type Probe = NonNullable<GateConfig["probe"]>;

export interface Bug {
  file: string;
  /** 1-based */
  line: number;
  /** an OpName, except for a --from row replayed as recorded */
  op: string;
  /** full lines (stored trimmed/cut in results) */
  before: string;
  after: string;
  /** a --from row the operator can't regenerate any more, applied as its recorded text */
  replayed?: true;
}

/** A --from entry that won't run: excluded (with why) or stale. */
export interface Unrunnable {
  file: string;
  line: number;
  op: string;
  before: string;
  after: string;
  outcome: "excluded" | "stale";
  reason: string;
}

const SOURCE = /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/;
const TEST_FILE = /\.(test|spec)\.[^/]+$/;
const TEST_DIRS = new Set(["e2e", "test", "tests", "__tests__"]);
const GENERATED_DIRS = new Set(["node_modules", "dist", "build", "generated", ".gate"]);
const IGNORE = /\/\/\s*probe-ignore:\s*(.*)$/;

const globCache = new Map<string, InstanceType<typeof Bun.Glob>>();
export function globMatch(pattern: string, path: string): boolean {
  let g = globCache.get(pattern);
  if (!g) {
    g = new Bun.Glob(pattern);
    globCache.set(pattern, g);
  }
  return g.match(path);
}

/** Why a file can never carry a planted bug, or null when it can. */
export function fileExclusion(probe: Probe, file: string): string | null {
  const ex = probe.exclude?.find((e) => globMatch(e.path, file) || file === e.path || file.startsWith(`${e.path.replace(/\/+$/, "")}/`));
  if (ex) return ex.why;
  if (!SOURCE.test(file) || file.endsWith(".d.ts")) return "not a TS/JS source file";
  const dirs = file.split("/").slice(0, -1);
  if (TEST_FILE.test(file) || dirs.some((d) => TEST_DIRS.has(d))) return "a test file";
  if (dirs.some((d) => GENERATED_DIRS.has(d)) || /\.gen\./.test(file)) return "generated or vendored";
  if (!probe.include.some((g) => globMatch(g, file))) return "outside probe.include";
  return null;
}

/** The `// probe-ignore: <why>` reason covering a 1-based line (same line or the one above), or null. */
export function ignoreReason(lines: string[], line: number): string | null {
  for (const l of [lines[line - 1], lines[line - 2]]) {
    const m = l === undefined ? null : IGNORE.exec(l);
    if (m) return `probe-ignore: ${(m[1] ?? "").trim()}`;
  }
  return null;
}

/** Lines added or changed between `since` and `sha`, per file (1-based, new side). */
export function changedLines(top: string, since: string, sha: string): Map<string, Set<number>> {
  const r = git(top, ["diff", "-U0", "--no-color", "--no-ext-diff", since, sha]);
  if (r.code !== 0) throw usage(`--since ${since}: ${r.stderr.trim() || "git diff failed"}`);
  const out = new Map<string, Set<number>>();
  let file: string | null = null;
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("+++ ")) {
      file = line.startsWith("+++ b/") ? line.slice(6) : null;
      continue;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h && file) {
      const start = Number(h[1]);
      const n = h[2] === undefined ? 1 : Number(h[2]);
      let set = out.get(file);
      if (!set) out.set(file, (set = new Set()));
      for (let i = 0; i < n; i++) set.add(start + i);
    }
  }
  return out;
}

export function filesAt(top: string, sha: string): string[] {
  const r = git(top, ["ls-tree", "-r", "-z", "--name-only", sha]);
  if (r.code !== 0) throw usage(`couldn't list files at ${sha}: ${r.stderr.trim()}`);
  return r.stdout.split("\0").filter(Boolean);
}

/** Every plantable bug in the copy (`root`), honoring include/exclude, test/generated dirs and probe-ignore. */
export function candidates(root: string, files: string[], probe: Probe, opts: { since?: Map<string, Set<number>>; onlyFiles?: string } = {}): Bug[] {
  const out: Bug[] = [];
  for (const file of files) {
    if (fileExclusion(probe, file)) continue;
    if (opts.onlyFiles && !globMatch(opts.onlyFiles, file)) continue;
    const changed = opts.since?.get(file);
    if (opts.since && !changed) continue;
    const text = readFileSync(join(root, file), "utf8");
    const lines = text.split("\n");
    for (const m of mutationsOf(text)) {
      if (changed && !changed.has(m.line)) continue;
      if (ignoreReason(lines, m.line)) continue;
      out.push({ file, ...m });
    }
  }
  return out;
}

/** mulberry32: small, seedable, good enough to sample with. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The directory just below the candidates' common prefix: `apps/web/server/x.ts` → `server`. */
export function areaOf(files: string[]): (file: string) => string {
  const dirs = files.map((f) => f.split("/").slice(0, -1));
  let common = 0;
  if (dirs.length) {
    const first = dirs[0] ?? [];
    while (common < first.length && dirs.every((d) => d[common] === first[common])) common++;
  }
  return (file) => file.split("/").slice(0, -1)[common] ?? ".";
}

function shuffle<T>(xs: T[], rand: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

/**
 * Up to `max` bugs, at most one per line, cycling through operators and, within
 * each operator, through areas, so no operator or file dominates.
 */
export function sample(cands: Bug[], max: number, seed: number): Bug[] {
  const rand = rng(seed);
  const area = areaOf([...new Set(cands.map((c) => c.file))]);
  const buckets = new Map<string, Map<string, Bug[]>>();
  for (const c of cands) {
    let byArea = buckets.get(c.op);
    if (!byArea) buckets.set(c.op, (byArea = new Map()));
    const a = area(c.file);
    byArea.set(a, [...(byArea.get(a) ?? []), c]);
  }
  const ops = shuffle([...buckets.keys()].sort(), rand);
  const areaOrder = new Map(ops.map((op) => [op, shuffle([...(buckets.get(op)?.keys() ?? [])].sort(), rand)]));
  const cursor = new Map(ops.map((op) => [op, 0]));
  const used = new Set<string>();
  const picked: Bug[] = [];
  let live = [...ops];
  while (picked.length < max && live.length) {
    const next: string[] = [];
    for (const op of live) {
      if (picked.length >= max) break;
      const areas = areaOrder.get(op) ?? [];
      let got = false;
      for (let tries = 0; tries < areas.length && !got; tries++) {
        const i = cursor.get(op) ?? 0;
        cursor.set(op, i + 1);
        const pool = (buckets.get(op)?.get(areas[i % areas.length] ?? "") ?? []).filter((c) => !used.has(`${c.file}:${c.line}`));
        if (!pool.length) continue;
        const c = pool[Math.floor(rand() * pool.length)] as Bug;
        used.add(`${c.file}:${c.line}`);
        picked.push(c);
        got = true;
      }
      if (got) next.push(op);
    }
    live = next;
  }
  return picked;
}

// ---- --from ----

const FromSchema = z.object({ file: z.string(), line: z.number().int().positive(), op: z.string(), before: z.string(), after: z.string() }).passthrough();

/** Read a .jsonl of bugs (the audit prototype's shape) or a stored probe result (.json with `bugs`). */
export function readFromFile(path: string): z.infer<typeof FromSchema>[] {
  if (!existsSync(path)) throw usage(`--from ${path}: no such file`);
  const text = readFileSync(path, "utf8");
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") && !trimmed.includes("\n{")) {
    try {
      const obj = z.object({ bugs: z.array(FromSchema) }).passthrough().safeParse(JSON.parse(text));
      if (obj.success) return obj.data.bugs;
    } catch {
      // not a single JSON document: fall through to JSON lines
    }
  }
  return text
    .split("\n")
    .map((l, i) => ({ l: l.trim(), i }))
    .filter(({ l }) => l)
    .map(({ l, i }) => {
      let raw: unknown;
      try {
        raw = JSON.parse(l);
      } catch {
        throw usage(`--from ${path}:${i + 1} isn't JSON`);
      }
      const p = FromSchema.safeParse(raw);
      if (!p.success) throw usage(`--from ${path}:${i + 1} needs file, line, op, before, after`);
      return p.data;
    });
}

/** The line a predicate picks: the recorded number when it matches, else the only line that does. */
function locate(lines: string[], line: number, match: (l: string) => boolean): { idx: number } | { why: string } {
  const at = lines[line - 1];
  if (at !== undefined && match(at)) return { idx: line - 1 };
  const hits = lines.flatMap((l, i) => (match(l) ? [i] : []));
  if (hits.length === 1) return { idx: hits[0] ?? -1 };
  return { why: hits.length ? `${hits.length} lines match the text` : "line not found" };
}

/**
 * Resolve --from entries against the copy: find the line (by number when its
 * text still starts with `before`, else the one line that does), regenerate the
 * operator's variants and take the one equal to `after`. When the operator can't
 * give that change any more but a line still reads exactly `before`, the recorded
 * edit is applied as written and marked `replayed`.
 */
export function resolveFrom(root: string, files: Set<string>, probe: Probe, entries: z.infer<typeof FromSchema>[]): (Bug | Unrunnable)[] {
  const used = new Set<string>();
  return entries.map((e) => {
    const base = { file: e.file, line: e.line, op: e.op, before: e.before, after: e.after };
    const excluded = (reason: string): Unrunnable => ({ ...base, outcome: "excluded", reason });
    const stale = (reason: string): Unrunnable => ({ ...base, outcome: "stale", reason });
    const why = fileExclusion(probe, e.file);
    if (why) return excluded(why);
    if (!files.has(e.file)) return stale("file isn't in this commit");
    const lines = readFileSync(join(root, e.file), "utf8").split("\n");

    const take = (idx: number, after: string, replayed: boolean): Bug | Unrunnable => {
      const ignored = ignoreReason(lines, idx + 1);
      if (ignored) return excluded(ignored);
      const key = `${e.file}:${idx + 1}`;
      if (used.has(key)) return excluded("same line as an earlier bug in this run");
      used.add(key);
      return { file: e.file, line: idx + 1, op: e.op, before: lines[idx] ?? "", after, ...(replayed ? { replayed: true as const } : {}) };
    };

    // 1. The operator regenerates the recorded change.
    let staleWhy: string;
    const before = stored(e.before);
    const found = locate(lines, e.line, (l) => stored(l).startsWith(before));
    if ("why" in found) staleWhy = found.why;
    else {
      const line = lines[found.idx] ?? "";
      if (!isOpName(e.op)) staleWhy = `unknown operator ${e.op}`;
      else if (!mutableLines(lines)[found.idx]) staleWhy = "the line is a comment, import or type now";
      else {
        const after = variantsOf(e.op, line).find((v) => stored(v) === stored(e.after));
        if (after !== undefined) return take(found.idx, after, false);
        staleWhy = `${e.op} no longer gives that change`;
      }
      const ignored = ignoreReason(lines, found.idx + 1);
      if (ignored) return excluded(ignored);
    }

    // 2. The operator can't, but the recorded line is still there word for word: apply the edit as recorded.
    const whole = e.before.trim();
    const recordedAfter = e.after.trim();
    if (whole.length < 200 && recordedAfter.length < 200) {
      const exact = locate(lines, e.line, (l) => l.trim() === whole);
      if ("idx" in exact) {
        const line = lines[exact.idx] ?? "";
        const after = `${/^\s*/.exec(line)?.[0] ?? ""}${recordedAfter}`;
        if (after !== line) return take(exact.idx, after, true);
      }
    }
    return stale(staleWhy);
  });
}

export function isBug(x: Bug | Unrunnable): x is Bug {
  return !("outcome" in x);
}
