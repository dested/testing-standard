// Probe results: one JSON file per probe in `<git common dir>/gate/probes/`,
// and what they add up to (`gate probe report`, the status line, readiness).

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import type { Repo } from "../context.ts";
import { short } from "../output.ts";
import { filesAt } from "./select.ts";

const FailingSchema = z.object({ name: z.string(), file: z.string().optional() });

export const BugResultSchema = z.object({
  file: z.string(),
  line: z.number(),
  op: z.string(),
  before: z.string(),
  after: z.string(),
  outcome: z.enum(["caught", "missed", "excluded", "stale"]),
  check: z.string().optional(),
  timeout: z.boolean().optional(),
  failing: z.array(FailingSchema),
  reason: z.string().optional(),
  /** "replayed as recorded": a --from row applied as written because the operator can't regenerate it */
  note: z.string().optional(),
  ms: z.number(),
});
export type BugResult = z.infer<typeof BugResultSchema>;

export const SummarySchema = z.object({
  counted: z.number(),
  caught: z.number(),
  missed: z.number(),
  excluded: z.number(),
  stale: z.number(),
  byCheck: z.record(z.string(), z.number()),
  rate: z.number().nullable(),
  minRate: z.number(),
  criticalMissed: z.array(z.string()),
  ok: z.boolean(),
  /** why it failed: below minRate, a critical miss, nothing counted, interrupted */
  why: z.array(z.string()),
  interrupted: z.string().optional(),
});
export type Summary = z.infer<typeof SummarySchema>;

export const ProbeResultSchema = z.object({
  v: z.literal(1),
  at: z.string(),
  run: z.string(),
  repo: z.string(),
  sha: z.string(),
  tree: z.string(),
  commitAt: z.string(),
  gate: z.string(),
  source: z.enum(["sample", "since", "from"]),
  since: z.string().optional(),
  from: z.string().optional(),
  seed: z.number().optional(),
  max: z.number().optional(),
  ms: z.number(),
  baseline: z.array(z.object({ name: z.string(), ms: z.number() })),
  bugs: z.array(BugResultSchema),
  summary: SummarySchema,
  exit: z.number(),
});
export type ProbeResult = z.infer<typeof ProbeResultSchema>;

export function probesDir(repo: Repo): string {
  return join(repo.gitDir, "gate", "probes");
}

