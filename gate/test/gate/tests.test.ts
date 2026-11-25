// `gate tests`: the per-test parser on real output (a monorepo's bun runs and a
// two-width Playwright run, captured from gate's own logs into
// test/gate/fixtures/tests-*.txt), and the report end to end on a sandbox repo
// whose checks replay those logs.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseTests } from "../../src/lib/gate/testlog.ts";
import type { TestsReport } from "../../src/lib/gate/tests.ts";
import { FIXTURES, gate, makeRepo, must, sandbox } from "./helpers.ts";

setDefaultTimeout(60_000);

const sb = sandbox();
afterAll(() => sb.cleanup());

const fx = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");
const statuses = (text: string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const t of parseTests(text)) out[t.status] = (out[t.status] ?? 0) + 1;
  return out;
};

describe("per-test parser on real output", () => {
  test("bun in a monorepo: every test, its workspace, file and time", () => {
    const tests = parseTests(fx("tests-bun-mono-pass.txt"));
    expect(tests.length).toBe(53);
    expect(statuses(fx("tests-bun-mono-pass.txt"))).toEqual({ pass: 53 });
    expect(tests[0]).toEqual({
      runner: "bun",
      file: "src/lib/resolve-api-url.rule.test.ts",
      workspace: "@app/mobile",
      name: "resolveApiUrl > EXPO_PUBLIC_API_URL wins, without its trailing slash",
      status: "pass",
      ms: 0.21,
    });
    expect(new Set(tests.map((t) => t.workspace))).toEqual(new Set(["@app/mobile", "@app/web", "@app/brand", "@app/tokens"]));
  });

  test("bun failures: the error's first lines, and the end-of-run recap isn't counted twice", () => {
    const tests = parseTests(fx("tests-bun-mono-fail.txt"));
    expect(statuses(fx("tests-bun-mono-fail.txt"))).toEqual({ pass: 38, fail: 3 });
    const fail = tests.filter((t) => t.status === "fail");
    expect(fail.map((t) => t.file)).toEqual(["src/lib/loader.rule.test.ts", "src/lib/loader.rule.test.ts", "src/lib/loader.rule.test.ts"]);
    expect(fail[0]?.name).toBe("safeNext > a path on this site passes through");
    expect(fail[0]?.error).toEqual(["error: expect(received).toBe(expected)", 'Expected: "/dashboard"', "Received: null"]);
    const small = parseTests(fx("bun-fail.txt"));
    expect(small.find((t) => t.status === "fail")?.error).toEqual(["error: expect(received).toBe(expected)", "Expected: 403", "Received: 401"]);
  });

  test("Playwright list reporter at two widths", () => {
    const tests = parseTests(fx("tests-pw-widths-pass.txt"));
    expect(statuses(fx("tests-pw-widths-pass.txt"))).toEqual({ pass: 32 });
    expect(new Set(tests.map((t) => t.project))).toEqual(new Set(["desktop", "phone"]));
    expect(new Set(tests.map((t) => `${t.file} ${t.name}`)).size).toBe(16);
    const empty = tests.find((t) => t.project === "phone" && t.name.includes("demo/posts-empty"));
    expect(empty).toMatchObject({ file: "e2e/demo.flow.spec.ts", loc: "29:3", name: expect.stringMatching(/^on an empty database › demo\/posts-empty · /), ms: 3300 });

    const failed = parseTests(fx("tests-pw-widths-fail.txt")).filter((t) => t.status === "fail");
    expect(failed.map((t) => t.project)).toEqual(["desktop", "phone"]);
    expect(failed[0]?.name).toBe("shell/not-found · an unknown page shows the 404 screen with a 404 status");
    expect(failed[0]?.error?.[0]).toBe("Error: expect(locator).toBeVisible() failed");
  });

  test("Playwright flaky, skipped and did-not-run", () => {
    expect(statuses(fx("pw-flaky-list.txt"))).toEqual({ flaky: 1, pass: 1 });
    expect(statuses(fx("pw-skip-list.txt"))).toEqual({ pass: 1, skip: 1 });
    expect(statuses(fx("pw-dnr-list.txt"))).toEqual({ fail: 1, dnr: 1 });
  });
});

