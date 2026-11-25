// Test detail a log can't carry: gate's Playwright reporter (handed to every
// check through PW_TEST_REPORTER, writing to $GATE_ARTIFACTS), the run's
// artifacts on the tests page, each test's code, and the disk bound.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KEEP_ARTIFACT_RUNS, pruneArtifacts } from "../../src/lib/gate/artifacts.ts";
import { blockFrom, testSpan, titleLine } from "../../src/lib/gate/source.ts";
import type { TestsReport } from "../../src/lib/gate/tests.ts";
import { FIXTURES, gate, makeRepo, sandbox } from "./helpers.ts";

setDefaultTimeout(60_000);

const sb = sandbox();
afterAll(() => sb.cleanup());

// a real 1×1 PNG, so ffmpeg (when it's on PATH) can re-encode it
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const TITLE = "auth/sign-up · an 8-character password signs a new person up onto their dashboard";

// Stands in for Playwright: loads the reporter gate handed it and feeds it one finished test.
const FAKE_PLAYWRIGHT = `
const path = require("node:path");
const Reporter = require(process.env.PW_TEST_REPORTER);
const file = path.join(process.env.GATE_ROOT, "e2e/auth.flow.spec.ts");
const r = new Reporter();
r.onTestEnd(
  { titlePath: () => ["", "desktop", "e2e/auth.flow.spec.ts", ${JSON.stringify(TITLE)}], location: { file, line: 6, column: 1 }, expectedStatus: "passed" },
  {
    status: "passed", duration: 1200, startTime: new Date(), retry: 0, errors: [], stdout: [], stderr: [],
    steps: [
      { title: "fixture: page", category: "fixture", duration: 1, steps: [] },
      { title: "Fill", subtitle: "getByLabel('Password')", params: { value: "hunter22" }, category: "pw:api", duration: 5, location: { file, line: 7 }, steps: [] },
      { title: "Navigate", subtitle: "/dashboard", params: { url: "/dashboard" }, category: "pw:api", duration: 9, location: { file, line: 8 }, steps: [] },
    ],
    attachments: [{ name: "screenshot", contentType: "image/png", path: path.join(process.env.GATE_ROOT, "shot.png") }],
  },
);
`;

const SPEC = ["import { test, expect } from '@playwright/test';", "", "// the sign-up flows", "", "", `test('${TITLE}', async ({ page }) => {`, "  await page.getByLabel('Password').fill('hunter22');", "  await page.goto(`/dashboard?from=${'{'}x{'}'}`);", "});", ""].join("\n");

