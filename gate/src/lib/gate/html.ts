// `gate tests --html`: the same report as `gate tests`, plus what the stored
// probes say about coverage, the repo's own coverage maps, and per test the
// detail a log can't carry (steps, screenshots, its code), as one page with
// inline CSS, JS and data (no server, no CDN; screenshots are files beside it).
// Answer first: one line says whether it's green and on which commit, then
// the numbers, then problems. Every register (files, flows, bugs) sits behind
// an expander; a test opens in a drawer the page draws from the embedded data.
// renderTestsPage is pure: data in, HTML out (test/gate/html.test.ts).

import { fmtMs, short } from "./output.ts";
import { linuxToWin } from "../platform.ts";
import { cellOk, type Cell, type MapEntry } from "./maps.ts";
import { pct } from "./probe/store.ts";
import type { PlantedBug, ProbeCoverage, SourceFileRow } from "./probe/coverage.ts";
import { countsText, localTime, testTime, type CheckRow, type TestRow, type TestsReport } from "./tests.ts";
import type { TestStatus } from "./testlog.ts";
import type { Step } from "./artifacts.ts";

/** What gate's reporter recorded for one test result, with paths the page can use. */
export interface ResultDetail {
  steps: Step[];
  errors: { message: string; snippet?: string }[];
  stdout: string;
  stderr: string;
  /** screenshots, `src` relative to the page */
  images: { name: string; src: string }[];
  /** trace, video and the rest: absolute paths */
  files: { name: string; path: string }[];
  attempts: number;
}

export interface TestCode {
  /** the commit the code was read at: the run's */
  sha: string;
  path: string;
  /** 1-based line of the first line in `text` */
  start: number;
  text: string;
}

export interface TestsPage {
  report: TestsReport;
  coverage: ProbeCoverage;
  /** ISO time the page was made */
  at: string;
  /** detailKey(path, project, name) → what the reporter recorded */
  details?: Record<string, ResultDetail>;
  /** codeKey(path, name) → the test's code */
  code?: Record<string, TestCode>;
}

export const detailKey = (path: string, project: string | undefined, name: string): string => `${path}\0${project ?? ""}\0${name}`;
export const codeKey = (path: string, name: string): string => `${path}\0${name}`;

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const plural = (n: number, word: string, many = `${word}s`): string => `${n} ${n === 1 ? word : many}`;

/** A Windows path for Sal, a file:// link the browser opens. */
function fileLink(path: string, text?: string): string {
  const win = path.startsWith("/") ? linuxToWin(path) : path;
  return `<a href="${esc(fileHref(path))}">${esc(text ?? win)}</a>`;
}

function fileHref(path: string): string {
  const win = path.startsWith("/") ? linuxToWin(path) : path;
  return encodeURI(`file:///${win.replace(/\\/g, "/").replace(/^\/\/+/, "")}`);
}

const WORD: Record<TestStatus, string> = { pass: "pass", fail: "fail", flaky: "flaky", skip: "skipped", todo: "todo", dnr: "did not run" };
const GLYPH: Record<TestStatus, string> = { pass: "✓", fail: "✘", flaky: "!", skip: "–", todo: "–", dnr: "·" };

function mark(s: TestStatus): string {
  return `<span class="m ${s}" title="${WORD[s]}">${GLYPH[s]}</span>`;
}

/** `<feature>/<flow> · <what a person sees>`, possibly after a describe chain joined by ` › `. */
export function splitTitle(name: string): { feature: string | null; prefix: string; title: string } {
  const parts = name.split(" › ");
  const i = parts.findIndex((p) => /^[^\s/·]+\/\S+ · /.test(p));
  if (i < 0) return { feature: null, prefix: "", title: name };
  const seg = parts.slice(i).join(" › ");
  const slash = seg.indexOf("/");
  return { feature: seg.slice(0, slash), prefix: parts.slice(0, i).join(" › "), title: seg.slice(slash + 1) };
}

function worst(rows: TestRow[]): TestStatus {
  if (rows.some((t) => t.status === "fail")) return "fail";
  if (rows.every((t) => t.clean)) return "pass";
  if (rows.some((t) => t.status === "flaky" || t.history.failed || t.history.flaky)) return "flaky";
  return rows.some((t) => t.status === "dnr") ? "dnr" : "skip";
}

function historyNote(t: TestRow): string {
  const bits: string[] = [];
  if (t.history.failed && !(t.status === "fail" && t.history.failed === 1)) bits.push(`failed in ${t.history.failed} of the last ${t.history.runs} runs`);
  if (t.history.flaky && !(t.status === "flaky" && t.history.flaky === 1)) bits.push(`flaky in ${t.history.flaky} of the last ${t.history.runs} runs`);
  return bits.join(" · ");
}

// ---- the tests, as the drawer's data ----

/** One test (a flow: every width), as the page's data carries it. */
interface PageTest {
  check: string;
  path: string;
  name: string;
  runner: "bun" | "playwright";
  line?: number;
  /** the run its results are from */
  run: string | null;
  /** file:// link to the log */
  log: string | null;
  results: {
    w: string;
    st: TestStatus;
    ms?: number;
    err?: string[];
    note?: string;
    /** newest first: [run, status, ms] */
    recent: [string, TestStatus, number | null][];
    d?: Omit<ResultDetail, "files"> & { files: { name: string; href: string }[] };
  }[];
  code?: TestCode;
  bugs: { file: string; line: number; op: string; before: string; after: string }[];
}

interface Built {
  tests: PageTest[];
  /** per check: flows (one per title) or tests, in the order the page lists them, with their index */
  index: Map<string, { name: string; path: string; i: number; rows: TestRow[] }[]>;
}

function buildTests(page: TestsPage): Built {
  const { report: r, coverage: cov } = page;
  const bugsBy = new Map<string, PageTest["bugs"]>();
  for (const f of cov.files)
    for (const b of f.bugs)
      if (b.outcome === "caught")
        for (const t of b.tests) bugsBy.set(t.title, [...(bugsBy.get(t.title) ?? []), { file: f.path, line: b.line, op: b.op, before: b.before, after: b.after }]);
  const tests: PageTest[] = [];
  const index: Built["index"] = new Map();
  for (const c of r.checks) {
    const list: { name: string; path: string; i: number; rows: TestRow[] }[] = [];
    for (const f of c.files) {
      const byName = new Map<string, TestRow[]>();
      for (const t of f.tests) byName.set(t.name, [...(byName.get(t.name) ?? []), t]);
      for (const [name, rows] of byName) {
        const line = Number(rows[0]?.loc?.split(":")[0]) || undefined;
        const code = page.code?.[codeKey(f.path, name)];
        tests.push({
          check: c.name,
          path: f.path,
          name,
          runner: f.runner,
          ...(line ? { line } : {}),
          run: c.from?.run ?? null,
          log: c.log ? fileHref(c.log) : null,
          results: rows.map((t) => {
            const d = page.details?.[detailKey(f.path, t.project, name)];
            const note = historyNote(t);
            return {
              w: t.project ?? "",
              st: t.status,
              ...(t.ms !== undefined ? { ms: t.ms } : {}),
              ...(t.error?.length ? { err: t.error } : {}),
              ...(note ? { note } : {}),
              recent: (t.history.recent ?? []).map((h): [string, TestStatus, number | null] => [h.run, h.status, h.ms ?? null]),
              ...(d ? { d: { ...d, files: d.files.map((x) => ({ name: x.name, href: fileHref(x.path) })) } } : {}),
            };
          }),
          ...(code ? { code } : {}),
          bugs: bugsBy.get(name) ?? [],
        });
        list.push({ name, path: f.path, i: tests.length - 1, rows });
      }
    }
    index.set(c.name, list);
  }
  return { tests, index };
}

