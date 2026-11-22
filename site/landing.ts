// The home page. Every number on it comes from a recorded run: the board is
// data/planted-bugs.json (a planted-bug run on the public starter), and the
// terminals are data/*.txt, pasted from real output.

import { join } from 'node:path'
import { z } from 'zod'
import { codeBlock, terminal } from './code'
import { examples, type Sample } from './examples'
import { esc, inline } from './html'
import { MARK } from './layout'

const check = z.enum(['types', 'rules', 'api', 'flows'])
type Check = z.infer<typeof check>

const bugSchema = z.object({
  file: z.string(),
  line: z.number(),
  op: z.string(),
  before: z.string(),
  after: z.string(),
  check: check.nullable(),
  test: z.string().nullable(),
  testFile: z.string().nullable(),
})
const runSchema = z.object({
  repo: z.string(),
  sha: z.string(),
  at: z.string(),
  seed: z.number(),
  max: z.number(),
  caught: z.number(),
  missed: z.number(),
  byCheck: z.record(check, z.number()),
  bugs: z.array(bugSchema),
})
export type PlantedBug = z.infer<typeof bugSchema>

const ORDER: Array<Check | null> = ['types', 'rules', 'api', 'flows', null]
const NAME: Record<Check, string> = { types: 'Types', rules: 'Rules', api: 'API', flows: 'Flows' }

type CheckRow = {
  key: Check | 'live'
  name: string
  question: string
  what: string
  where: string
  /** The code this check shows: a heading in examples.md and how many of its blocks. */
  code: Array<[heading: string, take: number]>
}

const CHECKS: CheckRow[] = [
  {
    key: 'types',
    name: 'Types',
    question: 'Does the code agree with itself?',
    what: 'Strict TypeScript with no `any`, and zod at every boundary: API input, env, forms, storage.',
    where: 'bun run typecheck',
    code: [['Types:', 3]],
  },
  {
    key: 'rules',
    name: 'Rules',
    question: 'Is the logic right where a wrong answer is silent?',
    what: 'Pure functions with many cases: money, dates, permissions, parsers, redirects. No database, network or environment.',
    where: '*.rule.test.ts',
    code: [['A rule:', 1]],
  },
  {
    key: 'api',
    name: 'API',
    question: 'Does every server procedure return, write and refuse what it should, for each kind of caller?',
    what: 'Every tRPC procedure called through the real router on a real Postgres, plus a committed table of who may call what.',
    where: '*.api.test.ts',
    code: [['An API test:', 1], ['Who may call what:', 1]],
  },
  {
    key: 'flows',
    name: 'Flows',
    question: 'Can a person actually do it?',
    what: 'A person’s path through the production build in a real browser, at desktop and phone width, with every screen walked by some flow.',
    where: '*.flow.spec.ts',
    code: [['A flow:', 1]],
  },
  {
    key: 'live',
    name: 'Live',
    question: 'Is what deployed the thing that was tested, and is it up?',
    what: 'After a deploy: the new revision is running, and the health path and listed paths answer. It warns and never rolls back.',
    where: 'after a deploy',
    code: [['Live:', 3]],
  },
]

const RULES: Array<{ rule: string; how: string; without: string }> = [
  {
    rule: 'A check has to have been seen failing once',
    how: 'Break the code on purpose, or let the planted-bug run do it, and watch the check go red before trusting its green.',
    without: 'Without it, half of 66 planted bugs passed every check.',
  },
  {
    rule: 'The builder doesn’t write its own pass mark',
    how: 'What a flow must show is written down before the code, as one line a person could check by hand. A separate agent turns that line into the browser test.',
    without: 'Without it, the agent that wrote the bug writes the test that agrees with it.',
  },
  {
    rule: 'A skipped test is a failed test',
    how: 'No `test.skip`, no `test.todo`, no run that finds zero tests, no test that quietly passes when an environment variable is missing.',
    without: 'Without it, one repo had 88 of 438 test files skipping themselves.',
  },
  {
    rule: 'Checks run on a clean copy of the commit, with their own database',
    how: 'Never the working tree and never the dev database. A file that was not committed is not in the copy.',
    without: 'Without it, 32 test files in one app were writing to the dev database.',
  },
]

