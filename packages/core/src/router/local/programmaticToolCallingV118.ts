/**
 * Programmatic tool calling (v1.41, Doi T3).
 *
 * Y tuong tu survey docs/repo-survey-v141.md §1 "Programmatic tool
 * calling" (chi hoc y tuong, khong copy code/text/tai san cua bat ky
 * repo nao): agent viet script goi nhieu tool trong sandbox, chi ket
 * qua cuoi vao context (giam token).
 *
 * Thiet ke an toan (khong dung eval / new Function):
 * - Ngon ngu con rieng (DSL) duoc parse bang recursive-descent parser
 *   viet tay: `let` / `const`, gan, `return`, `if/else`, `for...of`,
 *   `while`, bieu thuc (+ - * / % == != < <= > >= && || ! - ?:),
 *   array/object literal, member/index access.
 * - API duy nhat script thay duoc: `call(toolName, args)`,
 *   `log(message)`, bien chi-doc `input`, mang `results` (ket qua cac
 *   call truoc). Khong co fs, khong network, khong require/process/
 *   fetch/eval — ca o muc quet tinh (static scan) lan muc chay
 *   (interpreter khong co cac primitive do).
 * - Gioi han: so buoc toi da (step budget), so call toi da, thoi gian
 *   chay toi da (kiem tra wall-clock moi buoc), kich thuoc ket qua
 *   toi da (cat ngan + danh dau truncated).
 * - Audit: moi tool call trong script deu ghi log (thu tu, tool,
 *   args tom tat, thoi gian, ok/error, preview ket qua) de kiem tra
 *   sau; log giu trong bo nho co gioi han (toi da 200 entry).
 * - Loi script -> fallback: tra ke hoach goi tool thuong tuan tu
 *   (cac call da chay xong + goi y tiep tuc bang tool call binh
 *   thuong) thay vi chet ca turn.
 *
 * Module nay thuan logic + goi executor do host truyen vao; khong goi
 * model that, khong doc credential, khong cham host truc tiep.
 */

/** Ham thuc thi mot tool that (host cung cap). */
export type ScriptToolExecutor = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<unknown> | unknown;

/** Gioi han chay script (host co the siet chat hon). */
export interface ScriptLimits {
  /** So buoc thuc thi toi da (mac dinh 10000). */
  maxSteps: number;
  /** So tool call toi da trong mot script (mac dinh 32). */
  maxCalls: number;
  /** Thoi gian chay toi da, ms (mac dinh 5000). */
  maxWallMs: number;
  /** So ky tu toi da cua mot ket qua call truoc khi cat (mac dinh 20000). */
  maxResultChars: number;
  /** So ky tu toi da cua gia tri return truoc khi cat (mac dinh 20000). */
  maxReturnChars: number;
  /** Do sau long nhau toi da cua gia tri (mac dinh 10). */
  maxDepth: number;
}

export function defaultScriptLimits(): ScriptLimits {
  return {
    maxSteps: 10000,
    maxCalls: 32,
    maxWallMs: 5000,
    maxResultChars: 20000,
    maxReturnChars: 20000,
    maxDepth: 10,
  };
}

/** Dinh danh bi cam tuyet doi trong script (quet tinh + chan luc chay). */
export const FORBIDDEN_SCRIPT_IDENTIFIERS: readonly string[] = [
  'require',
  'process',
  'globalThis',
  'global',
  'window',
  'fetch',
  'eval',
  'Function',
  'import',
  'fs',
  'net',
  'http',
  'https',
  'child_process',
  'constructor',
  '__proto__',
  'prototype',
  'Buffer',
  'Deno',
  'Bun',
] as const;

/** Thuoc tinh bi cam khi truy cap member (ke ca qua `a["__proto__"]`). */
export const FORBIDDEN_MEMBER_NAMES: readonly string[] = [
  '__proto__',
  'constructor',
  'prototype',
] as const;

export interface ScriptValidationError {
  kind: 'forbidden-identifier' | 'syntax' | 'empty' | 'too-large';
  message: string;
  line?: number;
}

export interface ScriptValidation {
  ok: boolean;
  errors: ScriptValidationError[];
  /** Ten tool duoc goi theo cach tinh (call("name", ...) literal). */
  calledTools: string[];
}

/** Gioi han kich thuoc source de tranh script khung. */
export const MAX_SCRIPT_CHARS = 20000;

/* ------------------------------------------------------------------ */
/* Lexer                                                               */
/* ------------------------------------------------------------------ */

type TokenKind =
  | 'number'
  | 'string'
  | 'ident'
  | 'punct'
  | 'op'
  | 'keyword'
  | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
  line: number;
}

const KEYWORDS: ReadonlySet<string> = new Set([
  'let',
  'const',
  'return',
  'if',
  'else',
  'for',
  'of',
  'while',
  'true',
  'false',
  'null',
]);

