// gate's Playwright reporter. gate puts this file's path in PW_TEST_REPORTER
// for every check it runs with an artifacts folder ($GATE_ARTIFACTS), and
// Playwright appends it to the repo's own reporters: no repo change needed.
// It writes what a log can't carry, for `gate tests --html`:
//   results.jsonl   one line per attempt: title, file:line, status, time,
//                   the steps it took, the full error, stdout/stderr
//   <id>/...        that attempt's images (always; `screenshot: 'on'` in the
//                   repo's config makes one per test), and its trace, video
//                   and other files only when it failed
// The log stays the source of every result (decisions.md 2026-11-22): this
// only adds detail, and a run without it still reads in full.
// Plain CommonJS with no imports but Node's: Playwright loads it from outside
// the repo, with no TypeScript transform and no @playwright/test to import.

"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_STEPS = 400;
const MAX_TEXT = 16_000;
const MAX_SMALL_FILE = 512 * 1024;
const SKIP_STEPS = new Set(["hook", "fixture", "test.attach", "attach"]);
/** step params worth showing next to the action: where it went, what it typed or expected */
const PARAMS = ["url", "value", "text", "key", "expected", "name"];
/** a field whose name says it's secret never shows what was typed into it */
const SECRET = /pass(word|code)?|secret|token|otp|pin\b/i;

/** @param {PwStep} s */
function detail(s) {
  const p = s.params ?? {};
  const bits = [];
  for (const k of PARAMS) {
    const v = p[k];
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") continue;
    // a URL the subtitle already shows
    if (typeof v === "string" && s.subtitle && (v === s.subtitle || v.endsWith(s.subtitle))) continue;
    if (k === "value" && SECRET.test(`${s.subtitle ?? ""} ${String(p.locator ?? "")}`)) bits.push("•••");
    else bits.push(JSON.stringify(v).slice(0, 120));
  }
  return bits.join(" ");
}

/** @param {unknown} s */
const plain = (s) => (typeof s === "string" ? s.replace(/\u001b\[[0-9;]*m/g, "") : "");
/** @param {string} s @param {number} n */
const cap = (s, n) => (s.length > n ? `${s.slice(0, n)}\n…cut at ${n} characters` : s);

/**
 * @typedef {{ title: string, subtitle?: string, params?: Record<string, unknown>, category: string, duration: number, error?: { message?: string }, location?: { file: string, line: number }, steps: PwStep[] }} PwStep
 * @typedef {{ name: string, contentType: string, path?: string, body?: Uint8Array }} PwAttachment
 * @typedef {{ status: string, duration: number, startTime: Date, retry: number, errors: { message?: string, stack?: string, snippet?: string, location?: { file: string, line: number, column: number } }[], steps: PwStep[], attachments: PwAttachment[], stdout: (string | Uint8Array)[], stderr: (string | Uint8Array)[] }} PwResult
 * @typedef {{ titlePath(): string[], location: { file: string, line: number, column: number }, expectedStatus: string, outcome(): string }} PwTest
 */

class GateReporter {
  constructor() {
    /** @type {string | undefined} */
    this.dir = process.env.GATE_ARTIFACTS;
    this.n = 0;
    if (this.dir) fs.mkdirSync(this.dir, { recursive: true });
  }

  printsToStdio() {
    return false;
  }

  /** @param {PwTest} test @param {PwResult} result */
  onTestEnd(test, result) {
    if (!this.dir) return;
    try {
      this.write(test, result);
    } catch (err) {
      // never fail a run over its detail
      process.stderr.write(`gate reporter: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  /** @param {PwTest} test @param {PwResult} result */
  write(test, result) {
    const dir = /** @type {string} */ (this.dir);
    const [, project, , ...titles] = test.titlePath();
    const title = titles.join(" › ");
    const id = crypto.createHash("sha1").update(`${project}\0${test.location.file}\0${title}\0${result.retry}`).digest("hex").slice(0, 12);
    const failed = result.status !== test.expectedStatus;

    /** @type {{ t: string, sub?: string, p?: string, c: string, d: number, ms: number, err?: string, line?: number }[]} */
    const steps = [];
    /** @param {PwStep[]} list @param {number} depth */
    const walk = (list, depth) => {
      for (const s of list) {
        if (steps.length >= MAX_STEPS) return;
        if (SKIP_STEPS.has(s.category)) continue;
        const own = s.location && s.location.file === test.location.file ? s.location.line : undefined;
        const more = detail(s);
        steps.push({
          t: plain(s.title).slice(0, 300),
          ...(s.subtitle ? { sub: plain(s.subtitle).slice(0, 300) } : {}),
          ...(more ? { p: more } : {}),
          c: s.category,
          d: depth,
          ms: Math.round(s.duration),
          ...(s.error ? { err: plain(s.error.message).split("\n")[0]?.slice(0, 300) ?? "error" } : {}),
          ...(own ? { line: own } : {}),
        });
        walk(s.steps ?? [], depth + 1);
      }
    };
    walk(result.steps ?? [], 0);

    /** @type {{ name: string, type: string, file: string }[]} */
    const files = [];
    for (const a of result.attachments ?? []) {
      const image = a.contentType.startsWith("image/");
      const text = a.contentType.startsWith("text/") || a.contentType === "application/json";
      // images always: they're what the test looked like; a trace, video or other file only when it failed
      if (!image && !failed) continue;
      const ext = path.extname(a.path ?? "") || (image ? `.${a.contentType.slice(6).replace("+xml", "")}` : text ? ".txt" : ".bin");
      const name = `${a.name.replace(/[^\w.-]+/g, "-").slice(0, 60) || "file"}-${files.length}${ext}`;
      const rel = path.join(id, name);
      const to = path.join(dir, rel);
      if (a.path && fs.existsSync(a.path)) {
        if (!image && !failed && fs.statSync(a.path).size > MAX_SMALL_FILE) continue;
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(a.path, to);
      } else if (a.body) {
        if (a.body.length > MAX_SMALL_FILE && !image) continue;
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.writeFileSync(to, a.body);
      } else continue;
      files.push({ name: a.name, type: a.contentType, file: rel });
    }

    /** @param {(string | Uint8Array)[]} chunks */
    const out = (chunks) => cap(plain((chunks ?? []).map((c) => (typeof c === "string" ? c : Buffer.from(c).toString("utf8"))).join("")), MAX_TEXT);

    const line = {
      v: 1,
      id,
      file: test.location.file,
      line: test.location.line,
      column: test.location.column,
      project,
      title,
      retry: result.retry,
      status: result.status,
      expected: test.expectedStatus,
      ms: Math.round(result.duration),
      at: result.startTime instanceof Date ? result.startTime.toISOString() : undefined,
      steps,
      errors: (result.errors ?? []).map((e) => ({
        message: cap(plain(e.message ?? e.stack ?? ""), MAX_TEXT),
        ...(e.snippet ? { snippet: cap(plain(e.snippet), 4000) } : {}),
        ...(e.location ? { line: e.location.line, file: e.location.file } : {}),
      })),
      stdout: out(result.stdout),
      stderr: out(result.stderr),
      attachments: files,
    };
    fs.appendFileSync(path.join(dir, "results.jsonl"), `${JSON.stringify(line)}\n`);
    this.n++;
  }
}

module.exports = GateReporter;