describe("gate tests on a repo", () => {
  const flip = join(sb.dir, "rules-log");
  const setRules = (name: string): void => writeFileSync(flip, join(FIXTURES, name));
  let dir = "";

  test("before any run: says so, names the command, lists the test files as not run yet", () => {
    dir = makeRepo(
      sb,
      "tests-repo",
      {
        "package.json": JSON.stringify({ name: "root", workspaces: ["apps/*"] }),
        "apps/web/package.json": JSON.stringify({ name: "@app/web" }),
        "apps/mobile/package.json": JSON.stringify({ name: "@app/mobile" }),
        // same path inside another workspace: only the log's `› @app/web …` line tells them apart
        "apps/mobile/src/lib/loader.rule.test.ts": "// never run\n",
        "apps/mobile/src/lib/ota-hold.rule.test.ts": "// replayed from a fixture\n",
        "apps/web/src/lib/loader.rule.test.ts": "// replayed from a fixture\n",
        "apps/web/e2e/shell.flow.spec.ts": "// replayed from a fixture\n",
        "apps/web/server/new.api.test.ts": "// never run\n",
      },
      {
        version: 1,
        mode: "report",
        checks: [
          { name: "rules", run: `cat "$(cat ${flip})"; grep -q fail "${flip}" && exit 1; exit 0` },
          { name: "flows", run: `cat ${join(FIXTURES, "tests-pw-widths-pass.txt")}` },
        ],
      },
    );
    const r = gate(sb, dir, ["tests"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("last run   none recorded yet: run gate");
    expect(r.stdout).toContain("not run yet");
    expect(r.stdout).toContain("apps/web/server/new.api.test.ts");
    expect(r.stdout).not.toContain("\x1b[");
  });

  test("a red last run: exit 0, failures by name with their error and log, the unreached check from its older run", () => {
    setRules("tests-bun-mono-pass.txt");
    expect(gate(sb, dir, []).code).toBe(0);
    setRules("tests-bun-mono-fail.txt");
    expect(gate(sb, dir, []).code).toBe(1);

    const r = gate(sb, dir, ["tests"], { env: { COLUMNS: "100" } });
    expect(r.code).toBe(0);
    const out = r.stdout;
    expect(out).toMatch(/last run {3}.* · FAIL at rules · HEAD has a receipt from an earlier pass/);
    expect(out).toMatch(/^rules +41 tests +38 pass · 3 fail/m);
    expect(out).toMatch(/^flows +16 flows at 2 widths +32 pass/m);
    expect(out).toMatch(/from the run of .*: the newest run didn't reach it/);
    // the workspace line resolves the printed path to the repo file
    expect(out).toMatch(/✘ +\d+ +apps\/web\/src\/lib\/loader\.rule\.test\.ts/);
    expect(out).toContain("✘ fail safeNext > a path on this site passes through");
    expect(out).toContain('Expected: "/dashboard"');
    expect(out).toMatch(/log \S+\/runs\/[a-z0-9]{8}\/rules\.log/);
    expect(out).toMatch(/desktop +phone/);
    expect(out.slice(out.indexOf("not run yet"))).toMatch(/^not run yet\n {2}· {2}apps\/mobile\/src\/lib\/loader\.rule\.test\.ts\n {2}· {2}apps\/web\/server\/new\.api\.test\.ts\n\n/);
    expect(out).toMatch(/✓ +4 +apps\/mobile\/src\/lib\/ota-hold\.rule\.test\.ts/);
    for (const line of out.split("\n")) expect(line.length).toBeLessThanOrEqual(100);
  });

  test("--json: every test, never truncated, with its history", () => {
    const r = gate(sb, dir, ["tests", "--json"]);
    expect(r.code).toBe(0);
    const j: TestsReport = JSON.parse(r.stdout);
    const rules = j.checks.find((c) => c.name === "rules");
    const flows = j.checks.find((c) => c.name === "flows");
    expect(rules?.tests).toBe(41);
    expect(rules?.state).toBe("fail");
    expect(rules?.newest).toBe(true);
    expect(flows?.newest).toBe(false);
    expect(flows?.flows).toEqual({ flows: 16, widths: ["desktop", "phone"] });
    const loader = rules?.files.find((f) => f.path === "apps/web/src/lib/loader.rule.test.ts");
    const failing = loader?.tests.find((t) => t.name === "safeNext > a path on this site passes through");
    expect(failing).toMatchObject({ status: "fail", history: { runs: 2, failed: 1, flaky: 0 }, clean: false });
    const long = flows?.files.flatMap((f) => f.tests).find((t) => t.name.includes("auth/sign-up · "));
    expect(long?.name).toBe("auth/sign-up · an 8-character password signs a new person up onto their dashboard");
    expect(j.notRunYet).toEqual(["apps/mobile/src/lib/loader.rule.test.ts", "apps/web/server/new.api.test.ts"]);
    expect(j.receipt).toBe(true);
    expect(j.headState).toBe("HEAD has a receipt from an earlier pass");
  });

  test("green again: an earlier failure still lists the test; --failed and the narrowing flags", () => {
    setRules("tests-bun-mono-pass.txt");
    expect(gate(sb, dir, []).code).toBe(0);
    const r = gate(sb, dir, ["tests"]);
    expect(r.stdout).toMatch(/· pass · HEAD has a receipt/);
    expect(r.stdout).toMatch(/✓ safeNext > a path on this site passes through\s+[\d.]+ms · failed in 1 of the last 3 runs/);

    const failed = gate(sb, dir, ["tests", "--failed"]).stdout;
    expect(failed).toContain("safeNext > a path on this site passes through");
    expect(failed).not.toContain("tokens.rule.test.ts");
    expect(failed).not.toContain("shell/home");

    const grep = gate(sb, dir, ["tests", "--grep", "nextFromSearch"]).stdout;
    expect(grep).toContain("nextFromSearch > reads ?next= and falls back to the signed-in page");
    expect(grep).not.toContain("brand.rule.test.ts");

    const one = gate(sb, dir, ["tests", "--check", "flows", "--file", "e2e/shell*"]).stdout;
    expect(one).toContain("shell/not-found · an unknown page");
    expect(one).not.toContain("auth/sign-up");
    expect(one).not.toMatch(/^rules$/m);

    const all = gate(sb, dir, ["tests", "--all"]).stdout;
    expect(all).toContain("✓ tokens.css > one theme: no .dark block, no OS color-scheme query");
  });

  test("planted bugs caught per file from stored probes; a file that caught none says so", () => {
    const sha = must(dir, "git rev-parse HEAD", sb.env).trim();
    const probes = resolve(dir, must(dir, "git rev-parse --git-common-dir", sb.env).trim(), "gate", "probes");
    mkdirSync(probes, { recursive: true });
    const bug = (file: string | null) => ({
      file: "apps/web/src/lib/loader.ts", line: 1, op: "flip-eq", before: "a === b", after: "a !== b",
      outcome: file ? "caught" : "missed", ...(file ? { check: "rules" } : {}),
      failing: file ? [{ name: "safeNext > x", file }] : [], ms: 10,
    });
    const probe = {
      v: 1, at: "2026-11-21T10:00:00.000Z", run: "aaaaaaaa", repo: "tests-repo", sha, tree: "t", commitAt: "2026-11-21T09:00:00.000Z",
      gate: "1", source: "sample", ms: 100, baseline: [],
      bugs: [bug("src/lib/loader.rule.test.ts"), bug("src/lib/loader.rule.test.ts"), bug(null)],
      summary: { counted: 3, caught: 2, missed: 1, excluded: 0, stale: 0, byCheck: { rules: 2 }, rate: 2 / 3, minRate: 0.8, criticalMissed: [], ok: false, why: ["below"] },
      exit: 1,
    };
    writeFileSync(join(probes, "2026-11-21T10-00-00.000Z-probe.json"), JSON.stringify(probe));
    const out = gate(sb, dir, ["tests"]).stdout;
    expect(out).toMatch(/probe {6}2026-11-21 · [0-9a-f]{7} · caught 67% · 1 missed/);
    expect(out).toMatch(/apps\/web\/src\/lib\/loader\.rule\.test\.ts +caught 2 planted bugs/);
    expect(out).toMatch(/apps\/web\/e2e\/shell\.flow\.spec\.ts +caught none/);
    expect(out).toContain("caught none: a file can be idle because no bug landed near it");
  });

  test("usage errors are exit 2: no gate.json, an unknown check, --all with --failed", () => {
    const bare = makeRepo(sb, "no-gate-json", { "a.txt": "a\n" });
    expect(gate(sb, bare, ["tests"]).code).toBe(2);
    const bad = gate(sb, dir, ["tests", "--check", "nope"]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("The checks: rules, flows");
    expect(gate(sb, dir, ["tests", "--all", "--failed"]).code).toBe(2);
  });
});