const MULTI_OPS: readonly string[] = ['===', '!==', '==', '!=', '<=', '>=', '&&', '||'];

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  const push = (kind: TokenKind, value: string, ln: number): void => {
    tokens.push({ kind, value, line: ln });
  };
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === '\n') {
      line++;
      i++;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const startLine = line;
      i += 2;
      let closed = false;
      while (i < source.length) {
        if (source[i] === '\n') line++;
        if (source[i] === '*' && source[i + 1] === '/') {
          i += 2;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) throw new ScriptSyntaxError('Block comment khong dong.', startLine);
      continue;
    }
    if (ch === '"' || ch === "'") {
      const startLine = line;
      const quote = ch;
      i++;
      let out = '';
      let closed = false;
      while (i < source.length) {
        const c = source[i] as string;
        if (c === '\n') throw new ScriptSyntaxError('String khong duoc xuong dong.', startLine);
        if (c === '\\' && i + 1 < source.length) {
          const n = source[i + 1] as string;
          if (n === 'n') out += '\n';
          else if (n === 't') out += '\t';
          else if (n === 'r') out += '\r';
          else if (n === '\\') out += '\\';
          else if (n === quote) out += quote;
          else out += n;
          i += 2;
          continue;
        }
        if (c === quote) {
          i++;
          closed = true;
          break;
        }
        out += c;
        i++;
      }
      if (!closed) throw new ScriptSyntaxError('String khong dong ngoac.', startLine);
      push('string', out, startLine);
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(source[i + 1] ?? ''))) {
      const startLine = line;
      let num = '';
      let dots = 0;
      while (i < source.length && /[0-9.]/.test(source[i] as string)) {
        if (source[i] === '.') dots++;
        num += source[i] as string;
        i++;
      }
      if (dots > 1) throw new ScriptSyntaxError(`So khong hop le "${num}".`, startLine);
      push('number', num, startLine);
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const startLine = line;
      let ident = '';
      while (i < source.length && /[A-Za-z0-9_$]/.test(source[i] as string)) {
        ident += source[i] as string;
        i++;
      }
      push(KEYWORDS.has(ident) ? 'keyword' : 'ident', ident, startLine);
      continue;
    }
    const three = source.slice(i, i + 3);
    const two = source.slice(i, i + 2);
    if (three === '===' || three === '!==') {
      push('op', three, line);
      i += 3;
      continue;
    }
    if (MULTI_OPS.includes(two)) {
      push('op', two, line);
      i += 2;
      continue;
    }
    if ('+-*/%<>=!?:;,.(){}[]'.includes(ch)) {
      push('+-*/%<>=!'.includes(ch) ? 'op' : 'punct', ch, line);
      i++;
      continue;
    }
    throw new ScriptSyntaxError(`Ky tu khong hop le "${ch}".`, line);
  }
  tokens.push({ kind: 'eof', value: '', line });
  return tokens;
}

export class ScriptSyntaxError extends Error {
  readonly line: number;
  constructor(message: string, line = 0) {
    super(message);
    this.name = 'ScriptSyntaxError';
    this.line = line;
  }
}

/* ------------------------------------------------------------------ */
/* AST + Parser (recursive descent)                                    */
/* ------------------------------------------------------------------ */

export type ScriptValue =
  | null
  | boolean
  | number
  | string
  | ScriptValue[]
  | { [key: string]: ScriptValue };

type Expr =
  | { kind: 'literal'; value: ScriptValue; line: number }
  | { kind: 'ident'; name: string; line: number }
  | { kind: 'array'; elements: Expr[]; line: number }
  | { kind: 'object'; entries: { key: string; value: Expr }[]; line: number }
  | { kind: 'member'; object: Expr; property: string; computed: boolean; index?: Expr; line: number }
  | { kind: 'call'; callee: string; args: Expr[]; line: number }
  | { kind: 'unary'; op: string; operand: Expr; line: number }
  | { kind: 'binary'; op: string; left: Expr; right: Expr; line: number }
  | { kind: 'ternary'; cond: Expr; then: Expr; otherwise: Expr; line: number };

