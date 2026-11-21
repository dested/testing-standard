# Bringing an existing repo onto the standard

Four steps, in this order. Each one leaves the repo working and is worth having on its own. The order matters: the later steps lean on the earlier ones, and the first changes nothing about what the app does.

Run `gate init` first. It writes `gate.json` in report mode from the repo's scripts and prints what it could not detect. Review it, commit it, run `gate`. Nothing blocks a push at any point.

## 1. Give the tests their own databases

Before writing a single new test, make the ones that exist safe to run.

- One migrated, empty template database, cloned per test process and dropped at the end.
- One guard function that every create, drop and truncate goes through. It refuses any database that isn't a test database.
- A test environment that never loads the repo's `.env` or a real provider key. A fake stands in for each paid service at the edge.
- Every conditional skip becomes a real failure with the fix in its message.

On the first existing app brought onto the standard, 32 test files had been writing to the dev database and 4 truncated a shared test database. Nobody had noticed.

Done when: `gate` is green on a clean copy, and replaying a list of planted bugs gives a first catch rate. That first number is the baseline for everything after.

## 2. Names, the access table, and an API test for every procedure

- Rename every test file to one of the three names without rewriting it. Add the names check.
- Tag every procedure builder with who it lets in. Write the builders' contract test: each builder against each kind of caller, with the exact error.
- Generate the table of who may call what and commit it. Add the test that fails when the table and the router disagree.
- Give every procedure a `describe('<path>')` that covers what it returns, writes and refuses. Fake only at the edge: the AI provider, file storage, push.
- See each new test red against a planted one-line bug before counting it.

Done when: a test names any procedure without an API test, and it names none.

## 3. Flows on every screen, at both widths

- Port the flow fixture: the production build per worker, on a free port, on its own clone of the database.
- Turn on the automatic problem checks and the every-screen check. Expect them to find real things on the first run. Fix what is real. Allow, by exact text and with a note, only what is known and waiting on a decision.
- Write a flow for every route that no flow lands on. Title each `<feature>/<flow> · <what a person sees>` and start it with its `// Check:` line.
- Every flow runs at desktop and phone width.

On the first app, the first full run failed 102 of 104 flow runs on the new checks alone. One cause was a real production problem (a fix the bundler had been dropping from every page) and two were noise.

Done when: a full run fails naming any screen no flow walked, and it names none.

## 4. Prove it with planted bugs

- Replay the first list of planted bugs. Every miss is now caught, or carries an honest `// probe-ignore` and is nowhere near sign-in, permissions, money or data.
- Then plant bugs the tests were never written against: `gate probe --max 40 --seed 1`. Write a test for each miss, and run again with a new seed.
- Report the new-sample number, not the replay.

Expect the replay to reach 100% and the new sample to land well below it. On the first app the replay went 36% → 64% → 100% across steps 1 to 3, while three new samples of 40 caught 53%, 57% and 63%. Each round of writing tests for the misses moved the new-sample number about five points.

## What to leave alone

- Existing unit tests that aren't rules stay until one blocks a change the owner asked for. Then it is deleted, not rewritten.
- `gate.json` stays in report mode. Blocking is the owner's decision.
- The repo's deploy files. Nothing in this standard runs during a deploy or can fail one.
