# Testing standard

Version 1.0 · 2026-11-21

One way to test a web app that agents build and nobody reads line by line.

When an agent writes the code and the tests, a green run proves little on its own. The tests may check nothing, may not have run, or may have run against the wrong files or the wrong database. This standard fixes what "tested" means: five checks, three test file names, four rules, one command, and a measured number that says how far to trust a green run.

It is written for TypeScript apps on React, tRPC, Postgres and Prisma, run with Bun and Playwright. The ideas carry to other stacks; the file names and commands here are for this one.

- [`adopt.md`](adopt.md): bringing an existing repo onto the standard
- [`examples.md`](examples.md): one real example of each test, the access table, `gate.json` and the output
- [`evidence.md`](evidence.md): what was measured before and after
- [`CHANGELOG.md`](CHANGELOG.md): what changed between versions

## Five checks

Each check answers a question the others can't.

| Check | The question | What runs | Where |
| --- | --- | --- | --- |
| Types | Does the code agree with itself? | Strict TypeScript with no `any`, and zod at every boundary (API input, env, forms, storage) | `bun run typecheck` |
| Rules | Is the logic right where a wrong answer is silent? | Pure functions with many cases: money, dates, permissions, parsers, redirects. No database, network or environment | `*.rule.test.ts` |
| API | Does every server procedure return, write and refuse what it should, for each kind of caller? | Every tRPC procedure called through the real router on a real Postgres, plus a committed table of who may call what | `*.api.test.ts` |
| Flows | Can a person actually do it? | A person's path through the production build in a real browser, at desktop (1280×800) and phone (390×844) width, with every screen walked by some flow | `*.flow.spec.ts` |
| Live | Is what deployed the thing that was tested, and is it up? | After a deploy: the new revision is running, and the health path and listed paths answer. It warns and never rolls back | the deploy tool |

The first four run before a push, with one command. The fifth runs after a deploy.

**Write no unit test that isn't a rule.** A unit test earns its place only on logic where a wrong answer is silent and has many cases. Everything else is proved by an API test or a flow, which test what the app does instead of how it is put together. The first time a non-rule unit test blocks a change the owner asked for, delete it.

## Three file names

Every test file has exactly one of three names. A names check runs first and fails on anything else.

| Name | Runner | May touch |
| --- | --- | --- |
| `*.rule.test.ts` | `bun test`, with no environment at all | Pure code only |
| `*.api.test.ts` | `bun test`, on its own clone of a migrated Postgres | The real router, handlers and database |
| `*.flow.spec.ts` | Playwright, two projects: `desktop` and `phone` | The production build, through a browser |

The name says what a test is allowed to depend on, so nobody has to open a file to know what it proves or what it needs to run.

## Four rules

1. **A check has to have been seen failing once.** Break the code on purpose, or let the planted-bug run do it, and watch the check go red before trusting its green. A test that has never failed has not shown it can.
2. **The builder doesn't write its own pass mark.** What a flow must show is written down before the code, as one line a person could check by hand. A separate agent turns that line into the browser test.
3. **A skipped test is a failed test.** No `test.skip`, no `test.todo`, no run that finds zero tests, no test that quietly passes when an environment variable is missing.
4. **Checks run on a clean copy of the commit, with their own database.** Never the working tree and never the dev database. A file that was not committed is not in the copy, so "works on my machine" cannot pass.

## Every change

1. Write the check with the change: the rule test, API test or flow it needs.
2. See it fail: before the change, or with the change broken on purpose.
3. Make it pass. `gate --dirty` gives a quick look at uncommitted work.
4. Commit, then run `gate`. It checks the commit, not the working tree.
5. Fix what is red, commit, run `gate` again.
6. Push. If you push past a red run, say so in the report: the check, what failed and why.

## One command: `gate`

