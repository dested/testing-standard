// gate probe on throwaway repos: who catches what, minRate and critical,
// exclusions, --from / --since / --seed, restoring the file, timeouts, a red
// baseline, and databases.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { slugOf } from "../../src/lib/gate/paths.ts";
import type { PgConn } from "../../src/lib/pgurl.ts";
import {
  commitAll,
  devUrl,
  dropAllFor,
  gate,
  gateAsync,
  gateDbsFor,
  makeRepo,
  must,
  requirePostgres,
  sandbox,
  uniq,
  waitFor,
  writeFiles,
} from "./helpers.ts";

setDefaultTimeout(120_000);

const sb = sandbox();
const dbRepos: string[] = [];
let server: PgConn | null = null;

beforeAll(async () => {
  server = await requirePostgres();
});

afterAll(async () => {
  for (const r of dbRepos) if (server) await dropAllFor(server, r).catch(() => {});
  sb.cleanup();
});

interface BugOut {
  file: string;
  line: number;
  op: string;
  before: string;
  after: string;
  outcome: string;
  check?: string;
  timeout?: boolean;
  reason?: string;
  note?: string;
  failing: { name: string; file?: string }[];
}
interface ProbeOut {
  exit: number;
  bugs: BugOut[];
  summary: { counted: number; caught: number; missed: number; rate: number | null; why: string[]; criticalMissed: string[] };
  path: string;
  error?: string;
}

function probe(dir: string, args: string[] = []): { code: number; json: ProbeOut; stderr: string } {
  const r = gate(sb, dir, ["probe", "--json", ...args]);
  try {
    return { code: r.code, json: JSON.parse(r.stdout) as ProbeOut, stderr: r.stderr };
  } catch {
    throw new Error(`gate probe --json printed no JSON (exit ${r.code}): ${r.stdout}\n${r.stderr}`);
  }
}

const MATH = `export function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}
`;
const UNTESTED = `export function isAdmin(role: string): boolean {
  return role === "admin";
}
`;
const MATH_TEST = `import { test, expect } from "bun:test";
import { clamp } from "../src/math.ts";
test("clamps low", () => expect(clamp(-1, 0, 5)).toBe(0));
test("clamps high", () => expect(clamp(9, 0, 5)).toBe(5));
test("passes through", () => expect(clamp(3, 0, 5)).toBe(3));
`;

function mathRepo(name: string, probeCfg: object = {}, extra: Record<string, string> = {}, checks?: object[]): string {
  return makeRepo(
    sb,
    uniq(name),
    { "src/math.ts": MATH, "src/untested.ts": UNTESTED, "tests/math.test.ts": MATH_TEST, ...extra },
    {
      version: 1,
      mode: "report",
      checks: checks ?? [
        { name: "lint", run: "true" },
        { name: "unit", run: "bun test" },
      ],
      probe: { include: ["src/**/*.ts"], ...probeCfg },
    },
  );
}

function fromFile(name: string, bugs: object[]): string {
  const path = join(sb.dir, `${uniq(name)}.jsonl`);
  writeFileSync(path, bugs.map((b) => JSON.stringify(b)).join("\n") + "\n");
  return path;
}

const sha = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");
const treeFile = (dir: string, rel: string): string => join(sb.work, slugOf(dir), "tree", rel);