type Step = { do: string; note?: string }
const PATHS: Array<{ key: string; tab: string; title: string; steps: Step[]; aside: string; href: string }> = [
  {
    key: 'new',
    tab: 'A new project',
    title: 'A new project starts already on it',
    steps: [
      { do: 'Clone the starter and run `bun run init my-app`', note: 'It carries the three names, the test databases, the flow fixture, the every-screen check, the access table and a `gate.json`.' },
      { do: 'Run the kickoff, then `bun run demo:drop`', note: 'The starter’s own tests fail until both are done.' },
      { do: 'Run `gate` before the first feature', note: 'It should be green. Every later number depends on it.' },
      { do: 'Build each change check first', note: 'Written with the change, seen failing, then made to pass.' },
      { do: 'List the critical files in `gate.json`', note: 'Sign-in, permissions, money, anything that writes data.' },
      { do: 'Plant bugs once there is real code', note: '`gate probe --max 40 --seed 1`, a test for each miss, then a new seed.' },
      { do: 'Turn on the live check with the first deploy' },
      { do: 'Keep the click-through list from the first flow' },
    ],
    aside: 'It begins at <strong>Walked</strong> and reaches <strong>Measured</strong> with its first planted-bug run.',
    href: '/adopt/#a-new-project',
  },
  {
    key: 'existing',
    tab: 'An existing app',
    title: 'An existing app takes four steps, in a fixed order',
    steps: [
      { do: 'Give the tests their own databases', note: 'A cloned template per test process, one guard on every drop and truncate, no real keys. Done when `gate` is green on a clean copy.' },
      { do: 'Names, the access table, and an API test for every procedure', note: 'Done when a test names any procedure without one, and names none.' },
      { do: 'Flows on every screen, at both widths', note: 'Done when a full run names any screen no flow walked, and names none.' },
      { do: 'Prove it with planted bugs', note: 'Replay the first list, then plant a new sample and report that number.' },
    ],
    aside: 'Start with `gate init`. Each step leaves the app working, and the first changes nothing about what it does. On the first app, 32 test files had been writing to the dev database. Nobody had noticed.',
    href: '/adopt/#an-existing-app',
  },
  {
    key: 'fork',
    tab: 'An older fork of the starter',
    title: 'An older fork gets it through the starter’s sync',
    steps: [
      { do: 'On a branch, run `bun run sync`', note: 'It merges the starter’s changes and never commits.' },
      { do: 'Check `gate.json` says `report`', note: 'If it doesn’t, or the fork has no web app, run `bun scripts/gate.ts --fit`.' },
      { do: 'Run `bun run test:rules`', note: 'The names check lists every test file with the name to use.' },
      { do: 'Run all four checks, commit, run `gate`' },
      { do: 'Plant bugs', note: 'The fork now stands at Walked. A new sample takes it to Measured.' },
    ],
    aside: 'For a project forked from the starter before 2026-11-20. The starter’s `MIGRATION.md` has the detail for each conflict a fork can hit.',
    href: '/adopt/#an-older-fork-of-the-starter',
  },
]

const SHAPES: Array<{ shape: string; cells: [string, string, string, string, string] }> = [
  { shape: 'A web app', cells: ['Yes', 'Yes', 'Every server procedure', 'Every screen, both widths', 'Yes'] },
  { shape: 'A desktop app', cells: ['Yes', 'Yes', 'The bridge between the window and the main process', 'Only for a web surface', 'No'] },
  { shape: 'A mobile app', cells: ['Yes', 'Yes', 'Its server’s procedures, in the server’s repo', 'Not covered: a real device is a person’s check', 'No'] },
  { shape: 'A CLI or a library', cells: ['Yes', 'Yes', 'Each command or exported function, called the way a caller calls it', 'No screen, no flows', 'No'] },
]

const STOPS: Array<{ name: string; when: string; pins?: Array<{ who: string; rate: string }>; bar?: boolean }> = [
  { name: 'Not on it', when: 'No `gate.json`' },
  { name: 'Safe to run', when: '`gate` is green on a clean copy, with its own databases' },
  { name: 'Named', when: 'Three file names, the access table, an API test for every procedure' },
  { name: 'Walked', when: 'Every screen walked by a flow at both widths' },
  {
    name: 'Measured',
    when: 'A planted-bug run on a new sample is on record',
    pins: [
      { who: 'The starter', rate: '80%' },
      { who: 'A production app', rate: '63%' },
    ],
  },
  { name: 'At the bar', when: '90% or more, with nothing missed in the critical files', bar: true },
]

