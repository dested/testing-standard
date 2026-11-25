#!/bin/sh
# Regenerate test/gate/fixtures: real `bun test` and Playwright output, captured
# with the same NO_COLOR=1 FORCE_COLOR=0 env gate gives every check. Re-run after
# a Bun or Playwright upgrade, then `bun run test` in gate/ (the counts parser reads these).
# Scratch goes to $GATE_FX, else <tmp>/gate-fx (needs network once for @playwright/test).
set -eu
repo=$(cd "$(dirname "$0")/.." && pwd)
out="$repo/test/gate/fixtures"
fx="${GATE_FX:-${TMPDIR:-/tmp}/gate-fx}"
rm -rf "$fx" && mkdir -p "$fx/bt" "$fx/pw/tests" "$out"
export NO_COLOR=1 FORCE_COLOR=0 CI=1

cd "$fx/bt"
cat > skip.test.ts <<'T'
import { test, expect, describe } from "bun:test";
describe("math", () => {
  test("adds", () => expect(1 + 1).toBe(2));
  test.skip("subtracts later", () => expect(1).toBe(1));
});
T
cat > todo.test.ts <<'T'
import { test, expect } from "bun:test";
test("works", () => expect(1).toBe(1));
test.todo("write the edge case");
T
cat > fail.test.ts <<'T'
import { test, expect, describe } from "bun:test";
describe("posts.create", () => {
  test("accepts a signed-in caller", () => expect(1).toBe(1));
  test("rejects a signed-out caller", () => expect(401).toBe(403));
});
T
cat > pass.test.ts <<'T'
import { test, expect } from "bun:test";
test("one", () => expect(1).toBe(1));
test("two", () => expect(2).toBe(2));
T
cat > zero.test.ts <<'T'
import { describe } from "bun:test";
describe("nothing here", () => {});
T
for f in skip todo fail pass zero; do bun test "./$f.test.ts" > "$out/bun-$f.txt" 2>&1 || true; done
mkdir -p empty && (cd empty && bun test > "$out/bun-nofiles.txt" 2>&1 || true)

cd "$fx/pw"
echo '{"name":"pw","type":"module"}' > package.json
bun add -d @playwright/test > /dev/null 2>&1
cat > playwright.config.ts <<'T'
import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: "tests", retries: 1, workers: 1, reporter: process.env.PWREP ?? "list" });
T
cat > tests/skip.spec.ts <<'T'
import { test, expect } from "@playwright/test";
test("home loads", async () => { expect(1).toBe(1); });
test.skip("billing page", async () => {});
T
cat > tests/flaky.spec.ts <<'T'
import { test, expect } from "@playwright/test";
import { existsSync, writeFileSync } from "node:fs";
test("sometimes fails", async () => {
  const f = "/tmp/gate-pw-flaky-" + process.env.FLAKY_TAG;
  if (!existsSync(f)) { writeFileSync(f, "1"); expect(1).toBe(2); }
});
test("steady", async () => { expect(1).toBe(1); });
T
cat > tests/fail.spec.ts <<'T'
import { test, expect } from "@playwright/test";
test.describe("checkout", () => {
  test("rejects an empty cart", async () => { expect(200).toBe(400); });
  test("accepts a full cart", async () => { expect(1).toBe(1); });
});
T
cat > tests/dnr.spec.ts <<'T'
import { test, expect } from "@playwright/test";
test.describe.configure({ mode: "serial" });
test("first", async () => { expect(1).toBe(2); });
test("second", async () => { expect(1).toBe(1); });
T
cat > tests/skiponly.spec.ts <<'T'
import { test } from "@playwright/test";
test.skip("only skipped", async () => {});
T
for f in skip flaky fail dnr; do for rep in list line; do
  FLAKY_TAG="$f$rep$$" PWREP=$rep bunx playwright test "tests/$f.spec.ts" > "$out/pw-$f-$rep.txt" 2>&1 || true
done; done
PWREP=list bunx playwright test tests/skiponly.spec.ts > "$out/pw-skiponly-list.txt" 2>&1 || true
PWREP=list bunx playwright test tests/nonexistent.spec.ts > "$out/pw-zero-list.txt" 2>&1 || true
rm -f /tmp/gate-pw-flaky-*
echo "fixtures written to $out"
