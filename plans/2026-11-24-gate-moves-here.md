# gate moves into testing-standard

> Status: **active** · 2026-11-24 · board #900

Sal, 2026-11-24: "take it out of destedtui and put it here. i need everythign testing related to be here. im sharing this with other people anticipating it's complete."

## Goal

Everything for testing lives in this repo: the standard, the site, and the `gate` CLI with its tests page, spec, contract and skill. Someone handed `github.com/dested/testing-standard` has all of it and no pointer sends them to destedtui.

## What moves

From `destedtui` at master `5cd715f` (history before the move lives there, same paths):

| destedtui | here |
| --- | --- |
| `bin/gate.mjs` (+ `launchPlain` from `bin/launch.mjs`) | `gate/bin/gate.mjs`, standalone |
| `src/gate.ts`, `src/lib/gate/**` | `gate/src/gate.ts`, `gate/src/lib/gate/**` (paths kept, so history lines up) |
| `src/lib/pgurl.ts`, `platform.ts`, `pgtools.ts` | `gate/src/lib/`, trimmed to what gate uses |
| `test/gate/**`, `bunfig.toml` preload | `gate/test/gate/**`, `gate/bunfig.toml` |
| `scripts/gate-fixtures.sh` | `gate/scripts/gate-fixtures.sh` |
| `features/gate.md` | `gate/spec.md` |
| `skill/gate/SKILL.md` | `gate/skill/SKILL.md` |
| `W:\junk\code\testing-strategy\spec\gate-contract.md` (never in git) | `gate/contract.md` |

## Nothing breaks

- `gate` stays the command, with the same flags, exit codes and gate.json. Only the install moves: `cd gate && bun install && bun link`.
- gate's state dir: `~/.gate`, but an existing `~/.destedtui/gate` keeps being used, so receipts already signed still verify.
- Tests find Postgres from `PG*` env vars, else `postgres:postgres@localhost:5432` (the same default destedtui used), with no destedtui config.
- The `agent-guard` hook calls `gate` from PATH, so it keeps working once the new bin is linked.

## Steps

1. Copy, decouple, typecheck, test here.
2. Relink: `bun link` here and repoint `~/.claude/skills/gate`.
3. destedtui drops gate (`repo do destedtui`), docs point here.
4. sals-powershell-setup: `testing.md`, `claude-setup.md` and the WSL skill link point here (`repo do`).
5. The standard and site: install from here, the tests page (`gate tests --html`), 1.2 in CHANGELOG.
6. sal-starter's docs point here (`repo do`).
7. Push testing-standard (deploys testing.dested.com) and destedtui.
