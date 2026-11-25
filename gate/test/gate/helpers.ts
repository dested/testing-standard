// Test harness for gate: throwaway git repos in a temp sandbox, the real
// `bin/gate.mjs` entry, the local Postgres. Nothing here touches Sal's real
// git config (every git and gate call gets the sandbox's GIT_CONFIG_GLOBAL, and
// test/gate/preload.ts fails the run if `git config --global -l` changes) and
// nothing pushes.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { listByPrefix, dropGateDatabase } from "../../src/lib/gate/db.ts";
import { slugOf } from "../../src/lib/gate/paths.ts";
import { adminRows } from "../../src/lib/pgadmin.ts";
import { parsePgUrl, withDatabase, type PgConn } from "../../src/lib/pgurl.ts";

export const ROOT = resolve(import.meta.dir, "../..");
export const GATE_BIN = join(ROOT, "bin", "gate.mjs");
export const FIXTURES = join(import.meta.dir, "fixtures");

export interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Sandbox {
  dir: string;
  home: string;
  work: string;
  env: Record<string, string>;
  cleanup: () => void;
}

const CALLER_ONLY = ["GATE_TEST_PG_URL", "GATE_ALLOW_WEAKEN", "DATABASE_URL", "GATE_WORK", "GATE_HOME", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"];

export function sandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "gate-test-"));
  const home = join(dir, "gatehome");
  const work = join(dir, "work");
  const gitconfig = join(dir, "gitconfig");
  writeFileSync(gitconfig, "[user]\n\tname = gate test\n\temail = gate@test\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !CALLER_ONLY.includes(k)) env[k] = v;
  Object.assign(env, { GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: "1", GATE_HOME: home, GATE_WORK: work });
  return { dir, home, work, env, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function sh(cwd: string, cmd: string, env: Record<string, string>): Result {
  const r = spawnSync("/bin/sh", ["-c", cmd], { cwd, env, encoding: "utf8" });
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

export function must(cwd: string, cmd: string, env: Record<string, string>): string {
  const r = sh(cwd, cmd, env);
  if (r.code !== 0) throw new Error(`${cmd} failed (${r.code}): ${r.stderr}${r.stdout}`);
  return r.stdout;
}

export function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
}

/** A fresh repo with these files committed. `gate.json` may be an object. */
export function makeRepo(sb: Sandbox, name: string, files: Record<string, string>, gate?: object): string {
  const dir = join(sb.dir, name);
  mkdirSync(dir, { recursive: true });
  must(dir, "git init -q", sb.env);
  writeFiles(dir, { ".gitignore": ".env\n", ...files, ...(gate ? { "gate.json": `${JSON.stringify(gate, null, 2)}\n` } : {}) });
  must(dir, "git add -A && git commit -qm init", sb.env);
  return dir;
}

export function commitAll(sb: Sandbox, dir: string, msg: string): void {
  must(dir, `git add -A && git commit -qm ${JSON.stringify(msg)}`, sb.env);
}

export function gate(sb: Sandbox, cwd: string, args: string[], extra: { env?: Record<string, string>; input?: string } = {}): Result {
  const r = spawnSync("node", [GATE_BIN, ...args], { cwd, env: { ...sb.env, ...extra.env }, input: extra.input ?? "", encoding: "utf8" });
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

export function gateAsync(sb: Sandbox, cwd: string, args: string[]): { child: ChildProcess; done: Promise<Result> } {
  const child = spawn("node", [GATE_BIN, ...args], { cwd, env: sb.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
  const done = new Promise<Result>((res) => child.on("close", (code) => res({ code: code ?? 1, stdout, stderr })));
  return { child, done };
}

export async function waitFor(cond: () => boolean, ms: number, what: string): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (cond()) return;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ---- Postgres ----

/**
 * The Postgres the database tests use: `GATE_TEST_PG_URL` (set it in a
 * gitignored `gate/.env.test`, which bun test loads), else the `PG*` variables,
 * else postgres:postgres@localhost:5432.
 */
export function pgServer(): PgConn {
  const env = process.env;
  if (env.GATE_TEST_PG_URL) return withDatabase(parsePgUrl(env.GATE_TEST_PG_URL), "postgres");
  const u = new URL("postgres://localhost/postgres");
  u.hostname = env.PGHOST || "localhost";
  u.port = env.PGPORT || "5432";
  u.username = encodeURIComponent(env.PGUSER || "postgres");
  u.password = encodeURIComponent(env.PGPASSWORD ?? "postgres");
  return parsePgUrl(u.toString());
}

/** Fails (never skips) when the local Postgres can't be reached. */
export async function requirePostgres(): Promise<PgConn> {
  const server = pgServer();
  try {
    await adminRows(server, false, "SELECT 1");
  } catch (err) {
    throw new Error(
      `Postgres is unreachable at ${server.host}:${server.port} (GATE_TEST_PG_URL, else the PG* variables, else postgres:postgres@localhost:5432): ${err instanceof Error ? err.message : String(err)}. Start it: the database tests need it and never skip`,
    );
  }
  return server;
}

/** A dev DATABASE_URL on the local server (the database itself needn't exist). */
export function devUrl(server: PgConn, db: string): string {
  return withDatabase(server, db).url;
}

export async function gateDbsFor(server: PgConn, repoDir: string): Promise<string[]> {
  return listByPrefix(server, `gate_${slugOf(repoDir)}_`);
}

export async function templatesFor(server: PgConn, repoDir: string): Promise<string[]> {
  return listByPrefix(server, `gate_tpl_${slugOf(repoDir)}_`);
}

export async function dropAllFor(server: PgConn, repoDir: string): Promise<void> {
  for (const n of [...(await gateDbsFor(server, repoDir)), ...(await templatesFor(server, repoDir))]) await dropGateDatabase(server, n);
}

export function uniq(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}
