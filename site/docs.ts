// The standard's markdown files, rendered as pages. The markdown at the repo
// root is the source of truth; nothing here rewrites its words.

import { join } from 'node:path'
import { Marked, type Token, type Tokens } from 'marked'
import { codeBlock } from './code'
import { esc, slug } from './html'
import { publicPath, shot } from './image'
import type { NavKey } from './layout'

export type Doc = { slug: Exclude<NavKey, 'home'>; file: string; label: string; description: string }

export const DOCS: Doc[] = [
  {
    slug: 'standard',
    file: 'README.md',
    label: 'The standard',
    description: 'Five checks, three test file names, four rules, one command, and a measured number for how far to trust a green run.',
  },
  {
    slug: 'adopt',
    file: 'adopt.md',
    label: 'Adoption plan',
    description: 'How a new project, an existing app, an older fork and something that is not a web app get onto the standard, and how to tell where a repo stands.',
  },
  {
    slug: 'examples',
    file: 'examples.md',
    label: 'Examples',
    description: 'One real example of each kind of test, the access table, gate.json and what gate prints.',
  },
  {
    slug: 'evidence',
    file: 'evidence.md',
    label: 'Evidence',
    description: 'What planted bugs measured before the standard and after it.',
  },
  {
    slug: 'changes',
    file: 'CHANGELOG.md',
    label: 'Changes',
    description: 'What changed between versions of the standard.',
  },
]

const ROOT = join(import.meta.dir, '..')

function isCode(token: Token): token is Tokens.Code {
  return token.type === 'code' && 'text' in token && typeof token.text === 'string'
}

function isImage(token: Token): token is Tokens.Image {
  return token.type === 'image' && 'href' in token && typeof token.href === 'string'
}

/** `adopt.md#x` → `/adopt/#x`; anything else is left alone. */
function siteHref(href: string): string {
  const match = /^([A-Za-z]+\.md)(#.*)?$/.exec(href)
  if (!match) return href
  const doc = DOCS.find((d) => d.file === match[1])
  return doc ? `/${doc.slug}/${match[2] ?? ''}` : href
}

export type Rendered = { doc: Doc; title: string; html: string; sections: Array<{ id: string; text: string }> }

export async function renderDoc(doc: Doc): Promise<Rendered> {
  let source = await Bun.file(join(ROOT, doc.file)).text()
  // The pointer to this site makes no sense on the site itself.
  source = source.replace(/\nRead it as a site at \[testing\.dested\.com\]\([^)]*\)\.\n/, '\n')

  const highlighted = new WeakMap<Tokens.Code, string>()
  const shots = new WeakMap<Tokens.Image, string>()
  const sections: Rendered['sections'] = []
  let title = doc.label

  const marked = new Marked({
    async: true,
    gfm: true,
    async walkTokens(token) {
      if (isCode(token)) highlighted.set(token, await codeBlock(token.text, token.lang))
      else if (isImage(token) && publicPath(token.href)) shots.set(token, await shot(token.href, token.text))
    },
    renderer: {
      code(token) {
        return highlighted.get(token) ?? `<pre class="term">${esc(token.text)}</pre>\n`
      },
      heading(token) {
        const inner = this.parser.parseInline(token.tokens)
        const text = token.tokens.map((t) => ('text' in t ? t.text : t.raw)).join('')
        if (token.depth === 1) {
          title = text
          return `<h1>${inner}</h1>\n`
        }
        const id = slug(text)
        if (token.depth === 2) sections.push({ id, text })
        return `<h${token.depth} id="${id}"><a href="#${id}">${inner}</a></h${token.depth}>\n`
      },
      image(token) {
        return shots.get(token) ?? `<img src="${esc(token.href)}" alt="${esc(token.text)}">`
      },
      link(token) {
        const href = siteHref(token.href)
        const outside = /^https?:/.test(href) && !href.startsWith('https://testing.dested.com')
        return `<a href="${esc(href)}"${outside ? ' rel="noopener"' : ''}>${this.parser.parseInline(token.tokens)}</a>`
      },
    },
  })

  const html = (await marked.parse(source))
    .replace(/<table>/g, '<div class="tbl"><table>')
    .replace(/<\/table>/g, '</table></div>')
    .replace(/<p>(Version [^<]+)<\/p>/, '<p class="version">$1</p>')

  return { doc, title, html, sections }
}

/** A doc page's body: the list of pages, this page's sections, the text. */
export function docBody(rendered: Rendered): string {
  const pages = DOCS.map(
    (d) => `<li><a href="/${d.slug}/"${d.slug === rendered.doc.slug ? ' aria-current="page"' : ''}>${esc(d.label)}</a></li>`,
  ).join('')
  const here = rendered.sections.map((s) => `<li><a href="#${s.id}">${esc(s.text.replace(/`/g, ''))}</a></li>`).join('')
  const index = DOCS.findIndex((d) => d.slug === rendered.doc.slug)
  const next = DOCS[index + 1]
  const prev = DOCS[index - 1]
  return `<div class="wrap doc-wrap">
<nav class="side" aria-label="The standard's pages">
<ul class="pages">${pages}</ul>
${here ? `<ul class="here">${here}</ul>` : ''}
</nav>
<main class="doc">
${rendered.html}
<div class="doc-next">${prev ? `<a class="btn line" href="/${prev.slug}/">${esc(prev.label)}</a>` : '<span></span>'}${next ? `<a class="btn solid" href="/${next.slug}/">${esc(next.label)}</a>` : ''}</div>
</main>
</div>`
}
