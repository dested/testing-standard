#!/usr/bin/env bun
// The `gate` bin: run a repo's checks on a clean copy of a commit, with its own
// databases, and write a signed receipt; agent-guard asks `gate guard push`
// before it lets an agent's git push through. gate never touches git config or hooks.
// Contract: features/gate.md (from the lead's gate-contract.md).

import { readFileSync } from "node:fs";
import { EXIT, GateError, errMsg, usage } from "./lib/gate/errors.ts";
import { findRepo, loadTarget, resolveCommit } from "./lib/gate/context.ts";
import { DEFAULT_MAX, gateProbe } from "./lib/gate/probe/run.ts";
import { printProbeReport, probeReport } from "./lib/gate/probe/store.ts";
import { allowWeaken, guardPush, GUARD_EXIT } from "./lib/gate/guard.ts";
import { doctor, printStatus, status, where } from "./lib/gate/info.ts";
import { initConfig } from "./lib/gate/init.ts";
import { narrow, printTests, testsReport } from "./lib/gate/tests.ts";
import { writeTestsPage } from "./lib/gate/page.ts";
import { gateRun, type Trigger } from "./lib/gate/run.ts";
import { GATE_VERSION } from "./lib/gate/version.ts";

const HELP = `gate — run a repo's checks on a clean copy of a commit, and write a receipt

usage:
  gate [run] [--sha <rev>] [--dirty] [--only a,b] [--all] [--json] [--verbose] [--no-wait]
             [--trigger manual|push|probe] [--quiet]
  gate status [--json]        mode, HEAD, receipt (pass / failed at <check> / none), last 10 runs
  gate init [--mode report|block] [--force]   write gate.json from package.json scripts (default report)
  gate guard push --cwd <dir> [--json] -- <git push args>
                              may this agent push? 0 allow · 1 deny (reason + next command) · 2 couldn't parse
  gate allow-weaken --sha <rev> --why "<Sal's words>"   only when Sal said so in the conversation
  gate probe [--sha <rev>] [--from <file.jsonl>] [--since <rev>] [--max <n>] [--seed <n>]
             [--only-files <glob>] [--json] [--verbose]
                              plant one bug at a time in a clean copy: which check catches it?
                              exit 0 at/above probe.minRate with no missed critical bug, else 1
  gate probe report [--json]  catch rate over time, checks and test files that never caught a bug
  gate tests [--all | --failed] [--check <name>] [--file <glob>] [--grep <text>] [--json]
             [--html [--no-open]]
                              every test and its last result, from the runs gate kept
  gate where                  the work root, tree, receipts and history paths
  gate doctor                 git, bun, databases, work root, agent guard: each problem with its fix
  gate --help | --version

run:
  --sha <rev>     check that commit instead of HEAD
  --dirty         HEAD plus the working tree's uncommitted files; never writes a receipt
  --only a,b      just those checks; never writes a receipt
  --all           keep going after a failed check
  --json          one JSON object on stdout, nothing else
  --verbose       stream each check's output as it runs
  --quiet         print nothing on a pass
  --no-wait       exit 3 instead of waiting when another gate run holds the repo

Checks run on \`git archive <commit>\`, never the working tree, with an allowlisted
environment and a fresh gate_* database per databases[] entry. Skipped, todo or
zero-test runs fail the check. A pass writes <git dir>/gate/receipts/<tree>.json;
gate informs; it doesn't gate. Every repo is report mode (Sal's standing decision,
2026-11-20): pushes always go through, with what gate knows. gate never installs a
git hook or writes git config.

tests:
  A report: it runs nothing and changes nothing. Per check: its last run, counts and
  time; per test file: its tests and the planted bugs it caught; per flow: each width
  side by side. Anything that isn't a clean pass (failed, skipped, flaky, failed in an
  earlier kept run) is listed by name with its error's first lines and the log.
  --all           every test by name
  --failed        only what isn't a clean pass
  --check <name>  one check · --file <glob or text> · --grep <text in a test's name>
  --json          one object with every test, never truncated (for agents)
  --html          one self-contained page, <work root>/tests.html, opened in the Windows
                  browser (--no-open: just write it; prints its Windows path either way):
                  green or red on which commit, problems, flows by area (each width side
                  by side), every test in a drawer (history per width, error, code at the
                  run's commit; Playwright: steps and screenshots), planted bugs per
                  source file, files no probe touched, catch rate per probe, coverage maps
  Exit 0 when it printed, even if the last run was red: gate judges, gate tests reports.
  2 no gate.json or a bad flag · 3 gate couldn't read its own files.

coverage maps (any check, any repo):
  While a check runs under gate (a run, a probe's baseline), $GATE_COVERAGE is an
  empty folder kept with that run. Write one <name>.json per map there:
    { "title": "Screens × widths", "columns": ["desktop", "phone"],
      "rows": [ { "item": "/settings", "group": "studio",
                  "cells": { "desktop": true, "phone": false },
                  "coveredBy": ["settings/senders · a sender shows as unverified"] } ] }
  A cell is true (covered), false (a gap), null (doesn't apply), a short text, or
  { "ok": bool, "text"?: str, "by"?: [test titles] }. group and coveredBy are optional.
  gate tests lists them (rows, gaps), --json carries them, --html draws each as a grid.
  Unset outside gate: write nothing then. Spec: features/gate.md § Coverage maps.

test detail (Playwright, any repo):
  Every check under gate gets $GATE_ARTIFACTS and PW_TEST_REPORTER (gate's own
  reporter, appended to the repo's): steps, full errors, screenshots, a trace on
  failure, for --html. End-state screenshots of passing tests need the repo's
  config: screenshot: process.env.GATE === '1' ? 'on' : 'only-on-failure'.
  Files kept on the newest 3 runs. Spec: features/gate.md § Test detail.

exit codes: 0 every check passed · 1 a check failed (your code is red)
            2 usage or gate.json error · 3 gate itself couldn't run`;