// ---- answer first ----

function verdict(r: TestsReport): { cls: string; text: string } {
  const l = r.lastRun;
  if (!l) return { cls: "", text: "No run recorded yet: run gate" };
  const on = `<code>${short(l.sha)}</code>`;
  const scope = [l.dirty ? "a --dirty run" : "", l.only ? `only ${esc(l.only.join(", "))}` : ""].filter(Boolean).join(", ");
  const head = l.sha === r.head ? "" : ` <span class="since">· HEAD <code>${short(r.head)}</code> is ${l.commitsSince ? plural(l.commitsSince, "commit") : "a different commit"} past it</span>`;
  if (!l.ok) return { cls: "bad", text: `✘ Red on ${on}: failed at ${esc(l.failedAt ?? "?")}${scope ? ` (${scope})` : ""}${head}` };
  return { cls: "good", text: `✓ All green on ${on}${scope ? ` (${scope})` : ""}${head}` };
}

function stats(page: TestsPage): string {
  const { report: r, coverage: cov } = page;
  const total = r.checks.reduce((n, c) => n + c.tests, 0);
  const failing = r.checks.reduce((n, c) => n + c.counts.fail, 0);
  const flaky = r.checks.reduce((n, c) => n + c.counts.flaky, 0);
  const head = cov.newestSampled;
  const replays = cov.timeline.filter((p) => p.replay).length;
  const stat = (v: string, label: string, cls = "", title = ""): string =>
    `<div class="stat ${cls}"${title ? ` title="${esc(title)}"` : ""}><div class="v">${v}</div><div class="l">${esc(label)}</div></div>`;
  return [
    stat(total.toLocaleString("en-US"), "test results"),
    stat(String(failing), "failing", failing ? "bad" : ""),
    ...(flaky ? [stat(String(flaky), "flaky", "warn")] : []),
    stat(
      head ? `${pct(head.rate)}<small> / ${pct(head.minRate)}</small>` : "—",
      head ? "catch rate" : replays ? "no sampled probe yet, only replays" : "no probe yet",
      head ? (head.exit === 0 ? "good" : "bad") : "",
      head ? `newest sampled probe, ${localTime(head.at)} on ${short(head.sha)}${replays ? ` · ${plural(replays, "--from replay")} not counted` : ""}` : "",
    ),
    ...(head ? [stat(String(head.missed), "missed in that probe", head.missed ? "bad" : "")] : []),
  ].join("");
}

function problems(page: TestsPage, built: Built): string {
  const { report: r, coverage: cov } = page;
  const items: string[] = [];
  for (const c of r.checks) {
    if (c.state === "fail" && !c.counts.fail) items.push(`<li>${mark("fail")} <b>${esc(c.name)}</b> failed${c.reason ? `: ${esc(c.reason)}` : ""}${c.log ? ` · ${fileLink(c.log, "log")}` : ""}</li>`);
    if (c.from && !c.newest) items.push(`<li>${mark("dnr")} <b>${esc(c.name)}</b>: the newest run stopped before it; these results are from ${esc(localTime(c.from.at))} on <code>${short(c.from.sha)}</code></li>`);
    for (const e of built.index.get(c.name) ?? []) {
      const st = worst(e.rows);
      if (st === "pass") continue;
      const where = e.rows.filter((t) => !t.clean).map((t) => t.project).filter((p): p is string => !!p);
      const why = e.rows.find((t) => t.error?.length)?.error?.[0] ?? e.rows.map(historyNote).find(Boolean) ?? WORD[st];
      items.push(
        `<li class="t" data-t="${e.i}">${mark(st)} <span class="ck">${esc(c.name)}</span> <a href="#t${e.i}">${esc(e.name)}</a>${where.length ? ` <span class="muted">${esc(where.join(", "))}</span>` : ""}<div class="why">${esc(why)}</div></li>`,
      );
    }
  }
  // every planted change whose newest planting passed every check: fixed ones were planted again and caught
  const missed = cov.files
    .map((f) => ({ f, n: f.bugs.filter((b) => b.outcome === "missed").length }))
    .filter((x) => x.n)
    .sort((a, b) => Number(b.f.critical) - Number(a.f.critical) || b.n - a.n);
  if (missed.length) {
    const n = missed.reduce((s, x) => s + x.n, 0);
    const crit = missed.filter((x) => x.f.critical).reduce((s, x) => s + x.n, 0);
    const files = missed.slice(0, 6).map((x) => `<a href="#bug-${esc(x.f.path)}" class="path">${esc(x.f.path)}</a> ${x.n}${x.f.critical ? ' <span class="tag crit">critical</span>' : ""}`);
    items.push(
      `<li>${mark("fail")} <b>${plural(n, "planted bug")} passed every check</b>${crit ? `, <span class="bad">${crit} in critical files</span>` : ""}<div class="why">${files.join(" · ")}${missed.length > 6 ? ` · <a href="#bugs">${missed.length - 6} more files</a>` : ""}</div></li>`,
    );
  }
  for (const m of r.maps) {
    if (!m.map) items.push(`<li>${mark("fail")} <a href="#maps">${esc(m.file.split("/").pop() ?? m.file)}</a> isn't a coverage map: ${esc(m.error ?? "")}</li>`);
    else if (m.gaps) items.push(`<li>${mark("flaky")} <a href="#maps">${esc(m.map.title)}</a>: ${plural(m.gaps, "gap")}</li>`);
  }
  if (r.notRunYet.length) items.push(`<li>${mark("dnr")} <a href="#notrun">${plural(r.notRunYet.length, "test file")}</a> no kept run named</li>`);
  if (!items.length) return "";
  return `<section id="problems"><h2>Problems <span class="n">${items.length}</span></h2><ul class="problems">${items.join("")}</ul></section>`;
}