describe("gate's Playwright reporter, end to end", () => {
  test("every check gets PW_TEST_REPORTER and $GATE_ARTIFACTS; the page shows the steps, the screenshot and the code", () => {
    const dir = makeRepo(
      sb,
      "art-repo",
      { "fake-playwright.cjs": FAKE_PLAYWRIGHT, "e2e/auth.flow.spec.ts": SPEC, "shot.png.b64": PNG },
      {
        version: 1,
        mode: "report",
        checks: [{ name: "flows", run: `base64 -d shot.png.b64 > shot.png && node fake-playwright.cjs && cat ${join(FIXTURES, "tests-pw-widths-pass.txt")}` }],
      },
    );
    expect(gate(sb, dir, []).code).toBe(0);
    const runs = join(sb.work, "art_repo", "runs");
    const run = readdirSync(runs)[0] ?? "";
    const art = join(runs, run, "artifacts", "flows");
    const lines = readFileSync(join(art, "results.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0] ?? "{}") as { title: string; steps: { t: string; p?: string; c: string }[]; attachments: { file: string; type: string }[] };
    expect(rec.title).toBe(TITLE);
    // fixtures are left out; a password field's value never lands on disk; a URL the subtitle shows isn't repeated
    expect(rec.steps.map((s) => s.t)).toEqual(["Fill", "Navigate"]);
    expect(rec.steps[0]?.p).toBe("•••");
    expect(rec.steps[1]?.p).toBeUndefined();
    expect(readFileSync(join(art, "results.jsonl"), "utf8")).not.toContain("hunter22");
    const shot = rec.attachments[0];
    const ext = Bun.which("ffmpeg") ? "webp" : "png";
    expect(shot?.file).toMatch(new RegExp(`^[0-9a-f]{12}/screenshot-0\\.${ext}$`));
    expect(shot?.type).toBe(`image/${ext}`);
    expect(existsSync(join(art, shot?.file ?? "x"))).toBe(true);

    // --json keeps its shape: no per-run history unless the page asks
    const j: TestsReport = JSON.parse(gate(sb, dir, ["tests", "--json"]).stdout);
    expect(j.kept).toBeUndefined();
    expect(j.checks[0]?.files[0]?.tests[0]?.history.recent).toBeUndefined();

    const page = JSON.parse(gate(sb, dir, ["tests", "--html", "--no-open", "--json"]).stdout) as { path: string };
    const html = readFileSync(page.path, "utf8");
    const data = JSON.parse(/<script type="application\/json" id="data">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "{}") as {
      tests: { name: string; results: { w: string; recent: [string, string, number | null][]; d?: { steps: { t: string }[]; images: { src: string }[] } }[]; code?: { start: number; text: string; sha: string } }[];
      runs: Record<string, { sha: string }>;
    };
    const flow = data.tests.find((t) => t.name === TITLE);
    const desktop = flow?.results.find((r) => r.w === "desktop");
    expect(desktop?.d?.steps.map((s) => s.t)).toEqual(["Fill", "Navigate"]);
    expect(desktop?.d?.images[0]?.src).toBe(`runs/${run}/artifacts/flows/${shot?.file}`);
    expect(desktop?.recent).toEqual([[run, "pass", 1200]]);
    expect(data.runs[run]?.sha).toHaveLength(40);
    // the code, from the commit the run checked, cut at the test's own closing bracket
    expect(flow?.code?.start).toBe(6);
    expect(flow?.code?.text.split("\n")).toHaveLength(4);
    expect(flow?.code?.text).toEndWith("});");
    // the phone result has no detail (the fake reported desktop only), and the page still lists it
    expect(flow?.results.find((r) => r.w === "phone")?.d).toBeUndefined();
  });
});

describe("a test's code", () => {
  const text = [
    "describe('price', () => {",
    "  test('rounds half up', () => {",
    "    const s = `a ${'}'} b ${`nested ${1}`}`; // a } in a comment",
    "    /* ) ] } */ expect(round(0.5)).toBe(1);",
    "    expect(')').toBe(\")\");",
    "  });",
    "  it(\"keeps cents\", () => expect(1).toBe(1));",
    "});",
  ];

  test("from the given line to the bracket that closes it: strings, template literals and comments skipped", () => {
    expect(blockFrom(text, 2)).toEqual({ start: 2, end: 6 });
    expect(blockFrom(text, 7)).toEqual({ start: 7, end: 7 });
    expect(blockFrom(text, 1)).toEqual({ start: 1, end: 8 });
    expect(blockFrom(text, 99)).toBeNull();
  });

  test("bun names a test by title: the last segment of `describe > test`", () => {
    expect(titleLine(text, "price > rounds half up")).toBe(2);
    expect(titleLine(text, "price > keeps cents")).toBe(7);
    expect(titleLine(text, "price > not here")).toBeNull();
    expect(testSpan(text.join("\n"), { name: "price > rounds half up" })).toEqual({ start: 2, end: 6 });
  });
});

describe("the disk bound", () => {
  test(`screenshots and traces stay on the newest ${KEEP_ARTIFACT_RUNS} runs that have them; results.jsonl stays with every run`, () => {
    const runs = join(sb.dir, "prune-runs");
    const ids = ["toaaaaa1", "toaaaaa2", "toaaaaa3", "toaaaaa4", "toaaaaa5"];
    for (const id of ids) {
      const art = join(runs, id, "artifacts", "flows");
      mkdirSync(join(art, "abc123"), { recursive: true });
      writeFileSync(join(art, "results.jsonl"), "{}\n");
      writeFileSync(join(art, "abc123", "screenshot-0.webp"), "x");
    }
    // a newer run with no artifact files doesn't count toward the newest three
    mkdirSync(join(runs, "toaaaaa6", "artifacts", "flows"), { recursive: true });
    pruneArtifacts(runs, "toaaaaa6");
    const heavy = (id: string): boolean => existsSync(join(runs, id, "artifacts", "flows", "abc123"));
    expect(ids.map(heavy)).toEqual([false, false, true, true, true]);
    for (const id of ids) expect(existsSync(join(runs, id, "artifacts", "flows", "results.jsonl"))).toBe(true);
  });
});
