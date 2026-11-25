// Preloaded for every test file (bunfig.toml): the whole suite must leave the machine's
// global git config byte-identical. gate never writes git config; this proves it.

import { afterAll } from "bun:test";
import { spawnSync } from "node:child_process";

function globalConfig(): string {
  const r = spawnSync("git", ["config", "--global", "-l"], { encoding: "utf8" });
  return `${r.status}\n${r.stdout}`;
}

const before = globalConfig();

afterAll(() => {
  const after = globalConfig();
  if (after !== before) {
    throw new Error(`the test run changed git config --global -l\n--- before\n${before}\n--- after\n${after}`);
  }
});
