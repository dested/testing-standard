// Receipts (one per passing tree, HMAC-signed with the machine key) and the
// history log (one line per run of any kind), both under `<git common dir>/gate`.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { broken } from "./errors.ts";
import { keyPath } from "./paths.ts";

const CountsSchema = z.object({
  passed: z.number(),
  failed: z.number(),
  skipped: z.number(),
  todo: z.number(),
  flaky: z.number(),
  didNotRun: z.number(),
});

export const ReceiptSchema = z.object({
  v: z.literal(1),
  tree: z.string(),
  sha: z.string(),
  ok: z.literal(true),
  at: z.string(),
  ms: z.number(),
  run: z.string(),
  gate: z.string(),
  checks: z.array(z.object({ name: z.string(), ok: z.boolean(), ms: z.number(), exit: z.number().nullable(), counts: CountsSchema.optional() })),
  flaky: z.array(z.string()),
  sig: z.string(),
});
export type Receipt = z.infer<typeof ReceiptSchema>;
export type UnsignedReceipt = Omit<Receipt, "sig">;

export const HistorySchema = z.object({
  at: z.string(),
  run: z.string(),
  sha: z.string(),
  tree: z.string(),
  mode: z.enum(["report", "block"]),
  trigger: z.enum(["manual", "push", "probe"]),
  dirty: z.boolean(),
  only: z.array(z.string()).nullable(),
  ok: z.boolean(),
  ms: z.number(),
  checks: z.array(z.object({ name: z.string(), ok: z.boolean(), ms: z.number(), counts: CountsSchema.optional(), reason: z.string().optional() })),
});
export type HistoryLine = z.infer<typeof HistorySchema>;

/** The machine key: 32 random bytes, mode 0600, made on first use. */
export function machineKey(create = true): Buffer | null {
  const path = keyPath();
  if (!existsSync(path)) {
    if (!create) return null;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(path, randomBytes(32), { flag: "wx", mode: 0o600 });
    } catch (err) {
      if (!(err instanceof Error && "code" in err && err.code === "EEXIST")) {
        throw broken(`couldn't create the gate key at ${path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    chmodSync(path, 0o600);
  }
  const key = readFileSync(path);
  if (key.length !== 32) throw broken(`the gate key at ${path} isn't 32 bytes. Delete it to make a new one (every receipt becomes invalid)`);
  return key;
}

/** JSON with object keys sorted at every level: the bytes the signature covers. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sign(body: UnsignedReceipt, key: Buffer): string {
  return createHmac("sha256", key).update(canonicalJson(body)).digest("hex");
}

export function receiptPath(receiptsDir: string, tree: string): string {
  return join(receiptsDir, `${tree}.json`);
}

export function writeReceipt(receiptsDir: string, body: UnsignedReceipt): Receipt {
  const key = machineKey();
  if (!key) throw broken("no gate key");
  const receipt: Receipt = { ...body, sig: sign(body, key) };
  mkdirSync(receiptsDir, { recursive: true });
  const path = receiptPath(receiptsDir, body.tree);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(receipt, null, 2)}\n`);
  renameSync(tmp, path);
  return receipt;
}

/** A receipt for `tree` whose signature verifies, else null (edited, unsigned, other machine). */
export function readReceipt(receiptsDir: string, tree: string): Receipt | null {
  const path = receiptPath(receiptsDir, tree);
  if (!existsSync(path)) return null;
  const key = machineKey(false);
  if (!key) return null;
  let parsed;
  try {
    parsed = ReceiptSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
  if (!parsed.success || parsed.data.tree !== tree) return null;
  const { sig, ...body } = parsed.data;
  const want = Buffer.from(sign(body, key), "hex");
  const got = Buffer.from(sig, "hex");
  return want.length === got.length && timingSafeEqual(want, got) ? parsed.data : null;
}

export function appendHistory(historyPath: string, line: HistoryLine): void {
  mkdirSync(dirname(historyPath), { recursive: true });
  appendFileSync(historyPath, `${JSON.stringify(line)}\n`);
}

export function readHistory(historyPath: string): HistoryLine[] {
  if (!existsSync(historyPath)) return [];
  const out: HistoryLine[] = [];
  for (const raw of readFileSync(historyPath, "utf8").split("\n")) {
    if (!raw.trim()) continue;
    try {
      const p = HistorySchema.safeParse(JSON.parse(raw));
      if (p.success) out.push(p.data);
    } catch {
      // a torn line from a killed run: skip it
    }
  }
  return out;
}

/** The newest full (non-dirty, non-only, non-probe) run of a tree. */
export function lastFullRun(history: HistoryLine[], tree: string): HistoryLine | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h && h.tree === tree && !h.dirty && !h.only && h.trigger !== "probe") return h;
  }
  return null;
}

export function failedAt(h: HistoryLine): string | null {
  return h.ok ? null : (h.checks.find((c) => !c.ok)?.name ?? "interrupted");
}
