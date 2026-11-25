# Adoption plan

How a repo gets onto the standard, and how to tell where it stands. Find your case, follow its steps in order. Nothing here blocks a push or touches a deploy at any point.

| Your repo | What to do |
| --- | --- |
| A new project | [Start from the starter](#a-new-project): it arrives already on the standard |
| An existing app, with or without tests | [Four steps, in a fixed order](#an-existing-app) |
| A fork of the starter made before the standard | [Sync it](#an-older-fork-of-the-starter) |
| Not a web app: a CLI, a library, a desktop or mobile app | [Keep the checks that apply](#something-that-isnt-a-web-app) |
| A repo you have decided to leave alone | Nothing. The standard never arrives by itself |

## Before any of them

Install the runner once per machine. `gate` lives in this repo, in [`gate/`](https://github.com/dested/testing-standard/tree/main/gate):

```bash
git clone https://github.com/dested/testing-standard
cd testing-standard/gate
bun install
bun link
```

It runs on Linux, macOS and WSL, and needs a local Postgres for a repo with a database. `gate doctor` says what is missing, each with its fix. To update it, `git pull` in the clone.

## Where a repo stands

One word says how far a repo has come. Each step is worth having on its own, and each has a test for whether it is done, so nobody has to judge it.

| Stands at | Done when |
| --- | --- |
| Not on it | There is no `gate.json` |
| 1 · Safe to run | `gate` is green on a clean copy of the commit, with its own databases and no real keys |
| 2 · Named | The names check passes, the access table is committed, and a test names any procedure without an API test and names none |
| 3 · Walked | A full flows run fails naming any screen no flow walked at either width, and names none |
| 4 · Measured | A planted-bug run on a new sample is recorded, and its catch rate is the number the repo reports |
| At the bar | The newest new-sample run caught 90% or more, with nothing missed in the critical files |

A new project from the starter begins at 3 and reaches 4 with its first planted-bug run. Measured and at the bar are different things: the two repos measured so far stand at 80% and 63%.

## A new project

1. **Start from the starter.**

   ```bash
   git clone https://github.com/dested/sal-starter.git my-app && cd my-app
   git remote rename origin upstream
   bun install
   bun run init my-app
   createdb my_app
   bun run db:migrate
   ```

   It carries the three names, the test databases, the flow fixture, the every-screen check, the access table and a `gate.json` in report mode.
2. **Run the kickoff and drop the demo** (`/kickoff`, then `bun run demo:drop`). The starter's own tests fail until both are done, so a half-started project can't ship.
3. **Run `gate` before the first feature.** It should be green. If it isn't, fix that first: every later number depends on it.
4. **Build each change the same way.** The six steps under [Every change](README.md#every-change): the check is written with the change, seen failing, then made to pass.
5. **List the critical files as soon as they exist.** Sign-in, permissions, money and anything that writes data go in `gate.json` under `probe.critical`. A planted bug missed there fails the run whatever the rate.
6. **Plant bugs once there is real code.** `gate probe --max 40 --seed 1`. Write the test for each miss, then run again with a new seed and report that number.
7. **Turn on the live check with the first deploy.** One path that reports the deployed commit is enough.
8. **Keep the click-through list from the first flow.** Each line a person would walk before a release gets a twin browser test with the same reference, so the list and the tests never drift.

## An existing app

Four steps, in this order. Each one leaves the app working. The order matters: the later steps lean on the earlier ones, and the first changes nothing about what the app does.

Run `gate init` first. It writes `gate.json` in report mode from the repo's scripts and prints what it could not detect. Review it, list the critical files under `probe.critical`, commit it, run `gate`.

An app with no tests follows the same four steps. Step 1 is only the test databases and the test environment, step 2 has nothing to rename, and the first API tests and flows go to the critical files: sign-in, permissions, money, anything that writes data.

### 1. Give the tests their own databases

Before writing a single new test, make the ones that exist safe to run.

- One migrated, empty template database, cloned per test process and dropped at the end.
- One guard function that every create, drop and truncate goes through. It refuses any database that isn't a test database.
- A test environment that never loads the repo's `.env` or a real provider key. A fake stands in for each paid service at the edge.
- Every conditional skip becomes a real failure with the fix in its message.

On the first existing app brought onto the standard, 32 test files had been writing to the dev database and 4 truncated a shared test database. Nobody had noticed.

Done when: `gate` is green on a clean copy, and a first planted-bug run gives a catch rate. Keep that run's list of bugs: it is the baseline, and step 4 replays it.

### 2. Names, the access table, and an API test for every procedure

- Rename every test file to one of the three names without rewriting it. Add the names check.
- Tag every procedure builder with who it lets in. Write the builders' contract test: each builder against each kind of caller, with the exact error.
- Generate the table of who may call what and commit it. Add the test that fails when the table and the router disagree.
- Give every procedure a `describe('<path>')` that covers what it returns, writes and refuses. Fake only at the edge: the AI provider, file storage, push.
- See each new test red against a planted one-line bug before counting it.

Done when: a test names any procedure without an API test, and it names none.

### 3. Flows on every screen, at both widths

- Port the flow fixture: the production build per worker, on a free port, on its own clone of the database.
- Turn on the automatic problem checks and the every-screen check. Expect them to find real things on the first run. Fix what is real. Allow, by exact text and with a note, only what is known and waiting on a decision.
- Write a flow for every route that no flow lands on. Title each `<feature>/<flow> · <what a person sees>` and start it with its `// Check:` line.
- Every flow runs at desktop and phone width.

On the first app, the first full run failed 102 of 104 flow runs on the new checks alone. One cause was a real production problem (a fix the bundler had been dropping from every page) and two were noise.

Done when: a full run fails naming any screen no flow walked, and it names none.

### 4. Prove it with planted bugs

- Replay the baseline list from step 1 (`gate probe --from <file>`). Every miss is now caught, or carries an honest `// probe-ignore` and is nowhere near sign-in, permissions, money or data.
- Then plant bugs the tests were never written against: `gate probe --max 40 --seed 1`. Write a test for each miss, and run again with a new seed.
- Report the new-sample number, not the replay.

Expect the replay to reach 100% and the new sample to land well below it. On the first app the replay went 36% → 64% → 100% across steps 1 to 3, while three new samples of 40 caught 53%, 57% and 63%. Each round of writing tests for the misses moved the new-sample number about five points.

## An older fork of the starter

A project forked from the starter before 2026-11-20 gets the standard through the starter's own sync. Do it on a branch.

1. `bun run sync`. It merges the starter's changes and never commits: the five checks, the three names, the API harness, the access table and `gate.json`.
2. `grep '"mode"' gate.json`. If it says anything but `report`, or the fork has no web app and `gate.json` still lists flows, run `bun scripts/gate.ts --fit` and commit the result with the merge.
3. `bun run test:rules`. The names check runs first and lists every test file with the name to use. Pure logic becomes `*.rule.test.ts`, anything that touches the router, Postgres or IPC becomes `*.api.test.ts`, and Playwright files become `<feature>.flow.spec.ts`.
4. `bun run typecheck && bun run test:rules && bun run test:api && bun run test:flows`, then commit and run `gate`.
5. The fork now stands at 3. Step 4 of [an existing app](#4-prove-it-with-planted-bugs) takes it the rest of the way.

The starter's [`MIGRATION.md`](https://github.com/dested/sal-starter/blob/main/MIGRATION.md) has the detail for each conflict a fork can hit.

## Something that isn't a web app

The standard was built and measured on web apps. For other shapes, keep each check whose question still applies and leave the rest out of `gate.json`. The four rules and the planted-bug run apply to all of them unchanged.

| Shape | Types | Rules | API | Flows | Live |
| --- | --- | --- | --- | --- | --- |
| A web app | Yes | Yes | Every server procedure | Every screen, both widths | Yes |
| A desktop app | Yes | Yes | The bridge between the window and the main process, called for real | Only for a web surface | No |
| A mobile app | Yes | Yes | Its server's procedures, in the server's repo | Not covered: a real device is a person's check | No |
| A CLI or a library | Yes | Yes | Each command or exported function, called the way a caller calls it, on real files and a real database | No screen, no flows | No |

- A repo with no database drops `databases` from `gate.json`. A repo with no screen drops the `flows` check.
- Only the web app and desktop rows have been run for real. The mobile and CLI rows are the rule to start from, and no catch rate has been measured for them yet.
- Where there is no flow, the click-through list is all `[manual]`, and it still belongs in the repo.

## Once a repo is on it

- **Every change follows the six steps.** A check written after the fact has never been seen failing.
- **`gate tests` shows the state of every test**: what the repo has, how each one last ran, which have ever failed, and which have never caught a planted bug.
- **`gate tests --html` puts it on one page** and opens it: what is red first, then every test with its history, steps, code and screenshots, the planted bugs in each source file, and any coverage maps the checks wrote. It is one file with nothing to serve.
- **Plant bugs when you want to know, with a new seed each time.** After a large change, before a release that touches the critical files, and after writing tests for the last run's misses. `gate probe report` shows the rate over time.
- **A red run is information.** Report mode records it and lets the push through. If you push past one, say which check, what failed and why.

## What to leave alone

- Existing unit tests that aren't rules stay until one blocks a change the owner asked for. Then it is deleted, not rewritten.
- `gate.json` stays in report mode. Blocking is the owner's decision.
- The repo's deploy files. Nothing in this standard runs during a deploy or can fail one.
- The rate, the excludes and the critical list. A miss is fixed with a test, never by changing what counts.
