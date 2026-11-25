// What the stored probes say about coverage, per source file: every planted
// bug (deduplicated across probes: a --from replay plants the same change
// again), which check and which tests caught it, which were missed or
// excluded; the source files under probe.include no probe has touched; and the
// catch rate of every probe over time. Feeds `gate tests --html`.

import { basename } from "node:path";
import type { Repo } from "../context.ts";
import type { GateConfig } from "../config.ts";
import { splitPwName } from "../testlog.ts";
import { fileExclusion, filesAt, globMatch } from "./select.ts";
import { isReplay, readProbes, type BugResult, type ProbeResult } from "./store.ts";

export interface CatchingTest {
  title: string;
  /** Playwright project (a width) */
  project?: string;
  /** as the runner printed it, relative to its cwd */
  file?: string;
}

export interface PlantedBug {
  line: number;
  op: string;
  before: string;
  after: string;
  outcome: BugResult["outcome"];
  check?: string;
  timeout?: boolean;
  reason?: string;
  note?: string;
  /** the tests that failed on it, one per title (widths folded into `projects`) */
  tests: (CatchingTest & { projects: string[] })[];
  /** the newest probe that planted it */
  at: string;
  sha: string;
  /** that probe was a `--from` replay of a list, not a sample */
  replay: boolean;
  /** every probe that planted it, oldest first */
  seen: { at: string; outcome: BugResult["outcome"]; replay: boolean }[];
}

export interface SourceFileRow {
  path: string;
  critical: boolean;
  /** why the file can't carry a planted bug at HEAD any more, when that's so */
  excludedNow: string | null;
  caught: number;
  missed: number;
  /** excluded or stale: planted nowhere */
  other: number;
  bugs: PlantedBug[];
}

export interface ProbePoint {
  at: string;
  sha: string;
  source: ProbeResult["source"];
  /** `gate probe --from <list>`: replays chosen bugs (often ones already fixed), so its rate says little about coverage */
  replay: boolean;
  /** the replayed list's file name */
  from?: string;
  rate: number | null;
  minRate: number;
  counted: number;
  caught: number;
  missed: number;
  exit: number;
}

export interface ProbeCoverage {
  timeline: ProbePoint[];
  /** the newest probe that wasn't a replay (a sample, or --since): the page's headline catch rate */
  newestSampled: ProbePoint | null;
  files: SourceFileRow[];
  /** source files under probe.include at HEAD that could carry a bug */
  candidates: number;
  /** candidates no probe ever planted a counted bug in */
  untouched: string[];
  /** test title → unique planted bugs it failed on */
  caughtByTitle: Record<string, number>;
  /** gate.json has no probe section */
  noProbeConfig: boolean;
}

function catching(f: { name: string; file?: string }): CatchingTest {
  const pw = splitPwName(f.name);
  if (pw) return { title: pw.title, ...(pw.project ? { project: pw.project } : {}), file: pw.file };
  return { title: f.name, ...(f.file ? { file: f.file } : {}) };
}

export function probeCoverage(repo: Repo, head: string, cfg: GateConfig): ProbeCoverage {
  const probes = readProbes(repo);
  const probe = cfg.probe;
  const byKey = new Map<string, PlantedBug & { file: string }>();
  for (const p of probes) {
    for (const b of p.bugs) {
      const key = `${b.file}\0${b.before.trim()}\0${b.after.trim()}`;
      const prev = byKey.get(key);
      const tests = new Map<string, CatchingTest & { projects: string[] }>();
      for (const f of b.failing) {
        const t = catching(f);
        const e = tests.get(t.title) ?? { title: t.title, ...(t.file ? { file: t.file } : {}), projects: [] };
        if (t.project && !e.projects.includes(t.project)) e.projects.push(t.project);
        tests.set(t.title, e);
      }
      // probes are oldest first: each later sighting replaces the bug's facts and extends its history
      byKey.set(key, {
        file: b.file,
        line: b.line,
        op: b.op,
        before: b.before,
        after: b.after,
        outcome: b.outcome,
        ...(b.check ? { check: b.check } : {}),
        ...(b.timeout ? { timeout: true } : {}),
        ...(b.reason ? { reason: b.reason } : {}),
        ...(b.note ? { note: b.note } : {}),
        tests: [...tests.values()],
        at: p.at,
        sha: p.sha,
        replay: isReplay(p),
        seen: [...(prev?.seen ?? []), { at: p.at, outcome: b.outcome, replay: isReplay(p) }],
      });
    }
  }

  const caughtByTitle: Record<string, number> = {};
  const files = new Map<string, SourceFileRow>();
  for (const b of byKey.values()) {
    if (b.outcome === "caught") for (const t of b.tests) caughtByTitle[t.title] = (caughtByTitle[t.title] ?? 0) + 1;
    let row = files.get(b.file);
    if (!row) {
      row = {
        path: b.file,
        critical: !!probe?.critical?.some((g) => globMatch(g, b.file)),
        excludedNow: probe ? fileExclusion(probe, b.file) : null,
        caught: 0,
        missed: 0,
        other: 0,
        bugs: [],
      };
      files.set(b.file, row);
    }
    if (b.outcome === "caught") row.caught++;
    else if (b.outcome === "missed") row.missed++;
    else row.other++;
    const { file: _file, ...bug } = b;
    row.bugs.push(bug);
  }
  for (const row of files.values()) row.bugs.sort((a, b) => a.line - b.line);

  const sorted = [...files.values()].sort(
    (a, b) => b.missed - a.missed || Number(b.critical) - Number(a.critical) || a.path.localeCompare(b.path),
  );

  const touched = new Set([...byKey.values()].filter((b) => b.outcome === "caught" || b.outcome === "missed").map((b) => b.file));
  const cands = probe ? filesAt(repo.top, head).filter((f) => fileExclusion(probe, f) === null) : [];

  const timeline: ProbePoint[] = probes.map((p) => ({
    at: p.at,
    sha: p.sha,
    source: p.source,
    replay: isReplay(p),
    ...(p.from ? { from: basename(p.from) } : {}),
    rate: p.summary.rate,
    minRate: p.summary.minRate,
    counted: p.summary.counted,
    caught: p.summary.caught,
    missed: p.summary.missed,
    exit: p.exit,
  }));
  return {
    timeline,
    newestSampled: [...timeline].reverse().find((p) => !p.replay) ?? null,
    files: sorted,
    candidates: cands.length,
    untouched: cands.filter((f) => !touched.has(f)).sort(),
    caughtByTitle,
    noProbeConfig: !probe,
  };
}
