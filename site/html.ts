// Tiny HTML helpers shared by the page templates.

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** Escape text for an HTML text node or a quoted attribute. */
export function esc(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ENTITIES[ch] ?? ch)
}

/** GitHub's heading slug: lower case, punctuation dropped, spaces to hyphens. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-')
}

/** Backticks in a short string become <code>; everything else is escaped. */
export function inline(text: string): string {
  return esc(text).replace(/`([^`]+)`/g, '<code>$1</code>')
}
