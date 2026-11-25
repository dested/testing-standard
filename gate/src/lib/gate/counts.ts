// Read a check's output for the summaries of `bun test` and Playwright's
// list/line reporters. Patterns come from real output captured into
// test/gate/fixtures (bun 1.4.3, @playwright/test 1.65.1); regenerate them with
// scripts/gate-fixtures.sh rather than editing patterns from memory.

export interface Counts {
  passed: number;
  failed: number;
  skipped: number;
  todo: number;
  flaky: number;
  /** Playwright "did not run" + "interrupted" */
  didNotRun: number;
}

export interface FailingTest {
  name: string;
  /** the test file, when the runner's output names it (as the runner printed it, relative to its cwd) */
  file?: string;
}

export interface Parsed {
  /** null when no known runner's summary was in the output */
  counts: Counts | null;
  /** a recognized run reported zero tests */
  zeroTests: boolean;
  failing: string[];
  failingTests: FailingTest[];
  flakyNames: string[];
}

function empty(): Counts {
  return { passed: 0, failed: 0, skipped: 0, todo: 0, flaky: 0, didNotRun: 0 };
}

// bun test: " 3 pass" / " 1 skip" / " 1 todo" / " 0 fail", closed by "Ran 5 tests across 1 file."
export const BUN_COUNT = /^\s*(\d+) (pass|fail|skip|todo)\s*$/;
export const BUN_RAN = /^Ran (\d+) tests? across \d+ files?\b/;
const BUN_FAIL = /^\(fail\) (.+?)(?: \[\d+(?:\.\d+)?m?s\])?\s*$/;
const BUN_NO_FILES = /^error: 0 test files matching/;
// bun prints "path/x.test.ts:" before that file's failures
export const BUN_FILE = /^(\S+\.(?:test|spec)\.[cm]?[jt]sx?):$/;
// Playwright names lead with the file: "tests/x.spec.ts:3:1 › …" (optionally "[project] › ")
const PW_FILE = /^(?:\[[^\]]+\] › )?(\S+?\.[cm]?[jt]sx?):\d+:\d+ ›/;
// Playwright: "  1 failed" / "  3 passed (1.2s)" / "  1 flaky" / "  1 skipped" / "  1 did not run"
export const PW_COUNT = /^ {2}(\d+) (passed|failed|flaky|skipped|did not run|interrupted)(?: \(.+\))?\s*$/;
const PW_NAME = /^ {4}(\S.*?)\s*─*\s*$/;
const PW_NO_TESTS = /^Error: No tests found\.?$/;

export function parseOutput(text: string): Parsed {
  const lines = text.split(/\r?\n/);
  let counts: Counts | null = null;
  let zeroTests = false;
  const failing = new Map<string, FailingTest>();
  const flakyNames = new Set<string>();
  let bunFile: string | undefined;

  let bunBlock = empty();
  let pwList: "failed" | "flaky" | null = null;

  for (const line of lines) {
    const bc = BUN_COUNT.exec(line);
    if (bc) {
      const n = Number(bc[1]);
      const k = bc[2];
      if (k === "pass") bunBlock.passed += n;
      else if (k === "fail") bunBlock.failed += n;
      else if (k === "skip") bunBlock.skipped += n;
      else if (k === "todo") bunBlock.todo += n;
      continue;
    }
    const ran = BUN_RAN.exec(line);
    if (ran) {
      counts ??= empty();
      for (const k of Object.keys(bunBlock) as (keyof Counts)[]) counts[k] += bunBlock[k];
      if (Number(ran[1]) === 0) zeroTests = true;
      bunBlock = empty();
      continue;
    }
    const file = BUN_FILE.exec(line);
    if (file?.[1]) {
      bunFile = file[1];
      continue;
    }
    const bf = BUN_FAIL.exec(line);
    if (bf?.[1]) {
      if (!failing.has(bf[1])) failing.set(bf[1], { name: bf[1], ...(bunFile ? { file: bunFile } : {}) });
      continue;
    }
    if (BUN_NO_FILES.test(line) || PW_NO_TESTS.test(line)) {
      counts ??= empty();
      zeroTests = true;
      continue;
    }

    const pc = PW_COUNT.exec(line);
    if (pc) {
      counts ??= empty();
      const n = Number(pc[1]);
      const k = pc[2];
      pwList = null;
      if (k === "passed") counts.passed += n;
      else if (k === "failed") (counts.failed += n), (pwList = "failed");
      else if (k === "flaky") (counts.flaky += n), (pwList = "flaky");
      else if (k === "skipped") counts.skipped += n;
      else counts.didNotRun += n;
      continue;
    }
    if (pwList) {
      const name = PW_NAME.exec(line);
      if (name?.[1]) {
        if (pwList === "flaky") flakyNames.add(name[1]);
        else if (!failing.has(name[1])) {
          const f = PW_FILE.exec(name[1])?.[1];
          failing.set(name[1], { name: name[1], ...(f ? { file: f } : {}) });
        }
        continue;
      }
      pwList = null;
    }
  }
  return { counts, zeroTests, failing: [...failing.keys()], failingTests: [...failing.values()], flakyNames: [...flakyNames] };
}

/** Why a check that exited 0 still fails under `skips: "fail"`, or null when it passes. */
export function skipReason(p: Parsed): string | null {
  if (p.zeroTests) return "the test run found no tests";
  const c = p.counts;
  if (!c) return null;
  const parts: string[] = [];
  if (c.skipped) parts.push(`${c.skipped} skipped`);
  if (c.todo) parts.push(`${c.todo} todo`);
  if (c.didNotRun) parts.push(`${c.didNotRun} did not run`);
  return parts.length ? `${parts.join(" · ")} (skipped tests fail the check)` : null;
}

/** "211 passed · 1 failed" style summary of a count. */
export function countsLine(c: Counts, ok: boolean): string {
  if (ok && !c.failed && !c.skipped && !c.todo && !c.didNotRun) {
    const total = c.passed;
    return `${total} test${total === 1 ? "" : "s"}${c.flaky ? ` · ${c.flaky} flaky` : ""}`;
  }
  const parts = [`${c.passed} passed`];
  if (c.failed) parts.push(`${c.failed} failed`);
  if (c.flaky) parts.push(`${c.flaky} flaky`);
  return parts.join(" · ");
}
