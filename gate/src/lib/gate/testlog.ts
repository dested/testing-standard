// Every test in a check's log, one result each: `bun test` prints a file header
// then `(pass) describe > name [1.2ms]`; Playwright's list reporter prints
// `  ✓  19 [phone] › e2e/auth.flow.spec.ts:21:1 › title (835ms)`, one line per
// attempt, and a numbered block per failure. The summary patterns are shared
// with counts.ts; fixtures in test/gate/fixtures are real output (see
// scripts/gate-fixtures.sh), so change a pattern only against a captured log.

import { BUN_COUNT, BUN_FILE, BUN_RAN, PW_COUNT } from "./counts.ts";

export type TestStatus = "pass" | "fail" | "flaky" | "skip" | "todo" | "dnr";

export interface LoggedTest {
  runner: "bun" | "playwright";
  /** the test file as the runner printed it, relative to the runner's cwd */
  file: string;
  /** the monorepo workspace a `› <workspace> <script>` line named, when there was one */
  workspace?: string;
  /** bun: `describe > test`; Playwright: the title chain joined by ` › ` */
  name: string;
  /** Playwright project (a width, in the standard) */
  project?: string;
  /** Playwright `line:col` */
  loc?: string;
  status: TestStatus;
  ms?: number;
  /** a failure's first lines */
  error?: string[];
}

const BUN_START = /^bun test v\d/;
const BUN_RESULT = /^\((pass|fail|skip|todo)\) (.+?)(?: \[(\d+(?:\.\d+)?)(ms|s)\])?\s*$/;
/** bun repeats every failure under `3 tests failed:` at the end of a run, without its file */
const BUN_FAILED_RECAP = /^\d+ tests? failed:$/;
/** a monorepo test script's `› @app/web test:rules` line before each workspace's run */
const WORKSPACE = /^› (\S+) \S+\s*$/;

const PW_RESULT = /^ {2}(✓|✘|-)\s+\d+ (.+?)\s*$/;
const PW_DURATION = / \((\d+(?:\.\d+)?)(ms|s|m)\)$/;
const PW_RETRY = / \(retry #\d+\)$/;
const PW_NAME = /^(?:\[([^\]]+)\] › )?(\S+?\.[cm]?[jt]sx?):(\d+:\d+) › (.+)$/;
const PW_FAILURE = /^ {2}\d+\) (.+?)\s*─*\s*$/;
const PW_RETRY_HEAD = /^ {4}Retry #\d+ ─/;

