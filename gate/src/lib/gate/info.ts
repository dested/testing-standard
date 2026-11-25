// `gate status`, `gate where`, `gate doctor`.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GateConfig } from "./config.ts";
import { findRepo, loadTarget, resolveCommit } from "./context.ts";
import { createGateDatabase, dropGateDatabase, maskUrl, planDatabases } from "./db.ts";
import { errMsg, GateError } from "./errors.ts";
import { git, treeSha } from "./git.ts";
import { fmtMs, short } from "./output.ts";
import { keyPath } from "./paths.ts";
import { failedAt, lastFullRun, readHistory, readReceipt, type HistoryLine } from "./receipt.ts";
import { newRunId } from "./runid.ts";
import { headline, isReplay, pct, probeStatusLine, readiness, readProbes, type ProbeStatus } from "./probe/store.ts";

export interface StatusJson {
  repo: string;
  top: string;
  mode: "report" | "block" | null;
  config: "ok" | "missing" | "invalid";
  configError?: string;
  head: string;
  tree: string;
  receipt: { state: "pass"; run: string; at: string } | { state: "failed"; check: string; run: string; at: string } | { state: "none" };
  runs: HistoryLine[];
  /** the newest sampled probe (never a --from replay: those go to 100% on a fixed list and say little) */
  probe: ProbeStatus | null;
  /** --from replays stored after it (all of them when there's no sampled probe) */
  probeReplaysSince: number;
  /** run ids (in `runs`) that were --from replays */
  replayRuns: string[];
  /** report mode: is everything in order (passing receipt for HEAD, a recent passing probe)? `why` lists what's open */
  ready?: { ready: boolean; why: string[] };
}

export function status(cwd: string): StatusJson {
  const repo = findRepo(cwd);
  const head = resolveCommit(repo, "HEAD");
  const tree = treeSha(repo.top, head);
  let cfg: GateConfig | null = null;
  let config: StatusJson["config"] = "ok";
  let configError: string | undefined;
  try {
    cfg = loadTarget(repo, head).cfg;
  } catch (err) {
    config = err instanceof GateError && err.message.startsWith("no gate.json") ? "missing" : "invalid";
    if (config === "invalid") configError = errMsg(err);
  }
  const history = readHistory(repo.paths.history);
  const probes = readProbes(repo);
  const ph = headline(probes);
  const r = readReceipt(repo.paths.receipts, tree);
  const last = lastFullRun(history, tree);
  const receipt: StatusJson["receipt"] = r
    ? { state: "pass", run: r.run, at: r.at }
    : last && !last.ok
      ? { state: "failed", check: failedAt(last) ?? "?", run: last.run, at: last.at }
      : { state: "none" };
  return {
    repo: repo.name,
    top: repo.top,
    mode: cfg?.mode ?? null,
    config,
    ...(configError ? { configError } : {}),
    head,
    tree,
    receipt,
    runs: history.slice(-10).reverse(),
    probe: ph.probe,
    probeReplaysSince: ph.replaysSince,
    replayRuns: probes.filter(isReplay).map((p) => p.run),
    ...(cfg?.mode === "report" ? { ready: readiness(repo, receipt.state === "pass") } : {}),
  };
}

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function localTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The facts, plainly: `probe 100% · nothing missed · every check passing`, or `open: <why; why>`. */
export function readyLine(r: { ready: boolean; why: string[] }, p: ProbeStatus | null): string {
  if (!r.ready || !p) return `open: ${r.why.join("; ")}`;
  return `sampled probe ${pct(p.rate)} · ${p.missed ? `${p.missed} missed` : "nothing missed"} · every check passing`;
}

export function printStatus(s: StatusJson): void {
  const mode = s.mode ?? (s.config === "missing" ? "no gate.json (gate init)" : "gate.json invalid");
  console.log(`gate  ${s.repo}  ${mode}`);
  if (s.configError) console.log(s.configError.replace(/^/gm, "      "));
  console.log(`HEAD     ${short(s.head)}  tree ${short(s.tree)}`);
  const r = s.receipt;
  console.log(
    `receipt  ${r.state === "pass" ? `pass (run ${r.run}, ${ago(r.at)})` : r.state === "failed" ? `failed at ${r.check} (run ${r.run}, ${ago(r.at)})` : "none: run gate"}`,
  );
  console.log(`probe    ${probeStatusLine({ probe: s.probe, replaysSince: s.probeReplaysSince })}`);
  if (s.ready) console.log(readyLine(s.ready, s.probe));
  if (!s.runs.length) {
    console.log("runs     none yet");
    return;
  }
  console.log("runs");
  for (const h of s.runs) {
    const what = h.ok ? "pass" : h.trigger === "probe" && h.checks.every((c) => c.ok) ? "FAIL (bugs missed)" : `FAIL at ${failedAt(h)}`;
    const replay = h.trigger === "probe" && s.replayRuns.includes(h.run);
    const flags = [replay ? "replay" : h.trigger, h.dirty ? "dirty" : null, h.only ? `only ${h.only.join(",")}` : null].filter(Boolean).join(" ");
    console.log(`  ${localTime(h.at)}  ${short(h.sha)}  ${h.run}  ${flags.padEnd(7)}  ${what}  ${fmtMs(h.ms)}`);
  }
}

