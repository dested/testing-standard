// `gate guard push`: what agent-guard asks before an agent's `git push`.
// A bare remote made with `git clone --bare` and remote-tracking refs from
// `git fetch`: nothing here pushes, installs a hook or writes git config.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { readHistory } from "../../src/lib/gate/receipt.ts";
import { commitAll, gate, makeRepo, must, sandbox, waitFor, writeFiles, type Result, type Sandbox } from "./helpers.ts";

setDefaultTimeout(60_000);

const sb: Sandbox = sandbox();
afterAll(() => sb.cleanup());

const BLOCK = { version: 1, mode: "block", checks: [{ name: "types", run: "true" }, { name: "rules", run: "true" }] };

/** A repo whose `origin` is a bare clone of its first commit, with remote-tracking refs fetched. */
function withRemote(name: string, cfg?: object, files: Record<string, string> = { "a.txt": "a" }): string {
  const dir = makeRepo(sb, name, files, cfg);
  const bare = join(sb.dir, `${name}.git`);
  must(sb.dir, `git clone -q --bare ${dir} ${bare}`, sb.env);
  must(dir, `git remote add origin ${bare} && git fetch -q origin`, sb.env);
  return dir;
}

/** Move the remote's main to the local main (a fetch into the bare repo, not a push), then refresh tracking refs. */
function remoteCatchUp(dir: string, branch = "main"): void {
  must(dir, `git -C "$(git remote get-url origin)" fetch -q ${dir} +${branch}:${branch} && git fetch -q origin`, sb.env);
}

const guard = (dir: string, args: string[]): Result => gate(sb, dir, ["guard", "push", "--cwd", dir, "--", ...args]);

