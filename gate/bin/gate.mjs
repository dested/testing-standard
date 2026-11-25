#!/usr/bin/env node
// @ts-check
// The `gate` bin: a repo's checks on a clean copy of a commit, a signed receipt,
// the push guard. This small Node process runs `bun src/gate.ts` as a child, so
// the bin works from any shell, and passes the exit code through. SIGTERM and
// SIGHUP go on to the child so its own cleanup runs (a terminal's Ctrl+C already
// reaches the whole process group).

import { spawn } from "node:child_process";
import { constants } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") {
  console.error("gate runs on Linux, macOS and WSL: open a WSL shell in the repo and run gate there");
  process.exit(2);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

process.on("SIGINT", () => {});
const child = spawn("bun", [join(root, "src", "gate.ts"), ...process.argv.slice(2)], { stdio: "inherit" });
for (const sig of /** @type {const} */ (["SIGTERM", "SIGHUP"])) {
  process.on(sig, () => child.kill(sig));
}
child.on("error", (err) => {
  console.error(`gate: couldn't start bun (https://bun.sh): ${err.message}`);
  process.exit(3);
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1)));
