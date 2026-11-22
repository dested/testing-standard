// The shell every page shares: head, top bar, footer.

import { esc } from './html'

export const SITE = 'https://testing.dested.com'
export const REPO = 'https://github.com/dested/testing-standard'

export type NavKey = 'home' | 'standard' | 'adopt' | 'examples' | 'evidence' | 'changes'

export type PageMeta = {
  title: string
  description: string
  path: string
  current: NavKey
  version: string
  assets: { css: string; js: string }
}

const NAV: Array<{ key: NavKey; href: string; label: string }> = [
  { key: 'standard', href: '/standard/', label: 'Standard' },
  { key: 'adopt', href: '/adopt/', label: 'Adoption plan' },
  { key: 'examples', href: '/examples/', label: 'Examples' },
  { key: 'evidence', href: '/evidence/', label: 'Evidence' },
]

// The static server answers an unknown path with the home page, so /adopt (no
// trailing slash) lands here. Send the known pages on to their real address.
const KNOWN = ['/standard', '/adopt', '/examples', '/evidence', '/changes']
const REDIRECT = `(function(){var p=location.pathname.replace(/\\/+$/,'');if(${JSON.stringify(KNOWN)}.indexOf(p)>=0&&location.pathname!==p+'/')location.replace(p+'/'+location.search+location.hash)})()`

const REPLAY = `if(!matchMedia('(prefers-reduced-motion: reduce)').matches){document.documentElement.classList.add('anim');setTimeout(function(){document.documentElement.classList.remove('anim')},6000)}`

export const MARK = `<svg viewBox="0 0 34 14" aria-hidden="true"><rect x="0" width="5" height="14" rx="2" fill="#2a78d6"/><rect x="7.25" width="5" height="14" rx="2" fill="#eda100"/><rect x="14.5" width="5" height="14" rx="2" fill="#6250d6"/><rect x="21.75" width="5" height="14" rx="2" fill="#1baf7a"/><rect x="29" width="5" height="14" rx="2" fill="#0d1420"/></svg>`

export function page(meta: PageMeta, body: string): string {
  const url = SITE + meta.path
  const nav = NAV.map(
    (n) => `<a href="${n.href}"${n.key === meta.current ? ' aria-current="page"' : ''}>${esc(n.label)}</a>`,
  ).join('')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(meta.title)}</title>
<meta name="description" content="${esc(meta.description)}">
<link rel="canonical" href="${url}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(meta.title)}">
<meta property="og:description" content="${esc(meta.description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${SITE}/og.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="color-scheme" content="light">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
${meta.current === 'home' ? `<script>${REDIRECT};${REPLAY}</script>\n` : ''}<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500..700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="${meta.assets.css}">
</head>
<body>
<header class="top"><div class="wrap">
<a class="mark" href="/">${MARK}Testing standard <small>${esc(meta.version)}</small></a>
<nav class="nav" aria-label="Pages">${nav}<a href="${REPO}">GitHub</a></nav>
</div></header>
${body}
<footer class="foot"><div class="wrap">
<span>Testing standard ${esc(meta.version)}</span>
<nav aria-label="More"><a href="/changes/">Changes</a><a href="${REPO}">The standard on GitHub</a><a href="https://github.com/dested/sal-starter">The starter</a><a href="https://github.com/dested/destedtui">gate</a></nav>
</div></footer>
<script src="${meta.assets.js}" defer></script>
</body>
</html>
`
}
