// Skipped counts as failed: real `bun test` and Playwright output (fixtures
// captured from bun 1.4.3 and @playwright/test 1.65.1, see scripts/gate-fixtures.sh).

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseOutput, skipReason } from "../../src/lib/gate/counts.ts";
import { FIXTURES, gate, makeRepo, must, sandbox } from "./helpers.ts";

setDefaultTimeout(60_000);

const sb = sandbox();
afterAll(() => sb.cleanup());

const fx = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");
const cat = (name: string): string => `cat ${join(FIXTURES, name)}`;

describe("parser on real output", () => {
  test("bun test summaries", () => {
    expect(parseOutput(fx("bun-pass.txt")).counts).toMatchObject({ passed: 2, failed: 0, skipped: 0, todo: 0 });
    expect(parseOutput(fx("bun-skip.txt")).counts).toMatchObject({ passed: 1, skipped: 1 });
    expect(parseOutput(fx("bun-todo.txt")).counts).toMatchObject({ passed: 1, todo: 1 });
    expect(parseOutput(fx("bun-zero.txt")).zeroTests).toBe(true);
    expect(parseOutput(fx("bun-nofiles.txt")).zeroTests).toBe(true);
    const fail = parseOutput(fx("bun-fail.txt"));
    expect(fail.counts).toMatchObject({ passed: 1, failed: 1 });
    expect(fail.failing).toEqual(["posts.create > rejects a signed-out caller"]);
    expect(skipReason(parseOutput(fx("bun-pass.txt")))).toBeNull();
  });

  test("Playwright list and line reporters", () => {
    for (const rep of ["list", "line"]) {
      expect(parseOutput(fx(`pw-skip-${rep}.txt`)).counts).toMatchObject({ passed: 1, skipped: 1 });
      const flaky = parseOutput(fx(`pw-flaky-${rep}.txt`));
      expect(flaky.counts).toMatchObject({ passed: 1, flaky: 1, failed: 0 });
      expect(flaky.flakyNames).toEqual(["tests/flaky.spec.ts:3:1 › sometimes fails"]);
      expect(skipReason(flaky)).toBeNull();
      const fail = parseOutput(fx(`pw-fail-${rep}.txt`));
      expect(fail.counts).toMatchObject({ passed: 1, failed: 1 });
      expect(fail.failing).toEqual(["tests/fail.spec.ts:3:3 › checkout › rejects an empty cart"]);
      expect(parseOutput(fx(`pw-dnr-${rep}.txt`)).counts).toMatchObject({ failed: 1, didNotRun: 1 });
    }
    expect(parseOutput(fx("pw-skiponly-list.txt")).counts).toMatchObject({ passed: 0, skipped: 1 });
    expect(parseOutput(fx("pw-zero-list.txt")).zeroTests).toBe(true);
  });
});

describe("8. skipped counts as failed", () => {
  test("skip, todo and zero-test runs fail on exit 0; flaky passes and is listed", () => {
    const dir = makeRepo(sb, "skips-repo", {}, {
      version: 1,
      mode: "block",
      checks: [
        { name: "bun-skip", run: cat("bun-skip.txt") },
        { name: "bun-todo", run: cat("bun-todo.txt") },
        { name: "bun-zero", run: cat("bun-zero.txt") },
        { name: "pw-skip", run: cat("pw-skip-list.txt") },
        { name: "pw-flaky", run: cat("pw-flaky-list.txt") },
        { name: "bun-pass", run: cat("bun-pass.txt") },
      ],
    });
    const r = gate(sb, dir, ["--all"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/FAIL {2}bun-skip .*1 skipped \(skipped tests fail the check\)/);
    expect(r.stdout).toMatch(/FAIL {2}bun-todo .*1 todo/);
    expect(r.stdout).toMatch(/FAIL {2}bun-zero .*found no tests/);
    expect(r.stdout).toMatch(/FAIL {2}pw-skip .*1 skipped/);
    expect(r.stdout).toMatch(/pass {2}pw-flaky .*1 flaky/);
    expect(r.stdout).toMatch(/pass {2}bun-pass .*2 tests/);
  });

  test("a flaky pass writes a receipt that lists it; skips: allow lets a skip through", () => {
    const dir = makeRepo(sb, "flaky-repo", {}, {
      version: 1,
      mode: "block",
      checks: [
        { name: "flows", run: cat("pw-flaky-line.txt") },
        { name: "rules", run: cat("bun-skip.txt"), skips: "allow" },
      ],
    });
    const r = gate(sb, dir, []);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("flaky (passed on retry): flows: tests/flaky.spec.ts:3:1 › sometimes fails");
    const tree = must(dir, "git rev-parse HEAD^{tree}", sb.env).trim();
    const receipt = JSON.parse(readFileSync(join(dir, ".git", "gate", "receipts", `${tree}.json`), "utf8")) as { flaky: string[] };
    expect(receipt.flaky).toEqual(["flows: tests/flaky.spec.ts:3:1 › sometimes fails"]);
  });
});
