// `gate tests --html` and coverage maps: the page builder on a hand-made
// report (pure), then end to end on a sandbox repo whose check writes maps to
// $GATE_COVERAGE.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { codeKey, detailKey, renderTestsPage, splitTitle, type ResultDetail, type TestCode } from "../../src/lib/gate/html.ts";
import type { MapEntry } from "../../src/lib/gate/maps.ts";
import type { ProbeCoverage } from "../../src/lib/gate/probe/coverage.ts";
import type { CheckRow, TestRow, TestsReport } from "../../src/lib/gate/tests.ts";
import { FIXTURES, gate, makeRepo, must, sandbox } from "./helpers.ts";

setDefaultTimeout(60_000);

const sb = sandbox();
afterAll(() => sb.cleanup());

const run = { run: "r1", at: "2026-11-22T10:00:00.000Z", sha: "a".repeat(40), trigger: "manual" as const, dirty: false };
const counts = (pass: number, fail = 0) => ({ pass, fail, flaky: 0, skip: 0, todo: 0, dnr: 0 });
const t = (name: string, extra: Partial<TestRow> = {}): TestRow => ({
  name,
  status: "pass",
  ms: 12,
  history: { runs: 1, failed: 0, flaky: 0 },
  clean: true,
  ...extra,
});

const rules: CheckRow = {
  name: "rules",
  state: "fail",
  ms: 800,
  from: run,
  newest: true,
  log: "/w/junk/demo/.gate/runs/r1/rules.log",
  tests: 2,
  summaryTotal: null,
  counts: counts(1, 1),
  files: [
    {
      path: "src/lib/price.rule.test.ts",
      runner: "bun",
      caught: 1,
      tests: [
        t("price > rounds half up"),
        t("price > <script>alert(1)</script> never runs", { status: "fail", clean: false, error: ["error: expect(received).toBe(expected)", "Expected: 3"], history: { runs: 1, failed: 1, flaky: 0 } }),
      ],
    },
  ],
};

const flows: CheckRow = {
  name: "flows",
  state: "pass",
  ms: 9000,
  from: run,
  newest: true,
  log: null,
  tests: 4,
  summaryTotal: null,
  counts: counts(4),
  flows: { flows: 2, widths: ["desktop", "phone"] },
  files: [
    {
      path: "e2e/auth.flow.spec.ts",
      runner: "playwright",
      caught: 0,
      tests: [
        t("auth/sign-in · a wrong password says so", { project: "desktop", loc: "5:1" }),
        t("auth/sign-in · a wrong password says so", { project: "phone", loc: "5:1", ms: 2100 }),
        t("on an empty database › shell/home · the home page shows its heading", { project: "desktop", loc: "9:3" }),
        t("on an empty database › shell/home · the home page shows its heading", { project: "phone", loc: "9:3" }),
      ],
    },
  ],
};

const report: TestsReport = {
  repo: "demo",
  head: "b".repeat(40),
  tree: "c".repeat(40),
  receipt: false,
  lastRun: { ...run, ok: false, failedAt: "rules", only: null, commitsSince: 0 },
  headState: "HEAD failed at rules",
  probe: null,
  probeReplaysSince: 0,
  probes: 2,
  runsKept: 1,
  checks: [rules, flows],
  notRunYet: ["src/new.api.test.ts"],
  maps: [
    {
      check: "flows",
      run: "r1",
      file: "/w/junk/demo/.gate/runs/r1/coverage/flows/screens.json",
      gaps: 1,
      map: {
        title: "Screens × widths",
        columns: ["desktop", "phone"],
        rows: [
          { item: "/sign-in", group: "auth", cells: { desktop: true, phone: true }, coveredBy: ["auth/sign-in · a wrong password says so"] },
          { item: "/settings", group: "studio", cells: { desktop: true, phone: false }, coveredBy: ["settings/x · a title no run has"] },
        ],
      },
    },
    { check: "flows", run: "r1", file: "/w/junk/demo/.gate/runs/r1/coverage/flows/broken.json", error: "columns: Required" },
  ] satisfies MapEntry[],
};

