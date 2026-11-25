// gate.json: the zod schema and its parse. Unknown keys are errors (exit 2) so a
// typo can't silently disable something.

import { z } from "zod";
import { usage } from "./errors.ts";

export const DEFAULT_BRANCHES = ["main", "master"];
export const DEFAULT_TIMEOUT_S = 600;

const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an environment variable name");
const relPath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith("/") && !p.split(/[\\/]/).includes(".."), "must be a path inside the repo");

const CheckSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]*$/, "must match ^[a-z][a-z0-9-]*$"),
    run: z.string().min(1),
    cwd: relPath.optional(),
    timeout: z.number().positive().optional(),
    skips: z.enum(["fail", "allow"]).optional(),
  })
  .strict();

const DatabaseSchema = z
  .object({
    env: envName,
    migrate: z.string().min(1).optional(),
    key: z.array(relPath).optional(),
  })
  .strict();

const ProbeSchema = z
  .object({
    include: z.array(z.string()),
    exclude: z.array(z.object({ path: z.string(), why: z.string() }).strict()).optional(),
    /** gate probe passes at or above this catch rate (default 0.9) */
    minRate: z.number().min(0).max(1).optional(),
    /** globs where any missed bug fails the probe: sign-in, permissions, money, data writes */
    critical: z.array(z.string()).optional(),
  })
  .strict();

const RESERVED = new Set(["setup"]);

export const GateConfigSchema = z
  .object({
    version: z.literal(1),
    mode: z.enum(["report", "block"]),
    branches: z.array(z.string().min(1)).default(DEFAULT_BRANCHES),
    copy: z
      .object({
        env: z.array(relPath).default([".env"]),
        keep: z.array(z.string().regex(/^[^/\\]+$/, "must be a directory name, not a path")).default(["node_modules"]),
      })
      .strict()
      .default({ env: [".env"], keep: ["node_modules"] }),
    setup: z.array(z.string().min(1)).default([]),
    databases: z.array(DatabaseSchema).default([]),
    ports: z.array(envName).default([]),
    pass: z.array(envName).default([]),
    checks: z.array(CheckSchema).min(1, "needs at least one check"),
    probe: ProbeSchema.optional(),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const names = new Set<string>();
    for (const [i, c] of cfg.checks.entries()) {
      if (names.has(c.name)) ctx.addIssue({ code: "custom", path: ["checks", i, "name"], message: `duplicate check name "${c.name}"` });
      if (RESERVED.has(c.name)) ctx.addIssue({ code: "custom", path: ["checks", i, "name"], message: `"${c.name}" is reserved for gate's own step` });
      names.add(c.name);
    }
    const vars = new Set<string>();
    for (const [i, v] of [...cfg.databases.map((d) => d.env), ...cfg.ports].entries()) {
      if (vars.has(v)) ctx.addIssue({ code: "custom", path: ["databases"], message: `${v} is set twice (databases/ports #${i})` });
      vars.add(v);
    }
  });

export type GateConfig = z.infer<typeof GateConfigSchema>;
export type GateCheck = GateConfig["checks"][number];
export type GateDatabase = GateConfig["databases"][number];

/** Parse gate.json text. `where` names it in errors ("gate.json at 4f2c91a"). Throws GateError(2). */
export function parseConfig(text: string, where: string): GateConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw usage(`${where} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (raw && typeof raw === "object" && "version" in raw && raw.version !== 1) {
    throw usage(`${where} has version ${JSON.stringify(raw.version)}; this gate reads version 1. Update gate, or set "version": 1`);
  }
  const parsed = GateConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.length ? i.path.join(".") : "(top level)"}: ${i.message}`);
    throw usage(`${where} is invalid:\n${lines.join("\n")}\nFix gate.json and run gate again`);
  }
  return parsed.data;
}

export function checkTimeout(c: GateCheck): number {
  return c.timeout ?? DEFAULT_TIMEOUT_S;
}
