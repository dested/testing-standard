// Code pulled out of examples.md by section, so the home page shows the same
// code the examples page does and the two can't drift apart.

import { join } from 'node:path'
import { Marked, Parser, type Token, type Tokens } from 'marked'

export type Sample = {
  /** The fence's language, or null for terminal output. */
  lang: string | null
  code: string
  /** The file the code is from: the first link in the line under the block. */
  file: { path: string; href: string } | null
  /** For a block with no file under it, the sentence above it, as HTML. */
  lead: string | null
}

function isHeading(token: Token): token is Tokens.Heading {
  return token.type === 'heading' && 'depth' in token
}
function isCode(token: Token): token is Tokens.Code {
  return token.type === 'code' && 'text' in token && typeof token.text === 'string'
}
function isParagraph(token: Token | undefined): token is Tokens.Paragraph {
  return token !== undefined && token.type === 'paragraph' && 'tokens' in token
}
function isLink(token: Token | undefined): token is Tokens.Link {
  return token !== undefined && token.type === 'link' && 'href' in token
}

/** `pick('A rule:', 1)` → the first code block under the heading that starts that way. */
export type Picker = (headingStartsWith: string, take: number) => Sample[]

export async function examples(): Promise<Picker> {
  const source = await Bun.file(join(import.meta.dir, '..', 'examples.md')).text()
  const tokens = new Marked({ gfm: true }).lexer(source).filter((t) => t.type !== 'space')

  return (headingStartsWith, take) => {
    const start = tokens.findIndex((t) => isHeading(t) && t.depth === 2 && t.text.startsWith(headingStartsWith))
    if (start < 0) throw new Error(`examples.md has no "## ${headingStartsWith}…" section`)
    const rest = tokens.slice(start + 1)
    const end = rest.findIndex((t) => isHeading(t) && t.depth <= 2)
    const section = end < 0 ? rest : rest.slice(0, end)

    const found: Sample[] = []
    section.forEach((token, i) => {
      if (!isCode(token) || found.length >= take) return
      const after = section[i + 1]
      const before = section[i - 1]
      const link = isParagraph(after) ? after.tokens[0] : undefined
      const file = isLink(link) ? { path: link.text.replace(/`/g, ''), href: link.href } : null
      found.push({
        lang: token.lang ? token.lang : null,
        code: token.text,
        file,
        lead: !file && isParagraph(before) ? Parser.parseInline(before.tokens) : null,
      })
    })
    if (found.length < take) throw new Error(`"## ${headingStartsWith}…" has ${found.length} code blocks, expected ${take}`)
    return found
  }
}
