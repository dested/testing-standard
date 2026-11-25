// Screenshots from site/public: the markdown links them as `site/public/x.png`
// (so they show on GitHub too), the site serves them at `/x.png`. Each gets its
// real size, so the page doesn't jump as it loads, and links to the full image.

import { join } from 'node:path'
import { esc } from './html'

const ROOT = join(import.meta.dir, '..')
const PUBLIC = 'site/public/'

/** `site/public/x.png` → `/x.png`; anything else is not a local image. */
export function publicPath(href: string): string | null {
  return href.startsWith(PUBLIC) ? `/${href.slice(PUBLIC.length)}` : null
}

/** Width and height from a PNG's header. */
async function pngSize(file: string): Promise<{ width: number; height: number }> {
  const head = new DataView(await Bun.file(file).slice(0, 24).arrayBuffer())
  if (head.byteLength < 24 || head.getUint32(12) !== 0x49484452) throw new Error(`${file} is not a PNG`)
  return { width: head.getUint32(16), height: head.getUint32(20) }
}

/** A screenshot in site/public as a linked image. `href` is its repo path, `site/public/x.png`. */
export async function shot(href: string, alt: string): Promise<string> {
  const src = publicPath(href)
  if (!src) throw new Error(`${href} is not under ${PUBLIC}`)
  const { width, height } = await pngSize(join(ROOT, href))
  return `<a class="shot" href="${esc(src)}"><img src="${esc(src)}" alt="${esc(alt)}" width="${width}" height="${height}" loading="lazy" decoding="async"></a>`
}
