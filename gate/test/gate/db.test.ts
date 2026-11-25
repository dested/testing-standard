// Databases on the real local Postgres: the env every check gets, fresh
// migrated databases, cleanup on pass / fail / SIGTERM, the template cache,
// the gate_ safety rule. Postgres unreachable → these fail, never skip.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertGateName, dropGateDatabase } from "../../src/lib/gate/db.ts";
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
  requirePostgres,
  sandbox,
  templatesFor,
  uniq,
  waitFor,
  writeFiles,
} from "./helpers.ts";

setDefaultTimeout(90_000);

const sb = sandbox();
let server: PgConn;
const repos: string[] = [];

beforeAll(async () => {
  server = await requirePostgres();
});

afterAll(async () => {
  for (const r of repos) await dropAllFor(server, r).catch(() => {});
  sb.cleanup();
});

function repo(name: string, files: Record<string, string>, cfg: object, dotenv: string): string {
  const dir = makeRepo(sb, uniq(name), files, cfg);
  writeFiles(dir, { ".env": dotenv });
  repos.push(dir);
  return dir;
}

interface JsonRun {
  ok: boolean;
  run: string;
  logs: Record<string, string>;
}

function runJson(dir: string, args: string[] = [], env: Record<string, string> = {}): { code: number; json: JsonRun } {
  const r = gate(sb, dir, ["--json", ...args], { env });
  try {
    return { code: r.code, json: JSON.parse(r.stdout) as JsonRun };
  } catch {
    throw new Error(`gate --json printed no JSON (exit ${r.code}): ${r.stdout}\n${r.stderr}`);
  }
}

const log = (j: JsonRun, check: string): string => readFileSync(j.logs[check] ?? "", "utf8");

