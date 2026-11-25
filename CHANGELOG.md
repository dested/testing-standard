# Changes

## 1.2 · 2026-11-24

Nothing about the checks, the names or the rules changed. `gate` keeps the same command, flags, exit codes and `gate.json`.

- `gate` lives in this repo now, in [`gate/`](https://github.com/dested/testing-standard/tree/main/gate): the CLI, [its spec](https://github.com/dested/testing-standard/blob/main/gate/spec.md), the contract it was built to, and its Claude Code skill. Everything the standard needs is in one place.
- The install is a clone of this repo, then `bun install` and `bun link` in `gate/`. It runs on Linux and WSL.
- `gate tests --html` puts every test on one page: what is red first, then each test's history, error, steps, code and screenshots, the planted bugs in each source file, and any coverage maps the checks wrote. [The examples](examples.md#the-tests-page-gate-tests---html) show it on the starter.

## 1.1 · 2026-11-21

Nothing about the checks, the names or the rules changed.

- The adoption plan covers every kind of repo: a new project, an existing app with or without tests, an older fork of the starter, and something that isn't a web app.
- A scale for where a repo stands: not on it, safe to run, named, walked, measured, at the bar. Each has a test for whether it is done.
- `gate tests` lists every test in a repo and how it last ran.
- The standard is a site: [testing.dested.com](https://testing.dested.com).
- The examples show the code for all five checks, Types and Live included. The starter's health route now reports the deployed commit.

## 1.0 · 2026-11-21

The first version. Built and corrected on a starter template, then brought to one production app.

- Five checks: types, rules, API, flows, live.
- Three test file names: `*.rule.test.ts`, `*.api.test.ts`, `*.flow.spec.ts`.
- Four rules: seen failing once, the builder doesn't write its own pass mark, a skipped test is a failed test, a clean copy with its own database.
- `gate` runs the first four on a clean copy of a commit. Report mode is the default: nothing blocks a push, and nothing fails a deploy.
- `gate probe` plants bugs and reports a catch rate. A run passes at 90% with nothing missed in critical files.
- The live check warns and never rolls back.