const sampled = { at: "2026-11-21T10:00:00.000Z", sha: "d".repeat(40), source: "sample" as const, replay: false, rate: 0.75, minRate: 0.9, counted: 4, caught: 3, missed: 1, exit: 1 };
const coverage: ProbeCoverage = {
  timeline: [
    { at: "2026-11-20T10:00:00.000Z", sha: "f".repeat(40), source: "sample", replay: false, rate: 0.5, minRate: 0.9, counted: 2, caught: 1, missed: 1, exit: 1 },
    sampled,
    // a replay of fixed misses: 100%, and not the headline
    { at: "2026-11-22T10:00:00.000Z", sha: "e".repeat(40), source: "from", replay: true, from: "misses.jsonl", rate: 1, minRate: 0.9, counted: 1, caught: 1, missed: 0, exit: 0 },
  ],
  newestSampled: sampled,
  files: [
    {
      path: "src/lib/price.ts",
      critical: true,
      excludedNow: null,
      caught: 1,
      missed: 2,
      other: 0,
      bugs: [
        { line: 4, op: "flip-rel", before: "if (n < 0) return 0;", after: "if (n >= 0) return 0;", outcome: "missed", tests: [], at: sampled.at, sha: sampled.sha, replay: false, seen: [{ at: sampled.at, outcome: "missed", replay: false }] },
        {
          line: 9,
          op: "off-by-one",
          before: "return Math.round(n * 100) / 100;",
          after: "return Math.round(n * 101) / 100;",
          outcome: "caught",
          check: "rules",
          tests: [{ title: "price > rounds half up", file: "src/lib/price.rule.test.ts", projects: [] }],
          at: "2026-11-22T10:00:00.000Z",
          sha: "e".repeat(40),
          replay: true,
          seen: [
            { at: sampled.at, outcome: "missed", replay: false },
            { at: "2026-11-22T10:00:00.000Z", outcome: "caught", replay: true },
          ],
        },
        { line: 12, op: "drop-not", before: "if (!ok) throw err;", after: "if (ok) throw err;", outcome: "missed", tests: [], at: "2026-11-20T10:00:00.000Z", sha: "f".repeat(40), replay: false, seen: [{ at: "2026-11-20T10:00:00.000Z", outcome: "missed", replay: false }] },
      ],
    },
  ],
  candidates: 3,
  untouched: ["src/app/home.tsx", "src/app/settings.tsx"],
  caughtByTitle: { "price > rounds half up": 1 },
  noProbeConfig: false,
};

/** The page's embedded data: what the drawer draws a test from. */
function pageData(html: string): { tests: { name: string; check: string; results: { w: string; st: string; recent: unknown[]; d?: { steps: { t: string }[]; images: { src: string }[] } }[]; code?: { text: string; start: number }; bugs: unknown[] }[]; runs: Record<string, unknown> } {
  const m = /<script type="application\/json" id="data">([\s\S]*?)<\/script>/.exec(html);
  return JSON.parse(m?.[1] ?? "{}");
}

