// `gate probe`: plant one bug at a time in the clean copy and see which check
// catches it. A green gate only means something if its checks can fail; the
// catch rate (and every bug that still passed) says whether they can.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkTimeout } from "../config.ts";
import { findRepo, loadTarget, resolveCommit } from "../context.ts";
import { broken, EXIT, GateError, errMsg, usage } from "../errors.ts";
import { git } from "../git.ts";
import { fmtMs, short } from "../output.ts";
import { appendHistory } from "../receipt.ts";
import { Interrupted, Session, type CheckResult } from "../session.ts";
import { GATE_VERSION } from "../version.ts";
import { stored } from "./operators.ts";
import { candidates, changedLines, filesAt, globMatch, isBug, readFromFile, resolveFrom, sample, type Bug, type Unrunnable } from "./select.ts";
import { pct, writeProbe, type BugResult, type ProbeResult, type Summary } from "./store.ts";

export const PROBE_INTERRUPTED = 130;
export const DEFAULT_MAX = 30;
export const DEFAULT_MIN_RATE = 0.9;
/** Marks a --from row applied as its recorded text because the operator can't regenerate it. */
export const REPLAYED = "replayed as recorded";

export interface ProbeOptions {
  cwd: string;
  sha?: string;
  from?: string;
  since?: string;
  max: number;
  seed?: number;
  onlyFiles?: string;
  json: boolean;
  verbose: boolean;
}

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

/** The probe's timeout for a check: min(its own, 3 × baseline + 30 s). */
export function probeTimeout(ownS: number, baselineMs: number): number {
  return Math.min(ownS, Math.ceil((3 * baselineMs) / 1000 + 30));
}