type Stmt =
  | { kind: 'declare'; name: string; constant: boolean; init: Expr | null; line: number }
  | { kind: 'assign'; name: string; value: Expr; line: number }
  | { kind: 'expr'; expr: Expr; line: number }
  | { kind: 'return'; value: Expr | null; line: number }
  | { kind: 'if'; cond: Expr; then: Stmt[]; otherwise: Stmt[] | null; line: number }
  | { kind: 'forOf'; name: string; iterable: Expr; body: Stmt[]; line: number }
  | { kind: 'while'; cond: Expr; body: Stmt[]; line: number }
  | { kind: 'block'; body: Stmt[]; line: number };

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)] as Token;
  }

  private next(): Token {
    const t = this.tokens[this.pos] as Token;
    if (this.pos < this.tokens.length - 1) this.pos++;
    return t;
  }

  private expectPunct(value: string): Token {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) {
      throw new ScriptSyntaxError(`Cho "${value}" nhung gap "${t.value}".`, t.line);
    }
    return t;
  }

  private expectOp(value: string): Token {
    const t = this.next();
    if (t.kind !== 'op' || t.value !== value) {
      throw new ScriptSyntaxError(`Cho "${value}" nhung gap "${t.value}".`, t.line);
    }
    return t;
  }

  private expectKeyword(value: string): Token {
    const t = this.next();
    if (t.kind !== 'keyword' || t.value !== value) {
      throw new ScriptSyntaxError(`Cho "${value}" nhung gap "${t.value}".`, t.line);
    }
    return t;
  }

  private matchPunct(value: string): boolean {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === value) {
      this.pos++;
      return true;
    }
    return false;
  }

  private matchOp(value: string): boolean {
    const t = this.peek();
    if (t.kind === 'op' && t.value === value) {
      this.pos++;
      return true;
    }
    return false;
  }

  parseProgram(): Stmt[] {
    const body: Stmt[] = [];
    while (this.peek().kind !== 'eof') {
      body.push(this.parseStatement());
    }
    return body;
  }

  parseBlock(): Stmt[] {
    this.expectPunct('{');
    const body: Stmt[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'eof') {
        throw new ScriptSyntaxError('Khoi lenh khong dong ngoac }.', this.peek().line);
      }
      body.push(this.parseStatement());
    }
    this.expectPunct('}');
    return body;
  }

  private parseStatement(): Stmt {
    const t = this.peek();
    if (t.kind === 'keyword' && (t.value === 'let' || t.value === 'const')) {
      this.next();
      const nameTok = this.next();
      if (nameTok.kind !== 'ident') {
        throw new ScriptSyntaxError('Sau let/const phai la ten bien.', nameTok.line);
      }
      let init: Expr | null = null;
      if (this.matchOp('=')) init = this.parseExpr();
      this.matchPunct(';');
      return { kind: 'declare', name: nameTok.value, constant: t.value === 'const', init, line: t.line };
    }
    if (t.kind === 'keyword' && t.value === 'return') {
      this.next();
      let value: Expr | null = null;
      if (!(this.peek().kind === 'punct' && this.peek().value === ';') && this.peek().kind !== 'eof') {
        value = this.parseExpr();
      }
      this.matchPunct(';');
      return { kind: 'return', value, line: t.line };
    }
    if (t.kind === 'keyword' && t.value === 'if') {
      this.next();
      this.expectPunct('(');
      const cond = this.parseExpr();
      this.expectPunct(')');
      const then = this.parseBlock();
      let otherwise: Stmt[] | null = null;
      if (this.peek().kind === 'keyword' && this.peek().value === 'else') {
        this.next();
        if (this.peek().kind === 'keyword' && this.peek().value === 'if') {
          otherwise = [this.parseStatement()];
        } else {
          otherwise = this.parseBlock();
        }
      }
      return { kind: 'if', cond, then, otherwise, line: t.line };
    }
    if (t.kind === 'keyword' && t.value === 'for') {
      this.next();
      this.expectPunct('(');
      const decl = this.peek();
      if (decl.kind !== 'keyword' || (decl.value !== 'let' && decl.value !== 'const')) {
        throw new ScriptSyntaxError('for...of phai bat dau bang let/const.', decl.line);
      }
      this.next();
      const nameTok = this.next();
      if (nameTok.kind !== 'ident') throw new ScriptSyntaxError('for...of thieu ten bien.', nameTok.line);
      this.expectKeyword('of');
      const iterable = this.parseExpr();
      this.expectPunct(')');
      const body = this.parseBlock();
      return { kind: 'forOf', name: nameTok.value, iterable, body, line: t.line };
    }
    if (t.kind === 'keyword' && t.value === 'while') {
      this.next();
      this.expectPunct('(');
      const cond = this.parseExpr();
      this.expectPunct(')');
      const body = this.parseBlock();
      return { kind: 'while', cond, body, line: t.line };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const body = this.parseBlock();
      return { kind: 'block', body, line: t.line };
    }
    // Gan: ident = expr;
    if (t.kind === 'ident' && this.peek(1).kind === 'op' && this.peek(1).value === '=') {
      this.next();
      this.next();
      const value = this.parseExpr();
      this.matchPunct(';');
      return { kind: 'assign', name: t.value, value, line: t.line };
    }
    const expr = this.parseExpr();
    this.matchPunct(';');
    return { kind: 'expr', expr, line: t.line };
  }

  parseExpr(): Expr {
    return this.parseTernary();
  }

  private parseTernary(): Expr {
    const cond = this.parseOr();
    if (this.peek().kind === 'punct' && this.peek().value === '?') {
      this.next();
      const then = this.parseExpr();
      this.expectPunct(':');
      const otherwise = this.parseExpr();
      return { kind: 'ternary', cond, then, otherwise, line: cond.line };
    }
    return cond;
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.peek().kind === 'op' && this.peek().value === '||') {
      this.next();
      const right = this.parseAnd();
      left = { kind: 'binary', op: '||', left, right, line: left.line };
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseEquality();
    while (this.peek().kind === 'op' && this.peek().value === '&&') {
      this.next();
      const right = this.parseEquality();
      left = { kind: 'binary', op: '&&', left, right, line: left.line };
    }
    return left;
  }

  private parseEquality(): Expr {
    let left = this.parseRelational();
    while (this.peek().kind === 'op' && ['==', '!=', '===', '!=='].includes(this.peek().value)) {
      const op = this.next().value;
      const right = this.parseRelational();
      left = { kind: 'binary', op, left, right, line: left.line };
    }
    return left;
  }

  private parseRelational(): Expr {
    let left = this.parseAdditive();
    while (
      this.peek().kind === 'op' &&
      ['<', '<=', '>', '>='].includes(this.peek().value)
    ) {
      const op = this.next().value;
      const right = this.parseAdditive();
      left = { kind: 'binary', op, left, right, line: left.line };
    }
    return left;
  }

  private parseAdditive(): Expr {
    let left = this.parseMultiplicative();
    while (this.peek().kind === 'op' && (this.peek().value === '+' || this.peek().value === '-')) {
      const op = this.next().value;
      const right = this.parseMultiplicative();
      left = { kind: 'binary', op, left, right, line: left.line };
    }
    return left;
  }

  private parseMultiplicative(): Expr {
    let left = this.parseUnary();
    while (
      this.peek().kind === 'op' &&
      ['*', '/', '%'].includes(this.peek().value)
    ) {
      const op = this.next().value;
      const right = this.parseUnary();
      left = { kind: 'binary', op, left, right, line: left.line };
    }
    return left;
  }

  private parseUnary(): Expr {
    const t = this.peek();
    if (t.kind === 'op' && (t.value === '!' || t.value === '-')) {
      this.next();
      const operand = this.parseUnary();
      return { kind: 'unary', op: t.value, operand, line: t.line };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let expr = this.parsePrimary();
    for (;;) {
      const t = this.peek();
      if (t.kind === 'punct' && t.value === '.') {
        this.next();
        const prop = this.next();
        if (prop.kind !== 'ident' && prop.kind !== 'keyword') {
          throw new ScriptSyntaxError('Sau "." phai la ten thuoc tinh.', prop.line);
        }
        expr = { kind: 'member', object: expr, property: prop.value, computed: false, line: t.line };
        continue;
      }
      if (t.kind === 'punct' && t.value === '[') {
        this.next();
        const index = this.parseExpr();
        this.expectPunct(']');
        expr = { kind: 'member', object: expr, property: '', computed: true, index, line: t.line };
        continue;
      }
      if (t.kind === 'punct' && t.value === '(') {
        if (expr.kind !== 'ident') {
          throw new ScriptSyntaxError('Chi duoc goi ham co ten (call/log).', t.line);
        }
        this.next();
        const args: Expr[] = [];
        if (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
          for (;;) {
            args.push(this.parseExpr());
            if (!this.matchPunct(',')) break;
          }
        }
        this.expectPunct(')');
        expr = { kind: 'call', callee: expr.name, args, line: expr.line };
        continue;
      }
      break;
    }
    return expr;
  }

  private parsePrimary(): Expr {
    const t = this.next();
    if (t.kind === 'number') {
      const value = Number(t.value);
      if (!Number.isFinite(value)) throw new ScriptSyntaxError(`So khong hop le "${t.value}".`, t.line);
      return { kind: 'literal', value, line: t.line };
    }
    if (t.kind === 'string') return { kind: 'literal', value: t.value, line: t.line };
    if (t.kind === 'keyword' && t.value === 'true') return { kind: 'literal', value: true, line: t.line };
    if (t.kind === 'keyword' && t.value === 'false') return { kind: 'literal', value: false, line: t.line };
    if (t.kind === 'keyword' && t.value === 'null') return { kind: 'literal', value: null, line: t.line };
    if (t.kind === 'ident') return { kind: 'ident', name: t.value, line: t.line };
    if (t.kind === 'punct' && t.value === '(') {
      const inner = this.parseExpr();
      this.expectPunct(')');
      return inner;
    }
    if (t.kind === 'punct' && t.value === '[') {
      const elements: Expr[] = [];
      if (!(this.peek().kind === 'punct' && this.peek().value === ']')) {
        for (;;) {
          elements.push(this.parseExpr());
          if (!this.matchPunct(',')) break;
        }
      }
      this.expectPunct(']');
      return { kind: 'array', elements, line: t.line };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const entries: { key: string; value: Expr }[] = [];
      if (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        for (;;) {
          const keyTok = this.next();
          let key: string;
          if (keyTok.kind === 'string') key = keyTok.value;
          else if (keyTok.kind === 'ident') key = keyTok.value;
          else throw new ScriptSyntaxError('Key object phai la string hoac ident.', keyTok.line);
          this.expectPunct(':');
          const value = this.parseExpr();
          entries.push({ key, value });
          if (!this.matchPunct(',')) break;
        }
      }
      this.expectPunct('}');
      return { kind: 'object', entries, line: t.line };
    }
    throw new ScriptSyntaxError(`Bieu thuc khong hop le tai "${t.value}".`, t.line);
  }
}

