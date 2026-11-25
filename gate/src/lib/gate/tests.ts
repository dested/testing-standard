// `gate tests`: every test the repo has and what happened to it the last time
// gate ran. A report: it runs nothing and writes nothing. It reads the kept run
// logs (`<work root>/runs/<run>/<check>.log`, a probe's `baseline-<check>.log`),
// history.jsonl, the receipts and the stored probes, so it works on any run
// gate ever kept, made before this command existed or after.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { findRepo, loadTarget, resolveCommit } from "./context.ts";
import { usage } from "./errors.ts";
import { git, showFile } from "./git.ts";
import { fmtMs, short } from "./output.ts";
import { failedAt, readHistory, readReceipt, type HistoryLine } from "./receipt.ts";
import { headline, pct, readProbes, replaysNote } from "./probe/store.ts";
import { filesAt, globMatch } from "./probe/select.ts";
import { parseTests, type LoggedTest, type TestStatus } from "./testlog.ts";
import { readMaps, type MapEntry } from "./maps.ts";

/** The standard's three test names; a file under one with no recorded result is "not run yet". */
export const TEST_NAMES = [/\.rule\.test\.tsx?$/, /\.api\.test\.ts$/, /\.flow\.spec\.ts$/];

export interface TestHistory {
  /** kept runs whose log for this check named the test */
  runs: number;
  failed: number;
  flaky: number;
  /** the newest kept run it failed in, with that log and error */
  lastFailure?: { run: string; at: string; log: string; error?: string[] };
  /** with `recent`: every kept run that named it, newest first (`run` is a `kept` entry's id) */
  recent?: { run: string; status: TestStatus; ms?: number }[];
}

export interface TestRow {
  name: string;
  project?: string;
  loc?: string;
  status: TestStatus;
  ms?: number;
  error?: string[];
  history: TestHistory;
  /** passed, and never failed or flaked in a kept run */
  clean: boolean;
}

export interface FileRow {
  /** repo-relative when it resolved to a file at HEAD, else as the runner printed it */
  path: string;
  runner: "bun" | "playwright";
  /** planted bugs this file's tests caught across every stored probe; null when there are no probes */
  caught: number | null;
  tests: TestRow[];
}

export interface StatusCounts {
  pass: number;
  fail: number;
  flaky: number;
  skip: number;
  todo: number;
  dnr: number;
}

export interface RunRef {
  run: string;
  at: string;
  sha: string;
  trigger: HistoryLine["trigger"];
  dirty: boolean;
}

export interface CheckRow {
  name: string;
  /** what the run said about the check; "not-run" when no kept run ran it */
  state: "pass" | "fail" | "not-run";
  ms: number | null;
  reason?: string;
  /** the run these results are from */
  from: RunRef | null;
  /** false when the newest run stopped before this check and the results are older */
  newest: boolean;
  log: string | null;
  /** tests named in the log */
  tests: number;
  /** the runner's own total, from history, when it differs from the named tests */
  summaryTotal: number | null;
  counts: StatusCounts;
  /** Playwright checks: distinct flows and the projects (widths) each ran at */
  flows?: { flows: number; widths: string[] };
  files: FileRow[];
}

export interface TestsReport {
  repo: string;
  head: string;
  tree: string;
  receipt: boolean;
  lastRun: (RunRef & { ok: boolean; failedAt: string | null; only: string[] | null; commitsSince: number | null }) | null;
  /** the receipt sentence: "HEAD has a receipt", "HEAD failed at api", "HEAD is 3 commits past it: no receipt" */
  headState: string;
  /** the newest sampled probe: a --from replay is never the headline */
  probe: { at: string; sha: string; rate: number | null; missed: number; exit: number } | null;
  /** --from replays stored after it (all of them when there's no sampled probe) */
  probeReplaysSince: number;
  probes: number;
  runsKept: number;
  checks: CheckRow[];
  notRunYet: string[];
  /** coverage maps the checks wrote to $GATE_COVERAGE, from the run each check's results come from */
  maps: MapEntry[];
  /** with `recent`: the kept runs, newest first */
  kept?: RunRef[];
}

