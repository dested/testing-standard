// The planted-bug operators: each turns one source line into its broken
// variants. Ported from the audit prototype (W:\junk\code\testing-strategy\
// scripts\probe.ts) so `gate probe --from` replays its result files exactly.
// Adding an operator is one row in OPERATORS plus a row in its test.

export const OP_NAMES = ["drop-guard", "drop-call", "flip-eq", "flip-logic", "flip-bool", "flip-rel", "drop-not", "off-by-one", "flip-arith"] as const;
export type OpName = (typeof OP_NAMES)[number];

export function isOpName(s: string): s is OpName {
  return (OP_NAMES as readonly string[]).includes(s);
}

interface Operator {
  name: OpName;
  variants: (line: string) => string[];
}

/** True when `idx` sits inside a '…', "…" or `…` literal (an odd number of unescaped quotes before it). */
export function inString(line: string, idx: number): boolean {
  let q = 0;
  for (let i = 0; i < idx; i++) {
    const ch = line[i];
    if ((ch === "'" || ch === '"' || ch === "`") && line[i - 1] !== "\\") q++;
  }
  return q % 2 === 1;
}

/** Every replacement of `re` on the line that isn't inside a string, one variant per match. */
function replaceEach(re: RegExp, rep: (m: RegExpExecArray) => string, opts: { noQuotes?: boolean } = {}): (line: string) => string[] {
  return (line) => {
    if (opts.noQuotes && /['"`]/.test(line)) return [];
    const g = new RegExp(re.source, "g");
    const out: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = g.exec(line))) {
      if (inString(line, m.index)) continue;
      out.push(line.slice(0, m.index) + rep(m) + line.slice(m.index + m[0].length));
    }
    return out;
  };
}

const indentOf = (line: string): string => /^\s*/.exec(line)?.[0] ?? "";
const count = (line: string, ch: string): number => line.split(ch).length - 1;
const REL: Record<string, string> = { "<": ">=", ">": "<=", "<=": ">", ">=": "<" };
const ARITH: Record<string, string> = { "+": "-", "-": "+", "*": "/" };

export const OPERATORS: Operator[] = [
  {
    // a one-line guard stops guarding
    name: "drop-guard",
    variants: (line) => (/^\s*if \(.*\) (return|throw|continue)\b[^{]*;?\s*$/.test(line) ? [`${indentOf(line)}void 0`] : []),
  },
  {
    // a statement that is only a call stops happening
    name: "drop-call",
    variants: (line) =>
      /^\s*(await\s+)?[\w.$?]+\([^=]*\);?\s*$/.test(line) &&
      !/^\s*(return|super|expect|console|throw|if|for|while|switch|catch|function|new|typeof|void)\b/.test(line) &&
      count(line, "(") === count(line, ")")
        ? [`${indentOf(line)}void 0`]
        : [],
  },
  { name: "flip-eq", variants: replaceEach(/===|!==/, (m) => (m[0] === "===" ? "!==" : "===")) },
  { name: "flip-logic", variants: replaceEach(/ && | \|\| /, (m) => (m[0] === " && " ? " || " : " && ")) },
  { name: "flip-bool", variants: replaceEach(/\b(true|false)\b/, (m) => (m[0] === "true" ? "false" : "true")) },
  { name: "flip-rel", variants: replaceEach(/(?<![=<>-]) (<|>|<=|>=) (?![=>])/, (m) => ` ${REL[m[1] ?? ""] ?? m[1]} `) },
  { name: "drop-not", variants: replaceEach(/(if \(|return |&& |\|\| |\? )!(?=[\w(])/, (m) => m[1] ?? "") },
  { name: "off-by-one", variants: replaceEach(/(?<![\w.#-])([1-9]\d{0,3}|0)(?![\w.%:])/, (m) => String(Number(m[1]) + 1), { noQuotes: true }) },
  { name: "flip-arith", variants: replaceEach(/(?<=[\w)\]]) (\+|-|\*) (?=[\w(])/, (m) => ` ${ARITH[m[1] ?? ""] ?? m[1]} `, { noQuotes: true }) },
];

const BY_NAME = new Map(OPERATORS.map((o) => [o.name, o]));

/** Per line (0-based): may it be mutated at all? Comments, imports and type-only lines may not. */
export function mutableLines(lines: string[]): boolean[] {
  let inBlockComment = false;
  let inType = false;
  return lines.map((line) => {
    const t = line.trim();
    if (inBlockComment) {
      if (t.includes("*/")) inBlockComment = false;
      return false;
    }
    if (t.startsWith("/*")) {
      if (!t.includes("*/")) inBlockComment = true;
      return false;
    }
    if (!t || t.startsWith("//") || t.startsWith("*") || t.startsWith("import ") || /^(export )?(type|interface|declare) /.test(t)) {
      if (/^(export )?(type|interface) .*[{(]\s*$/.test(t)) inType = true;
      return false;
    }
    if (inType) {
      if (/^[})]/.test(t)) inType = false;
      return false;
    }
    return true;
  });
}

export interface Mutation {
  /** 1-based */
  line: number;
  op: OpName;
  before: string;
  after: string;
}

/** Every variant of one operator on one line (no context check). */
export function variantsOf(op: OpName, line: string): string[] {
  return BY_NAME.get(op)?.variants(line) ?? [];
}

/** Every mutation in a source file, in line order. */
export function mutationsOf(text: string): Mutation[] {
  const lines = text.split("\n");
  const ok = mutableLines(lines);
  const out: Mutation[] = [];
  lines.forEach((line, i) => {
    if (!ok[i]) return;
    for (const o of OPERATORS) for (const after of o.variants(line)) out.push({ line: i + 1, op: o.name, before: line, after });
  });
  return out;
}

/** The trimmed, 200-character form result files store `before`/`after` in. */
export function stored(line: string): string {
  return line.trim().slice(0, 200);
}