function checksTable(r: TestsReport): string {
  const rows = r.checks.map((c) => {
    const state: TestStatus = c.state === "fail" ? "fail" : c.state === "not-run" ? "dnr" : c.counts.flaky || c.counts.skip || c.counts.todo || c.counts.dnr ? "flaky" : "pass";
    const total = c.summaryTotal ?? c.tests;
    const what = c.flows ? `${plural(c.flows.flows, "flow")}${c.flows.widths.length > 1 ? ` × ${c.flows.widths.length} widths` : ""}` : total ? plural(total, "test") : c.state === "not-run" ? "" : "no tests";
    const result = c.state === "not-run" ? "not run in a kept run" : c.tests ? countsText(c.counts) : c.state === "pass" ? "pass" : "FAIL";
    const from = c.from ? `${esc(localTime(c.from.at))} · <code>${short(c.from.sha)}</code>${c.from.trigger === "probe" ? " · probe baseline" : c.from.dirty ? " · dirty" : ""}` : "";
    const name = c.files.length ? `<a href="#check-${esc(c.name)}">${esc(c.name)}</a>` : esc(c.name);
    return `<tr><td>${mark(state)}</td><td><b>${name}</b></td><td>${esc(what)}</td><td class="res">${esc(result)}</td><td class="num">${c.ms === null ? "" : fmtMs(c.ms)}</td><td class="run">${from}</td><td>${c.log ? fileLink(c.log, "log") : ""}</td></tr>`;
  });
  return `<table class="grid checks"><thead><tr><th></th><th>Check</th><th>Tests</th><th class="res">Result</th><th class="num">Time</th><th class="run">Run</th><th></th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

// ---- the registers ----

function widthCell(t: TestRow | undefined): string {
  if (!t) return '<td class="w muted">—</td>';
  const text = t.status === "pass" || t.status === "flaky" ? testTime(t.ms) : WORD[t.status];
  const note = historyNote(t);
  return `<td class="w"${note ? ` title="${esc(note)}"` : ""}>${mark(t.status)} <span class="muted">${esc(text)}</span>${note ? ' <span class="warn">●</span>' : ""}</td>`;
}

function flowsCheck(c: CheckRow, built: Built, caught: Record<string, number>): string {
  const widths = c.flows?.widths.length ? c.flows.widths : [""];
  const groups = new Map<string, { name: string; path: string; i: number; rows: TestRow[] }[]>();
  for (const e of built.index.get(c.name) ?? []) {
    const feature = splitTitle(e.name).feature ?? "other";
    groups.set(feature, [...(groups.get(feature) ?? []), e]);
  }
  const head = `<thead><tr><th></th><th>Flow</th>${widths.map((w) => `<th class="w">${esc(w)}</th>`).join("")}<th class="num bugs">Caught</th></tr></thead>`;
  return [...groups.entries()]
    .sort(([a], [b]) => (a === "other" ? 1 : b === "other" ? -1 : a.localeCompare(b)))
    .map(([feature, flows]) => {
      const all = flows.flatMap((f) => f.rows);
      const st = worst(all);
      const per = widths
        .map((w) => {
          const rows = all.filter((t) => (t.project ?? "") === w);
          const ok = rows.filter((t) => t.status === "pass" || t.status === "flaky").length;
          return `<span class="pw ${ok === rows.length ? "ok" : "bad"}">${esc(w || "result")} ${ok}/${rows.length}</span>`;
        })
        .join("");
      const ms = all.reduce((n, t) => n + (t.ms ?? 0), 0);
      const rows = [...flows]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((fl) => {
          const sp = splitTitle(fl.name);
          const fst = worst(fl.rows);
          const title = `${sp.prefix ? `<span class="muted">${esc(sp.prefix)} › </span>` : ""}${esc(sp.title)}`;
          const n = caught[fl.name];
          return `<tr class="t${fst === "pass" ? " clean" : ""}" data-t="${fl.i}" data-q="${esc(`${fl.name} ${fl.path}`.toLowerCase())}"><td>${mark(fst)}</td><td class="name"><a href="#t${fl.i}">${title}</a></td>${widths.map((w) => widthCell(fl.rows.find((x) => (x.project ?? "") === w))).join("")}<td class="num bugs">${n ? `<span class="caught" title="planted bugs it failed on">${n}</span>` : ""}</td></tr>`;
        });
      return `<details class="area${st === "pass" ? " clean" : ""}"${st === "pass" ? "" : " open"}><summary>${mark(st)}<b>${esc(feature)}</b><span class="muted">${plural(flows.length, "flow")}</span><span class="pws">${per}</span><span class="muted num">${fmtMs(ms)}</span></summary><table class="grid flows">${head}<tbody>${rows.join("")}</tbody></table></details>`;
    })
    .join("");
}

function bunCheck(c: CheckRow, built: Built, caught: Record<string, number>): string {
  const byFile = new Map<string, { name: string; path: string; i: number; rows: TestRow[] }[]>();
  for (const e of built.index.get(c.name) ?? []) byFile.set(e.path, [...(byFile.get(e.path) ?? []), e]);
  return c.files
    .map((f) => {
      const st = worst(f.tests);
      const ms = f.tests.reduce((n, t) => n + (t.ms ?? 0), 0);
      const rows = (byFile.get(f.path) ?? []).map((e) => {
        const t = e.rows[0];
        if (!t) return "";
        const note = [testTime(t.ms), historyNote(t)].filter(Boolean).join(" · ");
        const n = caught[e.name];
        return `<tr class="t${t.clean ? " clean" : ""}" data-t="${e.i}" data-q="${esc(`${e.name} ${WORD[t.status]}`.toLowerCase())}"><td>${mark(t.status)}</td><td class="name"><a href="#t${e.i}">${esc(e.name)}</a>${t.status !== "pass" ? ` <span class="st ${t.status}">${WORD[t.status]}</span>` : ""}</td><td class="num muted">${esc(note)}</td><td class="num bugs">${n ? `<span class="caught" title="planted bugs it failed on">${n}</span>` : ""}</td></tr>`;
      });
      const caughtText = f.caught === null ? "" : f.caught ? `<span class="caught">caught ${f.caught}</span>` : '<span class="muted">caught none</span>';
      return `<details class="file${st === "pass" ? " clean" : ""}"${st === "pass" ? "" : " open"} data-q="${esc(f.path.toLowerCase())}"><summary>${mark(st)}<span class="path">${esc(f.path)}</span><span class="muted num">${plural(f.tests.length, "test")}</span><span class="muted num">${testTime(ms)}</span><span class="num">${caughtText}</span></summary><table class="grid tests"><tbody>${rows.join("")}</tbody></table></details>`;
    })
    .join("");
}

function checkSection(c: CheckRow, built: Built, caught: Record<string, number>): string {
  const what = c.flows ? `${plural(c.flows.flows, "flow")} × ${plural(c.flows.widths.length, "width")}` : plural(c.tests, "test");
  const facts = `<span class="muted">${esc(what)} · ${esc(countsText(c.counts))}${c.ms === null ? "" : ` · ${fmtMs(c.ms)}`}</span>`;
  if (c.flows) {
    return `<section class="check" id="check-${esc(c.name)}"><h2>${esc(c.name)} ${facts}<button class="mini" data-expand="check-${esc(c.name)}">Expand all</button></h2>${flowsCheck(c, built, caught)}</section>`;
  }
  const st: TestStatus = c.state === "fail" ? "fail" : c.files.every((f) => f.tests.every((t) => t.clean)) ? "pass" : "flaky";
  return `<section class="check" id="check-${esc(c.name)}"><details class="reg"${st === "pass" ? "" : " open"}><summary><h2>${mark(st)} ${esc(c.name)} ${facts}</h2></summary>${bunCheck(c, built, caught)}</details></section>`;
}

function rateChart(cov: ProbeCoverage): string {
  const pts = cov.timeline.filter((p) => p.rate !== null);
  if (!pts.length) return "";
  const W = 360;
  const H = 108;
  const top = 14;
  const base = H - 30;
  const left = 30;
  const slot = (W - left) / Math.max(pts.length, 6);
  const bw = Math.min(28, slot - 6);
  const y = (v: number): number => base - v * (base - top);
  const minRate = pts.at(-1)?.minRate ?? 0.9;
  const oneDay = new Set(pts.map((p) => localTime(p.at).slice(0, 10))).size === 1;
  const tick = (iso: string): string => (oneDay ? localTime(iso).slice(11) : localTime(iso).slice(5, 10));
  const bars = pts.map((p, i) => {
    const x = left + i * slot + (slot - bw) / 2;
    const v = p.rate ?? 0;
    const h = Math.max(2, base - y(v));
    const kind = p.replay ? `replay of ${p.from ?? "a list"}` : p.source === "since" ? "sample of changed lines" : "sample";
    const tip = `${localTime(p.at)} · ${short(p.sha)} · ${kind} · caught ${p.caught} of ${p.counted} (${pct(p.rate)}) · ${p.missed} missed · exit ${p.exit}`;
    const headline = cov.newestSampled !== null && p.at === cov.newestSampled.at;
    // every bar keeps its own value; the headline's is bold, a replay's muted
    const label = headline || p.replay || i === pts.length - 1 ? `<text x="${x + bw / 2}" y="${y(v) - 4}" class="${headline ? "lbl" : "tick"}" text-anchor="middle">${pct(p.rate)}</text>` : "";
    const cls = p.replay ? "replay" : p.exit === 0 ? "ok" : "bad";
    const sub = p.replay ? `<text x="${x + bw / 2}" y="${H - 4}" class="tick" text-anchor="middle">replay</text>` : "";
    return `<g><title>${esc(tip)}</title><rect x="${x - 3}" y="${top}" width="${bw + 6}" height="${base - top}" fill="transparent"/><path d="M${x},${base} v${-(h - 4)} q0,-4 4,-4 h${bw - 8} q4,0 4,4 v${h - 4} z" class="bar ${cls}"/>${label}<text x="${x + bw / 2}" y="${H - 16}" class="tick" text-anchor="middle">${esc(tick(p.at))}</text>${sub}</g>`;
  });
  const grid = [0, 0.5, 1].map((v) => `<line x1="${left}" x2="${W}" y1="${y(v)}" y2="${y(v)}" class="gl"/><text x="${left - 4}" y="${y(v) + 3}" class="tick" text-anchor="end">${v * 100}%</text>`);
  const minLine = `<line x1="${left}" x2="${W}" y1="${y(minRate)}" y2="${y(minRate)}" class="min"/><text x="${W}" y="${y(minRate) - 3}" class="tick" text-anchor="end">minRate ${pct(minRate)}</text>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="catch rate per probe">${grid.join("")}${minLine}${bars.join("")}</svg>`;
}

function bugRow(b: PlantedBug, headAt: string | undefined): string {
  const when = b.outcome === "missed" && b.at !== headAt ? `<span class="warn">missed in the ${b.replay ? "replay" : "probe"} of ${esc(localTime(b.at))} (<code>${short(b.sha)}</code>), not planted since</span>` : "";
  const by =
    b.outcome === "caught"
      ? `<b>${esc(b.check ?? "?")}</b>${b.timeout ? " (timeout)" : ""}${b.tests.length ? `: ${b.tests
          .slice(0, 3)
          .map((t) => `${esc(t.title)}${t.projects.length ? ` <span class="muted">[${esc(t.projects.join(", "))}]</span>` : ""}`)
          .join("<br>")}${b.tests.length > 3 ? `<br><span class="muted">and ${b.tests.length - 3} more</span>` : ""}` : ""}`
      : b.reason
        ? `<span class="muted">${esc(b.reason)}</span>`
        : when;
  const seen = b.seen.length > 1 ? `<span class="hist" title="${esc(b.seen.map((s) => `${localTime(s.at)} ${s.outcome}${s.replay ? " (replay)" : ""}`).join("\n"))}">${b.seen.map((s) => `<i class="${s.outcome}${s.replay ? " rp" : ""}"></i>`).join("")}</span>` : "";
  const replay = b.replay ? ' <span class="tag rp" title="this result is from a --from replay">replay</span>' : "";
  const cls = b.outcome === "caught" ? " clean" : "";
  return `<tr class="b${cls}" data-q="${esc(`${b.before} ${b.after} ${b.op} ${b.outcome}${b.replay ? " replay" : ""} ${b.tests.map((t) => t.title).join(" ")}`.toLowerCase())}"><td class="num">${b.line}</td><td><span class="out ${b.outcome}">${b.outcome}</span>${replay}${seen}</td><td class="muted op">${esc(b.op)}</td><td class="code"><code class="before">${esc(b.before)}</code><code class="after">${esc(b.after)}</code>${b.note ? `<div class="muted">${esc(b.note)}</div>` : ""}</td><td class="by">${by}</td></tr>`;
}

function bugsSection(page: TestsPage): string {
  const cov = page.coverage;
  if (!cov.files.length) return `<section id="bugs"><h2>Planted bugs</h2><p class="muted">${cov.noProbeConfig ? "gate.json has no probe section" : "No probe yet: gate probe"}</p></section>`;
  const all = cov.files.flatMap((f) => f.bugs);
  const caught = all.filter((b) => b.outcome === "caught").length;
  const missed = all.filter((b) => b.outcome === "missed").length;
  const other = all.length - caught - missed;
  const probed = cov.candidates - cov.untouched.length;
  const replays = cov.timeline.filter((p) => p.replay).length;
  const nums = [
    `<b>${caught}</b> of ${caught + missed} caught`,
    missed ? `<b class="bad">${missed}</b> missed` : "",
    other ? `${other} excluded or stale` : "",
    cov.noProbeConfig ? "" : `<b>${probed}</b> of ${plural(cov.candidates, "source file")} probed`,
    `${plural(cov.timeline.length, "probe")}${replays ? ` (${plural(replays, "replay")})` : ""}`,
  ].filter(Boolean);
  const body = cov.files.map((f: SourceFileRow) => {
    const counts = [f.caught ? `${f.caught} caught` : "", f.missed ? `<span class="bad">${f.missed} missed</span>` : "", f.other ? `${f.other} excluded or stale` : ""].filter(Boolean).join(" · ");
    const tags = `${f.critical ? ' <span class="tag crit">critical</span>' : ""}${f.excludedNow ? ` <span class="tag">${esc(f.excludedNow)}</span>` : ""}`;
    return `<details class="bugfile${f.missed ? "" : " clean"}" id="bug-${esc(f.path)}" data-q="${esc(f.path.toLowerCase())}"><summary>${mark(f.missed ? "fail" : "pass")}<span class="path">${esc(f.path)}</span>${tags}<span class="muted">${counts}</span></summary><table class="grid bugs"><thead><tr><th class="num">Line</th><th>Outcome</th><th class="op">Operator</th><th>Change</th><th class="by">Caught by</th></tr></thead><tbody>${f.bugs.map((b) => bugRow(b, cov.newestSampled?.at)).join("")}</tbody></table></details>`;
  });
  return `<section id="bugs"><h2>Planted bugs</h2><div class="bugtop"><p class="nums">${nums.join(" · ")}</p>${rateChart(cov)}</div><details class="reg" id="bugfiles"><summary><h3>${plural(cov.files.length, "source file")}</h3></summary>${body.join("")}</details></section>`;
}

function untouchedSection(cov: ProbeCoverage): string {
  if (cov.noProbeConfig || !cov.untouched.length) return "";
  const byDir = new Map<string, string[]>();
  for (const f of cov.untouched) {
    const i = f.lastIndexOf("/");
    const dir = i < 0 ? "." : f.slice(0, i);
    byDir.set(dir, [...(byDir.get(dir) ?? []), f.slice(i + 1)]);
  }
  const rows = [...byDir.entries()].map(
    ([dir, files]) =>
      `<details class="dir" data-q="${esc(`${dir} ${files.join(" ")}`.toLowerCase())}"><summary><span class="path">${esc(dir)}/</span><span class="muted">${files.length}</span></summary><ul>${files.map((f) => `<li>${esc(f)}</li>`).join("")}</ul></details>`,
  );
  return `<section id="untouched"><details class="reg"><summary><h2>Never probed <span class="muted">${cov.untouched.length} of ${plural(cov.candidates, "source file")}</span></h2></summary><div class="dirs">${rows.join("")}</div></details></section>`;
}

function mapCell(c: Cell | undefined): string {
  const ok = cellOk(c);
  const text = typeof c === "string" ? c : c && typeof c === "object" ? (c.text ?? "") : "";
  const by = c && typeof c === "object" && c.by?.length ? ` title="${esc(c.by.join("\n"))}"` : "";
  if (ok === true) return `<td class="c ok"${by}>✓${text ? ` <span class="muted">${esc(text)}</span>` : ""}</td>`;
  if (ok === false) return `<td class="c gap"${by}>✘${text ? ` ${esc(text)}` : ""}</td>`;
  return `<td class="c muted"${by}>${esc(text)}</td>`;
}

function mapsSection(r: TestsReport): string {
  if (!r.maps.length) return "";
  const status = new Map<string, TestStatus>();
  for (const c of r.checks) for (const f of c.files) for (const t of f.tests) if (status.get(t.name) !== "fail") status.set(t.name, t.status);
  const one = (m: MapEntry): string => {
    if (!m.map) return `<div class="map"><h3>${mark("fail")} ${esc(m.file.split("/").pop() ?? m.file)} <span class="bad">not a coverage map</span></h3><pre class="err">${esc(m.error ?? "")}</pre></div>`;
    const map = m.map;
    const head = `<tr><th>Item</th>${map.columns.map((c) => `<th class="w">${esc(c)}</th>`).join("")}<th>Covered by</th></tr>`;
    const groups = new Map<string, typeof map.rows>();
    for (const row of map.rows) groups.set(row.group ?? "", [...(groups.get(row.group ?? "") ?? []), row]);
    const body = [...groups.entries()].map(([g, rows]) => {
      const gh = g ? `<tr class="gh"><td colspan="${map.columns.length + 2}"><b>${esc(g)}</b></td></tr>` : "";
      const trs = rows.map((row) => {
        const gap = map.columns.some((c) => cellOk(row.cells[c]) === false);
        const by = row.coveredBy ?? [];
        const lost = by.filter((t) => !status.has(t));
        const failing = by.filter((t) => status.get(t) === "fail");
        const byText = by.length
          ? `<span title="${esc(by.join("\n"))}">${plural(by.length, "test")}</span>${failing.length ? ` <span class="bad">${failing.length} failing</span>` : ""}${lost.length ? ` <span class="warn" title="${esc(lost.join("\n"))}">${lost.length} not in the last run</span>` : ""}`
          : "";
        return `<tr class="r${gap || failing.length ? "" : " clean"}" data-q="${esc(`${g} ${row.item} ${by.join(" ")}`.toLowerCase())}"><td class="name">${esc(row.item)}</td>${map.columns.map((c) => mapCell(row.cells[c])).join("")}<td>${byText}</td></tr>`;
      });
      return `<tbody class="group">${gh}${trs.join("")}</tbody>`;
    });
    const gaps = m.gaps ?? 0;
    return `<details class="map"${gaps ? " open" : ""}><summary>${mark(gaps ? "flaky" : "pass")}<b>${esc(map.title)}</b><span class="muted">${plural(map.rows.length, "row")} · ${gaps ? `<span class="warn">${plural(gaps, "gap")}</span>` : "no gaps"} · ${esc(m.check)}</span></summary><table class="grid cov">${head}${body.join("")}</table></details>`;
  };
  return `<section id="maps"><h2>Coverage maps</h2>${r.maps.map(one).join("")}</section>`;
}

function notRunSection(r: TestsReport): string {
  if (!r.notRunYet.length) return "";
  return `<section id="notrun"><details class="reg" open><summary><h2>Not run yet <span class="muted">${plural(r.notRunYet.length, "test file")}</span></h2></summary><ul class="plain">${r.notRunYet.map((f) => `<li data-q="${esc(f.toLowerCase())}">${mark("dnr")} <span class="path">${esc(f)}</span></li>`).join("")}</ul></details></section>`;
}

// ---- the page ----

const CSS = `
:root{--ink:#1f2328;--ink2:#59636e;--ink3:#818b98;--line:#d1d9e0;--line2:#eef1f4;--bg:#fff;--bg2:#f6f8fa;--good:#1a7f37;--bad:#cf222e;--warn:#9a6700;--accent:#0969da}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;font:14px/1.45 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:var(--bg)}
code,pre,.path{font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;font-size:12.5px}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
header{padding:18px 24px 6px;max-width:1280px;margin:0 auto}
h1{font-size:15px;margin:0 0 6px;color:var(--ink2);font-weight:600}
.verdict{font-size:22px;font-weight:650;margin:0 0 14px;line-height:1.3}
.verdict.good{color:var(--good)}.verdict.bad{color:var(--bad)}
.verdict code{font-size:20px}
.verdict .since{font-size:14px;font-weight:400;color:var(--warn)}.verdict .since code{font-size:13px}
.stats{display:flex;flex-wrap:wrap;gap:10px 36px;margin-bottom:6px}
.stat .v{font-size:24px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.2}
.stat .v small{font-size:14px;color:var(--ink3);font-weight:400}
.stat .l{color:var(--ink2);font-size:12.5px}
.stat.bad .v{color:var(--bad)}.stat.good .v{color:var(--good)}.stat.warn .v{color:var(--warn)}
.bar{position:sticky;top:0;z-index:5;background:var(--bg);border-bottom:1px solid var(--line)}
.bar>div{max-width:1280px;margin:0 auto;padding:8px 24px;display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center}
nav{display:flex;gap:4px 14px;flex-wrap:wrap}
input[type=search]{font:inherit;padding:4px 9px;border:1px solid var(--line);border-radius:6px;width:220px;margin-left:auto}
button{font:inherit;padding:3px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg2);color:var(--ink);cursor:pointer}
button.mini{font-size:12px;padding:1px 8px;margin-left:10px;vertical-align:2px;font-weight:400}
main{max-width:1280px;margin:0 auto;padding:0 24px 80px}
section{scroll-margin-top:56px;margin-top:26px}
h2{font-size:16px;margin:0 0 8px}
h2 .muted{font-weight:400;font-size:13px;margin-left:4px}
h2 .n{font-size:12px;background:#ffebe9;color:var(--bad);border-radius:9px;padding:1px 7px;vertical-align:2px}
.muted{color:var(--ink3)}.bad{color:var(--bad)}.warn{color:var(--warn)}.caught{color:var(--good);white-space:nowrap}
table{border-collapse:collapse;width:100%}
.grid th{text-align:left;font-weight:600;color:var(--ink2);border-bottom:1px solid var(--line);padding:4px 8px;white-space:nowrap;font-size:12.5px}
.grid td{border-bottom:1px solid var(--line2);padding:4px 8px;vertical-align:top}
.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.w{white-space:nowrap;width:96px}
.m{display:inline-block;width:15px;font-weight:700;text-align:center;flex:none}
.m.pass{color:var(--good)}.m.fail{color:var(--bad)}.m.flaky{color:var(--warn)}.m.skip,.m.todo,.m.dnr{color:var(--ink3)}
.st{font-size:11px;padding:0 5px;border-radius:8px;background:var(--bg2);color:var(--ink2)}
.st.fail{background:#ffebe9;color:var(--bad)}.st.flaky{background:#fff8c5;color:var(--warn)}
ul.problems{list-style:none;margin:0;padding:0;border:1px solid #ffcecb;border-radius:8px;background:#fffbfb}
ul.problems li{padding:7px 12px;border-top:1px solid #ffe2df}ul.problems li:first-child{border-top:0}
ul.problems li.t{cursor:pointer}ul.problems li.t:hover{background:#fff1f0}
ul.problems .ck{font-size:12px;color:var(--ink2);background:var(--bg2);border-radius:6px;padding:0 6px}
ul.problems .why{color:var(--ink2);font-size:12.5px;margin:2px 0 0 19px;overflow-wrap:anywhere}
details>summary{cursor:pointer;list-style:none}
details>summary::-webkit-details-marker{display:none}
details>summary::before{content:"";display:inline-block;width:0;height:0;border:4px solid transparent;border-left:6px solid var(--ink3);margin-right:6px;vertical-align:1px;transition:transform .1s}
details[open]>summary::before{transform:rotate(90deg);transform-origin:3px 4px}
details.reg>summary h2,details.reg>summary h3{display:inline}details.reg>summary h3{font-size:14px}
details.area,details.file,details.bugfile,details.map{border-bottom:1px solid var(--line2)}
details.area>summary,details.file>summary,details.bugfile>summary,details.map>summary{display:flex;flex-wrap:wrap;gap:4px 12px;align-items:baseline;padding:6px 4px}
details.area>summary:hover,details.file>summary:hover,details.bugfile>summary:hover,details.map>summary:hover{background:var(--bg2)}
details.area>summary .pws{display:flex;gap:6px;margin-left:auto}
.pw{font-size:12px;border-radius:8px;padding:0 7px;white-space:nowrap}.pw.ok{background:#dafbe1;color:var(--good)}.pw.bad{background:#ffebe9;color:var(--bad)}
details.file>summary .path{flex:1 1 300px;overflow-wrap:anywhere}
details[open]>table{margin:2px 0 10px 18px;width:calc(100% - 18px)}
tr.t{cursor:pointer}tr.t:hover td{background:var(--bg2)}
td.name{overflow-wrap:anywhere}td.name a{color:var(--ink)}
.checks .run{color:var(--ink2)}
.bugtop{display:flex;flex-wrap:wrap;gap:6px 30px;align-items:center;margin-bottom:6px}
.bugtop .nums{margin:0;color:var(--ink2)}
.chart .bar{fill:#54aeff}.chart .bar.bad{fill:#a9c9ec}.chart .bar.replay{fill:#fff;stroke:#54aeff;stroke-width:1.5;stroke-dasharray:3 2}
.chart .gl{stroke:var(--line2)}.chart .min{stroke:var(--ink3);stroke-dasharray:3 3}
.chart .tick{font-size:9px;fill:var(--ink3)}.chart .lbl{font-size:10px;fill:var(--ink);font-weight:600}
.bugs td:nth-child(2){white-space:nowrap}
.out{font-size:11px;padding:0 6px;border-radius:8px;white-space:nowrap}
.out.caught{background:#dafbe1;color:var(--good)}.out.missed{background:#ffebe9;color:var(--bad)}.out.excluded,.out.stale{background:var(--bg2);color:var(--ink2)}
.hist{margin-left:6px;white-space:nowrap}.hist i{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:2px;background:var(--ink3)}
.hist i.caught{background:var(--good)}.hist i.missed{background:var(--bad)}
.hist i.rp{background:#fff;box-shadow:inset 0 0 0 1.5px var(--ink3)}.hist i.rp.caught{box-shadow:inset 0 0 0 1.5px var(--good)}.hist i.rp.missed{box-shadow:inset 0 0 0 1.5px var(--bad)}
td.code code{display:block;white-space:pre-wrap;overflow-wrap:anywhere}
code.before{color:var(--ink2)}code.before::before{content:"− ";color:var(--ink3)}
code.after{color:var(--ink)}code.after::before{content:"+ ";color:var(--ink3)}
.tag{font-size:11px;padding:0 6px;border-radius:8px;background:var(--bg2);color:var(--ink2)}
.tag.crit{background:#fff1e5;color:#953800}.tag.rp{border:1px dashed var(--ink3);background:#fff}
.dirs{columns:2 420px;column-gap:28px;margin-top:6px}
details.dir{break-inside:avoid;padding:2px 0}
details.dir>summary{display:flex;gap:10px}
details.dir ul{margin:2px 0 6px 18px;padding:0;font-family:ui-monospace,Consolas,monospace;font-size:12px;color:var(--ink2);list-style:none}
td.c{text-align:center;white-space:nowrap}td.c.ok{color:var(--good)}td.c.gap{color:var(--bad);background:#fff5f5;font-weight:600}
.gh td{background:var(--bg2)}
ul.plain{list-style:none;padding:0;margin:6px 0 0}
pre.err{margin:4px 0;padding:6px 10px;background:#fff5f5;border-left:2px solid var(--bad);color:#82071e;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}
.hidden{display:none!important}
#scrim{position:fixed;inset:0;background:rgba(31,35,40,.28);z-index:9}
#detail{position:fixed;top:0;right:0;bottom:0;width:min(980px,100%);background:var(--bg);z-index:10;overflow:auto;box-shadow:-8px 0 24px rgba(31,35,40,.15);padding:16px 24px 60px}
#detail .close{position:sticky;top:0;float:right;z-index:2}
#detail h2{font-size:18px;margin:0 90px 4px 0;overflow-wrap:anywhere}
#detail h3{font-size:14px;margin:22px 0 8px}
#detail .where{color:var(--ink2);font-size:12.5px}
.widths{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;margin-top:14px}
.wcard{border:1px solid var(--line);border-radius:8px;padding:10px 12px;min-width:0}
.wcard .top{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.wcard .top b{font-size:14px}
.wcard img{display:block;max-width:100%;max-height:520px;margin:10px auto 0;border:1px solid var(--line2);border-radius:4px;cursor:zoom-in}
.wcard .files{margin-top:6px;font-size:12.5px}
.dots{display:flex;gap:3px;flex-wrap:wrap;margin-top:8px}
.dots i{width:11px;height:11px;border-radius:2px;background:var(--line)}
.dots i.pass{background:#4ac26b}.dots i.fail{background:var(--bad)}.dots i.flaky{background:#d4a72c}
.dots i.none{background:#fff;box-shadow:inset 0 0 0 1px var(--line)}
.tabs{display:flex;gap:6px;margin-bottom:6px}
.tabs button[aria-pressed=true]{background:var(--ink);color:#fff;border-color:var(--ink)}
ol.steps{list-style:none;margin:0;padding:0;font-size:13px}
ol.steps li{display:flex;gap:8px;padding:2px 4px;border-bottom:1px solid var(--line2);align-items:baseline}
ol.steps li .t{flex:1;min-width:0;overflow-wrap:anywhere}
ol.steps li .sub{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:var(--ink2)}
ol.steps li.step>.t{font-weight:600}
ol.steps li.err{background:#fff5f5}ol.steps li.err .t{color:var(--bad)}
ol.steps li .ln{color:var(--accent);cursor:pointer;font-size:12px;font-family:ui-monospace,Consolas,monospace}
pre.src{margin:0;padding:8px 0;background:var(--bg2);border-radius:6px;overflow:auto;font-size:12.5px;line-height:1.5}
pre.src span{display:block;padding:0 12px 0 56px;text-indent:-56px;white-space:pre-wrap;overflow-wrap:anywhere}
pre.src span::before{content:attr(data-n);display:inline-block;width:44px;margin-right:12px;text-align:right;color:var(--ink3);text-indent:0}
pre.src span.hit{background:#fff8c5}pre.src span.on{background:#ddf4ff}
pre.out{margin:0;padding:8px 10px;background:var(--bg2);border-radius:6px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;max-height:320px;overflow:auto}
@media (max-width:700px){
header,.bar>div,main{padding-left:14px;padding-right:14px}
.verdict{font-size:19px}.verdict code{font-size:17px}
.stats{gap:8px 22px}.stat .v{font-size:20px}
input[type=search]{width:100%;margin-left:0}
.bar{position:static}
details.area>summary>.muted{display:none}
details.area>summary{flex-wrap:nowrap}
.pw{font-size:11.5px;padding:0 5px}
.checks .run,.checks .res,.bugs .op,.bugs .by,th.bugs,td.bugs{display:none}
.w{width:auto}
details[open]>table{margin-left:0;width:100%}
#detail{padding:12px 14px 60px}
#detail h2{font-size:16px;margin-right:70px}
}
`;

const JS = `
const D=JSON.parse(document.getElementById('data').textContent);
const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];
function el(tag,attrs,...kids){const e=document.createElement(tag);for(const[k,v]of Object.entries(attrs||{})){if(v==null||v===false)continue;if(k==='class')e.className=v;else if(k.startsWith('on'))e.addEventListener(k.slice(2),v);else e.setAttribute(k,v===true?'':v)}for(const k of kids.flat(Infinity)){if(k==null||k===false)continue;e.append(k instanceof Node?k:document.createTextNode(String(k)))}return e}
const WORD={pass:'pass',fail:'fail',flaky:'flaky',skip:'skipped',todo:'todo',dnr:'did not run'},GLYPH={pass:'✓',fail:'✘',flaky:'!',skip:'–',todo:'–',dnr:'·'};
const mk=s=>el('span',{class:'m '+s,title:WORD[s]},GLYPH[s]);
const ms=v=>v==null?'':v<1?v.toFixed(2)+'ms':v<1000?Math.round(v)+'ms':v<60000?(v/1000).toFixed(1)+'s':Math.floor(v/60000)+'m'+String(Math.round(v%60000/1000)).padStart(2,'0')+'s';
const when=iso=>{const d=new Date(iso),p=n=>String(n).padStart(2,'0');return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes())};
function render(i){const t=D.tests[i];if(!t)return close();
const run=t.run&&D.runs[t.run];
const box=$('#detail');box.replaceChildren();
box.append(el('button',{class:'close',onclick:()=>{history.length>1&&location.hash?history.back():close()}},'Close'));
box.append(el('h2',{},t.name));
box.append(el('div',{class:'where'},t.path+(t.line?':'+t.line:''),' · ',t.check,run?' · '+when(run.at)+' on ':'',run?el('code',{},run.sha.slice(0,7)):'',t.log?[' · ',el('a',{href:t.log},'log')]:''));
const cards=el('div',{class:'widths'});
for(const r of t.results){const c=el('div',{class:'wcard'});
c.append(el('div',{class:'top'},mk(r.st),el('b',{},r.w||WORD[r.st]),r.w?el('span',{},WORD[r.st]):'',el('span',{class:'muted'},ms(r.ms)),r.d&&r.d.attempts>1?el('span',{class:'warn'},r.d.attempts+' attempts'):''));
const runs=D.order.filter(id=>D.runs[id]);
if(r.recent.length){const seen=new Map(r.recent.map(x=>[x[0],x]));const dots=el('div',{class:'dots',title:'oldest to newest'});
for(const id of runs.slice().reverse()){const x=seen.get(id),R=D.runs[id];dots.append(el('i',{class:x?x[1]:'none',title:when(R.at)+' · '+R.sha.slice(0,7)+' · '+(x?WORD[x[1]]+(x[2]!=null?' · '+ms(x[2]):''):'not in that run')}))}
c.append(dots);
const bad=r.recent.filter(x=>x[1]==='fail').length,fl=r.recent.filter(x=>x[1]==='flaky').length;
c.append(el('div',{class:'muted'},bad||fl?[bad?'failed in '+bad:'',bad&&fl?', ':'',fl?'flaky in '+fl:'',' of the last '+r.recent.length+' runs']:r.recent.length===1?'passed in its one kept run':'passed in all '+r.recent.length+' kept runs'))}
if(r.d){for(const im of r.d.images)c.append(el('a',{href:im.src,target:'_blank'},el('img',{src:im.src,alt:(r.w||'')+' '+im.name,loading:'lazy'})));
if(r.d.files.length)c.append(el('div',{class:'files'},r.d.files.map((f,k)=>[k?' · ':'',el('a',{href:f.href},f.name)])))}
cards.append(c)}
box.append(cards);
const errs=t.results.filter(r=>r.st==='fail'||r.st==='flaky'||(r.d&&r.d.errors.length));
if(errs.length){box.append(el('h3',{},'Error'));const seen=new Map();for(const r of errs){const full=r.d&&r.d.errors.length?r.d.errors.map(e=>e.message+(e.snippet?'\\n\\n'+e.snippet:'')).join('\\n\\n'):(r.err||[]).join('\\n');if(full)seen.set(full,[...(seen.get(full)||[]),r.w].filter(Boolean))}for(const[full,ws]of seen)box.append(el('pre',{class:'err'},ws.length?el('b',{},ws.join(', ')+'  '):'',full))
const outs=t.results.filter(r=>r.d&&(r.d.stdout||r.d.stderr));for(const r of outs){box.append(el('details',{},el('summary',{},'Output'+(r.w?' ('+r.w+')':'')),el('pre',{class:'out'},(r.d.stdout||'')+(r.d.stderr?'\\n'+r.d.stderr:''))))}}
const withSteps=t.results.filter(r=>r.d&&r.d.steps.length);
let src=null;
if(withSteps.length){box.append(el('h3',{},'Steps'));const host=el('div');
const show=r=>{host.replaceChildren(el('ol',{class:'steps'},r.d.steps.map(s=>el('li',{class:(s.c==='test.step'?'step':'')+(s.err?' err':''),style:'padding-left:'+(4+s.d*18)+'px'},el('span',{class:'t'},s.t,s.sub?[' ',el('span',{class:'sub'},s.sub)]:'',s.p?[' ',el('span',{class:'sub'},s.p)]:'',s.err?el('div',{},s.err):''),s.line&&t.code?el('span',{class:'ln',onclick:()=>hit(s.line)},':'+s.line):'',el('span',{class:'muted num'},ms(s.ms))))))};
if(withSteps.length>1){const tabs=el('div',{class:'tabs'});withSteps.forEach((r,k)=>tabs.append(el('button',{'aria-pressed':String(k===0),onclick:e=>{$$('button',tabs).forEach(b=>b.setAttribute('aria-pressed','false'));e.target.setAttribute('aria-pressed','true');show(r)}},r.w)));box.append(tabs)}
show(withSteps[0]);box.append(host)}
if(t.code){box.append(el('h3',{},'Code ',el('span',{class:'muted'},'at ',el('code',{},t.code.sha.slice(0,7)))));const lines=t.code.text.split('\\n');const stepLines=new Set(withSteps.flatMap(r=>r.d.steps.map(s=>s.line)).filter(Boolean));
src=el('pre',{class:'src'},lines.map((l,k)=>el('span',{'data-n':String(t.code.start+k),class:stepLines.has(t.code.start+k)?'hit':null},l||' ')));box.append(src)}
if(t.bugs.length){box.append(el('h3',{},'Planted bugs it caught'));box.append(el('table',{class:'grid bugs'},el('tbody',{},t.bugs.map(b=>el('tr',{},el('td',{class:'path'},b.file+':'+b.line),el('td',{class:'code'},el('code',{class:'before'},b.before),el('code',{class:'after'},b.after)))))))}
function hit(n){if(!src)return;$$('span.on',src).forEach(s=>s.classList.remove('on'));const s=src.children[n-t.code.start];if(s){s.classList.add('on');s.scrollIntoView({block:'center',behavior:'smooth'})}}
box.classList.remove('hidden');$('#scrim').classList.remove('hidden');document.body.style.overflow='hidden';box.scrollTop=0;box.focus()}
function close(){$('#detail').classList.add('hidden');$('#scrim').classList.add('hidden');document.body.style.overflow='';if(location.hash.startsWith('#t'))history.replaceState(null,'',location.pathname+location.search)}
function route(){const m=/^#t(\\d+)$/.exec(location.hash);if(m)render(Number(m[1]));else{$('#detail').classList.add('hidden');$('#scrim').classList.add('hidden');document.body.style.overflow='';const id=decodeURIComponent(location.hash.slice(1));const target=id&&document.getElementById(id);for(let d=target;d;d=d.parentElement)if(d.tagName==='DETAILS')d.open=true;if(target)target.scrollIntoView()}}
addEventListener('hashchange',route);route();
$('#scrim').addEventListener('click',()=>history.back());
addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('#detail').classList.contains('hidden'))history.back()});
document.addEventListener('click',e=>{const row=e.target.closest('[data-t]');if(!row||e.target.closest('a'))return;location.hash='t'+row.dataset.t});
$$('[data-expand]').forEach(b=>b.addEventListener('click',()=>{const ds=$$('details',document.getElementById(b.dataset.expand));const open=ds.some(d=>!d.open);ds.forEach(d=>d.open=open);b.textContent=open?'Collapse all':'Expand all'}));
const q=$('#q');
q.addEventListener('input',()=>{const v=q.value.trim().toLowerCase();
$$('[data-q]').forEach(e=>{const own=e.dataset.q.includes(v);const any=$$('[data-q]',e).some(k=>k.dataset.q.includes(v));e.classList.toggle('hidden',!!v&&!own&&!any)});
$$('details.area,details.file,details.bugfile,details.map,details.reg,details.dir').forEach(d=>{if(!v){d.classList.remove('hidden');return}const hits=$$('[data-q]',d).filter(k=>!k.classList.contains('hidden'));const own=d.dataset.q&&d.dataset.q.includes(v);d.classList.toggle('hidden',!hits.length&&!own);if(hits.length)d.open=true})});
`;

export function renderTestsPage(page: TestsPage): string {
  const { report: r, coverage: cov } = page;
  const built = buildTests(page);
  const caught = cov.caughtByTitle;
  const v = verdict(r);
  const checks = r.checks.filter((c) => c.files.length);
  const flowChecks = checks.filter((c) => c.flows);
  const bunChecks = checks.filter((c) => !c.flows);
  const sections: [string, string, string][] = [
    ["problems", "Problems", problems(page, built)],
    ["checks", "Checks", `<section id="checks"><h2>Checks</h2>${checksTable(r)}</section>`],
    ...flowChecks.map((c): [string, string, string] => [`check-${c.name}`, c.name, checkSection(c, built, caught)]),
    ...bunChecks.map((c): [string, string, string] => [`check-${c.name}`, c.name, checkSection(c, built, caught)]),
    ["bugs", "Planted bugs", bugsSection(page)],
    ["maps", "Coverage maps", mapsSection(r)],
    ["untouched", "Never probed", untouchedSection(cov)],
    ["notrun", "Not run yet", notRunSection(r)],
  ];
  const nav = sections
    .filter(([, , html]) => html)
    .map(([id, label]) => `<a href="#${esc(id)}">${esc(label)}</a>`)
    .join("");
  const runs: Record<string, { at: string; sha: string }> = {};
  for (const k of r.kept ?? []) runs[k.run] = { at: k.at, sha: k.sha };
  for (const c of r.checks) if (c.from) runs[c.from.run] ??= { at: c.from.at, sha: c.from.sha };
  const data = JSON.stringify({ tests: built.tests, runs, order: (r.kept ?? []).map((k) => k.run) }).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(r.repo)} tests</title><style>${CSS}</style></head>
<body><header><h1>${esc(r.repo)} tests</h1><p class="verdict ${v.cls}">${v.text}</p><div class="stats">${stats(page)}</div></header>
<div class="bar"><div><nav>${nav}</nav><input type="search" id="q" placeholder="Filter" aria-label="Filter tests, files and bugs"></div></div>
<main>${sections.map(([, , html]) => html).join("\n")}<p class="muted foot">Made ${esc(localTime(page.at))} · HEAD <code>${short(r.head)}</code> · ${esc(r.headState)}</p></main>
<div id="scrim" class="hidden"></div><aside id="detail" class="hidden" tabindex="-1" aria-label="Test detail"></aside>
<script type="application/json" id="data">${data}</script>
<script>${JS}</script></body></html>
`;
}
