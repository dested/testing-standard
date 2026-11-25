# gate: the contract (v1)

> **Sal, 2026-11-20 (after the build was pushed):** "dont do frozen ropes. i dont want anything gates for now. you can oupsh but dont ever faila  deploy ."
> So: every repo's gate is `report` mode (sal-starter and new forks included); nobody flips a repo to `block` or proposes it unless Sal raises it; Drydock's live check only warns (no rollback, never a red deploy); no rollout to Frozen Ropes or other repos until he asks. Anything below that says otherwise is history.

Written 2026-11-20 by the lead session in /w/code for Sal's testing standard. Two builders read this:
the destedtui session builds the `gate` command; the sal-starter session ships the first repo that uses it.
If something here is wrong or can't be built as written, say so in your report under "Open questions"
and build the closest thing that keeps the guarantees below. Do not silently change the contract.

## Why it exists

Sal builds with agents only and no longer reads most code. Measured this month: no repo has a git hook,
no deploy workflow runs a test, and of 66 one-line bugs planted in two repos, 33 passed every check.
`gate` is the one command that decides whether a commit may reach `main`. Its guarantees:

1. **Clean copy.** Checks run on `git archive <commit>`, never the working tree, so another agent's
   half-finished files (or a file somebody forgot to `git add`) can't turn a red commit green.
2. **Own databases, own ports.** Nothing depends on a database or server that happens to exist.
3. **Skipped counts as failed.** A skipped, todo or zero-test run fails the check.
4. **A receipt.** A pass writes a signed receipt for that tree. In a repo in `block` mode, an agent's
   push to a protected branch without one is refused by the agent guard (no git hook: see the end).
5. **Two modes.** `report` runs and records but never blocks a push (for existing repos until they are
   ready). `block` refuses. A new repo from sal-starter starts in `block`.

## gate.json (repo root, committed)

```json
{
  "version": 1,
  "mode": "block",
  "branches": ["main", "master"],
  "copy": { "env": [".env"], "keep": ["node_modules"] },
  "setup": ["bun install --frozen-lockfile"],
  "databases": [
    { "env": "DATABASE_URL", "migrate": "bun run db:deploy", "key": ["apps/web/prisma"] }
  ],
  "ports": [],
  "pass": [],
  "checks": [
    { "name": "types", "run": "bun run typecheck" },
    { "name": "rules", "run": "bun run test:rules" },
    { "name": "api",   "run": "bun run test:api" },
    { "name": "flows", "run": "bun run test:flows", "timeout": 900 }
  ],
  "probe": {
    "include": ["apps/web/server/**/*.ts", "apps/web/src/**/*.{ts,tsx}"],
    "exclude": [{ "path": "apps/web/server/logger.ts", "why": "log colours and formatting" }],
    "minRate": 0.9,
    "critical": ["apps/web/server/auth/**", "apps/web/server/trpc.ts"]
  }
}
```

| Field | Meaning | Default |
| --- | --- | --- |
| `version` | Always `1`. Unknown version → exit 2. | required |
| `mode` | `report` or `block`. | required |
| `branches` | Branch names the push hook protects. | `["main","master"]` |
| `copy.env` | Files copied from the **working tree** into the clean copy at the same relative path, when they exist (gitignored secrets). Never printed. | `[".env"]` |
| `copy.keep` | Directory basenames carried over from the previous run's copy (dependency caches), at any depth ≤ 4, not nested inside another kept directory. | `["node_modules"]` |
| `setup` | Shell commands run in order at the copy root before the checks. A failure is reported as a failed check named `setup` (exit 1): it is reproducible from the commit. | `[]` |
| `databases[]` | One fresh database per entry (see below). | `[]` |
| `ports[]` | Env var names. Each gets a distinct free TCP port, free on both 127.0.0.1 and ::1. | `[]` |
| `pass[]` | Extra env var names passed through from the caller's environment. | `[]` |
| `checks[]` | Ordered. `name` matches `^[a-z][a-z0-9-]*$` and is unique. `run` is a shell command (`sh -c`) at the copy root, or in `cwd` (relative). `timeout` in seconds, default 600. `skips`: `"fail"` (default) or `"allow"`. | required, ≥ 1 |
| `probe` | Settings for `gate probe` (the planted-bug run): `include` globs that may be mutated; `exclude[]` of `{ path (glob), why }`. A single line is excluded in the source instead, with `// probe-ignore: <why>` on that line or the line above. Every exclusion needs a reason. `minRate` (0–1, default `0.9`): the probe exits 0 only at or above this catch rate. `critical[]` (globs: sign-in, permissions, money, anything that writes data): any missed bug under one fails the probe whatever the rate. | optional |

