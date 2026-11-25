# The site

testing.dested.com is this repo, built into static pages. The markdown at the repo root is the standard; the site renders it and adds a home page. Nothing in `site/` restates the standard's rules in its own words except the home page, and every number there comes from a recorded run.

```bash
bun install
bun run dev         # http://localhost:7357, rebuilt on every change
bun run build       # dist/
bun run typecheck
```

| File | What it is |
| --- | --- |
| `build.ts` | Writes `dist/`: the home page, one page per markdown file, `site.css`, `app.js`, and `public/` as it is |
| `dev.ts` | The local server on port 7357. It answers the way the deployed static server does |
| `layout.ts` | The shell every page shares: head, top bar, footer |
| `landing.ts` | The home page |
| `docs.ts` | The markdown pages. `DOCS` maps each file to its address |
| `examples.ts` | Pulls code blocks out of `examples.md` by heading, for the home page |
| `code.ts` | One code block as HTML: highlighted when it names a language, a dark terminal when it doesn't |
| `image.ts` | A screenshot in `public/` as a linked image at its real size, for the home page and the markdown pages |
| `client.ts` | The browser script: the planted-bug board and the adoption picker |
| `styles.css` | Every style. One light theme, tokens at the top |
| `data/planted-bugs.json` | The 40 planted bugs on the home page: one recorded `gate probe` run on the starter |
| `data/gate.txt`, `data/gate-tests.txt` | Real output, pasted. Leaving lines out is marked with `…` |
| `public/` | Copied to `dist/` unchanged: the icon, `og.png`, and the tests page screenshots (`tests-page.png`, `tests-page-test.png`) |

## Things to know

- **The home page's code is `examples.md`'s code.** Each check in `CHECKS` (`landing.ts`) names a heading in `examples.md` and how many of its code blocks to show. The file label is the first link in the line under a block; a block with no link under it shows the sentence above it. The build fails if a heading or a block is missing, so the two pages can't drift.
- **A new markdown page** is one entry in `DOCS` in `docs.ts`, and one in `KNOWN` in `layout.ts`.
- **Addresses end in a slash** (`/adopt/`). The deployed server answers an unknown path with the home page, so the home page sends `/adopt` on to `/adopt/`.
- **Links between the markdown files stay as GitHub reads them** (`adopt.md#a-new-project`). The site rewrites them.
- **A code block with a language is highlighted; one without is shown as terminal output.**
- **A screenshot in the markdown** is linked as `site/public/<name>.png`, so GitHub shows it too; the site serves it at `/<name>.png` with its real size. The tests page shots are `gate tests --html --no-open` on the starter, taken at 1280px wide.
- **`/__phone?u=/adopt/`** (dev only) shows a page as 390px-wide slices side by side, for a browser tool that can't resize its window. `document.body.dataset.overflow` is the sideways overflow in pixels and should be 0.
- **`/__og`** (dev only) is the share image as a page. `public/og.png` is a screenshot of its `#og` box: retake it when the headline or the run changes.
- **Refreshing the board:** copy a newer `gate probe` result from the starter into `data/planted-bugs.json` in the same shape, and paste the matching output into the two text files.

## Deploy

Every push to `main` deploys to testing.dested.com as a static site: `bun run build`, then `dist/` is served. The root `Dockerfile`, `drydock.yaml` and `.github/workflows/drydock.yml` are written by the deploy tool. Don't edit them by hand.
