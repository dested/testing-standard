// 1. The operator table: every operator's variants for positive lines, and
// nothing for lines it must leave alone (strings, comments, imports, types).

import { describe, expect, test } from "bun:test";
import { mutationsOf, OP_NAMES, variantsOf, type OpName } from "../../src/lib/gate/probe/operators.ts";

const TABLE: Record<OpName, { yes: [string, string[]][]; no: string[] }> = {
  "drop-guard": {
    yes: [
      ["  if (!user) return null;", ["  void 0"]],
      ["    if (n > max) throw new Error('too big');", ["    void 0"]],
      ["  if (seen.has(k)) continue;", ["  void 0"]],
    ],
    no: ["  if (x) {", "  if (x) return { a: 1 };", "  return x;"],
  },
  "drop-call": {
    yes: [
      ["  doThing(a, b);", ["  void 0"]],
      ["  await save(x)", ["  void 0"]],
      ["  e.preventDefault()", ["  void 0"]],
    ],
    no: ["  const x = f();", "  console.log(x);", "  return f();", "  if (ok) go();", "  f(a, (b"],
  },
  "flip-eq": {
    yes: [["if (a === b && c !== d) {", ["if (a !== b && c !== d) {", "if (a === b && c === d) {"]]],
    no: ['const s = "a === b";', "x = a == b"],
  },
  "flip-logic": {
    yes: [["ok = a && b || c", ["ok = a || b || c", "ok = a && b && c"]]],
    no: ["ok = a&&b", 'msg = "x && y"'],
  },
  "flip-bool": {
    yes: [
      ["return true;", ["return false;"]],
      ["navigate('/', { replace: true })", ["navigate('/', { replace: false })"]],
    ],
    no: ['x = "true"', "const truely = 1", "isFalsey()"],
  },
  "flip-rel": {
    yes: [
      ["if (a < b) x", ["if (a >= b) x"]],
      ["if (a > b) x", ["if (a <= b) x"]],
      ["if (a <= b) x", ["if (a > b) x"]],
      ["if (a >= b) x", ["if (a < b) x"]],
    ],
    no: ["const xs: Array<string> = []", "const f = (x) => y", "a << b", "a >>> b"],
  },
  "drop-not": {
    yes: [
      ["if (!ctx.isAdmin) {", ["if (ctx.isAdmin) {"]],
      ["return !x", ["return x"]],
      ["ok = a && !b", ["ok = a && b"]],
      ["v = c ? !d : e", ["v = c ? d : e"]],
    ],
    no: ["x = !y", "if (a !== b) {"],
  },
  "off-by-one": {
    yes: [
      ["const n = 5;", ["const n = 6;"]],
      ["return arr[0]", ["return arr[1]"]],
    ],
    no: ["x = 1.5", "width: 10%", 'f("a", 3)', "v2 = 1x", "at 10:"],
  },
  "flip-arith": {
    yes: [
      ["total = a + b", ["total = a - b"]],
      ["area = w * h", ["area = w / h"]],
      ["left = n - 1", ["left = n + 1"]],
    ],
    no: ['s = "a" + b', "i++", "x = -1", "a+b"],
  },
};

describe("operators", () => {
  test("the table covers every operator", () => {
    expect(Object.keys(TABLE).sort()).toEqual([...OP_NAMES].sort());
  });
  for (const op of OP_NAMES) {
    test(op, () => {
      const row = TABLE[op];
      for (const [line, want] of row.yes) expect({ line, got: variantsOf(op, line) }).toEqual({ line, got: want });
      for (const line of row.no) expect({ line, got: variantsOf(op, line) }).toEqual({ line, got: [] });
    });
  }

  test("comments, imports and type-only lines are never mutated", () => {
    const src = [
      'import { a, b } from "./x";',
      "// if (a === b) return true;",
      "/* if (a === b) return true;",
      "   still a comment: a && b */",
      " * jsdoc line with true",
      "type Mode = 'a' | 'b';",
      "export interface Shape {",
      "  open: true;",
      "  size: 1;",
      "}",
      "declare const x: number;",
      "export function f(a: number) {",
      "  return a === 1;",
      "}",
    ].join("\n");
    const lines = new Set(mutationsOf(src).map((m) => m.line));
    expect([...lines]).toEqual([13]);
    expect(mutationsOf(src).map((m) => m.op).sort()).toEqual(["flip-eq", "off-by-one"]);
  });
});