const LIMITS: string[] = [
  '<b>It does not judge taste.</b> Whether a screen feels right is a person’s call.',
  '<b>It does not stop a push or fail a deploy</b> unless the owner turns that on.',
  '<b>It does not make green mean “no bugs”.</b> The number is the point: it is known, and it can be moved.',
  '<b>It does not cover what no check reaches:</b> mobile builds on real devices, third-party dashboards, and email as it lands in an inbox.',
]

async function text(name: string): Promise<string | null> {
  const file = Bun.file(join(import.meta.dir, 'data', name))
  return (await file.exists()) ? await file.text() : null
}

function steps(list: Step[]): string {
  return `<ol class="steps">${list
    .map((s) => `<li><div><b>${inline(s.do)}</b>${s.note ? ` <span>${inline(s.note)}</span>` : ''}</div></li>`)
    .join('')}</ol>`
}

/** The share image, as a page: dev.ts serves it at /__og and site/public/og.png is a screenshot of it. */
export async function shareCard(css: string): Promise<string> {
  const run = runSchema.parse(await Bun.file(join(import.meta.dir, 'data', 'planted-bugs.json')).json())
  const bugs = [...run.bugs].sort((a, b) => ORDER.indexOf(a.check) - ORDER.indexOf(b.check))
  const cells = bugs.map((b) => `<span class="cell" data-check="${b.check ?? 'none'}"></span>`).join('')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>share card</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500..700&family=Inter:wght@400;500;600&display=swap">
<style>${css}\nbody { background: #8a93a3; padding: 24px; }</style></head><body>
<div class="og" id="og">
<div class="og-say"><span class="mark">${MARK}Testing standard</span><h1>Five checks, one command, and a number for how far to trust them</h1></div>
<div class="og-board"><div class="cells">${cells}</div><div class="tally"><strong>${run.caught}</strong><span>of ${run.max} planted bugs caught</span></div></div>
</div></body></html>`
}

export async function landing(): Promise<string> {
  const run = runSchema.parse(await Bun.file(join(import.meta.dir, 'data', 'planted-bugs.json')).json())
  const bugs = [...run.bugs].sort((a, b) => ORDER.indexOf(a.check) - ORDER.indexOf(b.check))
  const first = Math.max(0, bugs.findIndex((b) => b.check === 'api'))
  const gateOut = await text('gate.txt')
  const testsOut = await text('gate-tests.txt')

  const cells = bugs
    .map((b, i) => {
      const verdict = b.check ? `caught by ${NAME[b.check]}` : 'nothing noticed'
      return `<button type="button" class="cell" data-i="${i}" data-check="${b.check ?? 'none'}" aria-pressed="${i === first}" tabindex="${i === first ? 0 : -1}" aria-label="${esc(`${b.file} line ${b.line}: ${verdict}`)}"></button>`
    })
    .join('')

  const legend = [
    ...(['types', 'rules', 'api', 'flows'] as const).map(
      (c) => `<li><i class="sw ${c}"></i>${NAME[c]} <b>${run.byCheck[c] ?? 0}</b></li>`,
    ),
    `<li><i class="sw none"></i>Got through <b>${run.missed}</b></li>`,
  ].join('')

  const pick = await examples()
  const figure = async (sample: Sample | undefined): Promise<string> => {
    if (!sample) return ''
    const block = await codeBlock(sample.code, sample.lang)
    if (sample.file) return `<figure class="code"><figcaption><a href="${esc(sample.file.href)}" rel="noopener">${esc(sample.file.path)}</a></figcaption>${block}</figure>`
    return `<figure class="code out">${sample.lead ? `<figcaption>${sample.lead}</figcaption>` : ''}${block}</figure>`
  }
  const checks = (
    await Promise.all(
      CHECKS.map(async (c) => {
        const caught = c.key === 'live' ? null : (run.byCheck[c.key] ?? 0)
        const samples = c.code.flatMap(([heading, take]) => pick(heading, take))
        const figures = (await Promise.all(samples.map(figure))).join('\n')
        return `<li class="check" id="check-${c.key}" style="--c: var(--${c.key})">
<div class="check-say">
<div class="check-name"><i class="sw ${c.key}"></i>${c.name}</div>
<h3 class="check-q">${esc(c.question)}</h3>
<p class="check-what">${inline(c.what)}</p>
<div class="check-where"><code>${esc(c.where)}</code>${caught === null ? '' : `<span><b>${caught}</b> of the ${run.max} planted bugs</span>`}</div>
</div>
<div class="check-code">${figures}</div>
</li>`
      }),
    )
  ).join('\n')

  const rules = RULES.map(
    (r) => `<div class="rule"><h3>${esc(r.rule)}</h3><p>${inline(r.how)}</p><p class="without">${esc(r.without)}</p></div>`,
  ).join('\n')

  const tabs = [...PATHS.map((p) => ({ key: p.key, tab: p.tab })), { key: 'other', tab: 'Not a web app' }]
    .map((t, i) => `<button type="button" class="case" role="tab" id="tab-${t.key}" aria-controls="path-${t.key}" aria-selected="${i === 0}">${esc(t.tab)}</button>`)
    .join('')

  const paths = PATHS.map(
    (p) => `<section class="sheet path" id="path-${p.key}" role="tabpanel" aria-labelledby="tab-${p.key}">
<h3>${esc(p.title)}</h3>
${steps(p.steps)}
<aside><p>${p.aside.includes('<strong>') ? p.aside : inline(p.aside)}</p><a class="btn line" href="${p.href}">Read this path in full</a></aside>
</section>`,
  ).join('\n')

  const shapeHead = (['types', 'rules', 'api', 'flows', 'live'] as const)
    .map((c) => `<th scope="col"><span><i class="sw ${c}"></i>${c === 'live' ? 'Live' : NAME[c]}</span></th>`)
    .join('')
  const shapeRows = SHAPES.map(
    (s) => `<tr><th scope="row">${esc(s.shape)}</th>${s.cells.map((c) => `<td${c === 'Yes' ? ' class="y"' : ''}>${esc(c)}</td>`).join('')}</tr>`,
  ).join('')

  const stops = STOPS.map(
    (s) => `<li class="stop${s.bar ? ' bar-stop' : ''}"><b>${esc(s.name)}</b><span>${inline(s.when)}</span>${(s.pins ?? [])
      .map((p) => `<span class="pin">${esc(p.who)} <b>${esc(p.rate)}</b></span>`)
      .join('')}</li>`,
  ).join('')

  return `<main>
<section class="hero"><div class="wrap">
<div class="hero-head">
<h1>Five checks, one command, and a number for how far to trust them</h1>
<div class="hero-side">
<p>A way to test web apps that agents build and nobody reads line by line. It plants bugs in its own code to find out whether a green run means anything.</p>
<div class="actions"><a class="btn solid" href="/standard/">Read the standard</a><a class="btn line" href="#adopt">Bring it to a repo</a></div>
</div>
</div>

<div class="board" id="board">
<div class="board-main">
<div class="prompt"><b>gate probe --max ${run.max} --seed ${run.seed}</b><span>${esc(run.repo)} at ${esc(run.sha)}</span></div>
<div class="cells" role="group" aria-label="${run.max} planted bugs">${cells}</div>
<div class="tally"><strong id="tally">${run.caught}</strong><span>of ${run.max} planted bugs caught</span></div>
<ul class="legend">${legend}</ul>
</div>
<div class="bug" id="bug" aria-live="polite"></div>
</div>
<script type="application/json" id="bugs">${JSON.stringify(bugs).replace(/</g, '\\u003c')}</script>
</div></section>

<section class="section" id="checks"><div class="wrap">
<h2>Each check answers a question the others can’t</h2>
<ul class="sheet checks">
${checks}
</ul>
</div></section>

<section class="section" id="gate"><div class="wrap">
<h2>One command runs them on a clean copy of the commit</h2>
<div class="gate">
${steps([
  { do: 'It copies the commit, not the working tree.', note: 'Uncommitted and untracked files are left behind.' },
  { do: 'It creates a fresh, migrated database', note: 'for the run and hands the checks its address.' },
  { do: 'It runs each check with an allowlisted environment,', note: 'so a variable your shell exports can’t make one pass.' },
  { do: 'It fails a check that skipped a test,', note: 'marked one todo, or found none.' },
  { do: 'It writes a signed receipt', note: 'for the commit on a full pass.' },
])}
<div class="terms">
${gateOut ? terminal(gateOut, 'gate') : ''}
${await figure(pick('`gate.json`', 1)[0])}
</div>
</div>
<div class="sheet facts">
<div><b>It reports and never blocks</b>Nothing it finds stops a push or fails a deploy. An agent that pushes past red has to say so.</div>
<div><b>It can’t pass by accident</b>Uncommitted files stay behind, the database is new, and a skipped test fails the run.</div>
<div><b>It stays out of git</b>No hook, no git config. The push check lives in the agents’ own tooling, because agents are the ones pushing.</div>
</div>
</div></section>

${
  testsOut
    ? `<section class="section" id="tests"><div class="wrap">
<h2>One more shows every test and how it last ran</h2>
${terminal(testsOut, 'gate tests')}
<div class="sheet facts">
<div><b>It runs nothing</b>It reads the runs <code>gate</code> already kept: each test’s last result, how long it took, and whether it has failed before.</div>
<div><b>It names the idle tests</b>Each test file shows how many planted bugs it has caught, and a file that exists but never ran is listed.</div>
<div><b>It narrows on request</b><code>--failed</code> for what is not a clean pass, <code>--all</code> for every test by name, <code>--json</code> for an agent.</div>
</div>
</div></section>

`
    : ''
}<section class="section" id="rules"><div class="wrap">
<h2>Four rules keep a green run honest</h2>
<div class="sheet rules">
${rules}
</div>
</div></section>

<section class="section" id="trust"><div class="wrap">
<h2>A green run is worth what the planted bugs say it is</h2>
<div class="sheet trust">
<div class="bars" role="img" aria-label="Share of planted bugs caught: 50% before the standard, 80% on the starter, 63% on a production app. The bar is 90%.">
<div class="barline"><em>The bar, 90%</em></div>
<div class="bar old"><span>Before, across the repos audited</span><i><u style="--v: 50%"></u></i><b>50%</b></div>
<div class="bar"><span>The starter, 40 new bugs</span><i><u style="--v: 80%"></u></i><b>80%</b></div>
<div class="bar"><span>A production app, 40 new bugs</span><i><u style="--v: 63%"></u></i><b>63%</b></div>
</div>
<div class="trust-say">
<p><strong>Only a new sample measures the checks.</strong> Replaying a list you have already fixed goes to 100% and says little.</p>
<p><strong>A missed bug is a real gap.</strong> Write the test that catches that exact change, then plant a new sample.</p>
<p><a href="/evidence/">Read what was measured</a></p>
</div>
</div>
</div></section>

<section class="section" id="adopt"><div class="wrap">
<h2>Every kind of repo has a path onto it</h2>
<div class="cases" role="tablist" aria-label="Kind of repo">${tabs}</div>
${paths}
<section class="sheet path path-wide" id="path-other" role="tabpanel" aria-labelledby="tab-other">
<h3>Something that isn’t a web app keeps the checks that apply</h3>
<div class="tbl"><table class="shape"><thead><tr><th></th>${shapeHead}</tr></thead><tbody>${shapeRows}</tbody></table></div>
<aside><p>Only the web app and desktop rows have been run for real. The mobile and CLI rows are the rule to start from, and no catch rate has been measured for them yet.</p><a class="btn line" href="/adopt/#something-that-isnt-a-web-app">Read this path in full</a></aside>
</section>
<div class="sheet scale">
<h3>Where a repo stands</h3>
<ol class="stops">${stops}</ol>
</div>
</div></section>

<section class="section" id="limits"><div class="wrap">
<h2>What it does not do</h2>
<ul class="limits">${LIMITS.map((l) => `<li>${l}</li>`).join('')}</ul>
</div></section>
</main>`
}
