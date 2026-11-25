# gate

`gate` runs a repo's checks on a clean copy of a commit, with its own databases and ports, and writes a signed receipt. `gate probe` plants bugs one at a time to see whether the checks can fail, and `gate tests` shows every test and how it last ran, in the terminal or as one page (`--html`). The standard it implements is the [README](../README.md) one folder up.

## Install

```sh
git clone https://github.com/dested/testing-standard
cd testing-standard/gate
bun install
bun link
```

Needs [Bun](https://bun.sh), Node, git and tar. Runs on Linux, macOS and WSL. A repo with a database needs a Postgres the caller's `DATABASE_URL` (or a `copy.env` file) points at. To update, `git pull` in the clone: `bun link` points at the folder, so there's nothing to reinstall.

## Use

```sh
gate init          # write gate.json from package.json scripts (report mode)
gate               # run the checks on HEAD; exit 0 pass, 1 red, 2 usage, 3 couldn't run
gate tests --html  # the tests page
gate probe         # plant bugs, report the catch rate
gate doctor        # what's missing on this machine, each with its fix
gate --help        # every command and flag
```

## In this folder

| Path | What |
| --- | --- |
| `spec.md` | The full spec: commands, exit codes, gate.json, the run in order, receipts, the probe, the tests page |
| `contract.md` | The contract gate was built to (v1, 2026-11-20) |
| `skill/SKILL.md` | The Claude Code skill: link it as `~/.claude/skills/gate` |
| `bin/gate.mjs` | The bin: runs `bun src/gate.ts` and passes the exit code through |
| `src/gate.ts` | Args, dispatch, exit codes |
| `src/lib/gate/` | Everything else: `run.ts` and `session.ts` (the run), `probe/`, `tests.ts`, `page.ts` and `html.ts` (the tests page), `guard.ts` (push guard), `receipt.ts` |
| `src/lib/` | `pgurl.ts`, `pgadmin.ts`, `platform.ts`: the few helpers gate needs |
| `test/gate/` | `bun run test`; `scripts/gate-fixtures.sh` regenerates the captured runner output in `fixtures/` |

## Develop

```sh
bun run typecheck
bun run test
```

The database tests need a Postgres and never skip. They use `GATE_TEST_PG_URL` (put it in a gitignored `gate/.env.test`), else the `PG*` variables, else `postgres:postgres@localhost:5432`. The suite fails if it changes `git config --global`.

gate lived in [destedtui](https://github.com/dested/destedtui) until 2026-11-24 (`5cd715f`), with the same paths. Its history before the move is there.
