// `gate init`: write a gate.json by reading package.json scripts. Default mode
// is report, so adopting the gate never blocks an existing repo.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { DEFAULT_BRANCHES, GateConfigSchema } from "./config.ts";
import { usage } from "./errors.ts";
import { parseDotenv } from "./env.ts";

const PackageSchema = z.object({ scripts: z.record(z.string(), z.string()).optional() }).passthrough();

type Pm = "bun" | "pnpm" | "yarn" | "npm";

function detectPm(top: string): { pm: Pm; setup: string | null } {
  if (existsSync(join(top, "bun.lock"))) return { pm: "bun", setup: "bun install --frozen-lockfile" };
  if (existsSync(join(top, "bun.lockb"))) return { pm: "bun", setup: null };
  if (existsSync(join(top, "pnpm-lock.yaml"))) return { pm: "pnpm", setup: "pnpm install --frozen-lockfile" };
  if (existsSync(join(top, "yarn.lock"))) return { pm: "yarn", setup: "yarn install --frozen-lockfile" };
  if (existsSync(join(top, "package-lock.json"))) return { pm: "npm", setup: "npm ci" };
  return { pm: "bun", setup: null };
}

// check name → script names, first match wins
const CHECKS: { name: string; scripts: string[]; timeout?: number }[] = [
  { name: "types", scripts: ["typecheck"] },
  { name: "rules", scripts: ["test:rules", "test"] },
  { name: "api", scripts: ["test:api"] },
  { name: "flows", scripts: ["test:flows", "test:e2e"], timeout: 900 },
];

export interface InitResult {
  path: string;
  json: string;
  wrote: string[];
  missing: string[];
}

export function initConfig(top: string, mode: "report" | "block", force: boolean): InitResult {
  const path = join(top, "gate.json");
  if (existsSync(path) && !force) throw usage(`${path} already exists. gate init --force overwrites it`);
  const pkgPath = join(top, "package.json");
  if (!existsSync(pkgPath)) throw usage(`no package.json in ${top}, so there are no scripts to read. Write gate.json by hand (features/gate.md has the shape)`);
  let scripts: Record<string, string>;
  try {
    scripts = PackageSchema.parse(JSON.parse(readFileSync(pkgPath, "utf8"))).scripts ?? {};
  } catch (err) {
    throw usage(`couldn't read ${pkgPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const { pm, setup } = detectPm(top);
  const runScript = (s: string): string => `${pm} run ${s}`;
  const wrote: string[] = [];
  const missing: string[] = [];

  const checks: { name: string; run: string; timeout?: number }[] = [];
  for (const c of CHECKS) {
    const script = c.scripts.find((s) => scripts[s] !== undefined);
    if (!script) {
      missing.push(`${c.name} (no ${c.scripts.join(" or ")} script)`);
      continue;
    }
    checks.push({ name: c.name, run: runScript(script), ...(c.timeout ? { timeout: c.timeout } : {}) });
    wrote.push(`${c.name}: ${runScript(script)}`);
  }
  if (!checks.length) throw usage(`found none of typecheck, test:rules, test, test:api, test:flows, test:e2e in ${pkgPath}. Add a script, or write gate.json by hand`);

  const databases: { env: string; migrate?: string; key?: string[] }[] = [];
  const envPath = join(top, ".env");
  if (existsSync(envPath) && parseDotenv(readFileSync(envPath, "utf8")).has("DATABASE_URL")) {
    const db: { env: string; migrate?: string; key?: string[] } = { env: "DATABASE_URL" };
    if (scripts["db:deploy"] !== undefined) {
      db.migrate = runScript("db:deploy");
      if (existsSync(join(top, "prisma"))) db.key = ["prisma"];
    } else {
      missing.push("migrate for DATABASE_URL (no db:deploy script): checks get an empty database");
    }
    databases.push(db);
    wrote.push(`databases: DATABASE_URL${db.migrate ? ` (migrate: ${db.migrate}${db.key ? `, cached on ${db.key.join(",")}` : ""})` : ""}`);
  }
  if (setup) wrote.push(`setup: ${setup}`);
  else missing.push("setup (no bun.lock / lockfile): add your install command to setup");

  const cfg = {
    version: 1,
    mode,
    branches: DEFAULT_BRANCHES,
    setup: setup ? [setup] : [],
    ...(databases.length ? { databases } : {}),
    checks,
  };
  GateConfigSchema.parse(cfg);
  const json = `${JSON.stringify(cfg, null, 2)}\n`;
  writeFileSync(path, json);
  return { path, json, wrote, missing };
}