describe("gate guard push", () => {
  test("1. block mode: every spelling of a push to main is denied without a receipt, allowed after gate passes", () => {
    const dir = withRemote("guard-block", BLOCK);
    writeFiles(dir, { "b.txt": "b" });
    commitAll(sb, dir, "b");
    must(dir, "git branch feature", sb.env);
    const spellings = [
      ["origin", "main"],
      [],
      ["origin", "HEAD"],
      ["origin", "HEAD:main"],
      ["origin", "feature:main"],
      ["--all"],
      ["-u", "origin", "main"],
      ["--force-with-lease", "origin", "main"],
    ];
    for (const args of spellings) {
      const r = guard(dir, args);
      expect({ args, code: r.code }).toEqual({ args, code: 1 });
      expect(r.stdout).toContain("push to main denied");
      expect(r.stdout).toContain("no receipt");
      expect(r.stdout).toContain(`next: cd ${dir} && gate`);
    }
    expect(gate(sb, dir, []).code).toBe(0);
    for (const args of spellings) {
      const r = guard(dir, args);
      expect({ args, code: r.code }).toEqual({ args, code: 0 });
    }
    expect(guard(dir, ["origin", "main"]).stdout).toContain("push to main allowed");
  });

  test("1b. a failed last run is named, and --json carries the decision", () => {
    const dir = withRemote("guard-red", { version: 1, mode: "block", checks: [{ name: "api", run: "exit 1" }] });
    writeFiles(dir, { "b.txt": "b" });
    commitAll(sb, dir, "b");
    expect(gate(sb, dir, []).code).toBe(1);
    const r = gate(sb, dir, ["guard", "push", "--cwd", dir, "--json", "--", "origin", "main"]);
    expect(r.code).toBe(1);
    const j = JSON.parse(r.stdout) as { decision: string; next: string; targets: { reason: string }[] };
    expect(j.decision).toBe("deny");
    expect(j.targets[0]?.reason).toBe("last run failed at api");
    expect(j.next).toBe(`cd ${dir} && gate`);
  });

  test("2. a push that can't reach a protected branch is allowed", () => {
    const dir = withRemote("guard-unprotected", BLOCK);
    must(dir, "git checkout -qb feature", sb.env);
    writeFiles(dir, { "wip.txt": "no gate run" });
    commitAll(sb, dir, "wip");
    must(dir, "git tag v1.0", sb.env);
    for (const args of [[], ["origin", "feature"], ["origin", "feature:staging"], ["origin", "--delete", "main"], ["origin", "v1.0"], ["origin", ":main"], ["--tags"]]) {
      const r = guard(dir, args);
      expect({ args, code: r.code, out: r.stdout }).toEqual({ args, code: 0, out: r.stdout });
    }
    must(dir, "git checkout -q main && git merge -q feature", sb.env);
    expect(guard(dir, ["origin", "main:staging"]).code).toBe(0);
    expect(guard(dir, ["origin", "main"]).code).toBe(1);
  });

  test("3. nothing new to push (the remote-tracking ref is already at the commit) is allowed without a receipt", () => {
    const dir = withRemote("guard-nothing", BLOCK);
    writeFiles(dir, { "b.txt": "b" });
    commitAll(sb, dir, "b");
    expect(guard(dir, ["origin", "main"]).code).toBe(1);
    remoteCatchUp(dir);
    expect(guard(dir, ["origin", "main"]).code).toBe(0);
    expect(guard(dir, []).code).toBe(0);
  });

  test("4. report mode allows with the would-deny line; the background run starts once", async () => {
    const dir = withRemote("guard-report", { version: 1, mode: "report", checks: [{ name: "ok", run: "sleep 1" }] });
    writeFiles(dir, { "b.txt": "b" });
    commitAll(sb, dir, "b");
    const first = guard(dir, ["origin", "main"]);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("report mode · ");
    expect(first.stdout).toContain(": no receipt: gate hasn't passed this commit · push allowed");
    expect(first.stdout).not.toContain("block");
    expect(first.stdout).toContain("gate started in the background");
    const second = guard(dir, ["origin", "main"]);
    expect(second.code).toBe(0);
    expect(second.stdout).not.toContain("started in the background");
    const history = join(dir, ".git", "gate", "history.jsonl");
    await waitFor(() => readHistory(history).some((h) => h.trigger === "push"), 30_000, "the background run");
    expect(guard(dir, ["origin", "main"]).stdout).toMatch(/report mode · [0-9a-f]{7} passed · push allowed/);
    await Bun.sleep(1500);
    expect(readHistory(history).filter((h) => h.trigger === "push").length).toBe(1);
  });

  test("5. weakening a block-mode remote is denied; gate allow-weaken lets that one sha through", () => {
    const dir = withRemote("guard-weaken", BLOCK);
    const reset = (): void => void must(dir, "git checkout -q -B main origin/main", sb.env);

    writeFiles(dir, { "gate.json": JSON.stringify({ ...BLOCK, mode: "report" }) });
    commitAll(sb, dir, "flip to report");
    let r = guard(dir, ["origin", "main"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("this push weakens the gate (mode block → report). That is the repo owner's call.");
    expect(r.stdout).toContain("gate allow-weaken --sha");
    const flipped = must(dir, "git rev-parse HEAD", sb.env).trim();
    expect(gate(sb, dir, ["allow-weaken", "--sha", flipped]).code).toBe(2);
    expect(gate(sb, dir, ["allow-weaken", "--sha", flipped, "--why", "owner: flip it, it's an experiment"]).code).toBe(0);
    expect(guard(dir, ["origin", "main"]).code).toBe(0);
    must(dir, "git commit -q --amend -m 'flip to report, reworded'", sb.env);
    expect(guard(dir, ["origin", "main"]).code).toBe(1);
    reset();

    rmSync(join(dir, "gate.json"));
    commitAll(sb, dir, "delete gate.json");
    r = guard(dir, ["origin", "main"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("deletes gate.json");
    reset();

    writeFiles(dir, { "gate.json": JSON.stringify({ ...BLOCK, checks: [{ name: "types", run: "true" }] }) });
    commitAll(sb, dir, "drop rules");
    expect(gate(sb, dir, []).code).toBe(0);
    r = guard(dir, ["origin", "main"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("drops check rules");
    expect(gate(sb, dir, ["allow-weaken", "--sha", "HEAD", "--why", "owner: rules moved into api"]).code).toBe(0);
    expect(guard(dir, ["origin", "main"]).code).toBe(0);
  });

  test("6. no gate.json at the pushed commit is allowed, fast", () => {
    const dir = withRemote("guard-none", undefined);
    writeFiles(dir, { "b.txt": "b" });
    commitAll(sb, dir, "b");
    guard(dir, ["origin", "main"]); // warm the file cache
    const t0 = performance.now();
    const r = guard(dir, ["origin", "main"]);
    const ms = Math.round(performance.now() - t0);
    console.log(`guard push, ungated repo: ${ms}ms (node launcher + bun + git)`);
    expect(r.code).toBe(0);
    expect(ms).toBeLessThan(2000);
  });

  test("7. arguments it can't read exit 2, never 1", () => {
    const dir = withRemote("guard-garbage", BLOCK);
    writeFiles(dir, { "b.txt": "b" });
    commitAll(sb, dir, "b");
    for (const args of [["--frobnicate"], ["origin", "nosuchbranch"], ["-Z", "origin"], ["--repo"], ["origin", "refs/heads/*"], ["--all", "origin", "main"]]) {
      const r = guard(dir, args);
      expect({ args, code: r.code }).toEqual({ args, code: 2 });
      expect(r.stdout).toContain("couldn't read this push");
    }
    expect(gate(sb, dir, ["guard", "push", "--cwd", join(sb.dir), "--", "origin", "main"]).code).toBe(2);
    expect(gate(sb, dir, ["guard", "pull", "--cwd", dir]).code).toBe(2);
  });
});
