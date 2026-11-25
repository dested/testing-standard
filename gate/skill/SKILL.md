---
name: gate
description: The testing standard's `gate` CLI (from the testing-standard repo, `gate/`) runs a repo's checks on a clean copy of a commit, with its own databases, writes a signed receipt, and plants bugs to see whether the checks can fail (`gate probe`). It informs; nothing is gated: report mode is the default, so never flip a repo to block or propose it unless the repo's owner asks. Use whenever a repo has a gate.json, before every push to main or master, when a push is denied with "gate:", when asked to "run the gate", "run the checks", "is this green", "can I push", "why was my push denied", to adopt the gate in a repo ("gate init"), or to read a gate failure. Never forge a receipt, never change a repo's mode (block, or back from it), never run gate allow-weaken unless the repo's owner raises it in the conversation, and fix a denied push by running gate, never by another route to the remote.
---

# gate: run the checks on a clean copy, know whether they can fail

> **Report mode is the default, everywhere.** Never flip a repo to `block`, never propose it,
> never run `gate allow-weaken`, unless the repo's owner raises it in the conversation. You
> still run `gate` before pushing to main and fix what is red: that is the job, gated or not.

The standard itself is public at https://github.com/dested/testing-standard (`README.md` the
standard, `adopt.md` how to bring a repo on, `examples.md` real cases); this skill is the commands.

`gate` runs the checks in `gate.json` on `git archive <commit>`, never your working tree,
with an allowlisted environment and a fresh `gate_*` Postgres database per `databases[]`
entry. Skipped, todo and zero-test runs fail. A full pass writes a signed receipt for the
commit's tree. In report mode (every repo, see above) a push always goes through; agent-guard's
`gate guard push` call just prints what gate knows about the commit. gate never touches git
config or git hooks.

```
gate                      run every check on HEAD; the receipt on a pass
gate --dirty              HEAD + your uncommitted files (no receipt): a quick look before committing
gate --only api           one check (no receipt)
gate --all                keep going after a failure
gate --json               one JSON object: ok, checks, receipt, logs, failures, exit
gate status               mode, HEAD, receipt (pass / failed at <check> / none), last 10 runs
gate tests                every test and its last result (--failed, --all, --check, --file, --grep, --json)
gate tests --html         the same as one page for the owner: each test's history, code, steps and screenshots, planted bugs, coverage maps
gate init                 write gate.json from package.json scripts (report mode)
gate doctor               what's broken in gate itself, each with its fix
gate where                work root, logs, receipts, history
```

Exit codes: **0** green · **1** your code is red · **2** usage or gate.json · **3** gate
itself couldn't run (no Postgres, lock held with `--no-wait`, interrupted). 1 means fix the
code; 3 means fix the environment (`gate doctor`) and run again; never treat 3 as a pass.

## When to run it

- **Before every push to main/master in a repo with gate.json.** Commit first: gate checks
  the commit, not the working tree, and the receipt is for that commit's tree. Then push.
- **If a push is ever denied** with `gate: push to main denied` (only a block-mode repo does
  that, and none should be): run the `next:` command it
  printed (`cd <repo> && gate`), fix what fails, commit, run gate, push again. That is the
  only fix. Never reach the remote another way (a script, `gh`, an API call, a different
  remote or branch name that lands on main, a `--no-verify`).
- `gate guard push --cwd <repo> -- origin main` asks the same question agent-guard asks,
  without pushing: 0 allow, 1 deny (reason + next command), 2 couldn't read the arguments.
- An amend that only changes the message keeps the receipt (it's keyed by tree). Any content
  change needs a new run.
- `gate` waits when another gate run holds the repo (one at a time per repo). Long runs
  belong in the background (`run_in_background: true`), like any long test suite.

## What is the state of the tests

`gate tests` answers it without running anything: when the checks last ran, on which
commit, whether HEAD has a receipt, the newest sampled probe, then per check its counts and time,
per test file its tests and the planted bugs it caught, per flow each width side by side.
Anything that isn't a clean pass (failed, skipped, flaky, failed in an earlier kept run) is
listed by name with its error's first lines and the log. It reads the runs gate kept (the
newest 20): a check the newest run didn't reach shows its tests from the run that did, and
says so. `gate tests --failed` is the short list; `gate tests --json` has every test, never
truncated, with `history.lastFailure` (run, log, error) for one that failed before. It exits
0 even when the last run was red: `gate` judges, `gate tests` reports.