export async function gateProbe(o: ProbeOptions): Promise<number> {
  const repo = findRepo(o.cwd);
  const sha = resolveCommit(repo, o.sha ?? "HEAD");
  const target = loadTarget(repo, sha);
  const { cfg } = target;
  const probe = cfg.probe;
  if (!probe?.include.length) throw usage(`gate.json at ${short(sha)} has no probe.include: add "probe": { "include": ["src/**/*.ts"] } (the files a bug may be planted in)`);
  if (o.from && o.since) throw usage("--from and --since don't combine: --from names its bugs");
  const since = o.since ? resolveCommit(repo, o.since) : undefined;
  const seed = o.seed ?? parseInt(target.tree.slice(0, 8), 16);
  const minRate = probe.minRate ?? DEFAULT_MIN_RATE;
  const critical = probe.critical ?? [];
  const commitAt = new Date(Number(git(repo.top, ["show", "-s", "--format=%ct", sha]).stdout.trim()) * 1000).toISOString();

  const s = new Session({ repo, cfg, sha, out: o.json ? "json" : "human", verbose: o.verbose, wait: true, dirty: false }, PROBE_INTERRUPTED);
  const { out } = s;
  await s.open();
  const started = Date.now();
  const at = new Date(started).toISOString();
  const baseline: CheckResult[] = [];
  const results: BugResult[] = [];
  let planned: (Bug | Unrunnable)[] = [];
  let gateError: GateError | null = null;
  let red: string | null = null;
  const width = s.width;

  try {
    await steps();
  } catch (err) {
    if (err instanceof GateError) gateError = err;
    else if (!(err instanceof Interrupted)) gateError = new GateError(EXIT.broken, `gate probe crashed: ${errMsg(err)}`);
  }
  await s.close();
  const interrupted = s.interrupted;
  const ms = Date.now() - started;

  if (gateError) {
    if (o.json) console.log(JSON.stringify({ ok: false, exit: gateError.code, error: gateError.message }));
    else console.error(`gate: ${s.scrubber.scrub(gateError.message)}`);
    return gateError.code;
  }

  const history = (ok: boolean) =>
    appendHistory(repo.paths.history, {
      at,
      run: s.run,
      sha,
      tree: target.tree,
      mode: cfg.mode,
      trigger: "probe",
      dirty: false,
      only: null,
      ok,
      ms,
      checks: baseline.map((r) => ({ name: r.name, ok: r.ok, ms: r.ms, ...(r.reason ? { reason: r.reason } : {}) })),
    });

  if (red) {
    history(false);
    const msg = `the commit is red at ${red}; a probe needs a green commit`;
    if (o.json) console.log(JSON.stringify({ ok: false, exit: EXIT.red, error: msg }));
    else {
      out.line(msg);
      out.line(`next: cd ${repo.top} && gate`);
    }
    return EXIT.red;
  }

  const summary = summarize(results, minRate, critical, interrupted);
  const exit = interrupted ? PROBE_INTERRUPTED : summary.ok ? EXIT.pass : EXIT.red;
  const result: ProbeResult = {
    v: 1,
    at,
    run: s.run,
    repo: repo.name,
    sha,
    tree: target.tree,
    commitAt,
    gate: GATE_VERSION,
    source: o.from ? "from" : since ? "since" : "sample",
    ...(since ? { since } : {}),
    ...(o.from ? { from: o.from } : { seed, max: o.max }),
    ms,
    baseline: baseline.map((r) => ({ name: r.name, ms: r.ms })),
    bugs: results,
    summary,
    exit,
  };
  const path = writeProbe(repo, result);
  history(summary.ok && !interrupted);

  if (o.json) {
    console.log(JSON.stringify({ ...result, path }));
    return exit;
  }
  const byCheck = Object.entries(summary.byCheck).map(([c, n]) => `${c} ${n}`);
  out.line(
    `${summary.counted} counted · ${summary.caught} caught${byCheck.length ? ` (${byCheck.join(" · ")})` : ""} · ${summary.missed} missed · ${summary.excluded} excluded · ${summary.stale} stale`,
  );
  out.line(`catch rate ${pct(summary.rate)}`);
  if (interrupted) out.line(`interrupted by ${interrupted}: ${results.length} of ${planned.length} bugs finished, written to ${path}`);
  else {
    out.line(`results ${path}`);
    if (!summary.ok) out.line(`FAILED: ${summary.why.join("; ")}`);
  }
  return exit;

  async function steps(): Promise<void> {
    s.planDatabases();
    await s.prepare();

    // Which bugs, read from the copy (the commit's exact content).
    const files = filesAt(repo.top, sha);
    if (o.from) {
      planned = resolveFrom(s.tree, new Set(files), probe!, readFromFile(o.from));
    } else {
      const cands = candidates(s.tree, files, probe!, { ...(since ? { since: changedLines(repo.top, since, sha) } : {}), ...(o.onlyFiles ? { onlyFiles: o.onlyFiles } : {}) });
      if (!cands.length) {
        throw usage(
          since
            ? `no plantable line changed between ${short(since)} and ${short(sha)} inside probe.include`
            : `probe.include (${probe!.include.join(", ")}) has no plantable line${o.onlyFiles ? ` matching ${o.onlyFiles}` : ""}`,
        );
      }
      planned = sample(cands, o.max, seed);
    }

    const setup = await s.setup();
    if (setup && !setup.ok) {
      red = "setup";
      s.report(setup);
      return;
    }
    if (s.plans.length) await s.snapshotDatabases();
    for (const c of cfg.checks) {
      const r = await s.runCheck(c, { logName: `baseline-${c.name}` });
      s.stop();
      baseline.push(r);
      if (!r.ok) {
        red = c.name;
        s.report(r);
        return;
      }
    }

    out.line(`gate probe  ${repo.name}  ${short(sha)}  ${planned.length} bugs  baseline ${baseline.map((r) => `${r.name} ${fmtMs(r.ms)}`).join(" · ")}`);
    const baseMs = new Map(baseline.map((r) => [r.name, r.ms]));
    for (const [k, b] of planned.entries()) {
      s.stop();
      if (!isBug(b)) {
        const r: BugResult = { file: b.file, line: b.line, op: b.op, before: stored(b.before), after: stored(b.after), outcome: b.outcome, failing: [], reason: b.reason, ms: 0 };
        results.push(r);
        out.line(bugLine(r));
        continue;
      }
      const r = await plant(k, b, baseMs);
      results.push(r);
      out.line(bugLine(r));
    }
  }

  /** Change one line, run the checks until one fails, put the line back (and prove it). */
  async function plant(k: number, b: Bug, baseMs: Map<string, number>): Promise<BugResult> {
    const path = join(s.tree, b.file);
    const original = readFileSync(path);
    const hash = sha256(original);
    const lines = original.toString("utf8").split("\n");
    const base: BugResult = {
      file: b.file,
      line: b.line,
      op: b.op,
      before: stored(b.before),
      after: stored(b.after),
      outcome: "missed",
      failing: [],
      ms: 0,
      ...(b.replayed ? { note: REPLAYED } : {}),
    };
    if (lines[b.line - 1] !== b.before) return { ...base, outcome: "stale", reason: "the line changed under the probe" };
    lines[b.line - 1] = b.after;
    const t0 = performance.now();
    try {
      writeFileSync(path, lines.join("\n"));
      if (s.plans.length) await s.resetDatabases();
      for (const c of cfg.checks) {
        s.stop();
        const r = await s.runCheck(c, { timeoutS: probeTimeout(checkTimeout(c), baseMs.get(c.name) ?? 0), logName: `b${k + 1}-${c.name}`, coverage: false });
        s.stop(); // a check killed by SIGTERM is not a catch
        if (!r.ok) {
          return {
            ...base,
            outcome: "caught",
            check: c.name,
            ...(r.timedOut ? { timeout: true } : {}),
            failing: r.failingTests,
            ms: Math.round(performance.now() - t0),
          };
        }
      }
      return { ...base, ms: Math.round(performance.now() - t0) };
    } finally {
      writeFileSync(path, original);
      if (sha256(readFileSync(path)) !== hash) throw broken(`couldn't restore ${b.file} in the clean copy after bug ${k + 1}`);
    }
  }

  function bugLine(r: BugResult): string {
    const loc = `${r.file}:${r.line}`.padEnd(40);
    const op = r.op.padEnd(10);
    const blank = "".padEnd(width);
    if (r.outcome === "caught") {
      const first = r.failing[0]?.name;
      const detail = [r.timeout ? "(timeout)" : null, first ?? null].filter(Boolean).join(" ");
      return `caught  ${(r.check ?? "").padEnd(width)}  ${loc} ${op}${detail ? ` ${detail}` : ""}${r.note ? ` (${r.note})` : ""}`.trimEnd();
    }
    if (r.outcome === "missed") return `MISSED  ${blank}  ${loc} ${op} ${r.before} → ${r.after}${r.note ? ` (${r.note})` : ""}`;
    return `${r.outcome === "excluded" ? "exclud" : "stale "}  ${blank}  ${loc} ${op} ${r.reason ?? ""}`.trimEnd();
  }
}

