// The browser side of the home page: the planted-bug board and the adoption
// picker. Doc pages load this too and it finds nothing to do.

type Check = 'types' | 'rules' | 'api' | 'flows'
type Bug = {
  file: string
  line: number
  op: string
  before: string
  after: string
  check: Check | null
  test: string | null
  testFile: string | null
}

const CHECK_NAME: Record<Check, string> = { types: 'Types', rules: 'Rules', api: 'API', flows: 'Flows' }
const KIND: Record<string, string> = {
  'drop-not': 'A ! removed',
  'flip-logic': '&& and || swapped',
  'drop-guard': 'A guard removed',
  'flip-bool': 'true and false swapped',
  'off-by-one': 'A number off by one',
  'drop-call': 'A call removed',
  'flip-eq': '=== and !== swapped',
  'flip-rel': 'A comparison flipped',
  'flip-arith': 'An arithmetic sign flipped',
}

function isBug(value: unknown): value is Bug {
  return (
    typeof value === 'object' &&
    value !== null &&
    'file' in value &&
    typeof value.file === 'string' &&
    'line' in value &&
    typeof value.line === 'number' &&
    'op' in value &&
    typeof value.op === 'string' &&
    'before' in value &&
    typeof value.before === 'string' &&
    'after' in value &&
    typeof value.after === 'string'
  )
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function board(): void {
  const root = document.getElementById('board')
  const panel = document.getElementById('bug')
  const data = document.getElementById('bugs')
  const tally = document.getElementById('tally')
  if (!root || !panel || !data || !tally) return

  const parsed: unknown = JSON.parse(data.textContent ?? '[]')
  const bugs = Array.isArray(parsed) ? parsed.filter(isBug) : []
  const cells = Array.from(root.querySelectorAll<HTMLButtonElement>('.cell'))
  const caught = bugs.filter((b) => b.check !== null).length

  const show = (index: number): void => {
    const bug = bugs[index]
    if (!bug) return
    cells.forEach((cell, i) => {
      cell.setAttribute('aria-pressed', String(i === index))
      cell.tabIndex = i === index ? 0 : -1
    })
    const diff = el('div', 'diff')
    diff.append(el('div', 'was', bug.before), el('div', 'now', bug.after))

    const verdict = el('div', 'verdict')
    const line = el('div', 'verdict-line')
    const swatch = el('i', `sw ${bug.check ?? 'none'}`)
    line.append(swatch, bug.check ? `${CHECK_NAME[bug.check]} caught it` : 'Nothing noticed')
    const why = el('p', '')
    if (!bug.check) {
      why.textContent = 'All four checks stayed green. The fix is a test for exactly this change.'
    } else if (bug.test && bug.testFile) {
      why.append(el('code', '', bug.test.replace(/^\[\w+\] › /, '')), ' went red in ', el('code', '', bug.testFile))
    } else if (bug.check === 'types') {
      why.textContent = 'The typecheck went red before any test ran.'
    } else {
      why.textContent = `The ${bug.check} check went red.`
    }
    verdict.append(line, why)

    panel.replaceChildren(
      el('div', 'bug-where', `${bug.file}:${bug.line}`),
      el('div', 'bug-kind', KIND[bug.op] ?? bug.op),
      diff,
      verdict,
    )
  }

  cells.forEach((cell, i) => {
    cell.addEventListener('mouseenter', () => show(i))
    cell.addEventListener('focus', () => show(i))
    cell.addEventListener('click', () => show(i))
  })

  const columns = (): number => getComputedStyle(cells[0]?.parentElement ?? root).gridTemplateColumns.split(' ').length
  root.addEventListener('keydown', (event) => {
    const at = cells.findIndex((cell) => cell === document.activeElement)
    if (at < 0) return
    const step: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns(), ArrowUp: -columns() }
    const move = step[event.key]
    if (move === undefined) return
    const next = at + move
    if (next < 0 || next >= cells.length) return
    event.preventDefault()
    cells[next]?.focus()
  })

  const first = Math.max(0, cells.findIndex((c) => c.getAttribute('aria-pressed') === 'true'))
  show(first)

  // One moment on load: the run replays, a bug at a time.
  const html = document.documentElement
  if (!html.classList.contains('anim')) return
  tally.textContent = '0'
  let lit = 0
  let count = 0
  const tick = (): void => {
    const cell = cells[lit]
    if (!cell) {
      html.classList.remove('anim')
      tally.textContent = String(caught)
      return
    }
    cell.classList.add('lit')
    if (cell.dataset.check !== 'none') count += 1
    tally.textContent = String(count)
    lit += 1
    window.setTimeout(tick, 38)
  }
  window.setTimeout(tick, 250)
}

function adoption(): void {
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('.case'))
  if (tabs.length === 0) return
  const select = (tab: HTMLButtonElement): void => {
    for (const t of tabs) {
      const on = t === tab
      t.setAttribute('aria-selected', String(on))
      t.tabIndex = on ? 0 : -1
      const panel = document.getElementById(t.getAttribute('aria-controls') ?? '')
      if (panel) panel.hidden = !on
    }
  }
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => select(tab))
    tab.addEventListener('keydown', (event) => {
      const move = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
      if (!move) return
      const next = tabs[(i + move + tabs.length) % tabs.length]
      if (!next) return
      event.preventDefault()
      select(next)
      next.focus()
    })
  })
  const first = tabs[0]
  if (first) select(first)
}

board()
adoption()
