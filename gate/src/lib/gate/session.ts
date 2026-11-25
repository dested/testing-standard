// One gate session: the lock, signal handling, databases, the clean copy,
// setup, and running checks. `gate run` and `gate probe` both drive it, so the
// probe's copy, setup and template cache are exactly the run's.

import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { checkTimeout, type GateCheck, type GateConfig } from "./config.ts";
import type { Repo } from "./context.ts";
import { parseOutput, skipReason, countsLine, type Counts, type FailingTest } from "./counts.ts";
import { makeCopy } from "./copy.ts";
import {
  closeConnections,
  createGateDatabase,
  databaseExists,
  dropGateDatabase,
  dropRun,
  keyHash,
  listByPrefix,
  pgBroken,
  planDatabases,
  sweepStale,
  templatePrefix,
  type DbPlan,
} from "./db.ts";
import { baseEnv, envFileValues, type Env } from "./env.ts";
import { EXIT, GateError, errMsg } from "./errors.ts";
import { acquireLock } from "./lock.ts";
import { COVERAGE_ENV, coverageDir } from "./maps.ts";
import { ARTIFACTS_ENV, artifactsDir, PLAYWRIGHT_REPORTER, pruneArtifacts, slimArtifacts } from "./artifacts.ts";
import { checkLine, Out, Scrubber, type OutMode } from "./output.ts";
import { allocatePorts } from "./ports.ts";
import { killAllCommands, runCommand, type CmdResult } from "./runner.ts";
import { newRunId } from "./runid.ts";

export interface CheckResult {
  name: string;
  ran: boolean;
  ok: boolean;
  ms: number;
  exit: number | null;
  timedOut: boolean;
  counts?: Counts;
  reason?: string;
  failing: string[];
  failingTests: FailingTest[];
  flaky: string[];
  log: string;
}

/** Thrown out of a step when SIGINT/SIGTERM/SIGHUP arrived. */
export class Interrupted extends Error {}

const KEEP_RUNS = 20;
const TAIL_LINES = 40;
const MAX_NAMES = 20;

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function notRun(name: string): CheckResult {
  return { name, ran: false, ok: false, ms: 0, exit: null, timedOut: false, failing: [], failingTests: [], flaky: [], log: "" };
}

export interface SessionOptions {
  repo: Repo;
  cfg: GateConfig;
  sha: string;
  out: OutMode;
  verbose: boolean;
  wait: boolean;
  dirty: boolean;
}

export class Session {
  readonly run = newRunId();
  readonly scrubber = new Scrubber();
  readonly out: Out;
  readonly runDir: string;
  readonly width: number;
  plans: DbPlan[] = [];
  env: Env = {};
  interrupted: NodeJS.Signals | null = null;
  private release: (() => void) | null = null;
  private readonly signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  private readonly onSignal = (sig: NodeJS.Signals): void => {
    if (this.interrupted) process.exit(this.secondSignalExit);
    this.interrupted = sig;
    killAllCommands();
  };

  constructor(
    readonly o: SessionOptions,
    private readonly secondSignalExit: number = EXIT.broken,
  ) {
    this.scrubber.add(...envFileValues(o.repo.top, o.cfg.copy.env));
    this.out = new Out(o.out, this.scrubber);
    this.runDir = join(o.repo.paths.runs, this.run);
    this.width = Math.max(5, ...o.cfg.checks.map((c) => c.name.length));
  }

  get repo(): Repo {
    return this.o.repo;
  }

  get tree(): string {
    return this.o.repo.paths.tree;
  }

  /** Take the repo lock and start catching signals. */
  async open(): Promise<void> {
    mkdirSync(this.repo.paths.runs, { recursive: true });
    this.release = await acquireLock(this.repo.paths.lock, this.run, {
      wait: this.o.wait,
      repo: this.repo.name,
      onWait: (h) => {
        if (this.o.out !== "quiet") process.stderr.write(`gate: waiting on run ${h.run} (pid ${h.pid}) in ${this.repo.name} to finish…\n`);
      },
    });
    for (const s of this.signals) process.on(s, this.onSignal);
    mkdirSync(this.runDir, { recursive: true });
  }

  /** Drop this run's databases, prune old runs, release the lock. Returns databases it couldn't drop. */
  async close(): Promise<string[]> {
    for (const s of this.signals) process.off(s, this.onSignal);
    const leftover = this.plans.length ? await dropRun(this.plans, this.repo.slug, this.run) : [];
    pruneRuns(this.repo.paths.runs, this.run);
    this.release?.();
    this.release = null;
    if (leftover.length) process.stderr.write(`gate: couldn't drop ${leftover.join(", ")}; the next run's sweep retries after 6 hours\n`);
    return leftover;
  }

  stop(): void {
    if (this.interrupted) throw new Interrupted();
  }