/* ------------------------------------------------------------------ */
/* Static validation                                                   */
/* ------------------------------------------------------------------ */

/** Quet cac call("ten", ...) co ten la string literal. */
export function extractCalledTools(source: string): string[] {
  const names: string[] = [];
  try {
    const tokens = tokenize(source);
    for (let i = 0; i + 2 < tokens.length; i++) {
      const a = tokens[i] as Token;
      const b = tokens[i + 1] as Token;
      const c = tokens[i + 2] as Token;
      if (a.kind === 'ident' && a.value === 'call' && b.kind === 'punct' && b.value === '(' && c.kind === 'string') {
        if (!names.includes(c.value)) names.push(c.value);
      }
    }
  } catch {
    return names;
  }
  return names;
}

/** Kiem tra tinh source (khong chay): rong / qua lon / dinh danh cam / loi cu phap. */
export function validateScript(source: string): ScriptValidation {
  const errors: ScriptValidationError[] = [];
  if (typeof source !== 'string' || source.trim() === '') {
    return { ok: false, errors: [{ kind: 'empty', message: 'Script rong.' }], calledTools: [] };
  }
  if (source.length > MAX_SCRIPT_CHARS) {
    errors.push({
      kind: 'too-large',
      message: `Script dai ${source.length} ky tu, vuot gioi han ${MAX_SCRIPT_CHARS}.`,
    });
    return { ok: false, errors, calledTools: [] };
  }
  let tokens: Token[];
  try {
    tokens = tokenize(source);
  } catch (err) {
    const e = err as ScriptSyntaxError;
    return {
      ok: false,
      errors: [{ kind: 'syntax', message: e.message, line: e.line }],
      calledTools: [],
    };
  }
  for (const token of tokens) {
    if (
      token.kind === 'ident' &&
      (FORBIDDEN_SCRIPT_IDENTIFIERS as readonly string[]).includes(token.value)
    ) {
      errors.push({
        kind: 'forbidden-identifier',
        message: `Dinh danh "${token.value}" bi cam trong script (khong co quyen host).`,
        line: token.line,
      });
    }
  }
  if (errors.length > 0) {
    return { ok: false, errors, calledTools: extractCalledTools(source) };
  }
  try {
    new Parser(tokens).parseProgram();
  } catch (err) {
    const e = err as ScriptSyntaxError;
    errors.push({ kind: 'syntax', message: e.message, line: e.line });
    return { ok: false, errors, calledTools: extractCalledTools(source) };
  }
  return { ok: true, errors: [], calledTools: extractCalledTools(source) };
}

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