describe("gate probe", () => {
  test("2. the tested function's bug is caught by the right check, the untested one is missed; minRate decides the exit", () => {
    const dir = mathRepo("probe-basic");
    const r = probe(dir);
    expect(r.code).toBe(1);
    expect(r.json.bugs.length).toBeGreaterThan(1);
    for (const b of r.json.bugs) {
      if (b.file === "src/math.ts") {
        expect({ b: `${b.file}:${b.line} ${b.op}`, outcome: b.outcome, check: b.check }).toEqual({ b: `${b.file}:${b.line} ${b.op}`, outcome: "caught", check: "unit" });
        expect(b.failing[0]?.file).toContain("math.test.ts");
      } else expect(b.outcome).toBe("missed");
    }
    expect(r.json.summary.why.join()).toContain("below minRate 90%");
    expect(existsSync(r.json.path)).toBe(true);

    const human = gate(sb, dir, ["probe"]);
    expect(human.stdout).toMatch(/^caught {2}unit {3}src\/math\.ts:\d+ +\S+ +clamps /m);
    expect(human.stdout).toMatch(/^MISSED {9}src\/untested\.ts:2 +flip-eq +return role === "admin"; → return role !== "admin";/m);
    expect(human.stdout).toContain("catch rate 67%");
    expect(human.stdout).toContain("FAILED: catch rate 67% is below minRate 90%");

    const lenient = mathRepo("probe-lenient", { minRate: 0.5 });
    expect(probe(lenient).code).toBe(0);
  });

  test("3. a missed bug under a critical glob fails the probe even at 95%", () => {
    const lines = Array.from({ length: 19 }, (_, i) => `export const f${i + 1} = (x: number): boolean => x === ${i + 1};`);
    const files = {
      "src/many.ts": `${lines.join("\n")}\n`,
      "src/auth/admin.ts": UNTESTED,
      "tests/many.test.ts": `import { test, expect } from "bun:test";\nimport * as m from "../src/many.ts";\ntest("all", () => { ${lines.map((_, i) => `expect(m.f${i + 1}(${i + 1})).toBe(true);`).join(" ")} });\n`,
    };
    const bugs = [
      ...lines.map((l, i) => ({ file: "src/many.ts", line: i + 1, op: "flip-eq", before: l, after: l.replace("===", "!==") })),
      { file: "src/auth/admin.ts", line: 2, op: "flip-eq", before: 'return role === "admin";', after: 'return role !== "admin";' },
    ];
    const from = fromFile("critical", bugs);
    const checks = [{ name: "unit", run: "bun test" }];
    const plain = makeRepo(sb, uniq("probe-crit-off"), files, { version: 1, mode: "report", checks, probe: { include: ["src/**/*.ts"] } });
    const ok = probe(plain, ["--from", from]);
    expect(ok.json.summary.rate).toBeCloseTo(0.95, 5);
    expect(ok.code).toBe(0);

    const crit = makeRepo(sb, uniq("probe-crit-on"), files, { version: 1, mode: "report", checks, probe: { include: ["src/**/*.ts"], critical: ["src/auth/**"] } });
    const r = probe(crit, ["--from", from]);
    expect(r.code).toBe(1);
    expect(r.json.summary.criticalMissed).toEqual(["src/auth/admin.ts:2"]);
    expect(r.json.summary.why).toEqual(["missed under critical: src/auth/admin.ts:2"]);
  });

  test("4. an excluded path and probe-ignore lines are reported excluded with the reason and never run", () => {
    const flags = [
      "export function defaults(x: boolean): boolean {",
      "  if (x) return true; // probe-ignore: product default, not logic",
      "  // probe-ignore: legacy toggle",
      "  if (!x) return false;",
      "  return x === true;",
      "}",
      "",
    ].join("\n");
    const dir = mathRepo("probe-exclude", { exclude: [{ path: "src/log.ts", why: "log colours and formatting" }] }, { "src/log.ts": "export const loud = (n: number) => n > 3;\n", "src/flags.ts": flags }, [
      { name: "unit", run: "bun test" },
    ]);
    const from = fromFile("exclude", [
      { file: "src/log.ts", line: 1, op: "flip-rel", before: "export const loud = (n: number) => n > 3;", after: "export const loud = (n: number) => n <= 3;" },
      { file: "src/flags.ts", line: 2, op: "flip-bool", before: "if (x) return true; // probe-ignore: product default, not logic", after: "if (x) return false; // probe-ignore: product default, not logic" },
      { file: "src/flags.ts", line: 4, op: "drop-not", before: "if (!x) return false;", after: "if (x) return false;" },
    ]);
    const r = probe(dir, ["--from", from]);
    expect(r.json.bugs.map((b) => [b.outcome, b.reason])).toEqual([
      ["excluded", "log colours and formatting"],
      ["excluded", "probe-ignore: product default, not logic"],
      ["excluded", "probe-ignore: legacy toggle"],
    ]);
    const runs = join(sb.work, slugOf(dir), "runs");
    expect(must(runs, "ls */ | grep -c '^b[0-9]' || true", sb.env).trim()).toBe("0");

    const all = probe(dir, ["--max", "200"]);
    for (const b of all.json.bugs) {
      expect(b.file).not.toBe("src/log.ts");
      if (b.file === "src/flags.ts") expect([2, 4]).not.toContain(b.line);
    }
    expect(all.json.bugs.some((b) => b.file === "src/flags.ts" && b.line === 5)).toBe(true);
  });

  test("5. --from: a moved line is found by its text, a truncated before/after resolves, a vanished line is stale", () => {
    const long = `  if (kind === "a") return "${"x".repeat(240)}";`;
    const dir = mathRepo("probe-from", {}, { "src/long.ts": `export function k(kind: string): string {\n${long}\n  return "";\n}\n` }, [{ name: "unit", run: "bun test" }]);
    const from = fromFile("from", [
      // recorded at line 2; the line has since moved to line 5
      { file: "src/math.ts", line: 2, op: "drop-guard", before: "if (n < lo) return lo;", after: "void 0" },
      { file: "src/long.ts", line: 2, op: "flip-eq", before: long.trim().slice(0, 200), after: long.replace("===", "!==").trim().slice(0, 200) },
      { file: "src/math.ts", line: 3, op: "flip-rel", before: "if (n > gone) return hi;", after: "if (n <= gone) return hi;" },
    ]);
    writeFiles(dir, { "src/math.ts": `// one\n// two\n// three\n${MATH}` });
    commitAll(sb, dir, "move clamp down");
    const r = probe(dir, ["--from", from]);
    const [moved, truncated, vanished] = r.json.bugs;
    expect(moved).toMatchObject({ file: "src/math.ts", line: 5, outcome: "caught", check: "unit" });
    expect(truncated).toMatchObject({ file: "src/long.ts", line: 2, outcome: "missed" });
    expect(truncated?.after.length).toBe(200);
    expect(vanished).toMatchObject({ outcome: "stale", reason: "line not found" });
    expect(r.json.summary.counted).toBe(2);
  });

  test("5b. --from: a row the operator can't regenerate is replayed as recorded when its line is still there word for word", () => {
    const dir = mathRepo("probe-replay", {}, {}, [{ name: "seen", run: `! grep -q 'role == "admin"' src/untested.ts` }]);
    const from = fromFile("replay", [
      // flip-eq never produces "==": only the recorded text can plant this
      { file: "src/untested.ts", line: 2, op: "flip-eq", before: 'return role === "admin";', after: 'return role == "admin";' },
      { file: "src/untested.ts", line: 2, op: "flip-eq", before: 'return role === "user";', after: 'return role == "user";' },
    ]);
    const r = probe(dir, ["--from", from]);
    const [replayed, gone] = r.json.bugs;
    expect(replayed).toMatchObject({ file: "src/untested.ts", line: 2, outcome: "caught", check: "seen", note: "replayed as recorded", after: 'return role == "admin";' });
    expect(gone).toMatchObject({ outcome: "stale" });
    expect(gate(sb, dir, ["probe", "--from", from]).stdout).toContain("(replayed as recorded)");
    expect(readFileSync(treeFile(dir, "src/untested.ts"), "utf8")).toBe(UNTESTED);
  });

  test("6. --since: only lines changed since that commit are candidates", () => {
    const dir = mathRepo("probe-since", {}, {}, [{ name: "noop", run: "true" }]);
    const base = must(dir, "git rev-parse HEAD", sb.env).trim();
    writeFiles(dir, { "src/math.ts": MATH.replace("if (n > hi) return hi;", "if (n >= hi) return hi;") });
    commitAll(sb, dir, "edge");
    const r = probe(dir, ["--since", base, "--max", "50"]);
    expect(r.json.bugs.length).toBeGreaterThan(0);
    for (const b of r.json.bugs) expect(`${b.file}:${b.line}`).toBe("src/math.ts:3");
  });

  test("7. the same seed picks the same bugs; another seed picks others", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `export const g${i} = (x: number): boolean => x === ${i} && x > ${i + 1};`);
    const dir = makeRepo(sb, uniq("probe-seed"), { "src/a/many.ts": `${lines.join("\n")}\n`, "src/b/more.ts": `${lines.join("\n")}\n` }, {
      version: 1,
      mode: "report",
      checks: [{ name: "noop", run: "true" }],
      probe: { include: ["src/**/*.ts"] },
    });
    const picks = (seed: string): string[] => probe(dir, ["--max", "8", "--seed", seed]).json.bugs.map((b) => `${b.file}:${b.line}:${b.op}`);
    const a = picks("1");
    expect(a.length).toBe(8);
    expect(new Set(a.map((p) => p.split(":").slice(0, 2).join(":"))).size).toBe(8);
    expect(picks("1")).toEqual(a);
    expect(picks("2")).not.toEqual(a);
    expect(new Set(a.map((p) => p.split(":")[2])).size).toBeGreaterThan(1);
    expect(new Set(a.map((p) => p.split("/")[1])).size).toBe(2);
  });

  test("8. the file is byte-identical after a probe, and after SIGTERM mid-bug", async () => {
    const marker = join(sb.dir, uniq("probe-hang"));
    const dir = mathRepo("probe-restore", {}, {}, [
      { name: "unit", run: "bun test" },
      { name: "hang", run: `if grep -q 'role !== ' src/untested.ts; then touch ${marker}; sleep 60; fi` },
    ]);
    const original = sha(join(dir, "src/untested.ts"));
    const plain = probe(dir, ["--only-files", "src/math.ts"]);
    expect(plain.code).toBe(0);
    expect(plain.json.summary.caught).toBeGreaterThan(1);
    expect(sha(treeFile(dir, "src/math.ts"))).toBe(sha(join(dir, "src/math.ts")));

    const from = fromFile("restore", [{ file: "src/untested.ts", line: 2, op: "flip-eq", before: 'return role === "admin";', after: 'return role !== "admin";' }]);
    const run = gateAsync(sb, dir, ["probe", "--from", from]);
    await waitFor(() => existsSync(marker), 30_000, "the planted bug's hanging check");
    expect(readFileSync(treeFile(dir, "src/untested.ts"), "utf8")).toContain("role !== ");
    run.child.kill("SIGTERM");
    const done = await run.done;
    expect(done.code).toBe(130);
    expect(done.stdout).toContain("interrupted by SIGTERM");
    expect(sha(treeFile(dir, "src/untested.ts"))).toBe(original);
    expect(sha(join(dir, "src/untested.ts"))).toBe(original);
  });

  test("9. a planted infinite loop is caught by the timeout in bounded time", () => {
    const loop = "  for (let i = 0; i < 10; i = i + 1) total = total + i;";
    const dir = mathRepo(
      "probe-loop",
      {},
      {
        "src/sum.ts": `export function sum(): number {\n  let total = 0;\n${loop}\n  return total;\n}\n`,
        "tests/sum.test.ts": `import { test, expect } from "bun:test";\nimport { sum } from "../src/sum.ts";\ntest("sum", () => expect(sum()).toBe(45));\n`,
      },
      [{ name: "unit", run: "bun test", timeout: 3 }],
    );
    const from = fromFile("loop", [{ file: "src/sum.ts", line: 3, op: "flip-arith", before: loop.trim(), after: loop.replace("i = i + 1", "i = i - 1").trim() }]);
    const t0 = Date.now();
    const r = probe(dir, ["--from", from]);
    expect(r.json.bugs[0]).toMatchObject({ outcome: "caught", check: "unit", timeout: true });
    expect(Date.now() - t0).toBeLessThan(30_000);
    expect(gate(sb, dir, ["probe", "--from", from]).stdout).toMatch(/caught {2}unit +src\/sum\.ts:3 +flip-arith +\(timeout\)/);
  });

  test("10. a red baseline exits 1 with the message and plants nothing", () => {
    const dir = mathRepo("probe-red", {}, { "tests/red.test.ts": `import { test, expect } from "bun:test";\ntest("red", () => expect(1).toBe(2));\n` }, [{ name: "unit", run: "bun test" }]);
    const r = gate(sb, dir, ["probe"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("the commit is red at unit; a probe needs a green commit");
    expect(r.stdout).not.toMatch(/^(caught|MISSED)/m);
    expect(existsSync(join(dir, ".git", "gate", "probes"))).toBe(false);
    for (const f of ["src/math.ts", "src/untested.ts"]) expect(sha(treeFile(dir, f))).toBe(sha(join(dir, f)));
  });

  test("11. every bug gets a fresh database, and none is left after the probe", async () => {
    if (!server) throw new Error("no Postgres");
    const dir = mathRepo(
      "gt-probe-db",
      {},
      {},
      [
        // fails if an earlier bug's row is still there: the database must be fresh per bug
        { name: "db", run: `psql "$DATABASE_URL" -tAc 'select count(*) from items' | grep -qx 0 && psql "$DATABASE_URL" -qc 'insert into items values (1)'` },
      ],
    );
    writeFiles(dir, {
      "gate.json": JSON.stringify({
        version: 1,
        mode: "report",
        databases: [{ env: "DATABASE_URL", migrate: `psql "$DATABASE_URL" -qc 'create table items(id int)'` }],
        checks: [{ name: "db", run: `psql "$DATABASE_URL" -tAc 'select count(*) from items' | grep -qx 0 && psql "$DATABASE_URL" -qc 'insert into items values (1)'` }],
        probe: { include: ["src/**/*.ts"] },
      }),
      ".env": `DATABASE_URL=${devUrl(server, "devdb_unused")}\n`,
    });
    commitAll(sb, dir, "db");
    dbRepos.push(dir);
    const r = probe(dir, ["--max", "3"]);
    expect(r.json.bugs.length).toBe(3);
    for (const b of r.json.bugs) expect(b.outcome).toBe("missed");
    expect(await gateDbsFor(server, dir)).toEqual([]);
  });
});

