// `gate run`: lock, clean copy, databases, setup, checks, receipt, history,
// cleanup. Cleanup (drop this run's databases, release the lock) runs on pass,
// fail, a gate error and SIGINT/SIGTERM/SIGHUP. The machinery is session.ts,
// shared with `gate probe`.

import { loadTarget, findRepo, resolveCommit } from "./context.ts";
import { EXIT, GateError, errMsg, usage } from "./errors.ts";
import { uncommitted } from "./git.ts";
import { short, type OutMode } from "./output.ts";
import { appendHistory, writeReceipt, type HistoryLine } from "./receipt.ts";
import { Interrupted, notRun, plural, Session, type CheckResult } from "./session.ts";
import { GATE_VERSION } from "./version.ts";

export type Trigger = "manual" | "push" | "probe";

export interface RunOptions {
  cwd: string;
  sha?: string;
  dirty: boolean;
  only: string[] | null;
  all: boolean;
  out: OutMode;
  verbose: boolean;
  wait: boolean;
  trigger: Trigger;
}

export async function gateRun(o: RunOptions): Promise<number> {
  const repo = findRepo(o.cwd);
  const head = resolveCommit(repo, "HEAD");
  const sha = o.sha ? resolveCommit(repo, o.sha) : head;
  if (o.dirty && sha !== head) throw usage("--dirty checks the working tree on top of HEAD; drop --sha");
  const target = loadTarget(repo, sha, o.dirty);
  const { cfg } = target;
  if (o.only) {
    const known = new Set(cfg.checks.map((c) => c.name));
    const bad = o.only.filter((n) => !known.has(n));
    if (bad.length) throw usage(`--only ${bad.join(",")}: no such check in gate.json (checks: ${[...known].join(", ")})`);
  }

  const s = new Session({ repo, cfg, sha, out: o.out, verbose: o.verbose, wait: o.wait, dirty: o.dirty });
  const { out, scrubber, run } = s;
  await s.open();

  const started = Date.now();
  const at = new Date(started).toISOString();
  const results: CheckResult[] = [];
  let gateError: GateError | null = null;

  try {
    await steps();
  } catch (err) {
    if (err instanceof GateError) gateError = err;
    else if (!(err instanceof Interrupted)) gateError = new GateError(EXIT.broken, `gate crashed: ${errMsg(err)}`);
  }
  await s.close();
  const interrupted = s.interrupted;

  const ms = Date.now() - started;
  const ran = results.filter((r) => r.ran);
  const allRan = cfg.checks.every((c) => ran.some((r) => r.name === c.name));
  const ok = !gateError && !interrupted && ran.length > 0 && ran.every((r) => r.ok);
  const checksForHistory = ran.map((r) => ({ name: r.name, ok: r.ok, ms: r.ms, ...(r.counts ? { counts: r.counts } : {}), ...(r.reason ? { reason: r.reason } : {}) }));
  if (gateError || interrupted) {
    checksForHistory.push({ name: "gate", ok: false, ms: 0, reason: interrupted ? `interrupted by ${interrupted}` : (gateError?.message.split("\n")[0] ?? "") });
  }
  const history: HistoryLine = {
    at,
    run,
    sha,
    tree: target.tree,
    mode: cfg.mode,
    trigger: o.trigger,
    dirty: o.dirty,
    only: o.only,
    ok,
    ms,
    checks: checksForHistory,
  };
  appendHistory(repo.paths.history, history);

  const flaky = results.flatMap((r) => r.flaky.map((n) => `${r.name}: ${n}`));
  let receipt = false;
  if (ok && allRan && !o.dirty && !o.only) {
    writeReceipt(repo.paths.receipts, {
      v: 1,
      tree: target.tree,
      sha,
      ok: true,
      at,
      ms,
      run,
      gate: GATE_VERSION,
      checks: results.map((r) => ({ name: r.name, ok: r.ok, ms: r.ms, exit: r.exit, ...(r.counts ? { counts: r.counts } : {}) })),
      flaky,
    });
    receipt = true;
  }

  const code = gateError ? gateError.code : interrupted ? EXIT.broken : ok ? EXIT.pass : EXIT.red;
  if (o.out === "json") {
    const logs: Record<string, string> = {};
    const failures: Record<string, string[]> = {};
    for (const r of ran) {
      logs[r.name] = r.log;
      if (!r.ok) failures[r.name] = r.failing.length ? r.failing : [r.reason ?? "failed"];
    }
    const extra = gateError ? { exit: code, error: gateError.message } : interrupted ? { exit: code, error: `interrupted by ${interrupted}` } : { exit: code };
    console.log(JSON.stringify({ ...history, receipt, logs, failures, flaky, ...extra }));
    return code;
  }

  if (gateError) {
    out.flush();
    console.error(`gate: ${scrubber.scrub(gateError.message)}`);
    return code;
  }
  if (interrupted) {
    out.line(`interrupted by ${interrupted}. Databases dropped, lock released.`);
    out.flush();
    return code;
  }
  if (flaky.length) out.line(`flaky (passed on retry): ${flaky.join("; ")}`);
  if (!ok) {
    const failed = ran.filter((r) => !r.ok).map((r) => r.name);
    out.line(`FAILED at ${failed.join(", ")}. Fix it, commit, run gate${o.dirty ? " --dirty" : ""} again.`);
    out.flush();
    return code;
  }
  if (receipt) {
    out.line(cfg.mode === "block" ? `receipt ${short(sha)} (tree ${short(target.tree)}) written · git push is allowed` : "receipt written · report mode never blocks a push");
  } else {
    out.line(`passed · no receipt (${o.dirty ? "--dirty run: commit, then run gate" : "--only run: run gate with every check for a receipt"})`);
  }
  return code;

  async function steps(): Promise<void> {
    const pending = o.dirty || sha === head ? uncommitted(repo.top) : null;
    const pendingCount = pending ? pending.present.length + pending.deleted.length : 0;
    s.planDatabases();

    const parts = [o.dirty ? `dirty copy (HEAD + ${plural(pendingCount, "uncommitted file")})` : "clean copy"];
    if (s.plans.length) parts.push(plural(s.plans.length, "database"));
    if (o.only) parts.push(`only ${o.only.join(",")}`);
    out.line(`gate  ${repo.name}  ${short(sha)}  ${cfg.mode}  ${parts.join(" · ")}`);
    if (!o.dirty && pendingCount > 0) out.line(`note: ${plural(pendingCount, "uncommitted file")} ${pendingCount === 1 ? "is" : "are"} not part of this check (gate --dirty checks them)`);

    await s.prepare();
    const setup = await s.setup();
    if (setup) {
      results.push(setup);
      s.report(setup);
    }
    let stopped = setup ? !setup.ok : false;
    for (const c of cfg.checks) {
      if (o.only && !o.only.includes(c.name)) continue;
      if (stopped || s.interrupted) {
        results.push(notRun(c.name));
        s.reportNotRun(c.name);
        continue;
      }
      const r = await s.runCheck(c);
      s.stop();
      results.push(r);
      s.report(r);
      if (!r.ok && !o.all) stopped = true;
    }
  }
}
