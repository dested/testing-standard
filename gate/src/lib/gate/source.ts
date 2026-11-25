// A test's own code, cut out of its file: from the `test(` call Playwright
// names by line (or, for bun, the line that names the test's title) to the
// bracket that closes it. A scanner, not a parser: it knows strings, template
// literals and comments, which is enough to find the matching bracket.

const MAX_LINES = 300;

export interface Span {
  /** 1-based, inclusive */
  start: number;
  end: number;
}

/** The line a bun test's title is declared on: `test("<title>"` / `it('<title>'`, the last segment of `a > b > title`. */
export function titleLine(lines: string[], name: string): number | null {
  const title = name.split(" > ").at(-1) ?? name;
  if (!title) return null;
  const quoted = ["'", '"', "`"].map((q) => `${q}${title}${q}`);
  const hits = lines.flatMap((l, i) => (quoted.some((q) => l.includes(q)) ? [i] : []));
  const call = hits.find((i) => /\b(test|it)(\.\w+)*\s*\(/.test(lines[i] ?? ""));
  const i = call ?? (hits.length === 1 ? hits[0] : undefined);
  return i === undefined ? null : i + 1;
}

/** From `start` (1-based) to the line where the first bracket opened on it closes. */
export function blockFrom(lines: string[], start: number): Span | null {
  if (start < 1 || start > lines.length) return null;
  let depth = 0;
  let opened = false;
  /** a stack of open template literals' brace depth, so `${…}` nests */
  const tpl: number[] = [];
  let quote: "'" | '"' | null = null;
  let block = false;
  const last = Math.min(lines.length, start + MAX_LINES - 1);
  for (let n = start; n <= last; n++) {
    const s = lines[n - 1] ?? "";
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      const next = s[i + 1];
      if (block) {
        if (ch === "*" && next === "/") {
          block = false;
          i++;
        }
        continue;
      }
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = null;
        continue;
      }
      const inTpl = tpl.length > 0 && tpl[tpl.length - 1] === depth;
      if (inTpl) {
        if (ch === "\\") i++;
        else if (ch === "`") tpl.pop();
        else if (ch === "$" && next === "{") {
          depth++;
          i++;
        }
        continue;
      }
      if (ch === "/" && next === "/") break;
      if (ch === "/" && next === "*") {
        block = true;
        i++;
        continue;
      }
      if (ch === "'" || ch === '"') quote = ch;
      else if (ch === "`") tpl.push(depth);
      else if (ch === "(" || ch === "[" || ch === "{") {
        depth++;
        opened = true;
      } else if (ch === ")" || ch === "]" || ch === "}") {
        depth--;
        if (opened && depth === 0) return { start, end: n };
      }
    }
    // a quote never spans lines; a template literal and a block comment can
    quote = null;
  }
  return opened ? { start, end: last } : null;
}

/** The test's span in its file's text: by line when the runner gave one, else by title. */
export function testSpan(text: string, opts: { line?: number; name?: string }): Span | null {
  const lines = text.split("\n");
  const start = opts.line ?? (opts.name ? titleLine(lines, opts.name) : null);
  return start ? blockFrom(lines, start) : null;
}
