// bun site/build.ts → dist/: the home page, one page per markdown file, the
// stylesheet, the browser script and site/public as it is.

import { cp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { DOCS, docBody, renderDoc } from './docs'
import { landing } from './landing'
import { page } from './layout'

const SITE_DIR = import.meta.dir
const ROOT = join(SITE_DIR, '..')
const OUT = join(ROOT, 'dist')

function stamp(text: string): string {
  return new Bun.CryptoHasher('sha1').update(text).digest('hex').slice(0, 10)
}

export async function build(): Promise<{ pages: string[] }> {
  await rm(OUT, { recursive: true, force: true })
  await mkdir(OUT, { recursive: true })
  await cp(join(SITE_DIR, 'public'), OUT, { recursive: true })

  const css = await Bun.file(join(SITE_DIR, 'styles.css')).text()
  await Bun.write(join(OUT, 'site.css'), css)

  const bundle = await Bun.build({ entrypoints: [join(SITE_DIR, 'client.ts')], target: 'browser', minify: true })
  const script = bundle.outputs[0]
  if (!bundle.success || !script) throw new Error(`client.ts did not build:\n${bundle.logs.join('\n')}`)
  const js = await script.text()
  await Bun.write(join(OUT, 'app.js'), js)

  const assets = { css: `/site.css?v=${stamp(css)}`, js: `/app.js?v=${stamp(js)}` }
  const readme = await Bun.file(join(ROOT, 'README.md')).text()
  const version = /^Version (\d+\.\d+)/m.exec(readme)?.[1]
  if (!version) throw new Error('README.md has no "Version x.y" line')

  const pages: string[] = ['/']
  await Bun.write(
    join(OUT, 'index.html'),
    page(
      {
        title: 'Testing standard',
        description:
          'Five checks, one command, and a measured number for how far to trust a green run. A way to test web apps that agents build and nobody reads line by line.',
        path: '/',
        current: 'home',
        version,
        assets,
      },
      await landing(),
    ),
  )

  for (const doc of DOCS) {
    const rendered = await renderDoc(doc)
    const path = `/${doc.slug}/`
    await mkdir(join(OUT, doc.slug), { recursive: true })
    await Bun.write(
      join(OUT, doc.slug, 'index.html'),
      page(
        { title: `${doc.label} · Testing standard`, description: doc.description, path, current: doc.slug, version, assets },
        docBody(rendered),
      ),
    )
    pages.push(path)
  }
  return { pages }
}

if (import.meta.main) {
  const { pages } = await build()
  console.log(`built ${pages.length} pages into dist/: ${pages.join(' ')}`)
}