export function writeProbe(repo: Repo, result: ProbeResult): string {
  const dir = probesDir(repo);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${result.at.replace(/:/g, "-")}-${short(result.sha)}.json`);
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
  return path;
}

/** Every stored probe, oldest first. Unreadable files are skipped. */
export function readProbes(repo: Repo): ProbeResult[] {
  const dir = probesDir(repo);
  if (!existsSync(dir)) return [];
  const out: ProbeResult[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    try {
      const p = ProbeResultSchema.safeParse(JSON.parse(readFileSync(join(dir, f), "utf8")));
      if (p.success) out.push(p.data);
    } catch {
      // a torn file from a killed probe
    }
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

export function pct(rate: number | null): string {
  return rate === null ? "n/a" : `${Math.round(rate * 100)}%`;
}

// ---- readiness (gate status) ----

export const READY_MAX_AGE_DAYS = 14;

/**
 * A `gate probe --from <list>` replays chosen bugs, often misses already fixed:
 * it goes to 100% and says little (the testing standard). The headline catch
 * rate everywhere (gate status, gate tests, the --html page) is the newest
 * probe that wasn't a replay: a sample, or --since.
 */
export function isReplay(p: Pick<ProbeResult, "source">): boolean {
  return p.source === "from";
}

export interface ProbeStatus {
  at: string;
  sha: string;
  rate: number | null;
  missed: number;
  exit: number;
}

export interface ProbeHeadline {
  /** the newest sampled probe (not a --from replay), or null */
  probe: ProbeStatus | null;
  /** --from replays stored after it (every replay, when there's no sampled probe): never the headline */
  replaysSince: number;
}

function toStatus(p: ProbeResult): ProbeStatus {
  return { at: p.at, sha: p.sha, rate: p.summary.rate, missed: p.summary.missed, exit: p.exit };
}

/** `probes` oldest first, as readProbes returns them. */
export function headline(probes: ProbeResult[]): ProbeHeadline {
  const i = probes.findLastIndex((p) => !isReplay(p));
  const sampled = i >= 0 ? probes[i] : undefined;
  return { probe: sampled ? toStatus(sampled) : null, replaysSince: probes.slice(i + 1).filter(isReplay).length };
}

export function newestProbe(repo: Repo): ProbeHeadline {
  return headline(readProbes(repo));
}

/** Everything in order: HEAD has a passing receipt and the newest sampled probe exited 0 on a commit ≤ 14 days old. `why` lists what's open. */
export function readiness(repo: Repo, receiptPass: boolean, now = Date.now()): { ready: boolean; why: string[] } {
  const why: string[] = [];
  if (!receiptPass) why.push("HEAD has no passing receipt (run gate)");
  const probes = readProbes(repo);
  const p = probes.findLast((x) => !isReplay(x));
  if (!p) why.push(probes.length ? "no sampled probe yet, only --from replays (run gate probe)" : "no probe yet (run gate probe)");
  else {
    if (p.exit !== 0) why.push(`the newest sampled probe failed (${p.summary.why.join("; ") || `exit ${p.exit}`})`);
    if (now - Date.parse(p.commitAt) > READY_MAX_AGE_DAYS * 86_400_000) why.push(`the newest sampled probe is of a commit older than ${READY_MAX_AGE_DAYS} days`);
  }
  return { ready: why.length === 0, why };
}

/** `, 2 --from replays since (not counted)` or "". */
export function replaysNote(n: number): string {
  return n ? ` · ${n} --from replay${n === 1 ? "" : "s"} since, not counted` : "";
}

// ---- gate probe report ----

const TEST_FILE = /(\.(test|spec)\.[cm]?[jt]sx?$)|(^|\/)(e2e|tests?|__tests__)\/.*\.[cm]?[jt]sx?$/;

export interface ProbeReport {
  repo: string;
  probes: { at: string; sha: string; rate: number | null; counted: number; caught: number; missed: number; exit: number; replay: boolean; from?: string }[];
  byCheck: Record<string, number>;
  idleChecks: string[];
  testFiles: number;
  idleTestFiles: string[];
}

export function probeReport(repo: Repo, checks: string[]): ProbeReport {
  const probes = readProbes(repo);
  const byCheck: Record<string, number> = Object.fromEntries(checks.map((c) => [c, 0]));
  const seen: string[] = [];
  for (const p of probes) {
    for (const b of p.bugs) {
      if (b.outcome !== "caught" || !b.check) continue;
      byCheck[b.check] = (byCheck[b.check] ?? 0) + 1;
      for (const f of b.failing) if (f.file) seen.push(f.file.replace(/^\.\//, ""));
    }
  }
  const tests = filesAt(repo.top, "HEAD").filter((f) => TEST_FILE.test(f) && !f.split("/").includes("node_modules"));
  // A runner prints paths relative to its own cwd, so a stored name matches a repo file by suffix.
  const caught = (f: string): boolean => seen.some((s) => f === s || f.endsWith(`/${s}`));
  return {
    repo: repo.name,
    probes: probes.map((p) => ({
      at: p.at,
      sha: p.sha,
      rate: p.summary.rate,
      counted: p.summary.counted,
      caught: p.summary.caught,
      missed: p.summary.missed,
      exit: p.exit,
      replay: isReplay(p),
      ...(p.from ? { from: basename(p.from) } : {}),
    })),
    byCheck,
    idleChecks: Object.entries(byCheck)
      .filter(([, n]) => n === 0)
      .map(([c]) => c),
    testFiles: tests.length,
    idleTestFiles: tests.filter((f) => !caught(f)),
  };
}

export function printProbeReport(r: ProbeReport): void {
  console.log(`gate probe report  ${r.repo}  ${r.probes.length} probe${r.probes.length === 1 ? "" : "s"}`);
  if (!r.probes.length) {
    console.log("no probes yet: run gate probe");
    return;
  }
  for (const p of r.probes) {
    const kind = p.replay ? `  replay of ${p.from ?? "a list"}` : "";
    console.log(`  ${p.at.slice(0, 16).replace("T", " ")}  ${short(p.sha)}  ${pct(p.rate).padStart(4)}  ${p.caught}/${p.counted} caught  ${p.missed} missed  exit ${p.exit}${kind}`);
  }
  const parts = Object.entries(r.byCheck).map(([c, n]) => `${c} ${n}`);
  console.log(`caught first, all probes: ${parts.join(" · ")}`);
  if (r.idleChecks.length) console.log(`checks that never caught a planted bug: ${r.idleChecks.join(", ")}`);
  console.log(`test files that never caught a planted bug: ${r.idleTestFiles.length} of ${r.testFiles}`);
  for (const f of r.idleTestFiles) console.log(`  ${f}`);
  console.log("a file can be idle because no bug landed near it");
}

export function probeStatusLine(h: ProbeHeadline): string {
  const p = h.probe;
  if (!p) return h.replaysSince ? `no sampled probe yet: gate probe (${h.replaysSince} --from replay${h.replaysSince === 1 ? "" : "s"} stored, not counted)` : "none yet: gate probe";
  return `${p.at.slice(0, 16).replace("T", " ")}  ${short(p.sha)}  catch rate ${pct(p.rate)} · ${p.missed} missed · exit ${p.exit} · newest sampled${replaysNote(h.replaysSince)}`;
}

