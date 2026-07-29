// `when:` guards — a tiny, safe predicate language for conditional operations.
//
// An operation may carry `when: "<expr>"` and runs only if the expression is
// truthy. Expressions read DOCUMENT FACTS (a per-input snapshot taken at run
// start) and declared VARS as identifiers:
//
//     when: "pages > 20 && encrypted == false"
//     when: "pdf_version < 1.7"
//     when: "env == 'prod'"        # env is a workflow variable
//
// The grammar is intentionally tiny and evaluated by a hand-written recursive-
// descent parser — NO eval, NO function calls, NO property access — so an
// untrusted/agent-authored workflow cannot execute arbitrary code:
//
//     expr    := or
//     or      := and ('||' and)*
//     and     := cmp ('&&' cmp)*
//     cmp     := unary (('=='|'!='|'<'|'<='|'>'|'>=') unary)?
//     unary   := '!' unary | primary
//     primary := number | 'string' | true | false | identifier | '(' expr ')'

/** Document facts computed cheaply from the input bytes by the bundled backend
 *  (no Python needed). */
export const BUNDLED_FACTS = ["pages", "pdf_version", "encrypted", "tagged", "size_kb"] as const;

/** Facts that need a content inspection (a text/image scan) — provided by the
 *  Python backend. A `when:` using one errors clearly if Python is unavailable. */
export const RICH_FACTS = ["has_text", "has_images"] as const;

/** All document facts a `when:` predicate may reference. */
export const KNOWN_FACTS = [...BUNDLED_FACTS, ...RICH_FACTS] as const;

export type WhenValue = string | number | boolean;
export type WhenScope = Record<string, WhenValue>;

export class WhenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhenError";
  }
}

type Ast =
  | { k: "lit"; v: WhenValue }
  | { k: "id"; name: string }
  | { k: "not"; e: Ast }
  | { k: "bin"; op: string; l: Ast; r: Ast };

interface Tok {
  t: "num" | "str" | "id" | "op" | "lparen" | "rparen";
  v: string | number;
}