  /** Resolve each databases[] entry's server and name (exit 3 when a server is unknown). */
  planDatabases(): void {
    this.plans = planDatabases(this.o.cfg.databases, process.env, this.repo.top, this.o.cfg.copy.env, this.repo.slug, this.run);
    this.scrubber.add(...this.plans.map((p) => p.server.password));
  }

  /** Sweep stale databases, make the clean copy, allocate ports, build the environment. */
  async prepare(): Promise<void> {
    const { cfg } = this.o;
    await sweepStale(this.plans, this.repo.slug, new Set([this.run]));
    await makeCopy({ top: this.repo.top, sha: this.o.sha, treeDir: this.tree, run: this.run, cfg, dirty: this.o.dirty });
    this.stop();
    let ports: Record<string, string>;
    try {
      ports = await allocatePorts(cfg.ports);
    } catch (err) {
      throw new GateError(EXIT.broken, `${errMsg(err)}. Free some ports and run gate again`);
    }
    this.env = {
      ...baseEnv(process.env, cfg.pass),
      GATE: "1",
      GATE_RUN: this.run,
      GATE_SHA: this.o.sha,
      GATE_ROOT: this.tree,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      ...ports,
      ...Object.fromEntries(this.plans.map((p) => [p.env, p.url])),
    };
  }

  private onLine(): ((l: string) => void) | undefined {
    return this.o.verbose ? (l) => this.out.stream(`      | ${l}`) : undefined;
  }

  /** Databases, setup commands, migrate (or the template), reported as one `setup` result. Null when there's nothing to set up. */
  async setup(): Promise<CheckResult | null> {
    const { cfg } = this.o;
    if (!cfg.setup.length && !this.plans.length) return null;
    const log = join(this.runDir, "setup.log");
    const t0 = performance.now();
    const fail = (exit: number | null, reason: string): CheckResult => ({ ...notRun("setup"), ran: true, ms: Math.round(performance.now() - t0), exit, reason, log });

    for (const p of this.plans) {
      try {
        if (p.migrate && p.key?.length) {
          const tpl = `${templatePrefix(this.repo.slug, p.index)}${keyHash(this.tree, p.key, p.migrate)}`;
          const hit = await databaseExists(p.server, tpl);
          p.template = { name: tpl, hit };
          await createGateDatabase(p.server, p.name, hit ? tpl : undefined);
        } else {
          await createGateDatabase(p.server, p.name);
        }
      } catch (err) {
        throw pgBroken(p.server, p.env, `create ${p.name}`, err);
      }
      this.stop();
    }

    const sh = async (cmd: string, check: string): Promise<CmdResult> => {
      const r = await runCommand({ cmd, cwd: this.tree, env: { ...this.env, GATE_CHECK: check }, log, onLine: this.onLine() });
      this.stop();
      return r;
    };
    for (const cmd of cfg.setup) {
      const r = await sh(cmd, "setup");
      if (r.exit !== 0) return fail(r.exit, `\`${cmd}\` exited ${r.exit ?? r.signal}`);
    }
    for (const p of this.plans) {
      if (!p.migrate || p.template?.hit) continue;
      const r = await sh(p.migrate, "migrate");
      if (r.exit !== 0) return fail(r.exit, `migrate for ${p.env} (\`${p.migrate}\`) exited ${r.exit ?? r.signal}`);
      if (p.template) await this.saveTemplate(p, log);
    }
    await this.closeAll();
    const hits = this.plans.filter((p) => p.template?.hit).length;
    return {
      ...notRun("setup"),
      ran: true,
      ok: true,
      ms: Math.round(performance.now() - t0),
      exit: 0,
      log,
      ...(hits ? { reason: `${plural(hits, "database")} from the template cache` } : {}),
    };
  }

  private async closeAll(): Promise<void> {
    for (const p of this.plans) {
      try {
        await closeConnections(p.server, p.name);
      } catch (err) {
        throw pgBroken(p.server, p.env, `close connections to ${p.name}`, err);
      }
    }
  }

  /** Keep a migrated template for the next run with the same `key` content; drop older ones. */
  private async saveTemplate(p: DbPlan, log: string): Promise<void> {
    if (!p.template) return;
    try {
      await closeConnections(p.server, p.name);
      await createGateDatabase(p.server, p.template.name, p.name);
      for (const old of await listByPrefix(p.server, templatePrefix(this.repo.slug, p.index))) {
        if (old !== p.template.name) await dropGateDatabase(p.server, old);
      }
    } catch (err) {
      // The run goes on without a cache; next run migrates again.
      appendFileSync(log, `gate: couldn't save template ${p.template.name}: ${errMsg(err)}\n`);
    }
  }

