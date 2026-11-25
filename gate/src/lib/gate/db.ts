// Fresh databases per run. Hard rule: gate never drops, truncates or writes to
// a database whose name doesn't start with `gate_`; every drop goes through
// dropGateDatabase and every other write through assertGateName.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { parsePgUrl, withDatabase, type PgConn } from "../pgurl.ts";
import { adminQuery, adminRows } from "../pgadmin.ts";
import type { GateDatabase } from "./config.ts";
import { broken, errMsg } from "./errors.ts";
import { lookupVar } from "./env.ts";
import { runIdTime } from "./runid.ts";

const SAFE_NAME = /^gate_[a-z0-9_]+$/;

/** Throws unless `name` is a database gate is allowed to touch. */
export function assertGateName(name: string): void {
  if (!SAFE_NAME.test(name) || name.length > 63) {
    throw new Error(`refusing to touch database "${name}": gate only drops or writes databases named gate_[a-z0-9_]+`);
  }
}

function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** The one function every drop goes through. */
export async function dropGateDatabase(server: PgConn, name: string): Promise<void> {
  assertGateName(name);
  await adminQuery(server, server.ssl, [`DROP DATABASE IF EXISTS ${ident(name)} WITH (FORCE)`]);
}

export async function createGateDatabase(server: PgConn, name: string, template?: string): Promise<void> {
  assertGateName(name);
  if (template) assertGateName(template);
  await adminQuery(server, server.ssl, [`CREATE DATABASE ${ident(name)}${template ? ` TEMPLATE ${ident(template)}` : ""}`]);
}

/** Close every other connection to a gate database (the harness may use it as a TEMPLATE source). */
export async function closeConnections(server: PgConn, name: string): Promise<void> {
  assertGateName(name);
  await adminQuery(server, server.ssl, [
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid()`,
  ]);
}

/** Databases on the server whose name starts with `prefix` (validated, so inlined safely). */
export async function listByPrefix(server: PgConn, prefix: string): Promise<string[]> {
  if (!/^gate_[a-z0-9_]*$/.test(prefix)) throw new Error(`bad prefix ${prefix}`);
  const rows = await adminRows<{ datname: string }>(server, server.ssl, `SELECT datname FROM pg_database WHERE starts_with(datname, '${prefix}') ORDER BY datname`);
  return rows.map((r) => r.datname);
}

export async function databaseExists(server: PgConn, name: string): Promise<boolean> {
  return (await listByPrefix(server, name)).includes(name);
}

/** `postgres://user:***@host:port/db` */
export function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    u.search = "";
    return u.toString();
  } catch {
    return "(unparseable url)";
  }
}

export function runDbName(slug: string, run: string, n: number): string {
  return `gate_${slug}_${run}_${n}`;
}

export function runPrefix(slug: string, run: string): string {
  return `gate_${slug}_${run}_`;
}

export function templatePrefix(slug: string, n: number): string {
  return `gate_tpl_${slug}_${n}_`;
}

/** Hash the `key` paths' contents (and the migrate command) into 12 hex chars. */
export function keyHash(root: string, keys: string[], migrate: string): string {
  const h = createHash("sha256");
  h.update(`migrate\0${migrate}\0`);
  const walk = (rel: string): void => {
    const abs = join(root, rel);
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      h.update(`missing\0${rel}\0`);
      return;
    }
    if (st.isSymbolicLink()) {
      h.update(`link\0${rel}\0${readlinkSync(abs)}\0`);
    } else if (st.isDirectory()) {
      for (const name of readdirSync(abs).sort()) walk(rel ? `${rel}/${name}` : name);
    } else if (st.isFile()) {
      h.update(`file\0${rel}\0`);
      h.update(readFileSync(abs));
      h.update("\0");
    }
  };
  for (const k of [...keys].sort()) walk(k.replace(/\/+$/, ""));
  return h.digest("hex").slice(0, 12);
}

export interface DbPlan {
  index: number;
  env: string;
  server: PgConn;
  name: string;
  /** what the env var is set to inside every command */
  url: string;
  migrate?: string;
  key?: string[];
  /** set once the template is known */
  template?: { name: string; hit: boolean };
}

/** Resolve each entry's server and run database name. Missing var → exit 3. */
export function planDatabases(entries: GateDatabase[], caller: NodeJS.ProcessEnv, top: string, envFiles: string[], slug: string, run: string): DbPlan[] {
  return entries.map((d, index) => {
    const found = lookupVar(caller, top, envFiles, d.env);
    if (!found) {
      const read = envFiles.map((f) => `${join(top, f)}${existsSync(join(top, f)) ? "" : " (missing)"}`).join(", ") || "none";
      throw broken(`databases[${index}]: ${d.env} isn't set, so gate doesn't know which Postgres server to use. Read: the environment, ${read}. Set ${d.env} in .env (or export it)`);
    }
    let server: PgConn;
    try {
      server = parsePgUrl(found.value);
    } catch {
      throw broken(`databases[${index}]: ${d.env} from ${found.from} isn't a postgres:// URL. Fix it in ${found.from}`);
    }
    const name = runDbName(slug, run, index);
    return { index, env: d.env, server, name, url: withDatabase(server, name).url, migrate: d.migrate, key: d.key };
  });
}

export function serverLabel(server: PgConn): string {
  return `${server.host}:${server.port}`;
}

/** Wrap a pg failure as exit 3 with what to do next. */
export function pgBroken(server: PgConn, env: string, what: string, err: unknown): Error {
  return broken(`couldn't ${what} on Postgres ${maskUrl(server.url)} (from ${env}): ${errMsg(err)}. Start Postgres, or check the user can CREATE DATABASE (gate doctor)`);
}

/** Distinct servers, one entry each. */
export function distinctServers(plans: DbPlan[]): PgConn[] {
  const seen = new Map<string, PgConn>();
  for (const p of plans) seen.set(`${p.server.host}:${p.server.port}:${p.server.user}`, p.server);
  return [...seen.values()];
}

/** Drop every database of this run on each server. Returns names it couldn't drop. */
export async function dropRun(plans: DbPlan[], slug: string, run: string): Promise<string[]> {
  const failed: string[] = [];
  for (const server of distinctServers(plans)) {
    let names: string[];
    try {
      names = await listByPrefix(server, runPrefix(slug, run));
    } catch {
      failed.push(`${runPrefix(slug, run)}* on ${serverLabel(server)}`);
      continue;
    }
    for (const n of names) {
      try {
        await dropGateDatabase(server, n);
      } catch {
        failed.push(n);
      }
    }
  }
  return failed;
}

const STALE_MS = 6 * 60 * 60 * 1000;

/** Drop `gate_<slug>_<run>_…` databases of dead runs older than 6 hours. Best effort. */
export async function sweepStale(plans: DbPlan[], slug: string, liveRuns: Set<string>, now = Date.now()): Promise<string[]> {
  const dropped: string[] = [];
  const pattern = new RegExp(`^gate_${slug}_([a-z0-9]{8})_`);
  for (const server of distinctServers(plans)) {
    let names: string[];
    try {
      names = await listByPrefix(server, `gate_${slug}_`);
    } catch {
      continue;
    }
    for (const n of names) {
      const run = pattern.exec(n)?.[1];
      if (!run || liveRuns.has(run)) continue;
      const t = runIdTime(run);
      if (t === null || now - t < STALE_MS) continue;
      try {
        await dropGateDatabase(server, n);
        dropped.push(n);
      } catch {
        // someone still holds it; the next sweep tries again
      }
    }
  }
  return dropped;
}
