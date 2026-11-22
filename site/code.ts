// Code blocks, for the markdown pages and the home page alike: a block with a
// language is highlighted, one without is terminal output.

import { codeToHtml } from 'shiki'
import { esc } from './html'

const LANGS: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  json: 'json',
  bash: 'bash',
  sh: 'bash',
  md: 'markdown',
  yaml: 'yaml',
  yml: 'yaml',
}

/** Colour the fixed vocabulary of gate's and tsc's output; everything else is plain. */
function terminalLines(text: string): string {
  return text
    .trimEnd()
    .split('\n')
    .map((line) => {
      const safe = esc(line)
      if (line.startsWith('$ ')) return `<span class="p">$ </span><span class="c">${esc(line.slice(2))}</span>`
      if (/^\s*(pass|caught)\b/.test(line)) return safe.replace(/^(\s*)(pass|caught)/, '$1<span class="ok">$2</span>')
      if (/^\s*(FAIL|MISSED|FAILED)\b/.test(line)) return safe.replace(/^(\s*)(FAIL|MISSED|FAILED)/, '$1<span class="bad">$2</span>')
      return safe
        .replace(/\berror (TS\d+)/g, '<span class="bad">error $1</span>')
        .replace(/✓/g, '<span class="ok">✓</span>')
        .replace(/✗/g, '<span class="bad">✗</span>')
    })
    .join('\n')
}

/** Terminal output as a dark block. `command` adds the prompt line above it. */
export function terminal(output: string, command?: string): string {
  const body = terminalLines(command ? `$ ${command}\n${output}` : output)
  return `<pre class="term" tabindex="0">${body}</pre>`
}

/** One code block as HTML: highlighted when it names a language, a terminal when it doesn't. */
export async function codeBlock(text: string, lang: string | null | undefined): Promise<string> {
  const known = LANGS[lang ?? '']
  return known ? await codeToHtml(text, { lang: known, theme: 'github-light' }) : terminal(text)
}