Unknown top-level keys are an error (exit 2) so a typo can't silently disable something. Validate with zod.

## What every command gets

**Working directory:** the clean copy (or the check's `cwd` inside it).

**Environment:** an allowlist, not the caller's environment. Passed through when set: `PATH`, `HOME`,
`USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TZ`, `TMPDIR`, `TERM`, `XDG_CONFIG_HOME`,
`XDG_CACHE_HOME`, `XDG_DATA_HOME`, `BUN_INSTALL`, `PLAYWRIGHT_BROWSERS_PATH`, `WSL_DISTRO_NAME`,
`WSL_INTEROP`, plus every name in `pass`. Then gate adds:

| Var | Value |
| --- | --- |
| `GATE` | `1` |
| `GATE_RUN` | the run id: 8 lowercase base36 characters |
| `GATE_SHA` | the full commit sha (the HEAD sha for a `--dirty` run) |
| `GATE_ROOT` | absolute path of the clean copy |
| `GATE_CHECK` | the check's name (`setup` for setup commands, `migrate` for a migrate command) |
| `NO_COLOR` | `1` (and `FORCE_COLOR=0`), so logs parse |
| each `databases[].env` | URL of that entry's fresh database |
| each `ports[]` name | the port number |

Gate does **not** read the copied `.env` into the environment; the repo's own scripts load it as they
always do. Process env wins over `.env` in Bun and Node, so gate's database URLs override the dev ones.
(Builder of gate: prove that with a fixture test, don't assume it.)

## Databases

For each `databases[]` entry, in order (`n` = index from 0):

- **Server.** Host, port, user and password come from the value of that env var in the caller's
  environment, else in the working tree's `copy.env` files (first that defines it). No value → exit 3
  with: which var, which files were read.
- **Name.** `gate_<slug>_<run>_<n>`. `<slug>` = the repo folder name lowercased, every character
  outside `[a-z0-9]` turned into `_`, cut to 20 characters.
- **Guarantee to the repo.** The env var points at a database that exists, is migrated (when `migrate`
  is set), is empty of app rows, and has **no open connections** when the first check starts, so a test
  harness may use it as a `CREATE DATABASE … TEMPLATE` source. Any database the harness creates must be
  named `<that database>_<suffix>`; gate drops all of them.
- **Migrate.** `migrate` runs once at the copy root with the env above. Failure → failed check `setup`.
- **Template cache.** With `key` (paths in the copy), gate hashes those paths' contents and keeps a
  migrated template `gate_tpl_<slug>_<n>_<hash12>`; a hit makes the run database with
  `CREATE DATABASE … TEMPLATE …` instead of running `migrate`. Making a new template drops that
  entry's older templates. Without `key`, migrate every run.
- **Cleanup.** At the end of every run, pass or fail or interrupted (SIGINT, SIGTERM), drop every
  database on that server whose name starts with `gate_<slug>_<run>_`, using `DROP DATABASE … WITH (FORCE)`.
  At the start of every run, sweep databases named `gate_<slug>_<8 chars>_…` whose run is not alive
  (no live lock for that run id) and that are older than 6 hours.
- **Safety, hard rule.** Gate never drops, truncates or writes to a database whose name does not start
  with `gate_`. Enforce it in one function every drop goes through, and test that function.

## The clean copy

- Work root: `$GATE_WORK/<slug>` when `GATE_WORK` is set; else `/w/junk/<repo folder>/.gate` when the
  repo is `/w/code/<repo folder>` (Sal's machine: scratch lives in the junk twin, outside git); else
  `<os tmpdir>/gate/<slug>`.
- Layout: `tree/` (the copy), `runs/<run>/<check>.log`, `lock`. Keep the 20 newest `runs/`.
- Making the copy: extract `git archive <sha>` into a new empty directory, move the `copy.keep`
  directories over from the old `tree/` (a rename, not a copy), delete the old tree, rename the new one
  to `tree/`. Then copy `copy.env`. Never symlink `node_modules` from the working tree.
- `--dirty`: the same copy of HEAD, then overlay the working tree's modified, added and untracked
  non-ignored files and remove its deleted ones. A `--dirty` run never writes a receipt.
- One run per repo at a time: `lock` holds the pid and run id. A second `gate` waits and says what it
  waits on; `--no-wait` exits 3 instead. A lock whose pid is dead is stale.

## Running the checks

- Order as listed; stop at the first failure (later checks are reported `not run`). `--all` keeps going.
- `--only a,b` runs a subset and never writes a receipt.
- Each check's combined stdout+stderr goes to its log file. On failure print the failing test names
  when the output is from a known runner, then the last 40 lines, then the log path.
- A timeout kills the check's whole process group and fails it with `timed out after <n>s`.
- **Counts.** Recognize the summary of `bun test` and of Playwright's list/line reporters and record
  `passed`, `failed`, `skipped`, `todo`, `flaky`. (Capture real output from Bun 1.4 and the installed
  Playwright as test fixtures; don't write the patterns from memory.)
- **Skipped counts as failed.** With `skips: "fail"`: `skipped > 0`, `todo > 0`, Playwright
  "did not run" > 0, or a recognized summary reporting zero tests → the check fails even on exit 0,
  with the reason on its line. `flaky > 0` passes but is listed in the output and the receipt.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | every check passed |
| 1 | a check (or `setup`) failed: the commit is red |
| 2 | usage or gate.json error |
| 3 | gate itself couldn't run: no Postgres, no disk, lock held with `--no-wait` |

An agent must be able to tell "my code is red" (1) from "the gate is broken" (3). Every error says
what to do next.

## Receipt, history

- Receipts: `<git common dir>/gate/receipts/<tree sha>.json`, keyed by the commit's **tree** sha, so an
  amend of the message or a rebase that leaves the content alone keeps its receipt.
- A receipt is written only when every check in gate.json ran and passed on a non-dirty run.
- Shape: `{ v: 1, tree, sha, ok: true, at, ms, run, gate: "<gate version>", checks: [{ name, ok, ms,
  exit, counts? }], flaky: string[], sig }`. `sig` = HMAC-SHA256 over the canonical JSON of every other
  field, with the machine key at `~/.destedtui/gate/key` (32 random bytes, mode 0600, made on first use).
  A receipt whose signature doesn't verify is treated as absent.
- History: `<git common dir>/gate/history.jsonl`, one line per run of any kind: `{ at, run, sha, tree,
  mode, trigger: "manual"|"push"|"probe", dirty, only, ok, ms, checks: [{ name, ok, ms, counts?,
  reason? }] }`.

## The push guard (no git hook, no git config)

Sal, 2026-11-20: "i dont like global git hook. you are the only thing writing code anymore on this
computer. its just for you. dont mess with git." So gate never installs a git hook, never writes git
config, never pushes or creates refs. Agents are the only pushers on this machine, so the check sits
in the agents' own guard: the `agent-guard` PreToolUse hook (sals-powershell-setup) calls
`gate guard push` before it lets an agent's `git push` through. Sal's own pushes are not checked.

`gate guard push --cwd <dir> [--json] -- <the arguments after "git push">`
Read-only: it runs only read-only git commands. Exit 0 = allow (stdout may carry one note line),
exit 1 = deny (stdout is the reason and the exact next command), exit 2 = couldn't parse (the guard
allows and shows the note: never block a push because of a gate bug).

- Work out what would be pushed where from the arguments: no refspec → the current branch to its
  push destination (`@{push}` when set, else the same name); `src`, `src:dst`, `+src:dst`, `HEAD`,
  `refs/heads/x`; `--all` / `--mirror` → every local branch; deletes (`:dst`, `--delete`) are skipped.
  The remote is the first positional argument, else the branch's configured remote, else `origin`.
- For each (commit, destination branch): read `gate.json` from the **pushed commit**. None → allow.
  Destination not in `branches` → allow. The remote-tracking ref already at that commit → allow.
- **Weakening.** If the remote-tracking ref's commit has a gate.json in `block` mode and the pushed
  gate.json is gone, or says `report`, or dropped a check name, or changed a check to
  `skips: "allow"`, or no longer lists this branch → deny, unless an allowance exists for that sha:
  `gate: this push weakens the gate (<what>). That is Sal's call. If Sal said so in this
  conversation: gate allow-weaken --sha <sha> --why "<his words>", then push again.`
  `gate allow-weaken` appends `{ at, sha, why }` to `<git common dir>/gate/allow.jsonl`.
- `mode: "block"`: a valid passing receipt for the pushed commit's tree → allow with one line.
  Otherwise deny: the short sha, why (no receipt / last run failed at `<check>`), and the next command
  (`gate`, run in that repo).
- `mode: "report"`: always allow, with one line saying what block mode would have done. If there is
  no receipt and no failed run for that tree, start `gate run --sha <sha> --trigger push --quiet`
  detached (own session, output to its run log) so the history fills in without anyone waiting.
