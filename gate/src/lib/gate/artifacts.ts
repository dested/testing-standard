// Test detail a log can't carry: the steps a Playwright test took, its full
// error, stdout, and its screenshots (plus trace and video when it failed).
// While a check runs under gate (a run, a probe's baseline; never a planted
// bug), `$GATE_ARTIFACTS` is `<work root>/runs/<run>/artifacts/<check>/` and
// gate's own reporter (reporter/playwright.cjs) rides along through
// PW_TEST_REPORTER, so a repo changes nothing to get it. The log stays the
// source of every result: this only adds detail (decisions.md 2026-11-22).
//
// Disk: `results.jsonl` is small and kept with the run; the files beside it
// (images, traces, videos) only in the newest KEEP_ARTIFACT_RUNS runs that
// have any. PNG screenshots are re-encoded as WebP when ffmpeg is on PATH.

import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const ARTIFACTS_ENV = "GATE_ARTIFACTS";
export const PLAYWRIGHT_REPORTER = fileURLToPath(new URL("./reporter/playwright.cjs", import.meta.url));
export const KEEP_ARTIFACT_RUNS = 3;
const RESULTS = "results.jsonl";

export function artifactsDir(runDir: string, check: string): string {
  return join(runDir, "artifacts", check);
}

const StepSchema = z.object({
  t: z.string(),
  sub: z.string().optional(),
  p: z.string().optional(),
  c: z.string(),
  d: z.number(),
  ms: z.number(),
  err: z.string().optional(),
  line: z.number().optional(),
});
export type Step = z.infer<typeof StepSchema>;

const ResultSchema = z.object({
  v: z.literal(1),
  id: z.string(),
  file: z.string(),
  line: z.number(),
  column: z.number(),
  project: z.string(),
  title: z.string(),
  retry: z.number(),
  status: z.string(),
  expected: z.string(),
  ms: z.number(),
  at: z.string().optional(),
  steps: z.array(StepSchema),
  errors: z.array(z.object({ message: z.string(), snippet: z.string().optional(), line: z.number().optional(), file: z.string().optional() })),
  stdout: z.string(),
  stderr: z.string(),
  attachments: z.array(z.object({ name: z.string(), type: z.string(), file: z.string() })),
});
export type ArtifactResult = z.infer<typeof ResultSchema>;

export interface TestArtifacts {
  /** the last attempt */
  last: ArtifactResult;
  attempts: number;
  /** the folder `file`s in attachments are relative to */
  dir: string;
}

export const artifactKey = (path: string, project: string, title: string): string => `${path}\0${project}\0${title}`;

/**
 * Every test's detail from one check of one run, keyed by repo-relative path, project and title (as
 * `gate tests` names them). `treePrefix` is the clean copy's root plus `/`, stripped from the
 * absolute file the reporter wrote. Lines that don't parse are skipped.
 */
export function readArtifacts(runDir: string, check: string, treePrefix: string): Map<string, TestArtifacts> {
  const dir = artifactsDir(runDir, check);
  const out = new Map<string, TestArtifacts>();
  const file = join(dir, RESULTS);
  if (!existsSync(file)) return out;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    if (!raw.trim()) continue;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      continue;
    }
    const p = ResultSchema.safeParse(json);
    if (!p.success) continue;
    const r = p.data;
    const path = r.file.startsWith(treePrefix) ? r.file.slice(treePrefix.length) : r.file;
    const key = artifactKey(path, r.project, r.title);
    const prev = out.get(key);
    if (!prev || r.retry >= prev.last.retry) out.set(key, { last: r, attempts: (prev?.attempts ?? 0) + 1, dir });
    else prev.attempts++;
  }
  return out;
}

/** Bytes under a folder. */
export function sizeOf(path: string): number {
  if (!existsSync(path)) return 0;
  const st = statSync(path);
  if (!st.isDirectory()) return st.size;
  let n = 0;
  for (const e of readdirSync(path)) n += sizeOf(join(path, e));
  return n;
}

/** The newest KEEP_ARTIFACT_RUNS runs with artifact files keep them; older runs keep only results.jsonl. */
export function pruneArtifacts(runsDir: string, keep: string): void {
  let runs: string[];
  try {
    runs = readdirSync(runsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
      .reverse();
  } catch {
    return;
  }
  let withFiles = 0;
  for (const run of runs) {
    const root = join(runsDir, run, "artifacts");
    if (!existsSync(root)) continue;
    const checks = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
    const heavy = checks.flatMap((c) => readdirSync(join(root, c.name), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(root, c.name, d.name)));
    if (!heavy.length) continue;
    withFiles++;
    if (withFiles <= KEEP_ARTIFACT_RUNS || run === keep) continue;
    for (const d of heavy) rmSync(d, { recursive: true, force: true });
  }
}

/**
 * Re-encode every PNG screenshot a check's tests attached as WebP (quality 80, at most 1280 px wide),
 * when ffmpeg is on PATH, and point results.jsonl at the new files. A phone screenshot at device
 * scale 3 is ~10× smaller. Anything that fails keeps its PNG.
 */
export async function slimArtifacts(dir: string): Promise<void> {
  const file = join(dir, RESULTS);
  const ffmpeg = Bun.which("ffmpeg");
  if (!ffmpeg || !existsSync(file)) return;
  const lines = readFileSync(file, "utf8").split("\n");
  const pngs = new Set<string>();
  for (const l of lines) for (const m of l.matchAll(/"file":"([^"]+\.png)"/g)) if (m[1]) pngs.add(m[1]);
  const done = new Set<string>();
  const queue = [...pngs];
  const worker = async (): Promise<void> => {
    for (let rel = queue.shift(); rel !== undefined; rel = queue.shift()) {
      const src = join(dir, rel);
      const to = src.replace(/\.png$/, ".webp");
      const p = Bun.spawn([ffmpeg, "-v", "error", "-y", "-i", src, "-vf", "scale='min(iw,1280)':-2", "-quality", "80", to], { stdout: "ignore", stderr: "ignore" });
      if ((await p.exited) === 0 && existsSync(to)) {
        rmSync(src, { force: true });
        done.add(rel);
      } else rmSync(to, { force: true });
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  if (!done.size) return;
  const swapped = lines.map((l) => l.replace(/"file":"([^"]+)\.png"/g, (all, base: string) => (done.has(`${base}.png`) ? `"file":"${base}.webp"` : all)).replace(/"type":"image\/png","file":"([^"]+)\.webp"/g, '"type":"image/webp","file":"$1.webp"'));
  writeFileSync(file, swapped.join("\n"));
}