export function summarize(results: BugResult[], minRate: number, critical: string[], interrupted: string | null): Summary {
  const caught = results.filter((r) => r.outcome === "caught");
  const missed = results.filter((r) => r.outcome === "missed");
  const counted = caught.length + missed.length;
  const byCheck: Record<string, number> = {};
  for (const r of caught) if (r.check) byCheck[r.check] = (byCheck[r.check] ?? 0) + 1;
  const rate = counted ? caught.length / counted : null;
  const criticalMissed = missed.filter((r) => critical.some((g) => globMatch(g, r.file))).map((r) => `${r.file}:${r.line}`);
  const why: string[] = [];
  if (interrupted) why.push(`interrupted by ${interrupted}`);
  if (rate === null) why.push("nothing counted: no bug could be planted");
  else if (rate < minRate) why.push(`catch rate ${pct(rate)} is below minRate ${pct(minRate)}`);
  if (criticalMissed.length) why.push(`missed under critical: ${criticalMissed.join(", ")}`);
  return {
    counted,
    caught: caught.length,
    missed: missed.length,
    excluded: results.filter((r) => r.outcome === "excluded").length,
    stale: results.filter((r) => r.outcome === "stale").length,
    byCheck,
    rate,
    minRate,
    criticalMissed,
    ok: why.length === 0,
    why,
    ...(interrupted ? { interrupted } : {}),
  };
}
