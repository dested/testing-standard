// gate run on throwaway repos: receipts, failures, the clean copy, timeouts,
// forgery, tree keys, the lock, init and gate.json validation.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { slugOf } from "../../src/lib/gate/paths.ts";
import { canonicalJson, readReceipt } from "../../src/lib/gate/receipt.ts";
import { gate, gateAsync, makeRepo, must, sandbox, waitFor, writeFiles } from "./helpers.ts";

setDefaultTimeout(60_000);

const sb = sandbox();
afterAll(() => sb.cleanup());

const tree = (dir: string): string => must(dir, "git rev-parse HEAD^{tree}", sb.env).trim();
const receiptFile = (dir: string): string => join(dir, ".git", "gate", "receipts", `${tree(dir)}.json`);
const statusJson = (dir: string): { receipt: { state: string } } => JSON.parse(gate(sb, dir, ["status", "--json"]).stdout);

describe("gate run", () => {
  test("1. a passing repo exits 0 and writes a receipt whose signature verifies", () => {
    const dir = makeRepo(sb, "pass-repo", { "a.txt": "a" }, { version: 1, mode: "block", checks: [{ name: "one", run: "test -f a.txt" }, { name: "two", run: "echo ok" }] });
    const r = gate(sb, dir, []);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("pass  one");
    expect(r.stdout).toContain("git push is allowed");
    expect(existsSync(receiptFile(dir))).toBe(true);

    // Verify independently of gate's own reader: HMAC-SHA256 over the canonical JSON of every other field.
    const receipt = JSON.parse(readFileSync(receiptFile(dir), "utf8")) as Record<string, unknown> & { sig: string };
    const { sig, ...body } = receipt;
    const key = readFileSync(join(sb.home, "key"));
    expect(key.length).toBe(32);
    expect(createHmac("sha256", key).update(canonicalJson(body)).digest("hex")).toBe(sig);
    expect(receipt.tree).toBe(tree(dir));
    process.env.GATE_HOME = sb.home;
    expect(readReceipt(join(dir, ".git", "gate", "receipts"), tree(dir))).not.toBeNull();
  });

  test("2. a failing check exits 1, writes no receipt, later checks are not run; --all runs them", () => {
    const dir = makeRepo(sb, "fail-repo", {}, {
      version: 1,
      mode: "block",
      checks: [
        { name: "first", run: "echo fine" },
        { name: "broken", run: "echo 'boom line'; exit 4" },
        { name: "later", run: "echo later-ran" },
      ],
    });
    const r = gate(sb, dir, []);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("FAIL  broken");
    expect(r.stdout).toContain("exit 4");
    expect(r.stdout).toContain("boom line");
    expect(r.stdout).toMatch(/ -- {3}later\s+not run/);
    expect(r.stdout).toContain("FAILED at broken.");
    expect(existsSync(receiptFile(dir))).toBe(false);

    const all = gate(sb, dir, ["--all"]);
    expect(all.code).toBe(1);
    expect(all.stdout).toContain("pass  later");
    expect(existsSync(receiptFile(dir))).toBe(false);
  });

  test("3. clean copy: an untracked file a check needs fails it; --dirty passes and writes no receipt", () => {
    const dir = makeRepo(sb, "clean-repo", {}, { version: 1, mode: "block", checks: [{ name: "needs", run: "test -f only-here.txt" }] });
    writeFileSync(join(dir, "only-here.txt"), "untracked");
    const r = gate(sb, dir, []);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("note: 1 uncommitted file is not part of this check");
    const d = gate(sb, dir, ["--dirty"]);
    expect(d.code).toBe(0);
    expect(d.stdout).toContain("passed · no receipt (--dirty run");
    expect(existsSync(receiptFile(dir))).toBe(false);
  });

  test("4. committed-but-dirty: a tracked file fixed only in the working tree still fails", () => {
    const dir = makeRepo(sb, "dirty-repo", { "value.txt": "broken\n" }, { version: 1, mode: "block", checks: [{ name: "fixed", run: "grep -q fixed value.txt" }] });
    writeFileSync(join(dir, "value.txt"), "fixed\n");
    expect(gate(sb, dir, []).code).toBe(1);
    expect(gate(sb, dir, ["--dirty"]).code).toBe(0);
  });

  test("9. a check past its timeout is killed with its children and the run fails", async () => {
    const pidFile = join(sb.dir, "timeout-child.pid");
    const dir = makeRepo(sb, "timeout-repo", {}, {
      version: 1,
      mode: "block",
      checks: [{ name: "slow", run: `sleep 30 & echo $! > ${pidFile}; wait`, timeout: 1 }],
    });
    const t0 = Date.now();
    const r = gate(sb, dir, []);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("timed out after 1s");
    expect(Date.now() - t0).toBeLessThan(15_000);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });

  test("10. a receipt edited by hand, or signed without the key, is treated as absent", () => {
    const dir = makeRepo(sb, "forge-repo", {}, { version: 1, mode: "block", checks: [{ name: "ok", run: "true" }] });
    expect(gate(sb, dir, []).code).toBe(0);
    expect(statusJson(dir).receipt.state).toBe("pass");
    const path = receiptFile(dir);
    const original = readFileSync(path, "utf8");

    const edited = JSON.parse(original) as Record<string, unknown>;
    edited.ms = 1;
    writeFileSync(path, JSON.stringify(edited));
    expect(statusJson(dir).receipt.state).toBe("none");

    const { sig: _sig, ...body } = JSON.parse(original) as Record<string, unknown>;
    const forged = { ...body, sig: createHmac("sha256", randomBytes(32)).update(canonicalJson(body)).digest("hex") };
    writeFileSync(path, JSON.stringify(forged));
    expect(statusJson(dir).receipt.state).toBe("none");

    writeFileSync(path, original);
    expect(statusJson(dir).receipt.state).toBe("pass");
  });

  test("11. tree-keyed: amending only the message keeps the receipt valid", () => {
    const dir = makeRepo(sb, "amend-repo", {}, { version: 1, mode: "block", checks: [{ name: "ok", run: "true" }] });
    expect(gate(sb, dir, []).code).toBe(0);
    const before = must(dir, "git rev-parse HEAD", sb.env).trim();
    must(dir, "git commit -q --amend -m 'a better message'", sb.env);
    expect(must(dir, "git rev-parse HEAD", sb.env).trim()).not.toBe(before);
    expect(statusJson(dir).receipt.state).toBe("pass");
  });

  test("16. a second gate --no-wait during a run exits 3; a stale lock (dead pid) is taken over", async () => {
    const marker = join(sb.dir, "lock-started");
    const dir = makeRepo(sb, "lock-repo", {}, { version: 1, mode: "block", checks: [{ name: "hold", run: `touch ${marker}; sleep 3` }] });
    const first = gateAsync(sb, dir, []);
    await waitFor(() => existsSync(marker), 20_000, "the first run's check to start");
    const second = gate(sb, dir, ["--no-wait"]);
    expect(second.code).toBe(3);
    expect(second.stderr).toContain("already running");
    expect((await first.done).code).toBe(0);

    const dead = spawnSync("true").pid;
    const lock = join(sb.work, slugOf(dir), "lock");
    mkdirSync(join(sb.work, slugOf(dir)), { recursive: true });
    writeFileSync(lock, JSON.stringify({ pid: dead, run: "deadrun1", at: new Date().toISOString() }));
    const third = gate(sb, dir, ["--no-wait", "--only", "hold"]);
    expect(third.code).toBe(0);
    expect(existsSync(lock)).toBe(false);
  });
});