/** Mot tool call trong script, ghi de audit. */
export interface ScriptToolCallAudit {
  seq: number;
  toolName: string;
  argsJson: string;
  startedAt: number;
  durationMs: number;
  ok: boolean;
  error?: string;
  /** Preview ket qua (da cat ngan). */
  resultPreview: string;
  resultChars: number;
  truncated: boolean;
}

/** Ke hoach fallback khi script loi: quay ve goi tool thuong. */
export interface ScriptFallbackPlan {
  reason: string;
  /** Cac tool call da chay xong truoc khi loi (de tiep tuc, khong chay lai). */
  completedCalls: ScriptToolCallAudit[];
  /** Goi y: cac buoc goi tool thuong tiep theo (mo ta, khong tu chay). */
  suggestedNextCalls: { toolName: string; args: Record<string, unknown>; note: string }[];
  fallbackToNormalToolCalls: true;
}

export interface ScriptRunResult {
  ok: boolean;
  /** Gia tri return cua script (chi gia tri nay vao context). */
  returnValue: ScriptValue | null;
  /** Co return ro rang khong (false = chay het script khong return). */
  returned: boolean;
  calls: ScriptToolCallAudit[];
  /** Log cua ham log() trong script. */
  logs: string[];
  stepsUsed: number;
  callsUsed: number;
  durationMs: number;
  /** Uoc tinh tiet kiem token: chi ket qua cuoi vao context. */
  tokenSaving: {
    intermediateResultChars: number;
    returnedChars: number;
    savedChars: number;
    savedPct: number;
  };
  error?: string;
  errorLine?: number;
  /** Ke hoach fallback (chi co khi ok = false). */
  fallback?: ScriptFallbackPlan;
}

export interface RunScriptOptions {
  /** Input truyen vao script qua bien `input` (chi-doc). */
  input?: unknown;
  /** Chi tool trong allowlist moi duoc goi (undefined = tat ca executor co). */
  allowedTools?: readonly string[];
  limits?: Partial<ScriptLimits>;
  /** Executor mac dinh (neu khong truyen executors map). */
  executor?: ScriptToolExecutor;
  /** Map ten tool -> executor (uu tien hon executor chung). */
  executors?: Readonly<Record<string, ScriptToolExecutor>>;
}

function toScriptValue(value: unknown, depth: number, maxDepth: number): ScriptValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) {
    if (depth >= maxDepth) return '[...]';
    return value.map((v) => toScriptValue(v, depth + 1, maxDepth));
  }
  if (typeof value === 'object') {
    if (depth >= maxDepth) return '{...}';
    const out: { [key: string]: ScriptValue } = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_MEMBER_NAMES.includes(k)) continue;
      out[k] = toScriptValue(v, depth + 1, maxDepth);
    }
    return out;
  }
  return String(value);
}

function cloneScriptValue(value: ScriptValue): ScriptValue {
  try {
    return JSON.parse(JSON.stringify(value)) as ScriptValue;
  } catch {
    return null;
  }
}

function isTruthy(value: ScriptValue): boolean {
  if (value === null || value === false) return false;
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value);
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return true;
  return Boolean(value);
}

function stringifyValue(value: ScriptValue): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return String(value);
  }
}

class ReturnSignal {
  constructor(readonly value: ScriptValue, readonly returned: boolean) {}
}

class ScriptRuntimeError extends Error {
  readonly line: number;
  constructor(message: string, line = 0) {
    super(message);
    this.name = 'ScriptRuntimeError';
    this.line = line;
  }
}

/** Bo nho luu audit cua cac lan chay script (gioi han 200 entry). */
export class ScriptAuditStore {
  private entries: ScriptToolCallAudit[] = [];
  private runs = 0;

  record(calls: readonly ScriptToolCallAudit[]): void {
    this.runs++;
    this.entries.push(...calls);
    if (this.entries.length > 200) {
      this.entries = this.entries.slice(-200);
    }
  }

  getRuns(): number {
    return this.runs;
  }

  list(limit = 50): ScriptToolCallAudit[] {
    return this.entries.slice(-limit);
  }

  byTool(toolName: string, limit = 50): ScriptToolCallAudit[] {
    return this.entries.filter((e) => e.toolName === toolName).slice(-limit);
  }

  clear(): void {
    this.entries = [];
    this.runs = 0;
  }
}

export const MAX_AUDIT_ENTRIES = 200;

/**
 * Chay script programmatic tool calling trong sandbox DSL.
 *
 * - Chi `call`/`log` + bien `input`/`results` ton tai trong script.
 * - Moi buoc deu dem step + kiem tra wall-clock (chong loop vo han).
 * - Ket qua call bi cat o maxResultChars; gia tri return bi cat o
 *   maxReturnChars — phan cat khong vao context.
 */