describe("databases", () => {
  test("5. env: DATABASE_URL in .env is overridden by the gate database; caller vars outside pass are absent", () => {
    const dev = `devdb_${Math.random().toString(36).slice(2, 8)}`;
    const dir = repo(
      "gt-env",
      {
        "check.ts": `import { SQL } from "bun";\nconst sql = new SQL(process.env.DATABASE_URL!);\nconst [row] = await sql\`select current_database() as db\`;\nconsole.log("bun-env=" + new URL(process.env.DATABASE_URL!).pathname.slice(1));\nconsole.log("connected=" + row.db);\nawait sql.close();\n`,
      },
      {
        version: 1,
        mode: "block",
        databases: [{ env: "DATABASE_URL" }],
        pass: ["GATE_TEST_PASSED"],
        checks: [
          { name: "bun", run: "bun check.ts" },
          { name: "node", run: `node --env-file=.env -e "console.log('node-env=' + new URL(process.env.DATABASE_URL).pathname.slice(1))"` },
          { name: "vars", run: `echo "secret=\${GATE_TEST_SECRET:-absent} passed=\${GATE_TEST_PASSED:-absent} gate=$GATE check=$GATE_CHECK color=$NO_COLOR"` },
        ],
      },
      `DATABASE_URL=${devUrl(server, dev)}\n`,
    );
    const { code, json } = runJson(dir, [], { GATE_TEST_SECRET: "leaked", GATE_TEST_PASSED: "yes" });
    expect(code).toBe(0);
    const want = `gate_${slugOf(dir)}_${json.run}_0`;
    expect(log(json, "bun")).toContain(`bun-env=${want}`);
    expect(log(json, "bun")).toContain(`connected=${want}`);
    expect(log(json, "node")).toContain(`node-env=${want}`);
    expect(log(json, "vars")).toContain("secret=absent passed=yes gate=1 check=vars color=1");
  });

  test("6. the database exists and is migrated; a harness copy is dropped; nothing is left on pass, fail or SIGTERM", async () => {
    const marker = join(sb.dir, uniq("sigterm-marker"));
    const migrate = `psql "$DATABASE_URL" -qc 'create table items(id int)'`;
    const cfg = (extra: object[]) => ({
      version: 1,
      mode: "block",
      databases: [{ env: "DATABASE_URL", migrate }],
      checks: [
        { name: "migrated", run: `psql "$DATABASE_URL" -tAc 'select count(*) from items' | grep -qx 0` },
        // Making <db>_w1 from the run database proves it has no open connections, too.
        { name: "harness", run: `db=\${DATABASE_URL##*/}; psql "\${DATABASE_URL%/*}/postgres" -qc "create database \${db}_w1 template \${db}"` },
        ...extra,
      ],
    });
    const dir = repo("gt-db", {}, cfg([]), `DATABASE_URL=${devUrl(server, "devdb_unused")}\n`);
    const pass = runJson(dir);
    expect(pass.code).toBe(0);
    expect(await gateDbsFor(server, dir)).toEqual([]);

    writeFiles(dir, { "gate.json": JSON.stringify(cfg([{ name: "red", run: "exit 1" }])) });
    commitAll(sb, dir, "red");
    const fail = runJson(dir);
    expect(fail.code).toBe(1);
    expect(await gateDbsFor(server, dir)).toEqual([]);

    writeFiles(dir, { "gate.json": JSON.stringify(cfg([{ name: "hang", run: `echo $GATE_RUN > ${marker}; sleep 60` }])) });
    commitAll(sb, dir, "hang");
    const run = gateAsync(sb, dir, []);
    await waitFor(() => existsSync(marker) && readFileSync(marker, "utf8").trim().length === 8, 30_000, "the hanging check to start");
    expect((await gateDbsFor(server, dir)).length).toBeGreaterThan(0);
    run.child.kill("SIGTERM");
    const done = await run.done;
    expect(done.code).toBe(3);
    expect(done.stdout).toContain("interrupted by SIGTERM");
    expect(await gateDbsFor(server, dir)).toEqual([]);
  });

  test("6b. the drop function refuses any name that doesn't start with gate_", async () => {
    for (const bad of ["postgres", "devdb", "template1", "gatex_1", 'gate_x"; drop database postgres; --', "GATE_upper"]) {
      expect(() => assertGateName(bad)).toThrow(/refusing/);
      await expect(dropGateDatabase(server, bad)).rejects.toThrow(/refusing/);
    }
    expect(() => assertGateName("gate_ok_abc12345_0")).not.toThrow();
  });

  test("7. template cache: the same key content skips migrate; a change under key migrates again", () => {
    const marks = join(sb.dir, uniq("migrate-count"));
    writeFileSync(marks, "");
    const dir = repo(
      "gt-tpl",
      { "schema/one.sql": "create table items(id int);\n" },
      {
        version: 1,
        mode: "block",
        databases: [{ env: "DATABASE_URL", migrate: `echo migrated >> ${marks} && psql "$DATABASE_URL" -qf schema/one.sql`, key: ["schema"] }],
        checks: [{ name: "table", run: `psql "$DATABASE_URL" -tAc 'select count(*) from items'` }],
      },
      `DATABASE_URL=${devUrl(server, "devdb_unused")}\n`,
    );
    const lines = (): number => readFileSync(marks, "utf8").split("\n").filter(Boolean).length;
    expect(runJson(dir).code).toBe(0);
    expect(lines()).toBe(1);
    const second = gate(sb, dir, []);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("from the template cache");
    expect(lines()).toBe(1);

    writeFiles(dir, { "schema/one.sql": "create table items(id int, name text);\n" });
    commitAll(sb, dir, "schema change");
    expect(runJson(dir).code).toBe(0);
    expect(lines()).toBe(2);
    return templatesFor(server, dir).then((t) => expect(t.length).toBe(1));
  });

  test("never prints a database password or a value from the copied .env", () => {
    const dir = repo(
      "gt-mask",
      {},
      { version: 1, mode: "block", databases: [{ env: "DATABASE_URL" }], checks: [{ name: "leak", run: `cat .env; echo "$DATABASE_URL"; exit 1` }] },
      `DATABASE_URL=${devUrl(server, "devdb_unused")}\nAPI_TOKEN=tok_supersecret_1234\n`,
    );
    const r = gate(sb, dir, []);
    expect(r.code).toBe(1);
    expect(r.stdout).not.toContain("tok_supersecret_1234");
    if (server.password.length >= 6) expect(r.stdout).not.toContain(server.password);
    expect(r.stdout).toContain("API_TOKEN=***");
  });

  test("no server for a databases entry exits 3 and names the var and the files read", () => {
    const dir = makeRepo(sb, uniq("gt-nodb"), {}, { version: 1, mode: "block", databases: [{ env: "DATABASE_URL" }], checks: [{ name: "ok", run: "true" }] });
    const r = gate(sb, dir, []);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("DATABASE_URL isn't set");
    expect(r.stderr).toContain(".env (missing)");
  });
});