function emptyCounts(): StatusCounts {
  return { pass: 0, fail: 0, flaky: 0, skip: 0, todo: 0, dnr: 0 };
}

const PackageName = z.object({ name: z.string().optional() });

/** Map a runner's printed path (relative to its cwd) to a file at HEAD. */
function resolver(top: string, head: string, files: string[]): (printed: string, workspace?: string) => string {
  const set = new Set(files);
  const workspaces = new Map<string, string>();
  for (const f of files) {
    if (!f.endsWith("package.json") || f === "package.json" || f.split("/").includes("node_modules")) continue;
    try {
      const p = PackageName.safeParse(JSON.parse(showFile(top, head, f) ?? "{}"));
      if (p.success && p.data.name) workspaces.set(p.data.name, dirname(f));
    } catch {
      // a package.json that isn't JSON names no workspace
    }
  }
  const cache = new Map<string, string>();
  return (printed, workspace) => {
    const raw = printed.replace(/^\.\//, "");
    const key = `${workspace ?? ""}\0${raw}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const dir = workspace ? workspaces.get(workspace) : undefined;
    let found: string | undefined;
    if (dir && set.has(`${dir}/${raw}`)) found = `${dir}/${raw}`;
    else if (set.has(raw)) found = raw;
    else {
      const ends = files.filter((f) => f.endsWith(`/${raw}`));
      found = (dir ? ends.find((f) => f.startsWith(`${dir}/`)) : undefined) ?? (ends.length === 1 ? ends[0] : undefined);
    }
    const out = found ?? (dir ? `${dir}/${raw}` : raw);
    cache.set(key, out);
    return out;
  };
}

function logPath(runs: string, h: HistoryLine, check: string): string {
  return join(runs, h.run, h.trigger === "probe" ? `baseline-${check}.log` : `${check}.log`);
}

function ref(h: HistoryLine): RunRef {
  return { run: h.run, at: h.at, sha: h.sha, trigger: h.trigger, dirty: h.dirty };
}

function commitsBetween(top: string, from: string, to: string): number | null {
  const r = git(top, ["rev-list", "--count", `${from}..${to}`]);
  const n = Number(r.stdout.trim());
  return r.code === 0 && Number.isInteger(n) ? n : null;
}

const testKey = (path: string, t: Pick<LoggedTest, "project" | "name">): string => `${path}\0${t.project ?? ""}\0${t.name}`;

export function testsReport(cwd: string, opts: { recent?: boolean } = {}): TestsReport {
  const repo = findRepo(cwd);
  const head = resolveCommit(repo, "HEAD");
  const target = loadTarget(repo, head);
  const files = filesAt(repo.top, head);
  const resolve = resolver(repo.top, head, files);
  const runsDir = repo.paths.runs;
  const treePrefix = `${repo.paths.tree}/`;

  const history = readHistory(repo.paths.history);
  // Kept runs, newest first: history lines whose run folder is still there.
  const kept: HistoryLine[] = [];
  const seenRun = new Set<string>();
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (!h || seenRun.has(h.run) || !existsSync(join(runsDir, h.run))) continue;
    seenRun.add(h.run);
    kept.push(h);
  }

  const parsed = new Map<string, LoggedTest[] | null>();
  const testsOf = (h: HistoryLine, check: string): LoggedTest[] | null => {
    const p = logPath(runsDir, h, check);
    if (!parsed.has(p)) parsed.set(p, existsSync(p) ? parseTests(readFileSync(p, "utf8")) : null);
    return parsed.get(p) ?? null;
  };

  const probes = readProbes(repo);
  // Per caught bug, the test files its failing tests named (relative to the runner's cwd, no workspace),
  // so a repo file matches by suffix, as in `gate probe report`.
  const caughtFiles = probes.flatMap((p) =>
    p.bugs.filter((b) => b.outcome === "caught").map((b) => b.failing.flatMap((f) => (f.file ? [f.file.replace(/^\.\//, "")] : []))),
  );
  const caughtBy = (path: string): number => caughtFiles.filter((fs) => fs.some((f) => path === f || path.endsWith(`/${f}`))).length;

  const recorded = new Set<string>();
  const checks: CheckRow[] = [];
  const maps: MapEntry[] = [];
  for (const c of target.cfg.checks) {
    // Every kept run's result for each test of this check, for "failed in 2 of the last 20 runs".
    const hist = new Map<string, TestHistory>();
    for (const h of kept) {
      if (!h.checks.some((x) => x.name === c.name)) continue;
      for (const t of testsOf(h, c.name) ?? []) {
        const path = resolve(t.file, t.workspace);
        recorded.add(path);
        const k = testKey(path, t);
        const e: TestHistory = hist.get(k) ?? { runs: 0, failed: 0, flaky: 0, ...(opts.recent ? { recent: [] } : {}) };
        e.runs++;
        e.recent?.push({ run: h.run, status: t.status, ...(t.ms !== undefined ? { ms: t.ms } : {}) });
        if (t.status === "fail") {
          e.failed++;
          // kept runs are newest first, so the first failure seen is the newest
          e.lastFailure ??= { run: h.run, at: h.at, log: logPath(runsDir, h, c.name), ...(t.error?.length ? { error: t.error.map((l) => l.split(treePrefix).join("")) } : {}) };
        }
        if (t.status === "flaky") e.flaky++;
        hist.set(k, e);
      }
    }

    const src = kept.find((h) => h.checks.some((x) => x.name === c.name) && testsOf(h, c.name) !== null) ?? null;
    const entry = src?.checks.find((x) => x.name === c.name);
    const logged = src ? (testsOf(src, c.name) ?? []) : [];
    const counts = emptyCounts();
    const byFile = new Map<string, FileRow>();
    for (const t of logged) {
      counts[t.status]++;
      const path = resolve(t.file, t.workspace);
      const history = hist.get(testKey(path, t)) ?? { runs: 1, failed: 0, flaky: 0 };
      const row: TestRow = {
        name: t.name,
        ...(t.project ? { project: t.project } : {}),
        ...(t.loc ? { loc: t.loc } : {}),
        status: t.status,
        ...(t.ms !== undefined ? { ms: t.ms } : {}),
        ...(t.error?.length ? { error: t.error.map((l) => l.split(treePrefix).join("")) } : {}),
        history,
        clean: t.status === "pass" && history.failed === 0 && history.flaky === 0,
      };
      const f = byFile.get(path) ?? { path, runner: t.runner, caught: probes.length ? caughtBy(path) : null, tests: [] };
      f.tests.push(row);
      byFile.set(path, f);
    }
    const summary = entry?.counts;
    const summaryTotal = summary ? summary.passed + summary.failed + summary.skipped + summary.todo + summary.flaky + summary.didNotRun : null;
    const pw = logged.filter((t) => t.runner === "playwright");
    if (src) maps.push(...readMaps(join(runsDir, src.run), c.name, src.run));
    checks.push({
      name: c.name,
      state: entry ? (entry.ok ? "pass" : "fail") : "not-run",
      ms: entry?.ms ?? null,
      ...(entry?.reason ? { reason: entry.reason } : {}),
      from: src ? ref(src) : null,
      newest: !!src && src === kept[0],
      log: src ? logPath(runsDir, src, c.name) : null,
      tests: logged.length,
      summaryTotal: summaryTotal !== null && summaryTotal !== logged.length ? summaryTotal : null,
      counts,
      ...(pw.length
        ? {
            flows: {
              flows: new Set(pw.map((t) => `${resolve(t.file, t.workspace)}\0${t.name}`)).size,
              widths: [...new Set(pw.flatMap((t) => (t.project ? [t.project] : [])))],
            },
          }
        : {}),
      files: [...byFile.values()].sort((a, b) => a.path.localeCompare(b.path)),
    });
  }

  const receipt = readReceipt(repo.paths.receipts, target.tree) !== null;
  const lastH = kept.find((h) => h.trigger !== "probe") ?? [...history].reverse().find((h) => h.trigger !== "probe") ?? null;
  const lastRun = lastH
    ? { ...ref(lastH), ok: lastH.ok, failedAt: failedAt(lastH), only: lastH.only, commitsSince: lastH.sha === head ? 0 : commitsBetween(repo.top, lastH.sha, head) }
    : null;
  let headState: string;
  if (receipt) headState = lastRun && !lastRun.ok && lastH?.tree === target.tree ? "HEAD has a receipt from an earlier pass" : "HEAD has a receipt";
  else if (!lastRun) headState = "no receipt: run gate";
  else if (lastH && lastH.tree === target.tree) {
    headState = !lastRun.ok
      ? `HEAD failed at ${lastRun.failedAt ?? "?"}`
      : `HEAD has no receipt (that run was ${lastRun.dirty ? "--dirty" : "--only"}): run gate`;
  } else {
    const n = lastRun.commitsSince;
    headState = n ? `HEAD is ${n} commit${n === 1 ? "" : "s"} past it: no receipt, run gate` : "HEAD has moved since: no receipt, run gate";
  }

  const ph = headline(probes);
  return {
    repo: repo.name,
    head,
    tree: target.tree,
    receipt,
    lastRun,
    headState,
    probe: ph.probe,
    probeReplaysSince: ph.replaysSince,
    probes: probes.length,
    runsKept: kept.length,
    checks,
    notRunYet: files.filter((f) => TEST_NAMES.some((re) => re.test(f)) && !f.split("/").includes("node_modules") && !recorded.has(f)).sort(),
    maps,
    ...(opts.recent ? { kept: kept.map(ref) } : {}),
  };
}

// ---- narrowing: --check, --file, --grep, --failed ----

export interface TestsFilter {
  check?: string;
  file?: string;
  grep?: string;
  failed?: boolean;
}

function fileMatches(pattern: string, path: string): boolean {
  // A glob matches from the repo root or from any folder (`e2e/*.flow.spec.ts`); plain text is a substring.
  return /[*?[{]/.test(pattern) ? globMatch(pattern, path) || globMatch(`**/${pattern}`, path) : path.includes(pattern);
}

export function narrow(r: TestsReport, f: TestsFilter): TestsReport {
  if (f.check && !r.checks.some((c) => c.name === f.check)) {
    throw usage(`no check named ${f.check}. The checks: ${r.checks.map((c) => c.name).join(", ")}`);
  }
  const grep = f.grep?.toLowerCase();
  const checks = r.checks
    .filter((c) => !f.check || c.name === f.check)
    .map((c) => ({
      ...c,
      files: c.files
        .filter((file) => !f.file || fileMatches(f.file, file.path))
        .map((file) => ({ ...file, tests: file.tests.filter((t) => (!grep || t.name.toLowerCase().includes(grep)) && (!f.failed || !t.clean)) }))
        .filter((file) => file.tests.length > 0),
    }));
  return {
    ...r,
    checks,
    notRunYet: r.notRunYet.filter((p) => (!f.file || fileMatches(f.file, p)) && !grep && !f.check),
    maps: r.maps.filter((m) => !f.check || m.check === f.check),
  };
}

// ---- printing ----

export interface PrintOptions {
  /** every test by name */
  all: boolean;
  /** --grep given: list matching tests by name */
  named: boolean;
  width: number;
  color: boolean;
}

function painter(on: boolean): Record<"green" | "red" | "yellow" | "dim" | "bold", (s: string) => string> {
  const wrap = (code: string) => (s: string) => (on ? `\x1b[${code}m${s}\x1b[0m` : s);
  return { green: wrap("32"), red: wrap("31"), yellow: wrap("33"), dim: wrap("2"), bold: wrap("1") };
}

export function localTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** A test's own time: `0.21ms`, `81ms`, `1.2s`. */
export function testTime(ms: number | undefined): string {
  if (ms === undefined) return "";
  if (ms < 1) return `${ms.toFixed(2)}ms`;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return fmtMs(ms);
}

function fit(s: string, n: number): string {
  if (n <= 1) return s.slice(0, Math.max(0, n));
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

const WORD: Record<TestStatus, string> = { pass: "pass", fail: "fail", flaky: "flaky", skip: "skipped", todo: "todo", dnr: "did not run" };

export function countsText(c: StatusCounts): string {
  const parts: string[] = [];
  if (c.pass) parts.push(`${c.pass} pass`);
  if (c.fail) parts.push(`${c.fail} fail`);
  if (c.flaky) parts.push(`${c.flaky} flaky`);
  if (c.skip) parts.push(`${c.skip} skipped`);
  if (c.todo) parts.push(`${c.todo} todo`);
  if (c.dnr) parts.push(`${c.dnr} did not run`);
  return parts.join(" · ");
}

function runWord(r: RunRef): string {
  return r.trigger === "probe" ? "probe baseline" : r.dirty ? "--dirty run" : "run";
}

export function printTests(r: TestsReport, o: PrintOptions): void {
  const p = painter(o.color);
  const W = Math.max(60, o.width);
  const out = (s = ""): void => console.log(s);
  const mark = (s: TestStatus): string =>
    s === "pass" ? p.green("✓") : s === "fail" ? p.red("✘") : s === "flaky" ? p.yellow("!") : s === "dnr" ? p.yellow("·") : p.yellow("-");
  const fileMark = (f: FileRow): string =>
    f.tests.some((t) => t.status === "fail") ? p.red("✘") : f.tests.every((t) => t.clean) ? p.green("✓") : p.yellow("!");
  const caughtText = (f: FileRow): string =>
    f.caught === null ? "" : f.caught ? `caught ${f.caught} planted bug${f.caught === 1 ? "" : "s"}` : p.yellow("caught none");

  out(`${p.bold("gate tests")}  ${r.repo}  ${short(r.head)}`);
  if (r.lastRun) {
    const l = r.lastRun;
    const verdict = l.ok ? p.green("pass") : p.red(`FAIL at ${l.failedAt ?? "?"}`);
    const extra = [l.dirty ? "dirty" : null, l.only ? `only ${l.only.join(",")}` : null].filter(Boolean).join(" ");
    out(`last run   ${localTime(l.at)} · ${short(l.sha)} · ${verdict}${extra ? ` (${extra})` : ""} · ${r.receipt ? r.headState : p.yellow(r.headState)}`);
  } else {
    out(`last run   none recorded yet: run ${p.bold("gate")}`);
  }
  if (r.probe) {
    const pr = r.probe;
    out(`probe      ${pr.at.slice(0, 10)} · ${short(pr.sha)} · caught ${pct(pr.rate)} · ${pr.missed ? p.yellow(`${pr.missed} missed`) : "nothing missed"} · newest sampled${p.dim(replaysNote(r.probeReplaysSince))}`);
  } else if (r.probeReplaysSince) {
    out(`probe      no sampled probe yet: gate probe (${r.probeReplaysSince} --from replay${r.probeReplaysSince === 1 ? "" : "s"} stored, not counted)`);
  } else {
    out("probe      none yet: gate probe");
  }
  out();

  const nameW = Math.max(6, ...r.checks.map((c) => c.name.length)) + 2;
  for (const c of r.checks) {
    const total = c.summaryTotal ?? c.tests;
    const what = c.flows
      ? `${c.flows.flows} flows${c.flows.widths.length > 1 ? ` at ${c.flows.widths.length} widths` : ""}`
      : total
        ? `${total} test${total === 1 ? "" : "s"}`
        : c.state === "not-run"
          ? ""
          : "no tests";
    let result: string;
    if (c.state === "not-run") result = p.dim("not run in a kept run");
    else if (c.tests) result = countsText(c.counts);
    else result = c.state === "pass" ? "pass" : "FAIL";
    const tint = c.state === "fail" ? p.red : c.counts.flaky || c.counts.skip || c.counts.todo || c.counts.dnr ? p.yellow : (s: string) => s;
    const time = c.ms === null ? "" : fmtMs(c.ms).padStart(7);
    const left = `${c.name.padEnd(nameW)}${what.padEnd(22)}`;
    const resultW = Math.max(10, Math.min(34, W - left.length - 7));
    out(`${left}${tint(result.padEnd(resultW))}${p.dim(time)}`);
    const notes: string[] = [];
    if (c.from && !c.newest) notes.push(`from the ${runWord(c.from)} of ${localTime(c.from.at)} (${short(c.from.sha)}): the newest run didn't reach it`);
    else if (c.from && c.from.trigger === "probe") notes.push(`from the probe baseline of ${localTime(c.from.at)}`);
    if (c.state === "fail" && c.reason) notes.push(c.reason);
    if (c.state === "fail" && !c.counts.fail && c.log) notes.push(`log ${c.log}`);
    if (c.summaryTotal !== null && c.tests < c.summaryTotal) notes.push(`the log names ${c.tests} of ${c.summaryTotal} tests`);
    for (const n of notes) out(p.dim(`${" ".repeat(nameW)}${fit(n, W - nameW)}`));
  }

  const listTest = (t: TestRow): boolean => o.all || o.named || !t.clean;
  const historyNote = (t: TestRow): string => {
    const bits: string[] = [];
    if (t.history.failed && !(t.status === "fail" && t.history.failed === 1)) bits.push(`failed in ${t.history.failed} of the last ${t.history.runs} runs`);
    if (t.history.flaky && !(t.status === "flaky" && t.history.flaky === 1)) bits.push(`flaky in ${t.history.flaky} of the last ${t.history.runs} runs`);
    return bits.join(" · ");
  };
  const printError = (t: TestRow, indent: number, label?: string): void => {
    if (!t.error?.length) return;
    t.error.forEach((l, i) => out(`${" ".repeat(indent)}${i === 0 && label ? `${label}: ` : ""}${p.red(fit(l, W - indent - (label ? label.length + 2 : 0)))}`));
  };

  let idle = false;
  for (const c of r.checks) {
    if (!c.files.length) continue;
    const pw = !!c.flows;
    out();
    if (!pw) {
      out(p.bold(c.name));
      const pathW = Math.min(Math.max(...c.files.map((f) => f.path.length)), W - 32);
      for (const f of c.files) {
        if (f.caught === 0) idle = true;
        out(`  ${fileMark(f)} ${String(f.tests.length).padStart(3)}  ${fit(f.path, pathW).padEnd(pathW)}  ${caughtText(f)}`.trimEnd());
        let failedHere = false;
        for (const t of f.tests) {
          if (!listTest(t)) continue;
          const word = t.status === "pass" ? "" : ` ${WORD[t.status]}`;
          const tail = [testTime(t.ms), historyNote(t)].filter(Boolean).join(" · ");
          const head = `      ${mark(t.status)}${word ? p.dim(word) : ""} `;
          const room = W - 8 - word.length;
          // A name never gives way to its note: the note wraps to its own line instead.
          if (t.name.length + tail.length + 2 <= room) out(`${head}${t.name}${tail ? `  ${p.dim(tail)}` : ""}`);
          else {
            out(`${head}${fit(t.name, room)}`);
            if (tail) out(p.dim(`${" ".repeat(10)}${fit(tail, W - 10)}`));
          }
          printError(t, 10);
          if (t.status === "fail") failedHere = true;
        }
        if (failedHere && c.log) out(p.dim(`          log ${c.log}`));
      }
      continue;
    }

    // Flows: one row per flow, each width side by side.
    const widths = c.flows?.widths.length ? c.flows.widths : [""];
    const content = Math.max(7, ...widths.map((w) => w.length));
    const cols = widths.length * (content + 2);
    const longest = Math.max(...c.files.flatMap((f) => f.tests.map((t) => t.name.length)));
    const titleW = Math.min(W - 4 - cols, longest + 2);
    out(`${p.bold(c.name)}${" ".repeat(Math.max(1, 4 + titleW - c.name.length))}${widths.map((w) => `  ${w.padStart(content)}`).join("")}`.trimEnd());
    for (const f of c.files) {
      if (f.caught === 0) idle = true;
      const flows = new Map<string, TestRow[]>();
      const line = (t: TestRow): number => Number(t.loc?.split(":")[0] ?? 0);
      for (const t of [...f.tests].sort((a, b) => line(a) - line(b))) flows.set(t.name, [...(flows.get(t.name) ?? []), t]);
      out(`  ${fileMark(f)} ${String(flows.size).padStart(3)}  ${f.path}  ${caughtText(f)}`.trimEnd());
      let failedHere = false;
      for (const [name, runs] of flows) {
        const cells = widths
          .map((w) => {
            const t = runs.find((x) => (x.project ?? "") === w);
            if (!t) return `  ${p.dim("—".padStart(content))}`;
            const text = t.status === "skip" || t.status === "todo" ? t.status : t.status === "dnr" ? "" : t.ms === undefined ? "" : fmtMs(t.ms);
            return `  ${mark(t.status)} ${p.dim(text.padStart(content - 2))}`;
          })
          .join("");
        out(`    ${fit(name, titleW).padEnd(titleW)}${cells}`.trimEnd());
        for (const t of runs) {
          const note = [t.status === "dnr" ? "did not run" : "", historyNote(t)].filter(Boolean).join(" · ");
          if (note) out(p.dim(`      ${t.project ? `${t.project}: ` : ""}${note}`));
          printError(t, 6, t.project);
          if (t.status === "fail") failedHere = true;
        }
      }
      if (failedHere && c.log) out(p.dim(`      log ${c.log}`));
    }
  }

  if (r.notRunYet.length) {
    out();
    out(p.bold("not run yet"));
    for (const f of r.notRunYet) out(`  ${p.yellow("·")}  ${f}`);
  }

  if (r.maps.length) {
    out();
    out(p.bold("coverage maps"));
    const titleW = Math.min(40, Math.max(...r.maps.map((m) => (m.map?.title ?? m.file.split("/").pop() ?? "").length)));
    for (const m of r.maps) {
      if (!m.map) {
        out(`  ${p.red("✘")} ${fit(m.file.split("/").pop() ?? m.file, titleW).padEnd(titleW)}  ${p.red(fit(`not a map: ${m.error ?? "?"}`, W - titleW - 6))}`);
        continue;
      }
      const rows = m.map.rows.length;
      const gaps = m.gaps ?? 0;
      const text = `${rows} row${rows === 1 ? "" : "s"} × ${m.map.columns.length} · ${gaps ? p.yellow(`${gaps} with a gap`) : "no gaps"}`;
      out(`  ${gaps ? p.yellow("!") : p.green("✓")} ${fit(m.map.title, titleW).padEnd(titleW)}  ${text}  ${p.dim(m.check)}`);
    }
  }

  const foot: string[] = [];
  if (idle) foot.push("caught none: a file can be idle because no bug landed near it");
  if (r.runsKept) foot.push(`history over the ${r.runsKept} kept run${r.runsKept === 1 ? "" : "s"} · every test: gate tests --all · the page: --html · agents: --json`);
  if (foot.length) {
    out();
    for (const l of foot) out(p.dim(l));
  }
}