describe("gate init and gate.json", () => {
  test("17. gate init writes the expected gate.json from package.json; an unknown key exits 2", () => {
    const dir = makeRepo(sb, "init-repo", {
      "package.json": JSON.stringify({ name: "x", scripts: { typecheck: "tsc", test: "bun test", "test:e2e": "playwright test", "db:deploy": "prisma migrate deploy", dev: "vite" } }),
      "bun.lock": "{}",
      "prisma/schema.prisma": "// schema",
    });
    writeFiles(dir, { ".env": "DATABASE_URL=postgres://u:p@localhost:5432/dev\n" });
    const r = gate(sb, dir, ["init"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("not detected:");
    expect(r.stdout).toContain("api (no test:api script)");
    expect(JSON.parse(readFileSync(join(dir, "gate.json"), "utf8"))).toEqual({
      version: 1,
      mode: "report",
      branches: ["main", "master"],
      setup: ["bun install --frozen-lockfile"],
      databases: [{ env: "DATABASE_URL", migrate: "bun run db:deploy", key: ["prisma"] }],
      checks: [
        { name: "types", run: "bun run typecheck" },
        { name: "rules", run: "bun run test" },
        { name: "flows", run: "bun run test:e2e", timeout: 900 },
      ],
    });
    expect(r.stdout).not.toContain("standing decision");
    expect(gate(sb, dir, ["init"]).code).toBe(2);
    const blk = gate(sb, dir, ["init", "--force", "--mode", "block"]);
    expect(blk.code).toBe(0);
    expect(blk.stdout.split("\n")[0]).toBe("Report mode is the default and nothing blocks a push; only use block if the repo's owner asked for it in this conversation");
    expect(JSON.parse(readFileSync(join(dir, "gate.json"), "utf8")).mode).toBe("block");

    // Uncommitted gate.json: the commit has none → exit 2 naming gate init.
    const none = gate(sb, dir, []);
    expect(none.code).toBe(2);
    expect(none.stderr).toContain('no gate.json in init-repo at');
    expect(none.stderr).toContain('run "gate init"');

    const typo = makeRepo(sb, "typo-repo", {}, { version: 1, mode: "block", chekcs: [], checks: [{ name: "ok", run: "true" }] });
    const t = gate(sb, typo, []);
    expect(t.code).toBe(2);
    expect(t.stderr).toContain("chekcs");

    const v2 = makeRepo(sb, "v2-repo", {}, { version: 2, mode: "block", checks: [{ name: "ok", run: "true" }] });
    expect(gate(sb, v2, []).code).toBe(2);
  });

  test("outside a git repo exits 2", () => {
    const dir = join(sb.dir, "not-a-repo");
    mkdirSync(dir, { recursive: true });
    const r = gate(sb, dir, []);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not inside a git repo");
  });

  test("--json prints exactly one JSON object", () => {
    const dir = makeRepo(sb, "json-repo", {}, { version: 1, mode: "report", checks: [{ name: "ok", run: "echo hi" }] });
    const r = gate(sb, dir, ["--json"]);
    expect(r.code).toBe(0);
    const obj = JSON.parse(r.stdout) as { ok: boolean; receipt: boolean; logs: Record<string, string>; trigger: string };
    expect(r.stdout.trim().split("\n").length).toBe(1);
    expect(obj.ok).toBe(true);
    expect(obj.receipt).toBe(true);
    expect(obj.trigger).toBe("manual");
    expect(readFileSync(obj.logs.ok ?? "", "utf8")).toContain("hi");
  });

  test("--quiet prints nothing on a pass", () => {
    const dir = makeRepo(sb, "quiet-repo", {}, { version: 1, mode: "report", checks: [{ name: "ok", run: "echo hi" }] });
    const r = gate(sb, dir, ["--quiet"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });
});