/** Printed by `gate init --mode block`, which still does what it's asked. */
export const BLOCK_NOTE = "Sal's standing decision is report mode everywhere (2026-11-20); only use block if he asked in this conversation";

const TRIGGERS = new Set<Trigger>(["manual", "push", "probe"]);

function isTrigger(v: string): v is Trigger {
  return (TRIGGERS as Set<string>).has(v);
}

interface Flags {
  positional: string[];
  sha?: string;
  only: string[] | null;
  mode?: string;
  cwd?: string;
  why?: string;
  from?: string;
  since?: string;
  max?: number;
  seed?: number;
  onlyFiles?: string;
  check?: string;
  file?: string;
  grep?: string;
  /** everything after the first `--` (guard push: the git push arguments) */
  rest: string[];
  trigger: Trigger;
  bool: Set<string>;
}

const BOOL = new Set(["--dirty", "--all", "--json", "--verbose", "--no-wait", "--quiet", "--force", "--failed", "--html", "--no-open", "--help", "-h", "--version", "-v"]);

function parseArgs(argv: string[]): Flags {
  const f: Flags = { positional: [], only: null, trigger: "manual", bool: new Set(), rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw usage(`${a} needs a value`);
      return v;
    };
    if (a === "--") {
      f.rest = argv.slice(i + 1);
      break;
    }
    if (BOOL.has(a)) f.bool.add(a);
    else if (a === "--sha") f.sha = value();
    else if (a === "--only") f.only = value().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--mode") f.mode = value();
    else if (a === "--cwd") f.cwd = value();
    else if (a === "--why") f.why = value();
    else if (a === "--from") f.from = value();
    else if (a === "--since") f.since = value();
    else if (a === "--only-files") f.onlyFiles = value();
    else if (a === "--check") f.check = value();
    else if (a === "--file") f.file = value();
    else if (a === "--grep") f.grep = value();
    else if (a === "--max" || a === "--seed") {
      const raw = value();
      const n = Number(raw);
      if (!Number.isInteger(n) || n < (a === "--max" ? 1 : 0)) throw usage(`${a} needs a whole number (got ${raw})`);
      if (a === "--max") f.max = n;
      else f.seed = n;
    }
    else if (a === "--trigger") {
      const t = value();
      if (!isTrigger(t)) throw usage(`--trigger must be manual, push or probe (got ${t})`);
      f.trigger = t;
    } else if (a.startsWith("-")) throw usage(`unknown flag ${a}. gate --help lists them`);
    else f.positional.push(a);
  }
  return f;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  return await Bun.stdin.text();
}

