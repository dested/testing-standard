// The two admin calls gate makes against a Postgres server: create, drop and list
// its run databases. Both connect to the server's `postgres` database, falling
// back to `template1` on a server without one.

import pg from "pg";
import type { PgConn } from "./pgurl.ts";

const { Client } = pg;

function client(conn: PgConn, ssl: boolean, database: string): pg.Client {
  return new Client({
    host: conn.host,
    port: conn.port,
    user: conn.user,
    password: conn.password,
    database,
    ssl: ssl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 8000,
  });
}

/** Run admin statements (create/drop database etc.) against a maintenance database on the same server. */
export async function adminQuery(conn: PgConn, ssl: boolean, queries: string[], maintenanceDb = "postgres"): Promise<void> {
  const c = client(conn, ssl, maintenanceDb);
  try {
    await c.connect();
  } catch (err) {
    await c.end().catch(() => {});
    if (maintenanceDb === "postgres") return adminQuery(conn, ssl, queries, "template1");
    throw new Error(`Could not connect to maintenance database: ${msg(err)}`);
  }
  try {
    for (const q of queries) await c.query(q);
  } finally {
    await c.end().catch(() => {});
  }
}

/** Run one row-returning query against a maintenance database on the server. */
export async function adminRows<T = Record<string, unknown>>(conn: PgConn, ssl: boolean, sql: string, maintenanceDb = "postgres"): Promise<T[]> {
  const c = client(conn, ssl, maintenanceDb);
  try {
    await c.connect();
  } catch (err) {
    await c.end().catch(() => {});
    if (maintenanceDb === "postgres") return adminRows<T>(conn, ssl, sql, "template1");
    throw new Error(`Could not connect to ${conn.host}:${conn.port}: ${msg(err)}`);
  }
  try {
    const res = await c.query(sql);
    // pg types rows as any[]: this module is the typed boundary, and every caller names its row shape
    return res.rows as T[];
  } finally {
    await c.end().catch(() => {});
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
