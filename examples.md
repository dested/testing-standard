# Examples

Real files from [sal-starter](https://github.com/dested/sal-starter), the reference implementation. Each is cut down to show the shape; the links go to the whole file.

## A rule: `access.rule.test.ts`

Who may sign up. Pure, many cases, and silent when wrong: the kind of logic a rule is for.

```ts
import { describe, expect, test } from 'bun:test'
import { emailMatches } from './access'

describe('emailMatches', () => {
  const entries = ['ada@example.com', '@acme.io']

  test('a whole domain, and only that domain', () => {
    expect(emailMatches('anyone@acme.io', entries)).toBe(true)
    expect(emailMatches('x@eng.acme.io', entries)).toBe(false)
    expect(emailMatches('x@notacme.io', entries)).toBe(false)
    expect(emailMatches('x@acme.io.evil.com', entries)).toBe(false)
  })

  test('the last @ decides the domain', () => {
    expect(emailMatches('"a@acme.io"@evil.com', entries)).toBe(false)
  })
})
```

[`apps/web/server/access.rule.test.ts`](https://github.com/dested/sal-starter/blob/main/apps/web/server/access.rule.test.ts)

## An API test: `demo.api.test.ts`

One `describe` per procedure: what it returns, what it writes, what it refuses. The caller is a real session, and the row is read back from a real Postgres.

```ts
import { describe, expect, test } from 'bun:test'
import { asAnon, asUser } from '../test/callers'
import { prisma } from './prisma'

describe('posts.create', () => {
  test('writes a post owned by the caller and returns it', async () => {
    const person = await asUser()
    const created = await person.api.posts.create({ title: 'Hello', content: 'World' })
    const row = await prisma.post.findUniqueOrThrow({ where: { id: created.id } })
    expect(row).toMatchObject({ title: 'Hello', content: 'World', authorId: person.user.id })
  })

  test('rejects a signed-out caller and writes nothing', async () => {
    const before = await prisma.post.count()
    const anon = await asAnon()
    await expect(anon.api.posts.create({ title: 'nope', content: 'nope' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
    expect(await prisma.post.count()).toBe(before)
  })
})
```

[`apps/web/server/demo.api.test.ts`](https://github.com/dested/sal-starter/blob/main/apps/web/server/demo.api.test.ts) · callers: [`apps/web/test/callers.ts`](https://github.com/dested/sal-starter/blob/main/apps/web/test/callers.ts) · databases: [`apps/web/test/db.ts`](https://github.com/dested/sal-starter/blob/main/apps/web/test/db.ts)

## Who may call what: `router.access.md`

Generated from the tag on each procedure's builder, committed, and checked by a test. A permission change is a one-line diff here.

```md
| procedure    | kind     | signed out | signed in | admin |
| ---          | ---      | ---        | ---       | ---   |
| me           | query    | no         | yes       | yes   |
| posts.create | mutation | no         | yes       | yes   |
| posts.list   | query    | yes        | yes       | yes   |
```

[`apps/web/server/router.access.md`](https://github.com/dested/sal-starter/blob/main/apps/web/server/router.access.md) · the script: [`apps/web/test/access-table.ts`](https://github.com/dested/sal-starter/blob/main/apps/web/test/access-table.ts)

## A flow: `auth.flow.spec.ts`

The title says what a person sees. The `// Check:` line names the one thing to look for. It imports `test` from the fixture, never from Playwright, and runs at both widths without saying so.

```ts
import { expect, test } from './flow'

test('auth/sign-in-next · signing in returns to the page and query asked for', async ({
  page,
  world,
}) => {
  // Check: sign-in from /dashboard?tab=posts ends on /dashboard?tab=posts.
  const person = await world.account('Linus')
  await page.goto('/dashboard?tab=posts')
  await page.waitForURL('**/sign-in?next=%2Fdashboard%3Ftab%3Dposts')
  await page.getByLabel('Email').fill(person.email)
  await page.getByLabel('Password').fill(person.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL((url) => url.pathname === '/dashboard' && url.search === '?tab=posts')
  await expect(page.getByRole('heading', { level: 1, name: 'Linus' })).toBeVisible()
})
```

[`apps/web/e2e/auth.flow.spec.ts`](https://github.com/dested/sal-starter/blob/main/apps/web/e2e/auth.flow.spec.ts) · the fixture: [`apps/web/e2e/flow.ts`](https://github.com/dested/sal-starter/blob/main/apps/web/e2e/flow.ts) · the every-screen check: [`apps/web/e2e/coverage.ts`](https://github.com/dested/sal-starter/blob/main/apps/web/e2e/coverage.ts)

What the fixture does without being asked, at the end of every flow:

```
no uncaught page error
no console.error
no response of 500 or more, no failed same-origin request
no sideways overflow on the page the flow ended on
```

A flow that provokes one on purpose allows exactly that one:

```ts
problems.allow('response', /\/api\/auth\/get-session/)
```

## `gate.json`

The whole contract between a repo and `gate`: how to set up, which database to make, the four checks, and which files planted bugs go into. This is the starter's.

```json
{
  "version": 1,
  "mode": "report",
  "branches": ["main", "master"],
  "copy": { "env": [".env"], "keep": ["node_modules"] },
  "setup": ["bun install --frozen-lockfile", "bun run db:generate"],
  "databases": [
    {
      "env": "DATABASE_URL",
      "migrate": "bun run db:deploy",
      "key": ["apps/web/prisma/schema.prisma", "apps/web/prisma/migrations"]
    }
  ],
  "ports": [],
  "pass": [],
  "checks": [
    { "name": "types", "run": "bun run typecheck" },
    { "name": "rules", "run": "bun run test:rules" },
    { "name": "api", "run": "bun run test:api" },
    { "name": "flows", "run": "bun run test:flows", "timeout": 900 }
  ],
  "probe": {
    "include": ["apps/web/server.ts", "apps/web/server/**/*.ts", "apps/web/src/**/*.{ts,tsx}"],
    "exclude": [
      { "path": "apps/web/server/logger.ts", "why": "log colours and formatting" },
      { "path": "apps/web/**/*.test.ts", "why": "the tests themselves, not code under test" }
    ]
  }
}
```

[`gate.json`](https://github.com/dested/sal-starter/blob/main/gate.json)

A real app adds the files where a missed bug is never acceptable. A planted-bug run fails if one gets through there, whatever the rate:

```json
"probe": {
  "minRate": 0.9,
  "critical": [
    "apps/web/server/auth.ts",
    "apps/web/server/trpc.ts",
    "apps/web/server/routers/**"
  ]
}
```

## What `gate` prints

A pass, on the starter:

```
gate  sal-starter  c9c25a3  report  clean copy · 1 database
pass  setup    2.3s   1 database from the template cache
pass  types    1.4s
pass  rules    0.3s   53 tests
pass  api      3.2s   32 tests
pass  flows   18.0s   32 tests
receipt written · report mode never blocks a push
```

A failure names the tests and stops:

```
FAIL  api     19.8s   211 passed · 1 failed
      posts.create > rejects a signed-out caller
      …last 40 lines of the log…
 --   flows    not run
FAILED at api. Fix it, commit, run gate again.
```

## What `gate probe` prints

One line per planted bug, then the rate. These lines are from a run of 40 new bugs on the starter:

```
gate probe  sal-starter  6aa609c  40 bugs  baseline types 1.4s · rules 0.3s · api 4.0s · flows 15.2s
caught  rules  apps/web/src/lib/loader.ts:57     flip-rel    safeNext > another host, a scheme or a relative path never does
caught  api    apps/web/server/trpc.ts:59        drop-not    procedure builders > each builder lets in exactly its callers, with the right error for the rest
caught  types  apps/web/server/access.ts:26      flip-eq
caught  flows  apps/web/src/app/sign-in.tsx:18   flip-bool   [desktop] › e2e/auth.flow.spec.ts:63:1 › auth/sign-in-next · signing in returns to the page and query asked for
MISSED         apps/web/server/auth.ts:50        off-by-one  window: 10, → window: 11,
MISSED         apps/web/src/app/sign-up.tsx:26   flip-bool   setLoading(false) → setLoading(true)
…
40 counted · 32 caught (rules 9 · api 2 · types 15 · flows 6) · 8 missed · 0 excluded · 0 stale
catch rate 80%
```

A `caught` line names the check and the test that went red. A `MISSED` line shows the exact change that got through: here, a rate-limit window nobody tests and a sign-up button that would stay stuck on loading. The fix for each is a test that fails on that change.