async function main(argv: string[]): Promise<number> {
  const f = parseArgs(argv);
  if (f.bool.has("--version") || f.bool.has("-v")) {
    console.log(`gate ${GATE_VERSION}`);
    return EXIT.pass;
  }
  if (f.bool.has("--help") || f.bool.has("-h") || f.positional[0] === "help") {
    console.log(HELP);
    return EXIT.pass;
  }
  if (process.platform === "win32") {
    console.error("gate runs in WSL for now: open a WSL shell in the repo and run gate there");
    return EXIT.usage;
  }
  const cwd = process.cwd();
  const [cmd = "run", sub] = f.positional;
  const json = f.bool.has("--json");

  switch (cmd) {
    case "run": {
      if (f.only && !f.only.length) throw usage("--only needs at least one check name");
      return gateRun({
        cwd,
        sha: f.sha,
        dirty: f.bool.has("--dirty"),
        only: f.only,
        all: f.bool.has("--all"),
        out: json ? "json" : f.bool.has("--quiet") ? "quiet" : "human",
        verbose: f.bool.has("--verbose"),
        wait: !f.bool.has("--no-wait"),
        trigger: f.trigger,
      });
    }
    case "status": {
      const s = status(cwd);
      if (json) console.log(JSON.stringify(s));
      else printStatus(s);
      return EXIT.pass;
    }
    case "init": {
      const mode = f.mode ?? "report";
      if (mode !== "report" && mode !== "block") throw usage(`--mode must be report or block (got ${mode})`);
      const repo = findRepo(cwd);
      if (mode === "block") console.log(BLOCK_NOTE);
      const r = initConfig(repo.top, mode, f.bool.has("--force"));
      console.log(`wrote ${r.path} (${mode} mode)`);
      for (const w of r.wrote) console.log(`  ${w}`);
      if (r.missing.length) {
        console.log("not detected:");
        for (const m of r.missing) console.log(`  ${m}`);
      }
      console.log(`next: review it, commit it, then run gate${mode === "report" ? ". Report mode never blocks a push" : ""}`);
      return EXIT.pass;
    }
    case "guard": {
      if (sub !== "push") throw usage(`gate guard ${sub ?? ""}: the only guard is "gate guard push --cwd <dir> -- <git push args>"`);
      try {
        const r = guardPush(f.cwd ?? cwd, f.rest);
        if (json) console.log(JSON.stringify({ decision: r.allow ? "allow" : "deny", ...r }));
        else for (const l of r.lines) console.log(l);
        return r.allow ? GUARD_EXIT.allow : GUARD_EXIT.deny;
      } catch (err) {
        // Never a deny: the guard allows on 2 and shows the note.
        const message = `gate guard couldn't read this push: ${errMsg(err)}`;
        if (json) console.log(JSON.stringify({ decision: "error", error: message }));
        else console.log(message);
        return GUARD_EXIT.unparsed;
      }
    }
    case "allow-weaken": {
      if (!f.sha) throw usage(`gate allow-weaken --sha <rev> --why "<Sal's words>"`);
      const r = allowWeaken(cwd, f.sha, f.why ?? "");
      console.log(`allowed ${r.sha.slice(0, 7)} to weaken the gate (recorded in ${r.path}). Push it now; the allowance is for that commit only`);
      return EXIT.pass;
    }
    case "tests": {
      if (sub !== undefined) throw usage(`gate tests takes no subcommand (got ${sub}). gate --help lists its flags`);
      if (f.bool.has("--all") && f.bool.has("--failed")) throw usage("--all and --failed don't go together: pick one");
      const html = f.bool.has("--html");
      const r = narrow(testsReport(cwd, { recent: html }), { check: f.check, file: f.file, grep: f.grep, failed: f.bool.has("--failed") });
      if (html) {
        const page = writeTestsPage(cwd, r, { open: !f.bool.has("--no-open") });
        if (json) console.log(JSON.stringify(page));
        else {
          console.log(page.win);
          if (page.openError) console.error(`couldn't open it: ${page.openError}`);
        }
        return EXIT.pass;
      }
      if (json) console.log(JSON.stringify(r));
      else {
        const tty = process.stdout.isTTY === true;
        printTests(r, {
          all: f.bool.has("--all"),
          named: f.grep !== undefined,
          width: (tty ? process.stdout.columns : undefined) ?? (Number(process.env.COLUMNS) || 100),
          color: tty && !process.env.NO_COLOR,
        });
      }
      return EXIT.pass;
    }
    case "where": {
      const w = where(cwd);
      if (json) console.log(JSON.stringify(w));
      else for (const [k, v] of Object.entries(w)) console.log(`${k.padEnd(9)} ${v}`);
      return EXIT.pass;
    }
    case "doctor": {
      const items = await doctor(cwd);
      if (json) console.log(JSON.stringify(items));
      else
        for (const i of items) {
          console.log(`${i.ok ? "ok  " : "FAIL"}  ${i.what}`);
          if (i.fix) console.log(`      fix: ${i.fix}`);
        }
      return items.every((i) => i.ok) ? EXIT.pass : EXIT.broken;
    }
    case "probe": {
      if (sub === "report") {
        const repo = findRepo(cwd);
        const head = resolveCommit(repo, "HEAD");
        let checks: string[] = [];
        try {
          checks = loadTarget(repo, head).cfg.checks.map((c) => c.name);
        } catch {
          // no gate.json at HEAD: report what's stored
        }
        const r = probeReport(repo, checks);
        if (json) console.log(JSON.stringify(r));
        else printProbeReport(r);
        return EXIT.pass;
      }
      if (sub !== undefined) throw usage(`gate probe ${sub}: use gate probe [flags] or gate probe report`);
      return gateProbe({
        cwd,
        sha: f.sha,
        from: f.from,
        since: f.since,
        max: f.max ?? DEFAULT_MAX,
        seed: f.seed,
        onlyFiles: f.onlyFiles,
        json,
        verbose: f.bool.has("--verbose"),
      });
    }
    case "live":
      throw usage(`gate ${cmd} isn't built yet`);
    default:
      throw usage(`unknown command ${cmd}. gate --help lists them`);
  }
}

const argv = process.argv.slice(2);
try {
  process.exitCode = await main(argv);
} catch (err) {
  const code = err instanceof GateError ? err.code : EXIT.broken;
  const message = err instanceof GateError ? err.message : `gate crashed: ${errMsg(err)}`;
  if (argv.includes("--json")) console.log(JSON.stringify({ ok: false, exit: code, error: message }));
  else console.error(`gate: ${message}`);
  process.exitCode = code;
}
