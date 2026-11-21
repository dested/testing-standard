# What was measured

The standard came out of an audit and was then proved on two repos: the starter template every new project begins from, and one production app with 174 API procedures. Every number here comes from a recorded run.

## Before: half the planted bugs passed every check

The audit covered 3,130 test files in 59 repos. Three in four were unit tests. They were honest tests (only 27 files mocked anything), but each checked one small function.

To see what the tests were worth, 66 one-line bugs were planted in two repos, one at a time: a flipped condition, a deleted guard, a number off by one. **33 of the 66 passed every check.**

| Repo | Planted | Caught by types | Caught by tests | Passed everything |
| --- | --- | --- | --- | --- |
| The starter | 40 | 13 | 11 | 16 |
| The production app | 26 | 4 | 5 | 17 |

Three of the ones that got through:

- An admin check with its `!` removed. Admins were refused, everyone else was let in, and every test stayed green.
- `&&` turned into `||` in a voice session. A reply the listener cut off was recorded as heard in full.
- Minus turned into plus in a cost calculation. Costs were filed under the wrong day.

What the audit showed:

- Unit tests on real logic caught as many planted bugs as the browser tests did. The other unit tests caught none.
- A browser test only sees the screens it walks. The production app had 1,049 `bun` tests and 52 browser tests, and the browser tests caught nothing.
- Nothing made any test run. A push went to production with no check in between.
- In one repo, 88 of 438 test files skipped themselves unless a database variable was set.

## After: every one of those bugs is caught

The same planted bugs were replayed after the work.

| Repo | Got through before | Get through now |
| --- | --- | --- |
| The starter | 16 of 40 | 0 |
| The production app | 16 of 25 (one of the 26 is log formatting and is set aside) | 0 of 24 (a second is set aside: both versions of the line behave the same) |

On the production app the replay moved step by step, which shows what each step bought:

| After step | Catch rate on the audit's list | What changed |
| --- | --- | --- |
| 1. Own databases | 36% | Nothing about the tests' reach, only their safety |
| 2. An API test per procedure | 64% | Every server-side miss caught |
| 3. A flow per screen | 100% | Every screen-side miss caught |

## The honest number: bugs the tests were never written against

A replayed list goes to 100% because the tests were written to catch it. The measurement that counts plants bugs nobody has seen.

| Repo | Run | Caught | Rate |
| --- | --- | --- | --- |
| The starter | 40 new bugs | 32 | 80% |
| The production app | 40 new bugs, first run | 21 | 53% |
| The production app | 40 new bugs, after fixing the first run's misses | 23 | 57% |
| The production app | 40 new bugs, after fixing the second run's misses | 25 | 63% |

Neither repo meets the 90% bar yet. Each round of writing tests for the misses moved the production app about five points.

Which check caught the 32 on the starter: types 15, rules 9, flows 6, API 2.

## What the checks found that no planted bug was looking for

Turning the standard on surfaced real problems before any bug was planted:

- **A fix that never reached production.** In the production app, a side-effect import was being dropped by the bundler, so every page logged a security-policy violation. The flows' automatic console check caught it the first time they ran the production build. The fix was 17 bytes.
- **Text spilling off a phone screen.** The starter's signed-in header overflowed a 390 px screen. The phone-width run caught it.
- **32 test files writing to the dev database**, and 4 truncating a shared one, in the production app. Giving the tests their own databases found them all.

## What a full run costs

On the production app, on a clean copy of the commit: types 3 s, rules 1 s (422 tests), API 41 s (1,071 tests), flows 100 s (164 runs across two widths).
