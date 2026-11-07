// Small C-like expression evaluator over the debug info (variables, fields, indexing, deref, arithmetic).
import { DebugInfo, TypeInfo } from './cdb';

export interface Value { type: TypeInfo; addr?: number; num?: number; unavailable?: string }
export interface EvalEnv {
  di: DebugInfo;
  lookup(name: string): Promise<Value | undefined>;
  read(addr: number, len: number): Promise<Buffer>;
}

const INT: TypeInfo = { kind: 'int', size: 2, signed: true, text: 'SI:S' };

export function decodeInt(b: Buffer, t: TypeInfo): number {
  let v = 0;
  for (let i = t.size - 1; i >= 0; i--) v = v * 256 + (b[i] ?? 0);
  if (t.signed && t.size > 0 && v >= 2 ** (8 * t.size - 1)) v -= 2 ** (8 * t.size);
  return v;
}

export async function scalar(env: EvalEnv, v: Value): Promise<number> {
  if (v.unavailable) throw new Error(v.unavailable);
  if (v.num !== undefined) return v.num;
  if (v.addr === undefined) throw new Error('no value');
  if (v.type.kind === 'array') return v.addr;          // array decays to its address
  if (v.type.kind === 'struct') throw new Error('struct has no scalar value');
  const size = Math.max(1, v.type.size);
  const b = await env.read(v.addr, size);
  return decodeInt(b, v.type.kind === 'ptr' ? { ...v.type, signed: false, size: 2 } : v.type);
}

type Tok = { t: 'id' | 'num' | 'op'; s: string };
function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  const re = /\s*(0x[0-9a-fA-F]+|\d+|[$A-Za-z_]\w*|->|<=|>=|==|!=|&&|\|\||[-+*\/%&|<>()\[\].!~])/gy;
  let m: RegExpExecArray | null; let pos = 0;
  while (pos < src.length && (m = re.exec(src))) {
    pos = re.lastIndex;
    const s = m[1];
    out.push({ t: /^(0x|\d)/.test(s) ? 'num' : /^[$A-Za-z_]/.test(s) ? 'id' : 'op', s });
  }
  if (src.slice(pos).trim()) throw new Error('unexpected input: ' + src.slice(pos).trim());
  return out;
}

export async function evaluate(env: EvalEnv, src: string): Promise<Value> {
  const toks = tokenize(src); let i = 0;
  const peek = () => toks[i]; const next = () => toks[i++];
  const isOp = (s: string) => peek()?.t === 'op' && peek().s === s;

  const num = (n: number): Value => ({ type: INT, num: n });

  async function primary(): Promise<Value> {
    const t = next();
    if (!t) throw new Error('unexpected end');
    if (t.t === 'num') return num(Number(t.s));
    if (t.t === 'id') {
      const v = await env.lookup(t.s);
      if (!v) throw new Error(`'${t.s}' not found`);
      return v;
    }
    if (t.s === '(') { const v = await binary(1); if (!isOp(')')) throw new Error("expected ')'"); next(); return v; }
    throw new Error('unexpected ' + t.s);
  }
  async function postfix(): Promise<Value> {
    let v = await primary();
    for (;;) {
      if (isOp('.') || isOp('->')) {
        const arrow = next().s === '->';
        const name = next()?.s;
        let base = v;
        if (arrow) base = await deref(v);
        if (base.type.kind !== 'struct') throw new Error('not a struct');
        const f = env.di.structFields(base.type.struct!).find((x) => x.name === name);
        if (!f) throw new Error(`no field '${name}'`);
        v = { type: f.type, addr: (base.addr ?? 0) + f.offset };
      } else if (isOp('[')) {
        next(); const idx = await scalar(env, await binary(1));
        if (!isOp(']')) throw new Error("expected ']'"); next();
        v = await index(v, idx);
      } else return v;
    }
  }
  async function index(v: Value, idx: number): Promise<Value> {
    if (v.type.kind === 'array') return { type: v.type.elem!, addr: (v.addr ?? 0) + idx * v.type.elem!.size };
    if (v.type.kind === 'ptr' && v.type.elem) return { type: v.type.elem, addr: (await scalar(env, v)) + idx * Math.max(1, v.type.elem.size) };
    throw new Error('cannot index');
  }
  async function deref(v: Value): Promise<Value> {
    if (v.type.kind === 'array') return { type: v.type.elem!, addr: v.addr };
    if (v.type.kind !== 'ptr' || !v.type.elem) throw new Error('cannot dereference');
    return { type: v.type.elem, addr: await scalar(env, v) };
  }
  async function unary(): Promise<Value> {
    if (isOp('*')) { next(); return deref(await unary()); }
    if (isOp('&')) { next(); const v = await unary(); if (v.addr === undefined) throw new Error('no address'); return { type: { kind: 'ptr', size: 2, elem: v.type, text: '' }, num: v.addr }; }
    if (isOp('-')) { next(); return num(-(await scalar(env, await unary()))); }
    if (isOp('!')) { next(); return num((await scalar(env, await unary())) ? 0 : 1); }
    if (isOp('~')) { next(); return num(~(await scalar(env, await unary()))); }
    return postfix();
  }
  const prec: Record<string, number> = { '||': 1, '&&': 2, '|': 3, '&': 4, '==': 5, '!=': 5, '<': 6, '>': 6, '<=': 6, '>=': 6, '+': 7, '-': 7, '*': 8, '/': 8, '%': 8 };
  async function binary(min: number): Promise<Value> {
    let l = await unary();
    for (;;) {
      const t = peek();
      if (!t || t.t !== 'op' || prec[t.s] === undefined || prec[t.s] < min) return l;
      next();
      const r = await binary(prec[t.s] + 1);
      const a = await scalar(env, l), b = await scalar(env, r);
      let n = 0;
      switch (t.s) {
        case '+': n = a + b; break; case '-': n = a - b; break; case '*': n = a * b; break;
        case '/': n = b ? Math.trunc(a / b) : 0; break; case '%': n = b ? a % b : 0; break;
        case '==': n = +(a === b); break; case '!=': n = +(a !== b); break;
        case '<': n = +(a < b); break; case '>': n = +(a > b); break;
        case '<=': n = +(a <= b); break; case '>=': n = +(a >= b); break;
        case '&&': n = +(!!a && !!b); break; case '||': n = +(!!a || !!b); break;
        case '&': n = a & b; break; case '|': n = a | b; break;
      }
      l = num(n);
    }
  }
  const v = await binary(1);
  if (i < toks.length) throw new Error('unexpected ' + toks[i].s);
  return v;
}