export async function runScript(
  source: string,
  options: RunScriptOptions = {},
  auditStore?: ScriptAuditStore,
): Promise<ScriptRunResult> {
  const startedAt = Date.now();
  const limits: ScriptLimits = { ...defaultScriptLimits(), ...(options.limits ?? {}) };
  const validation = validateScript(source);
  const emptyResult = (error: string, line?: number): ScriptRunResult => ({
    ok: false,
    returnValue: null,
    returned: false,
    calls: [],
    logs: [],
    stepsUsed: 0,
    callsUsed: 0,
    durationMs: Date.now() - startedAt,
    tokenSaving: { intermediateResultChars: 0, returnedChars: 0, savedChars: 0, savedPct: 0 },
    error,
    errorLine: line,
    fallback: {
      reason: error,
      completedCalls: [],
      suggestedNextCalls: [],
      fallbackToNormalToolCalls: true,
    },
  });
  if (!validation.ok) {
    const first = validation.errors[0];
    return emptyResult(first ? first.message : 'Script khong hop le.', first?.line);
  }
  let program: Stmt[];
  try {
    program = new Parser(tokenize(source)).parseProgram();
  } catch (err) {
    const e = err as ScriptSyntaxError;
    return emptyResult(e.message, e.line);
  }

  const calls: ScriptToolCallAudit[] = [];
  const logs: string[] = [];
  const results: ScriptValue[] = [];
  let steps = 0;
  const scopes: Map<string, ScriptValue>[] = [new Map()];
  const constants = new Set<string>();
  // Bien chi-doc co san trong script.
  const inputValue = toScriptValue(options.input ?? null, 0, limits.maxDepth);
  scopes[0]?.set('input', cloneScriptValue(inputValue));
  scopes[0]?.set('results', []);

  const step = (line: number): void => {
    steps++;
    if (steps > limits.maxSteps) {
      throw new ScriptRuntimeError(`Vuot step budget (${limits.maxSteps} buoc) — co the loop vo han.`, line);
    }
    if (steps % 64 === 0 && Date.now() - startedAt > limits.maxWallMs) {
      throw new ScriptRuntimeError(`Vuot thoi gian chay toi da (${limits.maxWallMs}ms).`, line);
    }
  };

  const lookup = (name: string, line: number): ScriptValue => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const scope = scopes[i] as Map<string, ScriptValue>;
      if (scope.has(name)) return scope.get(name) as ScriptValue;
    }
    if (name === 'results') return results as unknown as ScriptValue;
    throw new ScriptRuntimeError(`Bien "${name}" chua khai bao.`, line);
  };

  const assign = (name: string, value: ScriptValue, line: number, constant: boolean): void => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const scope = scopes[i] as Map<string, ScriptValue>;
      if (scope.has(name)) {
        if (constants.has(`${i}:${name}`)) {
          throw new ScriptRuntimeError(`Khong the gan lai const "${name}".`, line);
        }
        scope.set(name, value);
        return;
      }
    }
    (scopes[scopes.length - 1] as Map<string, ScriptValue>).set(name, value);
    if (constant) constants.add(`${scopes.length - 1}:${name}`);
  };

  const declareVar = (name: string, value: ScriptValue, constant: boolean, line: number): void => {
    const scope = scopes[scopes.length - 1] as Map<string, ScriptValue>;
    if (scope.has(name)) throw new ScriptRuntimeError(`Bien "${name}" da khai bao trong scope nay.`, line);
    scope.set(name, value);
    if (constant) constants.add(`${scopes.length - 1}:${name}`);
  };

  const resolveExecutor = (toolName: string): ScriptToolExecutor | null => {
    if (options.executors && Object.prototype.hasOwnProperty.call(options.executors, toolName)) {
      return options.executors[toolName] as ScriptToolExecutor;
    }
    return options.executor ?? null;
  };

  const callTool = async (toolName: string, args: ScriptValue, line: number): Promise<ScriptValue> => {
    if (options.allowedTools && !options.allowedTools.includes(toolName)) {
      throw new ScriptRuntimeError(`Tool "${toolName}" khong co trong allowlist cua script nay.`, line);
    }
    if (calls.length >= limits.maxCalls) {
      throw new ScriptRuntimeError(`Vuot so tool call toi da (${limits.maxCalls}).`, line);
    }
    const executor = resolveExecutor(toolName);
    if (executor === null) {
      throw new ScriptRuntimeError(`Khong co executor cho tool "${toolName}".`, line);
    }
    const argsObj: Record<string, unknown> =
      args !== null && typeof args === 'object' && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {};
    if (args !== null && (typeof args !== 'object' || Array.isArray(args))) {
      throw new ScriptRuntimeError(`Args cua call("${toolName}") phai la object.`, line);
    }
    const argsJson = JSON.stringify(argsObj);
    const callStarted = Date.now();
    const seq = calls.length + 1;
    try {
      const raw = await executor(toolName, argsObj);
      const value = toScriptValue(raw, 0, limits.maxDepth);
      const full = stringifyValue(value);
      const truncated = full.length > limits.maxResultChars;
      const preview = truncated ? full.slice(0, limits.maxResultChars) : full;
      const audit: ScriptToolCallAudit = {
        seq,
        toolName,
        argsJson,
        startedAt: callStarted,
        durationMs: Date.now() - callStarted,
        ok: true,
        resultPreview: preview,
        resultChars: full.length,
        truncated,
      };
      calls.push(audit);
      results.push(truncated ? toScriptValue(preview, 0, limits.maxDepth) : value);
      return truncated ? toScriptValue(preview, 0, limits.maxDepth) : value;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const audit: ScriptToolCallAudit = {
        seq,
        toolName,
        argsJson,
        startedAt: callStarted,
        durationMs: Date.now() - callStarted,
        ok: false,
        error: message,
        resultPreview: '',
        resultChars: 0,
        truncated: false,
      };
      calls.push(audit);
      throw new ScriptRuntimeError(`Tool "${toolName}" loi: ${message}`, line);
    }
  };

  const evalExpr = async (expr: Expr): Promise<ScriptValue> => {
    step(expr.line);
    switch (expr.kind) {
      case 'literal':
        return expr.value;
      case 'ident': {
        if ((FORBIDDEN_SCRIPT_IDENTIFIERS as readonly string[]).includes(expr.name)) {
          throw new ScriptRuntimeError(`Dinh danh "${expr.name}" bi cam.`, expr.line);
        }
        if (expr.name === 'results') return results as unknown as ScriptValue;
        return lookup(expr.name, expr.line);
      }
      case 'array': {
        const out: ScriptValue[] = [];
        for (const el of expr.elements) out.push(await evalExpr(el));
        return out;
      }
      case 'object': {
        const out: { [key: string]: ScriptValue } = {};
        for (const entry of expr.entries) {
          if ((FORBIDDEN_MEMBER_NAMES as readonly string[]).includes(entry.key)) {
            throw new ScriptRuntimeError(`Key "${entry.key}" bi cam.`, expr.line);
          }
          out[entry.key] = await evalExpr(entry.value);
        }
        return out;
      }
      case 'member': {
        const obj = await evalExpr(expr.object);
        let prop: string;
        if (expr.computed) {
          if (!expr.index) throw new ScriptRuntimeError('Index access thieu chi so.', expr.line);
          const idx = await evalExpr(expr.index);
          prop = stringifyValue(idx);
        } else {
          prop = expr.property;
        }
        if ((FORBIDDEN_MEMBER_NAMES as readonly string[]).includes(prop)) {
          throw new ScriptRuntimeError(`Thuoc tinh "${prop}" bi cam.`, expr.line);
        }
        if (obj === null || typeof obj !== 'object') {
          if (prop === 'length' && typeof obj === 'string') return obj.length;
          throw new ScriptRuntimeError('Truy cap thuoc tinh cua gia tri khong phai object.', expr.line);
        }
        if (Array.isArray(obj)) {
          if (prop === 'length') return obj.length;
          const idx = Number(prop);
          if (Number.isInteger(idx) && idx >= 0 && idx < obj.length) return obj[idx] as ScriptValue;
          throw new ScriptRuntimeError(`Index "${prop}" ngoai pham vi array.`, expr.line);
        }
        if (prop === 'length' && typeof obj === 'string') return (obj as unknown as string).length;
        const record = obj as { [key: string]: ScriptValue };
        if (!Object.prototype.hasOwnProperty.call(record, prop)) {
          throw new ScriptRuntimeError(`Object khong co thuoc tinh "${prop}".`, expr.line);
        }
        return record[prop] as ScriptValue;
      }
      case 'call': {
        if (expr.callee === 'call') {
          if (expr.args.length < 1 || expr.args.length > 2) {
            throw new ScriptRuntimeError('call() can 1-2 doi so: call("tool", {args}).', expr.line);
          }
          const nameValue = await evalExpr(expr.args[0] as Expr);
          if (typeof nameValue !== 'string' || nameValue.trim() === '') {
            throw new ScriptRuntimeError('call() doi so dau phai la ten tool (string).', expr.line);
          }
          const argsValue = expr.args.length === 2 ? await evalExpr(expr.args[1] as Expr) : {};
          return callTool(nameValue, argsValue, expr.line);
        }
        if (expr.callee === 'log') {
          const parts: string[] = [];
          for (const arg of expr.args) parts.push(stringifyValue(await evalExpr(arg)));
          logs.push(parts.join(' '));
          return null;
        }
        throw new ScriptRuntimeError(`Ham "${expr.callee}" khong ton tai trong sandbox (chi co call/log).`, expr.line);
      }
      case 'unary': {
        const operand = await evalExpr(expr.operand);
        if (expr.op === '!') return !isTruthy(operand);
        if (expr.op === '-') {
          if (typeof operand !== 'number') throw new ScriptRuntimeError('Toan tu - can so.', expr.line);
          return -operand;
        }
        throw new ScriptRuntimeError(`Toan tu "${expr.op}" khong ho tro.`, expr.line);
      }
      case 'binary': {
        if (expr.op === '&&') {
          const left = await evalExpr(expr.left);
          if (!isTruthy(left)) return false;
          return isTruthy(await evalExpr(expr.right));
        }
        if (expr.op === '||') {
          const left = await evalExpr(expr.left);
          if (isTruthy(left)) return true;
          return isTruthy(await evalExpr(expr.right));
        }
        const left = await evalExpr(expr.left);
        const right = await evalExpr(expr.right);
        switch (expr.op) {
          case '+':
            if (typeof left === 'string' || typeof right === 'string') {
              return stringifyValue(left) + stringifyValue(right);
            }
            if (typeof left === 'number' && typeof right === 'number') return left + right;
            throw new ScriptRuntimeError('Toan tu + can hai so hoac co mot string.', expr.line);
          case '-':
          case '*':
          case '/':
          case '%': {
            if (typeof left !== 'number' || typeof right !== 'number') {
              throw new ScriptRuntimeError(`Toan tu ${expr.op} can hai so.`, expr.line);
            }
            if (expr.op === '-') return left - right;
            if (expr.op === '*') return left * right;
            if (expr.op === '/') {
              if (right === 0) throw new ScriptRuntimeError('Chia cho 0.', expr.line);
              return left / right;
            }
            if (right === 0) throw new ScriptRuntimeError('Chia lay du cho 0.', expr.line);
            return left % right;
          }
          case '==':
            return left === right;
          case '!=':
            return left !== right;
          case '===':
            return left === right;
          case '!==':
            return left !== right;
          case '<':
          case '<=':
          case '>':
          case '>=': {
            if ((typeof left === 'number' && typeof right === 'number') ||
              (typeof left === 'string' && typeof right === 'string')) {
              if (expr.op === '<') return left < right;
              if (expr.op === '<=') return left <= right;
              if (expr.op === '>') return left > right;
              return left >= right;
            }
            throw new ScriptRuntimeError(`Toan tu ${expr.op} can hai so hoac hai string.`, expr.line);
          }
          default:
            throw new ScriptRuntimeError(`Toan tu "${expr.op}" khong ho tro.`, expr.line);
        }
      }
      case 'ternary': {
        const cond = await evalExpr(expr.cond);
        return evalExpr(isTruthy(cond) ? expr.then : expr.otherwise);
      }
      default:
        throw new ScriptRuntimeError('Bieu thuc khong ho tro.', 0);
    }
  };

  const execBlock = async (stmts: Stmt[]): Promise<void> => {
    for (const stmt of stmts) {
      step(stmt.line);
      switch (stmt.kind) {
        case 'declare': {
          const value = stmt.init ? await evalExpr(stmt.init) : null;
          declareVar(stmt.name, value, stmt.constant, stmt.line);
          break;
        }
        case 'assign': {
          const value = await evalExpr(stmt.value);
          assign(stmt.name, value, stmt.line, false);
          break;
        }
        case 'expr': {
          await evalExpr(stmt.expr);
          break;
        }
        case 'return': {
          const value = stmt.value ? await evalExpr(stmt.value) : null;
          throw new ReturnSignal(value, true);
        }
        case 'if': {
          const cond = await evalExpr(stmt.cond);
          if (isTruthy(cond)) {
            scopes.push(new Map());
            try {
              await execBlock(stmt.then);
            } finally {
              scopes.pop();
            }
          } else if (stmt.otherwise !== null) {
            scopes.push(new Map());
            try {
              await execBlock(stmt.otherwise);
            } finally {
              scopes.pop();
            }
          }
          break;
        }
        case 'forOf': {
          const iterable = await evalExpr(stmt.iterable);
          if (!Array.isArray(iterable)) {
            throw new ScriptRuntimeError('for...of can mot array.', stmt.line);
          }
          for (const item of iterable) {
            step(stmt.line);
            scopes.push(new Map([[stmt.name, cloneScriptValue(item)]]));
            try {
              await execBlock(stmt.body);
            } finally {
              scopes.pop();
            }
          }
          break;
        }
        case 'while': {
          for (;;) {
            step(stmt.line);
            const cond = await evalExpr(stmt.cond);
            if (!isTruthy(cond)) break;
            scopes.push(new Map());
            try {
              await execBlock(stmt.body);
            } finally {
              scopes.pop();
            }
          }
          break;
        }
        case 'block': {
          scopes.push(new Map());
          try {
            await execBlock(stmt.body);
          } finally {
            scopes.pop();
          }
          break;
        }
        default:
          throw new ScriptRuntimeError('Cau lenh khong ho tro.', 0);
      }
    }
  };

  let returnValue: ScriptValue | null = null;
  let returned = false;
  let error: string | undefined;
  let errorLine: number | undefined;
  try {
    await execBlock(program);
  } catch (err) {
    if (err instanceof ReturnSignal) {
      returnValue = err.value;
      returned = true;
    } else if (err instanceof ScriptRuntimeError) {
      error = err.message;
      errorLine = err.line;
    } else {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  const durationMs = Date.now() - startedAt;
  if (auditStore) auditStore.record(calls);

  const intermediateChars = calls.reduce((sum, c) => sum + c.resultChars, 0);
  let returnedChars = 0;
  let finalValue: ScriptValue | null = returnValue;
  if (returned && returnValue !== null) {
    const full = stringifyValue(returnValue);
    returnedChars = full.length;
    if (full.length > limits.maxReturnChars) {
      finalValue = toScriptValue(full.slice(0, limits.maxReturnChars), 0, limits.maxDepth);
      returnedChars = limits.maxReturnChars;
    }
  }
  const savedChars = Math.max(0, intermediateChars - returnedChars);
  const savedPct = intermediateChars > 0 ? Math.round((savedChars / intermediateChars) * 1000) / 10 : 0;

  if (error !== undefined) {
    const failedTool = calls.length > 0 && calls[calls.length - 1]?.ok === false
      ? (calls[calls.length - 1] as ScriptToolCallAudit).toolName
      : null;
    return {
      ok: false,
      returnValue: null,
      returned: false,
      calls,
      logs,
      stepsUsed: steps,
      callsUsed: calls.length,
      durationMs,
      tokenSaving: { intermediateResultChars: intermediateChars, returnedChars: 0, savedChars: 0, savedPct: 0 },
      error,
      errorLine,
      fallback: {
        reason: error,
        completedCalls: calls.filter((c) => c.ok),
        suggestedNextCalls: failedTool
          ? [{ toolName: failedTool, args: {}, note: 'Goi lai tool nay bang tool call thuong (kiem tra args truoc khi goi).' }]
          : [],
        fallbackToNormalToolCalls: true,
      },
    };
  }

  return {
    ok: true,
    returnValue: finalValue,
    returned,
    calls,
    logs,
    stepsUsed: steps,
    callsUsed: calls.length,
    durationMs,
    tokenSaving: {
      intermediateResultChars: intermediateChars,
      returnedChars,
      savedChars,
      savedPct,
    },
  };
}