[`gate`](https://github.com/dested/destedtui/blob/master/features/gate.md) reads `gate.json` at the repo root and runs the checks in order:

1. Copies the commit with `git archive` into a work folder. Uncommitted and untracked files are left behind.
2. Creates a fresh, migrated `gate_*` Postgres database for the run and hands the checks its URL. A template keyed on the schema makes this quick the second time.
3. Runs each check with an allowlisted environment, so a variable your shell happens to export can't make a check pass.
4. Fails a check that skipped a test, marked one todo, or found none.
5. On a full pass, writes a signed receipt for the commit's tree and prints one line per check.

```
gate                 every check on HEAD; a receipt on a pass
gate --dirty         HEAD plus uncommitted files, for a quick look (no receipt)
gate --only api      one check (no receipt)
gate status          the mode, the receipt for HEAD, the last runs, the newest planted-bug run
gate init            write gate.json from the repo's scripts
gate doctor          what is broken in gate itself, each with its fix
```

Exit 0 is green, 1 is the code, 2 is usage or `gate.json`, 3 is gate itself. 3 is never a pass.

### It reports, it does not block

`gate.json` has two modes. In `report`, the default and the mode every repo here runs, `gate` records each run and prints what it knows about a commit, and a push always goes through. In `block`, an agent's push to a protected branch is refused until that commit has a receipt. Turning `block` on is the owner's decision alone, per repo.

Three things `gate` never does: install a git hook, change git config, or fail a deploy. The push check lives in the agents' own tooling, because agents are the ones pushing.

## Planted bugs: how far to trust green

A green run only means something if the checks can fail. `gate probe` measures that:

1. It takes a green commit and plants one small bug in the clean copy: a flipped `===`, a dropped guard, a removed call, an off-by-one, `&&` turned into `||`.
2. It runs the checks. The first one to go red **caught** the bug. If every check stays green, the bug was **missed**.
3. It puts the line back and plants the next one.

```
gate probe                   30 sampled bugs from the files listed in gate.json
gate probe --max 40 --seed 3 a different sample
gate probe --since main      only the lines this branch changed
gate probe --from <file>     replay an earlier run's bugs
gate probe report            the catch rate over time; checks and test files that never catch anything
```

The result is a **catch rate**: caught ÷ (caught + missed). The run passes at 90% or more with nothing missed in the files `gate.json` lists as critical (sign-in, permissions, money, anything that writes data).

- A missed bug is a real gap. Write the test that catches that exact change, commit, and probe again.
- `// probe-ignore: <why>` is for a line where a change can't be a bug, such as log formatting or copy. The reason has to be true. Never on sign-in, permissions, money or anything that writes data.
- Never fix a miss by excluding it. Widening the excludes, lowering the rate or trimming the critical list is the owner's call.
- **Only a new sample measures the checks.** Replaying a list you have already fixed goes to 100% and says little. Use a new seed each time and report that number.

## The details of each check

### Types

`strict: true` in every tsconfig, and never `any`: not in generics, casts or catch blocks. `unknown` with narrowing, real generics and discriminated unions instead. zod parses anything that crosses a boundary. No `as` to paper over a mismatch, no `@ts-ignore` without a written reason. On the starter, types caught more planted bugs than any other check (15 of the 32 caught), and it costs seconds.

### Rules

A `*.rule.test.ts` sits next to the pure function it covers and imports nothing that reads `process.env`, opens a socket or touches a database. The rules run with an empty environment, so one that cheats fails on import. Good candidates: who may sign up, which redirect is safe, how money rounds, where a date lands across a timezone, what a parser does with bad input.

### API

- **One test per procedure.** Every path in the router has a `describe('<path>', …)` in some `*.api.test.ts` that covers what it returns, what it writes (read the row back) and what it refuses (bad input, the wrong caller). A test fails naming any procedure without one.
- **Real callers.** Tests call the router as a signed-out visitor, a signed-in person and an admin, each with a real session.
- **Its own database.** One migrated, empty template database, cloned per test process and dropped at the end. One guard function is the only code allowed to create, drop or truncate a database, and it refuses any name that isn't a test database.
- **Its own environment.** The API tests never load the repo's `.env`. They remove every key it defines and set exactly what the server needs, so no test can reach a paid service with a real key.
- **Who may call what, in git.** Every procedure builder carries a tag for who it lets in. A script writes the table of every procedure against every kind of caller to a committed file, and a test fails when the table and the router disagree. A permission change then shows up in review as a one-line diff, and the commit says what changed and why.

### Flows

- **The production build.** Each Playwright worker starts the built app on a free port against its own clone of the test database.
- **Two widths, always.** Every flow runs in both projects, `desktop` (1280×800) and `phone` (390×844, touch). Never pin a flow to one.
- **Every screen.** A full run fails naming any route, or the 404, that no flow landed on at either width.
- **Problems fail the flow without being asked.** An uncaught page error, a `console.error`, a response of 500 or more, a failed same-origin request, or sideways overflow on the page the flow ended on. A flow that provokes one on purpose allows exactly that one, by pattern.
- **Titles a person can read.** `<feature>/<flow> · <what a person sees>`, such as `auth/sign-out · signing out lands home, and Back does not reopen the dashboard`. The body starts with a `// Check:` line naming the one thing to see.

### Live

After a deploy, the deploy tool checks that the new revision is running and that the health path and a short list of paths answer. A path can be required to report the new commit, which proves that what is live is what was tested. It is opt-in per app. It warns, and it never fails or rolls back a deploy: a check that can take production down is worse than the bug it might catch.

## One list for the person and the machine

The owner keeps a short click-through list for each app: the flows a person would walk before trusting a release. Each flow a machine can check gets a twin browser test whose title starts with the flow's reference, so the two lists are one list.

- `[manual]` marks a flow only a person can judge: feel, motion, sound, a real device, a third-party screen. It never marks a flow whose test is merely fiddly to write.
- A check offline compares the test titles to the list, so a flow without a twin, or a twin without a flow, fails.
- A machine pass never counts as the owner having tested anything. It only moves the flows a machine passed, at every width and at that commit, out of the way, so the person's list holds what needs a person.

## What this does not do

- It does not judge taste. Whether a screen feels right is a person's call.
- It does not stop a push or fail a deploy unless the owner turns that on.
- It does not make green mean "no bugs". On code the tests were not written against, the two repos measured so far catch 63% and 80% of planted bugs. That number is the point: it is known, and it can be moved.
- It does not cover what no check reaches: mobile builds on real devices, third-party dashboards, and email as it lands in an inbox.

## Starting

- **A new project** starts from [sal-starter](https://github.com/dested/sal-starter), which carries all of it: the three names, the test databases, the flow fixture, the every-screen check, the access table and a `gate.json`.
- **An existing repo** follows [`adopt.md`](adopt.md), four steps in a fixed order.
- **The runner** is `gate`, part of [destedtui](https://github.com/dested/destedtui): clone it, `bun install`, `bun link`. It runs on Linux and WSL, and needs a local Postgres for a repo with a database.