describe("the page builder", () => {
  const details: Record<string, ResultDetail> = {
    [detailKey("e2e/auth.flow.spec.ts", "phone", "auth/sign-in · a wrong password says so")]: {
      steps: [{ t: "Click", sub: "getByRole('button', { name: 'Sign in' })", c: "pw:api", d: 0, ms: 40, line: 6 }],
      errors: [],
      stdout: "",
      stderr: "",
      images: [{ name: "screenshot", src: "runs/r1/artifacts/flows/abc/screenshot-0.webp" }],
      files: [],
      attempts: 1,
    },
  };
  const code: Record<string, TestCode> = {
    [codeKey("e2e/auth.flow.spec.ts", "auth/sign-in · a wrong password says so")]: { sha: "a".repeat(40), path: "e2e/auth.flow.spec.ts", start: 5, text: "test('auth/sign-in · a wrong password says so', async ({ page }) => {\n  await page.getByRole('button').click();\n});" },
  };
  const html = renderTestsPage({ report, coverage, at: "2026-11-22T12:00:00.000Z", details, code });

  test("one page: no external script, style, font or image, no dark mode", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toMatch(/<(script|link|img)[^>]+(src|href)=["']?https?:/i);
    expect(html).not.toMatch(/@import|url\(\s*["']?https?:/i);
    expect(html).not.toContain("prefers-color-scheme");
    expect(html).not.toMatch(/\.dark\b/);
    // the data can't close its own script tag
    expect(html.match(/<\/script>/g)?.length).toBe(2);
  });

  test("answer first: red or green on which commit, then the numbers", () => {
    expect(html).toMatch(/<p class="verdict bad">✘ Red on <code>aaaaaaa<\/code>: failed at rules <span class="since">· HEAD <code>bbbbbbb<\/code>/);
    expect(html).toMatch(/<div class="v">6<\/div><div class="l">test results<\/div>/);
    expect(html).toMatch(/<div class="stat bad"><div class="v">1<\/div><div class="l">failing<\/div>/);
  });

  test("problems first: the failing test, the planted bugs that passed, the map gaps, files not run", () => {
    const probs = html.slice(html.indexOf('<section id="problems">'), html.indexOf('<section id="checks">'));
    expect(probs).toContain("price &gt; &lt;script&gt;alert(1)&lt;/script&gt; never runs");
    expect(probs).toContain("error: expect(received).toBe(expected)");
    expect(probs).toMatch(/2 planted bugs passed every check<\/b>, <span class="bad">2 in critical files/);
    expect(probs).toContain("Screens × widths</a>: 1 gap");
    expect(probs).toContain("broken.json</a> isn't a coverage map");
    expect(probs).toContain("1 test file</a> no kept run named");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  test("registers are opt-in: green files and areas closed, red ones open", () => {
    expect(html).toMatch(/<details class="file" open data-q="src\/lib\/price\.rule\.test\.ts">/);
    expect(html).toMatch(/<details class="area clean"><summary>.*<b>auth<\/b>/);
    expect(html).toMatch(/<details class="reg" id="bugfiles">/);
  });

  test("flows: grouped by area, one row per flow, each width side by side", () => {
    const flowsHtml = html.slice(html.indexOf('id="check-flows"'), html.indexOf('id="check-rules"'));
    expect(flowsHtml).toMatch(/<th class="w">desktop<\/th><th class="w">phone<\/th>/);
    expect(flowsHtml).toMatch(/<b>auth<\/b><span class="muted">1 flow<\/span><span class="pws"><span class="pw ok">desktop 1\/1<\/span><span class="pw ok">phone 1\/1<\/span>/);
    expect(flowsHtml).toMatch(/<b>shell<\/b>/);
    expect(flowsHtml).toContain("on an empty database › ");
    expect(flowsHtml.match(/>sign-in · a wrong password says so<\/a>/g)?.length).toBe(1);
    expect(flowsHtml).toContain("2.1s");
  });

  test("a test opens from the data: results per width with history, steps, screenshots, its code, the bugs it caught", () => {
    const d = pageData(html);
    const flow = d.tests.find((t) => t.name === "auth/sign-in · a wrong password says so");
    expect(flow?.check).toBe("flows");
    expect(flow?.results.map((r) => r.w)).toEqual(["desktop", "phone"]);
    const phone = flow?.results[1];
    expect(phone?.d?.steps[0]?.t).toBe("Click");
    expect(phone?.d?.images[0]?.src).toBe("runs/r1/artifacts/flows/abc/screenshot-0.webp");
    expect(flow?.code?.start).toBe(5);
    expect(flow?.code?.text).toContain("getByRole('button')");
    expect(html).toMatch(new RegExp(`data-t="${d.tests.indexOf(flow as never)}"`));
    const rounds = d.tests.find((t) => t.name === "price > rounds half up");
    expect(rounds?.bugs).toHaveLength(1);
  });

  test("planted bugs per source file, what caught each, older misses, files never probed, the catch rate", () => {
    expect(html).toContain("src/lib/price.ts");
    expect(html).toContain('class="tag crit">critical');
    expect(html).toContain("if (n &gt;= 0) return 0;");
    expect(html).toMatch(/<b>rules<\/b>: price &gt; rounds half up/);
    expect(html).toMatch(/missed in the probe of 2026-11-20 [\d:]+ \(<code>fffffff<\/code>\), not planted since/);
    // the newest sampled probe's own miss needs no note
    expect(html).not.toMatch(/missed in the probe of 2026-11-21/);
    expect(html).toContain("Never probed");
    expect(html).toContain("src/app/");
    expect(html).toContain("home.tsx");
    expect(html).toMatch(/<svg class="chart"[\s\S]*minRate 90%/);
  });

  test("the headline catch rate is the newest sampled probe's; replays are marked and keep their own result", () => {
    const top = html.slice(0, html.indexOf("</header>"));
    expect(top).toMatch(/<div class="stat bad" title="newest sampled probe, 2026-11-2[01] [\d:]+ on ddddddd · 1 --from replay not counted"><div class="v">75%<small> \/ 90%<\/small><\/div><div class="l">catch rate<\/div>/);
    expect(top).toMatch(/<div class="v">1<\/div><div class="l">missed in that probe<\/div>/);
    expect(top).not.toMatch(/<div class="v">100%/);
    // the chart: the replay's bar is drawn as a replay, says so, and still shows its 100%
    const bugs = html.slice(html.indexOf('<section id="bugs">'));
    expect(bugs).toContain("replay of misses.jsonl · caught 1 of 1 (100%)");
    expect(bugs).toContain('class="bar replay"');
    expect(bugs).toMatch(/class="tick" text-anchor="middle">replay<\/text>/);
    expect(bugs).toMatch(/class="lbl" text-anchor="middle">75%<\/text>/);
    expect(bugs).toMatch(/class="tick" text-anchor="middle">100%<\/text>/);
    // the planted-bugs list: the replay's own result (caught), marked as a replay
    const row9 = html.slice(html.indexOf('<td class="num">9</td>'), html.indexOf('<td class="num">12</td>'));
    expect(row9).toMatch(/<span class="out caught">caught<\/span> <span class="tag rp"[^>]*>replay<\/span>/);
    expect(row9).toContain('<i class="caught rp"></i>');
    expect(html).toContain("(1 replay)");
  });

  test("coverage maps: a grid per map, gaps marked, covering titles checked against the last run", () => {
    expect(html).toContain("Screens × widths");
    expect(html).toMatch(/<td class="c gap"[^>]*>✘/);
    expect(html).toContain("1 not in the last run");
    expect(html).toContain("not a coverage map");
    expect(html).toContain("columns: Required");
  });

  test("no eyebrows, no period at the end of a heading", () => {
    for (const m of html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/g)) expect(m[1]?.replace(/<[^>]+>/g, "").trim()).not.toMatch(/\.$/);
  });

  test("splitTitle reads the standard's titles", () => {
    expect(splitTitle("auth/sign-in · a wrong password says so")).toEqual({ feature: "auth", prefix: "", title: "sign-in · a wrong password says so" });
    expect(splitTitle("on an empty db › demo/posts-empty · nothing yet")).toEqual({ feature: "demo", prefix: "on an empty db", title: "posts-empty · nothing yet" });
    expect(splitTitle("price > rounds half up").feature).toBeNull();
  });
});

describe("coverage maps and --html on a repo", () => {
  const map = JSON.stringify({
    title: "Screens × widths",
    columns: ["desktop", "phone"],
    rows: [
      { item: "/", cells: { desktop: true, phone: true }, coveredBy: ["shell/home · the home page shows its heading"] },
      { item: "/settings", cells: { desktop: true, phone: { ok: false, text: "no flow" } } },
    ],
  });
  let dir = "";

  test("a check writes maps to $GATE_COVERAGE; gate tests lists them and --json carries them", () => {
    dir = makeRepo(
      sb,
      "maps-repo",
      { "e2e/shell.flow.spec.ts": "// replayed from a fixture\n" },
      {
        version: 1,
        mode: "report",
        checks: [
          {
            name: "flows",
            run: `cat ${join(FIXTURES, "tests-pw-widths-pass.txt")}; test -d "$GATE_COVERAGE" && printf '%s' '${map}' > "$GATE_COVERAGE/screens.json" && echo '{"title":"x"}' > "$GATE_COVERAGE/broken.json"`,
          },
        ],
      },
    );
    expect(gate(sb, dir, []).code).toBe(0);
    const text = gate(sb, dir, ["tests"], { env: { COLUMNS: "100" } }).stdout;
    expect(text).toContain("\ncoverage maps\n");
    expect(text).toMatch(/^ {2}! Screens × widths +2 rows × 2 · 1 with a gap {2}flows$/m);
    expect(text).toMatch(/✘ broken\.json +not a map: columns: /);

    const j: TestsReport = JSON.parse(gate(sb, dir, ["tests", "--json"]).stdout);
    const ok = j.maps.find((m) => m.map);
    expect(ok?.check).toBe("flows");
    expect(ok?.gaps).toBe(1);
    expect(ok?.file).toMatch(/\/runs\/[a-z0-9]{8}\/coverage\/flows\/screens\.json$/);
    expect(j.maps.find((m) => !m.map)?.error).toContain("columns");
  });

  test("--html writes one page in the work root, prints its path, and opens it with GATE_OPEN", () => {
    const quiet = gate(sb, dir, ["tests", "--html", "--no-open", "--json"]);
    expect(quiet.code).toBe(0);
    const page = JSON.parse(quiet.stdout) as { path: string; win: string; opened: boolean };
    expect(page.path).toBe(join(sb.work, "maps_repo", "tests.html"));
    expect(page.opened).toBe(false);
    const html = readFileSync(page.path, "utf8");
    expect(html).toContain("<title>maps-repo tests</title>");
    expect(html).toContain("Screens × widths");
    expect(html).toContain("no flow");

    const human = gate(sb, dir, ["tests", "--html", "--no-open"]);
    expect(human.stdout.trim()).toBe(page.win);

    const rec = join(sb.dir, "opened.txt");
    const opener = join(sb.dir, "opener.sh");
    Bun.write(opener, `#!/bin/sh\necho "$1" > ${rec}\n`);
    Bun.spawnSync(["chmod", "+x", opener]);
    const opened = gate(sb, dir, ["tests", "--html", "--json"], { env: { GATE_OPEN: opener, WSL_DISTRO_NAME: "sal" } });
    expect(JSON.parse(opened.stdout).opened).toBe(true);
    for (let i = 0; i < 50 && !existsSync(rec); i++) Bun.sleepSync(20);
    expect(readFileSync(rec, "utf8").trim()).toBe(page.path);
  });

  test("stored probes: a newer --from replay takes the headline nowhere: the page, gate tests, gate status, probe report", () => {
    const sha = must(dir, "git rev-parse HEAD", sb.env).trim();
    storeProbe(dir, sha, "2026-11-21T10:00:00.000Z", "sample", "pppppppp", [bug("caught", 1), bug("caught", 2), bug("caught", 3), bug("missed", 4)]);
    storeProbe(dir, sha, "2026-11-22T10:00:00.000Z", "from", "rrrrrrrr", [bug("caught", 4)]);

    const out = JSON.parse(gate(sb, dir, ["tests", "--html", "--no-open", "--json"]).stdout) as { path: string };
    const html = readFileSync(out.path, "utf8");
    expect(html).toMatch(/<div class="v">75%<small> \/ 90%<\/small><\/div><div class="l">catch rate<\/div>/);
    expect(html).toContain("replay of misses.jsonl · caught 1 of 1 (100%)");
    // line 4: missed by the sample, caught by the replay: the replay's own result, marked
    expect(html).toMatch(/<td class="num">4<\/td><td><span class="out caught">caught<\/span> <span class="tag rp"/);

    // gate tests: the same number, the replay named and not counted
    const tests = gate(sb, dir, ["tests"]).stdout;
    expect(tests).toMatch(/^probe {6}2026-11-2[01] · [0-9a-f]{7} · caught 75% · 1 missed · newest sampled · 1 --from replay since, not counted$/m);
    const tj: TestsReport = JSON.parse(gate(sb, dir, ["tests", "--json"]).stdout);
    expect(tj.probe?.rate).toBe(0.75);
    expect(tj.probeReplaysSince).toBe(1);

    // gate status: the probe line, the facts line, the replay's run in the runs list
    const st = gate(sb, dir, ["status"]).stdout;
    expect(st).toMatch(/^probe {4}2026-11-2[01] [\d:]+ {2}[0-9a-f]{7} {2}catch rate 75% · 1 missed · exit 1 · newest sampled · 1 --from replay since, not counted$/m);
    expect(st).toContain("the newest sampled probe failed (catch rate 75% is below minRate 90%)");
    expect(st).toMatch(/^ {2}2026-11-2[12] [\d:]+ {2}[0-9a-f]{7} {2}rrrrrrrr {2}replay {3}pass/m);
    const sj = JSON.parse(gate(sb, dir, ["status", "--json"]).stdout) as { probe: { rate: number }; probeReplaysSince: number; replayRuns: string[] };
    expect(sj.probe.rate).toBe(0.75);
    expect(sj.probeReplaysSince).toBe(1);
    expect(sj.replayRuns).toEqual(["rrrrrrrr"]);

    // gate probe report lists both, the replay as a replay
    const rep = gate(sb, dir, ["probe", "report"]).stdout;
    expect(rep).toMatch(/ 75% {2}3\/4 caught {2}1 missed {2}exit 1\n/);
    expect(rep).toMatch(/100% {2}1\/1 caught {2}0 missed {2}exit 0 {2}replay of misses\.jsonl\n/);
  });

  test("only replays stored: no headline, and every place says why", () => {
    const only = makeRepo(sb, "replays-only", { "a.txt": "a\n" }, { version: 1, mode: "report", checks: [{ name: "ok", run: "true" }] });
    const sha = must(only, "git rev-parse HEAD", sb.env).trim();
    storeProbe(only, sha, "2026-11-22T10:00:00.000Z", "from", "rrrrrrrr", [bug("caught", 4)]);
    expect(gate(sb, only, ["status"]).stdout).toContain("probe    no sampled probe yet: gate probe (1 --from replay stored, not counted)\n");
    expect(gate(sb, only, ["status"]).stdout).toContain("no sampled probe yet, only --from replays (run gate probe)");
    expect(gate(sb, only, ["tests"]).stdout).toContain("probe      no sampled probe yet: gate probe (1 --from replay stored, not counted)\n");
    const page = JSON.parse(gate(sb, only, ["tests", "--html", "--no-open", "--json"]).stdout) as { path: string };
    expect(readFileSync(page.path, "utf8")).toContain('<div class="v">—</div><div class="l">no sampled probe yet, only replays</div>');
  });
});

function bug(outcome: "caught" | "missed", line: number) {
  return {
    file: "src/x.ts", line, op: "flip-eq", before: `a === ${line}`, after: `a !== ${line}`, outcome,
    ...(outcome === "caught" ? { check: "flows" } : {}), failing: [], ms: 5,
  };
}

/** A stored probe result, and its history line, as gate probe writes them. */
function storeProbe(repoDir: string, sha: string, at: string, source: "sample" | "from", run: string, bugs: ReturnType<typeof bug>[]): void {
  const gitDir = resolve(repoDir, must(repoDir, "git rev-parse --git-common-dir", sb.env).trim(), "gate");
  mkdirSync(join(gitDir, "probes"), { recursive: true });
  const caught = bugs.filter((b) => b.outcome === "caught").length;
  const ok = caught === bugs.length;
  const rate = caught / bugs.length;
  const result = {
    v: 1, at, run, repo: "maps-repo", sha, tree: "t", commitAt: new Date().toISOString(), gate: "1", source,
    ...(source === "from" ? { from: "/w/junk/maps-repo/misses.jsonl" } : { seed: 1, max: 30 }), ms: 100, baseline: [], bugs,
    summary: { counted: bugs.length, caught, missed: bugs.length - caught, excluded: 0, stale: 0, byCheck: { flows: caught }, rate, minRate: 0.9, criticalMissed: [], ok, why: ok ? [] : [`catch rate ${Math.round(rate * 100)}% is below minRate 90%`] },
    exit: ok ? 0 : 1,
  };
  writeFileSync(join(gitDir, "probes", `${at.replace(/:/g, "-")}-${run}.json`), JSON.stringify(result));
  const line = { at, run, sha, tree: "t", mode: "report", trigger: "probe", dirty: false, only: null, ok, ms: 100, checks: [{ name: "flows", ok: true, ms: 50 }] };
  writeFileSync(join(gitDir, "history.jsonl"), `${JSON.stringify(line)}\n`, { flag: "a" });
}
