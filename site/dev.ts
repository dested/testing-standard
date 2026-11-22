// bun site/dev.ts → http://localhost:7357, rebuilt when a source file changes.
// It answers the way the deployed static server does: a path ending in / gets
// its index.html, and a path with no file gets the home page.
//
// /__phone?u=/adopt/ shows that page as 390px-wide slices side by side, for a
// browser tool that cannot resize its window. /__og is the share image as a
// page; site/public/og.png is a screenshot of its #og box. Both are dev only.

import { watch } from 'node:fs'
import { join } from 'node:path'
import { shareCard } from './landing'

const ROOT = join(import.meta.dir, '..')
const OUT = join(ROOT, 'dist')
const PORT = Number(process.env.PORT ?? 7357)

// Each build is its own process, so an edit to a template or the build script
// itself is picked up without restarting this server.
async function rebuild(why: string): Promise<void> {
  const started = performance.now()
  const run = Bun.spawn(['bun', join(import.meta.dir, 'build.ts')], { cwd: ROOT, stdout: 'ignore', stderr: 'pipe' })
  const [code, errors] = await Promise.all([run.exited, new Response(run.stderr).text()])
  if (code === 0) console.log(`built (${why}) in ${Math.round(performance.now() - started)}ms`)
  else console.error(`build failed (${why}):\n${errors.trim()}`)
}

await rebuild('start')

let pending: ReturnType<typeof setTimeout> | undefined
const changed = (name: string | null): void => {
  if (name && /(^|\/)(dist|node_modules|\.git|plans)\//.test(name)) return
  if (name && !/\.(md|ts|css|json|txt|svg|png)$/.test(name)) return
  clearTimeout(pending)
  pending = setTimeout(() => void rebuild(name ?? 'change'), 80)
}
watch(ROOT, { recursive: true }, (_event, name) => changed(name))

const PHONE = `<!doctype html><meta charset="utf-8"><title>phone slices</title>
<style>body{margin:0;background:#8a93a3;display:flex;flex-wrap:wrap;gap:16px;padding:16px}.s{width:390px;height:844px;overflow:hidden;background:#fff;flex:none}iframe{width:390px;border:0;display:block}</style><body>
<script>
const q=new URLSearchParams(location.search),u=q.get('u')||'/';
const probe=document.createElement('iframe');probe.src=u;probe.style.cssText='width:390px;height:844px;position:absolute;left:-9999px';
probe.onload=()=>setTimeout(()=>{const h=probe.contentDocument.documentElement.scrollHeight,n=Math.ceil(h/844);
document.body.dataset.height=h;document.body.dataset.overflow=probe.contentDocument.documentElement.scrollWidth-390;probe.remove();
for(let i=0;i<n;i++){const d=document.createElement('div');d.className='s';d.id='s'+i;const f=document.createElement('iframe');f.src=u;f.style.height=h+'px';f.style.marginTop=(-i*844)+'px';d.appendChild(f);document.body.appendChild(d)}
document.body.dataset.slices=n},400);
document.body.appendChild(probe);
</script>`

Bun.serve({
  port: PORT,
  async fetch(request) {
    let path = decodeURIComponent(new URL(request.url).pathname)
    if (path === '/__og') {
      const css = await Bun.file(join(import.meta.dir, 'styles.css')).text()
      return new Response(await shareCard(css), { headers: { 'content-type': 'text/html; charset=utf-8' } })
    }
    if (path === '/__phone') return new Response(PHONE, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    if (path.endsWith('/')) path += 'index.html'
    let file = Bun.file(join(OUT, path))
    if (!(await file.exists())) file = Bun.file(join(OUT, 'index.html'))
    return new Response(file, { headers: { 'cache-control': 'no-store' } })
  },
})
console.log(`http://localhost:${PORT}`)