  private baseName(p: DbPlan): string {
    return `gate_${this.repo.slug}_${this.run}_base${p.index}`;
  }

  /** Snapshot every set-up database as this run's base, so resetDatabases() can hand out fresh copies. */
  async snapshotDatabases(): Promise<void> {
    for (const p of this.plans) {
      try {
        await closeConnections(p.server, p.name);
        await createGateDatabase(p.server, this.baseName(p), p.name);
      } catch (err) {
        throw pgBroken(p.server, p.env, `snapshot ${p.name}`, err);
      }
    }
  }

  /** Every databases[] entry back to its just-set-up state (and the harness's `<db>_*` copies gone). */
  async resetDatabases(): Promise<void> {
    for (const p of this.plans) {
      try {
        for (const n of await listByPrefix(p.server, p.name)) {
          if (n === p.name || n.startsWith(`${p.name}_`)) await dropGateDatabase(p.server, n);
        }
        await createGateDatabase(p.server, p.name, this.baseName(p));
      } catch (err) {
        throw pgBroken(p.server, p.env, `reset ${p.name}`, err);
      }
    }
  }

  /**
   * `coverage: false` (a planted bug's run): no $GATE_COVERAGE and no $GATE_ARTIFACTS, so its maps and
   * test detail never mix with the baseline's. Otherwise gate's Playwright reporter rides along through
   * PW_TEST_REPORTER (Playwright appends it to the repo's own), unless the repo passes its own.
   */
  async runCheck(c: GateCheck, opts: { timeoutS?: number; logName?: string; coverage?: boolean } = {}): Promise<CheckResult> {
    const log = join(this.runDir, `${opts.logName ?? c.name}.log`);
    const timeout = opts.timeoutS ?? checkTimeout(c);
    const env: Env = { ...this.env, GATE_CHECK: c.name };
    if (opts.coverage !== false) {
      const dir = coverageDir(this.runDir, c.name);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      env[COVERAGE_ENV] = dir;
      const art = artifactsDir(this.runDir, c.name);
      rmSync(art, { recursive: true, force: true });
      env[ARTIFACTS_ENV] = art;
      env.PW_TEST_REPORTER ??= PLAYWRIGHT_REPORTER;
    }
    const r = await runCommand({
      cmd: c.run,
      cwd: c.cwd ? join(this.tree, c.cwd) : this.tree,
      env,
      log,
      timeoutS: timeout,
      onLine: this.onLine(),
    });
    if (env[ARTIFACTS_ENV]) await slimArtifacts(env[ARTIFACTS_ENV]);
    const parsed = parseOutput(readFileSync(log, "utf8"));
    const counts = parsed.counts ?? undefined;
    let ok = r.exit === 0 && !r.timedOut;
    let reason: string | undefined;
    if (r.timedOut) reason = `timed out after ${timeout}s`;
    else if (!ok) reason = counts ? undefined : `exit ${r.exit ?? r.signal}`;
    else if ((c.skips ?? "fail") === "fail") {
      const why = skipReason(parsed);
      if (why) {
        ok = false;
        reason = why;
      }
    }
    return {
      name: c.name,
      ran: true,
      ok,
      ms: r.ms,
      exit: r.exit,
      timedOut: r.timedOut,
      counts,
      reason,
      failing: parsed.failing,
      failingTests: parsed.failingTests,
      flaky: parsed.flakyNames,
      log,
    };
  }

  /** The check's line, plus failing names, the log tail and its path on a failure. */
  report(r: CheckResult): void {
    const detail = [r.counts ? countsLine(r.counts, r.ok) : null, r.reason ?? null].filter(Boolean).join(" · ");
    this.out.line(checkLine(r.ok ? "pass" : "FAIL", r.name, this.width, r.ms, detail || undefined));
    if (r.ok) return;
    for (const n of r.failing.slice(0, MAX_NAMES)) this.out.line(`      ${n}`);
    if (r.failing.length > MAX_NAMES) this.out.line(`      …and ${r.failing.length - MAX_NAMES} more`);
    let text = "";
    try {
      text = readFileSync(r.log, "utf8");
    } catch {
      // no log written
    }
    for (const l of text.replace(/\n+$/, "").split("\n").slice(-TAIL_LINES)) this.out.line(`      ${l}`);
    this.out.line(`      log ${r.log}`);
  }

  reportNotRun(name: string): void {
    this.out.line(checkLine("skip", name, this.width, null));
  }
}

function pruneRuns(runsDir: string, keep: string): void {
  let dirs: string[];
  try {
    dirs = readdirSync(runsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
      .reverse();
  } catch {
    return;
  }
  for (const d of dirs.slice(KEEP_RUNS)) if (d !== keep) rmSync(join(runsDir, d), { recursive: true, force: true });
  pruneArtifacts(runsDir, keep);
}