describe("gate probe report and status", () => {
  test("report lists rates, per-check catches and idle test files; status says whether report mode may block", () => {
    const dir = mathRepo("probe-report", { minRate: 0.5 }, { "tests/idle.test.ts": `import { test, expect } from "bun:test";\ntest("idle", () => expect(1).toBe(1));\n` });
    expect(probe(dir).code).toBe(0);
    const rep = JSON.parse(gate(sb, dir, ["probe", "report", "--json"]).stdout) as { probes: unknown[]; byCheck: Record<string, number>; idleChecks: string[]; idleTestFiles: string[] };
    expect(rep.probes.length).toBe(1);
    expect(rep.byCheck.unit).toBeGreaterThan(0);
    expect(rep.idleChecks).toEqual(["lint"]);
    expect(rep.idleTestFiles).toEqual(["tests/idle.test.ts"]);
    expect(gate(sb, dir, ["probe", "report"]).stdout).toContain("a file can be idle because no bug landed near it");

    let st = JSON.parse(gate(sb, dir, ["status", "--json"]).stdout) as { ready: { ready: boolean; why: string[] }; probe: { exit: number } };
    expect(st.probe.exit).toBe(0);
    expect(st.ready.ready).toBe(false);
    expect(st.ready.why).toEqual(["HEAD has no passing receipt (run gate)"]);
    let text = gate(sb, dir, ["status"]).stdout;
    expect(text).toContain("\nopen: HEAD has no passing receipt (run gate)\n");
    expect(gate(sb, dir, []).code).toBe(0);
    st = JSON.parse(gate(sb, dir, ["status", "--json"]).stdout);
    expect(st.ready.ready).toBe(true);
    text = gate(sb, dir, ["status"]).stdout;
    expect(text).toContain("\nsampled probe 67% · 1 missed · every check passing\n");
    expect(text.toLowerCase()).not.toContain("block");
    expect(gate(sb, dir, ["probe", "report"]).stdout.toLowerCase()).not.toContain("block");
  });

  test("status in a report-mode repo with no probe states what's open, never 'block'", () => {
    const dir = mathRepo("probe-status-none");
    const text = gate(sb, dir, ["status"]).stdout;
    expect(text).toContain("probe    none yet: gate probe\n");
    expect(text).toContain("\nopen: HEAD has no passing receipt (run gate); no probe yet (run gate probe)\n");
    expect(text.toLowerCase()).not.toContain("block");
  });

  test("no probe.include exits 2", () => {
    const dir = makeRepo(sb, uniq("probe-noinclude"), {}, { version: 1, mode: "report", checks: [{ name: "ok", run: "true" }] });
    const r = gate(sb, dir, ["probe"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("no probe.include");
  });
});
