// Coverage maps: a repo's own "what does this cover" grids, without gate
// knowing the repo. While a check runs (gate run, a probe's baseline; never a
// planted bug), `$GATE_COVERAGE` is an empty folder kept with the run's logs:
// `<work root>/runs/<run>/coverage/<check>/`. A check may write any number of
// `<name>.json` files there, one map each, and `gate tests` (text, --json,
// --html) shows them from the run whose results it shows for that check.
// Outside gate the variable is unset: a check writes nothing.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const COVERAGE_ENV = "GATE_COVERAGE";

/** `true` covered · `false` a gap · `null` doesn't apply · a short text shown as is · or the long form. */
export const CellSchema = z.union([
  z.boolean(),
  z.null(),
  z.string().max(40),
  z.object({ ok: z.boolean(), text: z.string().max(40).optional(), by: z.array(z.string()).optional() }).strict(),
]);
export type Cell = z.infer<typeof CellSchema>;

export const CoverageMapSchema = z
  .object({
    title: z.string().min(1).max(80),
    columns: z.array(z.string().min(1)).min(1).max(24),
    rows: z
      .array(
        z
          .object({
            item: z.string().min(1),
            /** rows with the same group sit under one heading */
            group: z.string().optional(),
            cells: z.record(z.string(), CellSchema),
            /** test titles (as the runner names them) that cover this row */
            coveredBy: z.array(z.string()).optional(),
          })
          .strict(),
      )
      .max(5000),
  })
  .strict();
export type CoverageMap = z.infer<typeof CoverageMapSchema>;

export interface MapEntry {
  check: string;
  /** the run it came from */
  run: string;
  /** the file the check wrote, under the run's coverage folder */
  file: string;
  map?: CoverageMap;
  /** why the file isn't a map: bad JSON or the issues zod found */
  error?: string;
  /** rows with at least one `false` cell (or `{ok:false}`) */
  gaps?: number;
}

export function coverageDir(runDir: string, check: string): string {
  return join(runDir, "coverage", check);
}

export function cellOk(c: Cell | undefined): boolean | null {
  if (c === undefined || c === null) return null;
  if (typeof c === "boolean") return c;
  if (typeof c === "string") return null;
  return c.ok;
}

export function rowGaps(m: CoverageMap): number {
  return m.rows.filter((r) => m.columns.some((col) => cellOk(r.cells[col]) === false)).length;
}

/** Every map a check wrote in one run, valid or not, sorted by file name. */
export function readMaps(runDir: string, check: string, run: string): MapEntry[] {
  const dir = coverageDir(runDir, check);
  if (!existsSync(dir)) return [];
  const out: MapEntry[] = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    const file = join(dir, name);
    const base = { check, run, file };
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      out.push({ ...base, error: `not JSON: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    const p = CoverageMapSchema.safeParse(raw);
    if (p.success) out.push({ ...base, map: p.data, gaps: rowGaps(p.data) });
    else out.push({ ...base, error: p.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") });
  }
  return out;
}