export function where(cwd: string): Record<string, string> {
  const repo = findRepo(cwd);
  return {
    work: repo.paths.work,
    tree: repo.paths.tree,
    runs: repo.paths.runs,
    lock: repo.paths.lock,
    receipts: repo.paths.receipts,
    history: repo.paths.history,
    key: keyPath(),
  };
}

export interface DoctorItem {
  ok: boolean;
  what: string;
  fix?: string;
}

function which(cmd: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" }).status === 0;
}

export async function doctor(cwd: string): Promise<DoctorItem[]> {
  const items: DoctorItem[] = [];
  const add = (ok: boolean, what: string, fix?: string): void => void items.push({ ok, what, ...(ok || !fix ? {} : { fix }) });

  const gv = spawnSync("git", ["--version"], { encoding: "utf8" });
  const m = /(\d+)\.(\d+)/.exec(gv.stdout ?? "");
  const gitOk = gv.status === 0 && !!m && (Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 31));
  add(gitOk, `git ${m ? m[0] : "missing"}`, "install git 2.31 or newer");
  add(which("bun"), "bun on PATH", "install bun (curl -fsSL https://bun.sh/install | bash)");
  add(which("tar"), "tar on PATH", "install tar");

  const kp = keyPath();
  if (existsSync(kp)) {
    const st = statSync(kp);
    add(st.size === 32 && (st.mode & 0o077) === 0, `key ${kp}`, `the key must be 32 bytes, mode 0600: chmod 600 ${kp}, or delete it (every receipt becomes invalid)`);
  } else {
    add(true, `key ${kp} (made on the first pass)`);
  }

  const inRepo = git(cwd, ["rev-parse", "--is-inside-work-tree"]).code === 0;
  const guard = join(homedir(), ".claude", "sal", "hooks", "agent-guard.ts");
  let wired = false;
  try {
    wired = readFileSync(guard, "utf8").includes("gate guard");
  } catch {
    // no agent-guard on this machine
  }
  add(true, wired ? `agent guard: wired (${guard} calls gate guard)` : "agent guard: not wired yet");

  if (!inRepo) {
    add(true, "not in a git repo: repo checks skipped");
    return items;
  }
  const repo = findRepo(cwd);
  try {
    mkdirSync(repo.paths.work, { recursive: true });
    const probe = join(repo.paths.work, `.doctor-${process.pid}`);
    writeFileSync(probe, "ok");
    readFileSync(probe);
    rmSync(probe);
    add(true, `work root ${repo.paths.work} writable`);
  } catch (err) {
    add(false, `work root ${repo.paths.work}`, `${errMsg(err)}: make it writable, or set GATE_WORK`);
  }

  let cfg: GateConfig | null = null;
  try {
    const head = resolveCommit(repo, "HEAD");
    cfg = loadTarget(repo, head).cfg;
    add(true, `gate.json at ${short(head)} (${cfg.mode})`);
  } catch (err) {
    const missing = err instanceof GateError && err.message.startsWith("no gate.json");
    add(missing, missing ? "no gate.json at HEAD (gate init writes one)" : "gate.json", errMsg(err));
  }
  if (!cfg) return items;

  const run = newRunId();
  let plans;
  try {
    plans = planDatabases(cfg.databases, process.env, repo.top, cfg.copy.env, repo.slug, run);
  } catch (err) {
    add(false, "databases", errMsg(err));
    return items;
  }
  for (const p of plans) {
    const name = `${p.name}_doctor`;
    try {
      await createGateDatabase(p.server, name);
      await dropGateDatabase(p.server, name);
      add(true, `${p.env}: ${maskUrl(p.server.url)} reachable, can CREATE DATABASE`);
    } catch (err) {
      add(false, `${p.env}: ${maskUrl(p.server.url)}`, `${errMsg(err)}. Start Postgres, or give the user CREATEDB (ALTER USER … CREATEDB)`);
    }
  }
  return items;
}