When the owner wants to *see* the tests ("show me the tests", "what do they cover", "a
visualization"), run `gate tests --html`: it writes one self-contained page to
`<work root>/tests.html` (`gate where` prints the work root), opens it in their browser and prints
its path (the Windows path from WSL); give them that path. It opens on one line (green or red, on which commit)
and the problems, with every register behind an expander. Any test opens in a drawer: its
result per width with history across kept runs, the full error, its code at the commit the run
checked, and for Playwright the steps it took, its screenshots, and a trace when it failed.
It also has every planted bug per source file, the files no probe has touched, the catch rate
per probe, and the repo's own coverage maps.

Playwright detail needs nothing from the repo: gate hands every check its own reporter through
`PW_TEST_REPORTER` and a folder in `$GATE_ARTIFACTS`. End-state screenshots of passing tests
need one line in the repo's playwright config: `screenshot: process.env.GATE === '1' ? 'on' :
'only-on-failure'`. Without it only failures carry a screenshot.

A repo can add its own coverage grids (screens × widths, procedures × callers) without gate
knowing the repo: a check writes `<name>.json` files into `$GATE_COVERAGE` (set only under
gate). The schema is in `gate --help` and features/gate.md § Coverage maps.

## Reading a failure

```
FAIL  api     19.8s   211 passed · 1 failed
      posts.create > rejects a signed-out caller
      …last 40 lines of the log…
      log <work root>/runs/<run>/api.log
 --   flows    not run
FAILED at api. Fix it, commit, run gate again.
```

- The indented names are the failing tests; the log path has the whole output.
- `1 skipped (skipped tests fail the check)` / `todo` / `the test run found no tests`: a
  skip is a failure here. Make the test run or delete it; don't add `skips: "allow"`.
- `timed out after 600s`: the check hung; its whole process tree was killed.
- `FAIL setup`: an install or migrate command failed; it's reproducible from the commit.
- `note: N uncommitted files are not part of this check`: they aren't in the copy. If a check
  needs one, commit it (`git add` what you forgot).
- Works on your machine but fails in gate? The difference is the clean copy (uncommitted or
  untracked files), the allowlisted env (a var your shell exports; list it in `pass` only if
  the repo truly needs it), or the database (gate's is fresh and migrated, never your dev one).

## Never

- **Forge or edit a receipt**, or write one by any route but a passing `gate`. A receipt not
  signed with the machine key is ignored anyway.
- **Run `gate allow-weaken`** unless the repo's owner said so in this conversation. A push that deletes
  gate.json, flips it to `report`, drops a check, allows skips or unprotects a branch is
  denied on purpose: that is the owner's call. Tell them what you want to change and why; if they
  say yes, `gate allow-weaken --sha <sha> --why "<their words>"` allows that one commit.
- **Reach the remote by another route** after a deny: no script, `gh`, API call, other remote
  or refspec that lands on a protected branch. Run `gate`.
- **Delete or weaken a check, allow skips (`skips: "allow"`), or change a repo's mode** to
  get green. Fix the code or the test.
- Point a check at a database or server that happens to exist. Use the `DATABASE_URL` /
  port vars gate gives you; a harness that needs more databases names them
  `<that database>_<suffix>` (gate drops them).
- Install git hooks or change git config to "help" the gate. It needs neither.

## The probe: can the checks fail?

`gate probe` plants one small bug at a time (a flipped `===`, a dropped guard, an off-by-one…)
in a clean copy and reports every bug that still passed every check. It needs `probe.include`
in gate.json and a green commit.

```
gate probe                     30 sampled bugs from probe.include
gate probe --since main        only lines this branch changed: run it before asking to merge
gate probe --from <file>       replay a past probe's bugs (.jsonl or a stored result .json)
gate probe report              catch rate over time; checks and test files that never catch anything
```

- Exit 0 = catch rate ≥ `probe.minRate` (0.9) and no missed bug under a `probe.critical` glob.
  Exit 1 lists why. A `MISSED` line is a real gap: write the test that would have caught that
  exact change (the line shows before → after), commit, probe again.
- Never fix a miss by excluding it. `probe.exclude` and `// probe-ignore: <why>` are for code
  where a change can't be a bug (log formatting, copy); each needs its reason, and widening
  them, or lowering `minRate`, or trimming `critical`, is the owner's call.
- `gate status` ends with the facts: `sampled probe 100% · nothing missed · every check passing`, or
  `open: <why; why>` naming what to do next (run gate, run a probe, fix the misses).
- The catch rate gate quotes (status, `gate tests`, the page) is the newest **sampled** probe's.
  A `--from` replay of misses you just fixed goes to 100% and says little: it's listed as a
  replay and never counted. After fixing misses, replay to confirm, then run a fresh
  `gate probe` (new seed) for a number that means something.

## Adopting the gate in a repo

`gate init` writes gate.json in **report** mode from the `typecheck`, `test:rules`/`test`,
`test:api`, `test:flows`/`test:e2e` and `db:deploy` scripts and prints what it couldn't
detect. Review it, commit it, run `gate`. Report mode never blocks a push, and it is the mode
for every repo (`gate init --mode block` says so before it does anything).

The full spec: `spec.md` beside this skill's folder (`gate/spec.md` in https://github.com/dested/testing-standard). Install or update gate: `cd <testing-standard>/gate && bun install && bun link`.
