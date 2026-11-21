# Changes

## 1.0 · 2026-11-21

The first version. Built and corrected on a starter template, then brought to one production app.

- Five checks: types, rules, API, flows, live.
- Three test file names: `*.rule.test.ts`, `*.api.test.ts`, `*.flow.spec.ts`.
- Four rules: seen failing once, the builder doesn't write its own pass mark, a skipped test is a failed test, a clean copy with its own database.
- `gate` runs the first four on a clean copy of a commit. Report mode is the default: nothing blocks a push, and nothing fails a deploy.
- `gate probe` plants bugs and reports a catch rate. A run passes at 90% with nothing missed in critical files.
- The live check warns and never rolls back.
