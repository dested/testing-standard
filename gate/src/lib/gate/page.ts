// `gate tests --html`: gather (report, probe coverage, what gate's Playwright
// reporter kept, each test's code at the commit its run checked), render,
// write `<work root>/tests.html`, open it in the Windows browser.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { findRepo, loadTarget, resolveCommit, type Repo } from "./context.ts";
import { showFile } from "./git.ts";
import { codeKey, detailKey, renderTestsPage, type ResultDetail, type TestCode } from "./html.ts";
import { probeCoverage } from "./probe/coverage.ts";
import { readArtifacts } from "./artifacts.ts";
import { testSpan } from "./source.ts";
import type { TestsReport } from "./tests.ts";
import { isWsl, linuxToWin } from "../platform.ts";

export interface WrittenPage {
  path: string;
  /** the same file as Windows opens it */
  win: string;
  opened: boolean;
  openError?: string;
}

const EXPLORER = "/mnt/c/Windows/explorer.exe";

/** The page in the person's browser: Windows' from WSL, else `open` (macOS) or `xdg-open` (Linux). */
function openPage(path: string, win: string): string | null {
  if (isWsl()) return openOnWindows(path, win);
  const opener = process.env.GATE_OPEN || Bun.which(process.platform === "darwin" ? "open" : "xdg-open");
  if (!opener) return "no browser opener (xdg-open) was found";
  try {
    const child = spawn(opener, [path], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function openOnWindows(path: string, win: string): string | null {
  // GATE_OPEN: tests point it at a recorder instead of a browser
  const winopen = process.env.GATE_OPEN || Bun.which("winopen") || (existsSync(EXPLORER) ? EXPLORER : null);
  if (!winopen) return "neither winopen nor explorer.exe was found";
  // explorer.exe wants the Windows path; winopen converts on its own
  const arg = winopen.endsWith("explorer.exe") ? win : path;
  try {
    const child = spawn(winopen, [arg], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Per test result, what gate's reporter recorded in the run its check's results come from. */
export function gatherDetails(repo: Repo, report: TestsReport): Record<string, ResultDetail> {
  const out: Record<string, ResultDetail> = {};
  const treePrefix = `${repo.paths.tree}/`;
  for (const c of report.checks) {
    if (!c.from) continue;
    const runDir = join(repo.paths.runs, c.from.run);
    const arts = readArtifacts(runDir, c.name, treePrefix);
    if (!arts.size) continue;
    for (const f of c.files)
      for (const t of f.tests) {
        const a = arts.get(detailKey(f.path, t.project, t.name));
        if (!a) continue;
        const images: ResultDetail["images"] = [];
        const files: ResultDetail["files"] = [];
        for (const x of a.last.attachments) {
          const abs = join(a.dir, x.file);
          if (!existsSync(abs)) continue; // pruned with an older run
          if (x.type.startsWith("image/")) images.push({ name: x.name, src: relative(repo.paths.work, abs).split("\\").join("/") });
          else files.push({ name: x.name, path: abs });
        }
        out[detailKey(f.path, t.project, t.name)] = {
          steps: a.last.steps,
          errors: a.last.errors.map((e) => ({ message: e.message.split(treePrefix).join(""), ...(e.snippet ? { snippet: e.snippet } : {}) })),
          stdout: a.last.stdout,
          stderr: a.last.stderr,
          images,
          files,
          attempts: a.attempts,
        };
      }
  }
  return out;
}

/** Every test's own code, from its file at the commit its check's run checked. */
export function gatherCode(repo: Repo, report: TestsReport): Record<string, TestCode> {
  const out: Record<string, TestCode> = {};
  const texts = new Map<string, string | null>();
  for (const c of report.checks) {
    const sha = c.from?.sha;
    if (!sha) continue;
    for (const f of c.files) {
      const key = `${sha}:${f.path}`;
      if (!texts.has(key)) texts.set(key, showFile(repo.top, sha, f.path));
      const text = texts.get(key);
      if (!text) continue;
      const lines = text.split("\n");
      for (const t of f.tests) {
        const k = codeKey(f.path, t.name);
        if (out[k]) continue;
        const line = Number(t.loc?.split(":")[0]) || undefined;
        const span = testSpan(text, line ? { line } : { name: t.name });
        if (!span) continue;
        out[k] = { sha, path: f.path, start: span.start, text: lines.slice(span.start - 1, span.end).join("\n") };
      }
    }
  }
  return out;
}

export function writeTestsPage(cwd: string, report: TestsReport, opts: { open: boolean }): WrittenPage {
  const repo = findRepo(cwd);
  const head = resolveCommit(repo, "HEAD");
  const target = loadTarget(repo, head);
  const html = renderTestsPage({
    report,
    coverage: probeCoverage(repo, head, target.cfg),
    at: new Date().toISOString(),
    details: gatherDetails(repo, report),
    code: gatherCode(repo, report),
  });
  mkdirSync(repo.paths.work, { recursive: true });
  const path = join(repo.paths.work, "tests.html");
  writeFileSync(path, html);
  const win = linuxToWin(path);
  if (!opts.open) return { path, win, opened: false };
  const err = openPage(path, win);
  return { path, win, opened: err === null, ...(err ? { openError: err } : {}) };
}
