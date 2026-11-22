# Changes

## 1.1 · 2026-11-21

Nothing about the checks, the names or the rules changed.

- The adoption plan covers every kind of repo: a new project, an existing app with or without tests, an older fork of the starter, and something that isn't a web app.
- A scale for where a repo stands: not on it, safe to run, named, walked, measured, at the bar. Each has a test for whether it is done.
- `gate tests` lists every test in a repo and how it last ran.
- The standard is a site: [testing.dested.com](https://testing.dested.com).

## 1.0 · 2026-11-21

The first version. Built and corrected on a starter template, then brought to one production app.

- Five checks: types, rules, API, flows, live.
- Three test file names: `*.rule.test.ts`, `*.api.test.ts`, `*.flow.spec.ts`.
- Four rules: seen failing once, the builder doesn't write its own pass mark, a skipped test is a failed test, a clean copy with its own database.
- `gate` runs the first four on a clean copy of a commit. Report mode is the default: nothing blocks a push, and nothing fails a deploy.
- `gate probe` plants bugs and reports a catch rate. A run passes at 90% with nothing missed in critical files.
- The live check warns and never rolls back.