/** Source context, stack and attachment lines: not the error itself. */
const NOISE = /^(>?\s*\d+ \||\|\s|at |Call log:|attachment #|Error Context:|─)/;
const MAX_ERROR_LINES = 4;

function toMs(n: string, unit: string): number {
  const v = Number(n);
  return unit === "m" ? v * 60_000 : unit === "s" ? v * 1000 : v;
}

/** `[phone] › e2e/x.flow.spec.ts:21:1 › describe › title` → its parts, or null. */
export function splitPwName(s: string): { project?: string; file: string; loc: string; title: string } | null {
  const m = PW_NAME.exec(s);
  if (!m?.[2] || !m[3] || !m[4]) return null;
  return { ...(m[1] ? { project: m[1] } : {}), file: m[2], loc: m[3], title: m[4] };
}

/** The error's first lines: from the first `error:`/`Error:` line, skipping source context and stack. */
export function errorLines(block: string[]): string[] {
  const lines = block.map((l) => l.trim()).filter(Boolean);
  const start = lines.findIndex((l) => /^(error:|\w*Error:)/.test(l));
  const out: string[] = [];
  for (const l of start >= 0 ? lines.slice(start) : lines) {
    if (/^Call log:/.test(l) || /^attachment #/.test(l)) break;
    if (NOISE.test(l)) continue;
    out.push(l);
    if (out.length >= MAX_ERROR_LINES) break;
  }
  return out;
}

interface Attempt {
  mark: "✓" | "✘" | "-";
  ms?: number;
}

export function parseTests(text: string): LoggedTest[] {
  const lines = text.split(/\r?\n/);
  const out: LoggedTest[] = [];

  // bun
  let workspace: string | undefined;
  let bunFile: string | undefined;
  let recap = false;
  let since: string[] = [];

  // Playwright: attempts per test, then failure blocks by name
  const attempts = new Map<string, { parts: NonNullable<ReturnType<typeof splitPwName>>; tries: Attempt[] }>();
  const pwErrors = new Map<string, string[]>();
  let pwBlock: { key: string; lines: string[] } | null = null;
  let pwDidNotRun = 0;
  let pwSkipped = 0;

  const closeBlock = (): void => {
    if (pwBlock && !pwErrors.has(pwBlock.key)) pwErrors.set(pwBlock.key, errorLines(pwBlock.lines));
    pwBlock = null;
  };

  for (const line of lines) {
    // ---- bun ----
    const ws = WORKSPACE.exec(line);
    if (ws?.[1]) {
      workspace = ws[1];
      bunFile = undefined;
      continue;
    }
    if (BUN_START.test(line)) {
      bunFile = undefined;
      recap = false;
      since = [];
      continue;
    }
    if (BUN_FAILED_RECAP.test(line)) {
      recap = true;
      continue;
    }
    if (BUN_COUNT.test(line) || BUN_RAN.test(line)) {
      recap = false;
      continue;
    }
    const file = BUN_FILE.exec(line);
    if (file?.[1]) {
      bunFile = file[1];
      recap = false;
      since = [];
      continue;
    }
    const br = BUN_RESULT.exec(line);
    if (br?.[1] && br[2]) {
      if (!recap && bunFile) {
        const status = br[1] === "pass" || br[1] === "fail" || br[1] === "skip" || br[1] === "todo" ? br[1] : "fail";
        out.push({
          runner: "bun",
          file: bunFile,
          ...(workspace ? { workspace } : {}),
          name: br[2],
          status,
          ...(br[3] && br[4] ? { ms: toMs(br[3], br[4]) } : {}),
          ...(status === "fail" ? { error: errorLines(since) } : {}),
        });
      }
      since = [];
      continue;
    }

    // ---- Playwright ----
    const pc = PW_COUNT.exec(line);
    if (pc) {
      closeBlock();
      if (pc[2] === "did not run") pwDidNotRun += Number(pc[1]);
      if (pc[2] === "skipped") pwSkipped += Number(pc[1]);
      continue;
    }
    const pr = PW_RESULT.exec(line);
    if (pr?.[1] && pr[2]) {
      let rest = pr[2];
      let ms: number | undefined;
      const d = PW_DURATION.exec(rest);
      if (d?.[1] && d[2]) {
        ms = toMs(d[1], d[2]);
        rest = rest.slice(0, d.index);
      }
      rest = rest.replace(PW_RETRY, "");
      const parts = splitPwName(rest);
      if (parts) {
        const key = `${parts.project ?? ""}\0${parts.file}\0${parts.title}`;
        const entry = attempts.get(key) ?? { parts, tries: [] };
        const mark = pr[1] === "✓" ? "✓" : pr[1] === "✘" ? "✘" : "-";
        entry.tries.push({ mark, ...(ms !== undefined ? { ms } : {}) });
        attempts.set(key, entry);
        continue;
      }
    }
    const pf = PW_FAILURE.exec(line);
    if (pf?.[1]) {
      const parts = splitPwName(pf[1]);
      if (parts) {
        closeBlock();
        pwBlock = { key: `${parts.project ?? ""}\0${parts.file}\0${parts.title}`, lines: [] };
        continue;
      }
    }
    if (pwBlock) {
      if (PW_RETRY_HEAD.test(line)) closeBlock();
      else pwBlock.lines.push(line);
      continue;
    }
    since.push(line);
  }
  closeBlock();

  // A `-` after a failure in serial mode is "did not run"; Playwright prints both with `-`.
  const dashIs: TestStatus = pwDidNotRun > 0 && pwSkipped === 0 ? "dnr" : "skip";
  for (const [key, { parts, tries }] of attempts) {
    const last = tries.at(-1);
    if (!last) continue;
    const failedOnce = tries.some((t) => t.mark === "✘");
    const status: TestStatus = last.mark === "✓" ? (failedOnce ? "flaky" : "pass") : last.mark === "✘" ? "fail" : dashIs;
    const err = pwErrors.get(key);
    out.push({
      runner: "playwright",
      file: parts.file,
      ...(workspace ? { workspace } : {}),
      name: parts.title,
      ...(parts.project ? { project: parts.project } : {}),
      loc: parts.loc,
      status,
      ...(last.ms !== undefined ? { ms: last.ms } : {}),
      ...((status === "fail" || status === "flaky") && err ? { error: err } : {}),
    });
  }
  return out;
}