const TWO_CHAR = new Set(["==", "!=", "<=", ">=", "&&", "||"]);
const CMP_OPS = new Set(["==", "!=", "<", "<=", ">", ">="]);

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "(") {
      toks.push({ t: "lparen", v: "(" });
      i++;
      continue;
    }
    if (c === ")") {
      toks.push({ t: "rparen", v: ")" });
      i++;
      continue;
    }
    const pair = src.slice(i, i + 2);
    if (TWO_CHAR.has(pair)) {
      toks.push({ t: "op", v: pair });
      i += 2;
      continue;
    }
    if (c === "<" || c === ">" || c === "!") {
      toks.push({ t: "op", v: c });
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== c) {
        s += src[j];
        j++;
      }
      if (j >= src.length) throw new WhenError(`unterminated string literal`);
      toks.push({ t: "str", v: s });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j]!)) j++;
      toks.push({ t: "num", v: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j++;
      toks.push({ t: "id", v: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new WhenError(`unexpected character "${c}"`);
  }
  return toks;
}

function parse(src: string): Ast {
  const toks = tokenize(src);
  let pos = 0;
  const peek = (): Tok | undefined => toks[pos];
  const isOp = (v: string) => {
    const p = peek();
    return p?.t === "op" && p.v === v;
  };

  const parseOr = (): Ast => {
    let l = parseAnd();
    while (isOp("||")) {
      pos++;
      l = { k: "bin", op: "||", l, r: parseAnd() };
    }
    return l;
  };
  const parseAnd = (): Ast => {
    let l = parseCmp();
    while (isOp("&&")) {
      pos++;
      l = { k: "bin", op: "&&", l, r: parseCmp() };
    }
    return l;
  };
  const parseCmp = (): Ast => {
    const l = parseUnary();
    const p = peek();
    if (p?.t === "op" && CMP_OPS.has(String(p.v))) {
      pos++;
      return { k: "bin", op: String(p.v), l, r: parseUnary() };
    }
    return l;
  };
  const parseUnary = (): Ast => {
    if (isOp("!")) {
      pos++;
      return { k: "not", e: parseUnary() };
    }
    return parsePrimary();
  };
  const parsePrimary = (): Ast => {
    const p = peek();
    if (!p) throw new WhenError("unexpected end of expression");
    if (p.t === "lparen") {
      pos++;
      const e = parseOr();
      if (peek()?.t !== "rparen") throw new WhenError("missing closing )");
      pos++;
      return e;
    }
    if (p.t === "num") {
      pos++;
      return { k: "lit", v: p.v as number };
    }
    if (p.t === "str") {
      pos++;
      return { k: "lit", v: String(p.v) };
    }
    if (p.t === "id") {
      pos++;
      if (p.v === "true") return { k: "lit", v: true };
      if (p.v === "false") return { k: "lit", v: false };
      return { k: "id", name: String(p.v) };
    }
    throw new WhenError(`unexpected token "${String(p.v)}"`);
  };

  const ast = parseOr();
  if (pos !== toks.length) throw new WhenError(`unexpected trailing input`);
  return ast;
}

function truthy(v: WhenValue): boolean {
  return typeof v === "boolean" ? v : typeof v === "number" ? v !== 0 : v !== "";
}

function looseEq(a: WhenValue, b: WhenValue): boolean {
  return typeof a === typeof b ? a === b : String(a) === String(b);
}

function relational(op: string, a: WhenValue, b: WhenValue): boolean {
  const cmp =
    typeof a === "number" && typeof b === "number"
      ? a - b
      : String(a) < String(b)
        ? -1
        : String(a) > String(b)
          ? 1
          : 0;
  switch (op) {
    case "<":
      return cmp < 0;
    case "<=":
      return cmp <= 0;
    case ">":
      return cmp > 0;
    case ">=":
      return cmp >= 0;
    default:
      return false;
  }
}

function evalNode(n: Ast, scope: WhenScope): WhenValue {
  switch (n.k) {
    case "lit":
      return n.v;
    case "id":
      if (!(n.name in scope)) throw new WhenError(`unknown identifier "${n.name}"`);
      return scope[n.name]!;
    case "not":
      return !truthy(evalNode(n.e, scope));
    case "bin":
      if (n.op === "&&") return truthy(evalNode(n.l, scope)) && truthy(evalNode(n.r, scope));
      if (n.op === "||") return truthy(evalNode(n.l, scope)) || truthy(evalNode(n.r, scope));
      {
        const a = evalNode(n.l, scope);
        const b = evalNode(n.r, scope);
        if (n.op === "==") return looseEq(a, b);
        if (n.op === "!=") return !looseEq(a, b);
        return relational(n.op, a, b);
      }
  }
}

/** Evaluate a `when:` expression against a fact/var scope. Throws {@link WhenError}
 *  on a malformed expression or an unknown identifier. */
export function evaluateWhen(expr: string, scope: WhenScope): boolean {
  return truthy(evalNode(parse(expr), scope));
}

export interface WhenAnalysis {
  /** Parse error message, if the expression is malformed. */
  error?: string;
  /** Identifier names referenced (facts/vars), for validation. */
  identifiers: string[];
}

/** Parse a `when:` expression WITHOUT evaluating it and report its parse status
 *  and the identifiers it references — used by the validator. */
export function analyzeWhen(expr: string): WhenAnalysis {
  try {
    const ast = parse(expr);
    const ids = new Set<string>();
    const walk = (n: Ast): void => {
      if (n.k === "id") ids.add(n.name);
      else if (n.k === "not") walk(n.e);
      else if (n.k === "bin") {
        walk(n.l);
        walk(n.r);
      }
    };
    walk(ast);
    return { identifiers: [...ids] };
  } catch (e) {
    return { error: (e as Error).message, identifiers: [] };
  }
}
