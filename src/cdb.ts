// Parser for SDCC .cdb (debug info) + .noi (symbol table) files.
import * as fs from 'fs';
import * as path from 'path';

export type TKind = 'int' | 'ptr' | 'array' | 'struct' | 'func' | 'void' | 'bool' | 'float';
export interface TypeInfo {
  kind: TKind;
  size: number;
  signed?: boolean;
  elem?: TypeInfo;      // pointee / array element
  count?: number;       // array element count
  struct?: string;      // struct key
  isChar?: boolean;
  text: string;
}
export interface StructField { name: string; offset: number; type: TypeInfo }

export interface VarInfo {
  name: string;
  func?: string;          // undefined for globals
  lvl: number; blk: number; id: number;
  type: TypeInfo;
  where: 'stack' | 'reg' | 'none' | 'global';
  offset?: number;        // stack offset from IX
  regs?: string[];        // register names (low first)
  addr?: number;          // for globals
  isParam: boolean;
}

export interface LineEntry { addr: number; file: string; line: number; lvl: number; blk: number }
export interface FuncInfo { name: string; start: number; end: number }

export class DebugInfo {
  module = '';
  funcs: FuncInfo[] = [];
  lines: LineEntry[] = [];
  vars: VarInfo[] = [];
  globals: VarInfo[] = [];
  structs = new Map<string, StructField[]>();
  symAddrs: number[] = [];                  // sorted code/data symbol addresses (from .noi)
  symNames = new Map<number, string>();     // addr -> name
  private symByName = new Map<string, number>();
  symAddr(name: string): number | undefined { return this.symByName.get(name); }
  segAddr = 0;                              // RAM address of _g_CurrentSegment (banked ROMs)
  bankLo = 0; bankHi = 0;                   // CPU address window of the switchable page
  private linesByFile = new Map<string, LineEntry[]>();
  private funcByName = new Map<string, FuncInfo>();

  static load(cdbPath: string): DebugInfo {
    const di = new DebugInfo();
    di.parseCdb(fs.readFileSync(cdbPath, 'latin1'));
    const noi = cdbPath.replace(/\.cdb$/i, '.noi');
    if (fs.existsSync(noi)) di.parseNoi(fs.readFileSync(noi, 'latin1'));
    di.finish();
    return di;
  }

  // ---------- types ----------
  parseType(spec: string): TypeInfo {
    // spec like "{2}DD,SI:U"  or "{1444}DA38d,DA38d,SC:U"
    const m = /^\{(\d+)\}(.*)$/.exec(spec.trim());
    const total = m ? parseInt(m[1], 10) : 0;
    const toks = (m ? m[2] : spec).split(',');
    const t = this.parseToks(toks, 0, total);
    return t;
  }
  private parseToks(toks: string[], i: number, total: number): TypeInfo {
    const tk = toks[i] ?? 'SV:S';
    const text = toks.slice(i).join(',');
    let mm: RegExpExecArray | null;
    if ((mm = /^DA(\d+)d$/.exec(tk))) {
      const count = parseInt(mm[1], 10);
      const elem = this.parseToks(toks, i + 1, count ? Math.floor(total / count) : 0);
      return { kind: 'array', size: total || elem.size * count, elem, count, text };
    }
    if (/^D[DGCPXF]$/.test(tk) && tk !== 'DF') {
      const elem = this.parseToks(toks, i + 1, 0);
      return { kind: 'ptr', size: 2, elem, text };
    }
    if (tk === 'DF') return { kind: 'func', size: 2, text };
    const base = tk.split(':');
    const code = base[0]; const sign = base[1] !== 'U';
    switch (code) {
      case 'SC': return { kind: 'int', size: 1, signed: sign, isChar: true, text };
      case 'SS': return { kind: 'int', size: 2, signed: sign, text };
      case 'SI': return { kind: 'int', size: 2, signed: sign, text };
      case 'SL': return { kind: 'int', size: 4, signed: sign, text };
      case 'SF': return { kind: 'float', size: 4, text };
      case 'SV': return { kind: 'void', size: 0, text };
      default:
        if (code.startsWith('SB')) return { kind: 'bool', size: 1, text };
        if (code.startsWith('ST')) return { kind: 'struct', size: total, struct: code.slice(2), text };
        return { kind: 'int', size: total || 1, signed: false, text };
    }
  }

  typeName(t: TypeInfo): string {
    switch (t.kind) {
      case 'int': return (t.isChar ? 'char' : t.size === 4 ? 'long' : 'int') + (t.signed ? '' : ' unsigned').replace(/^ /, '');
      case 'ptr': return (t.elem ? this.typeName(t.elem) : 'void') + '*';
      case 'array': return `${t.elem ? this.typeName(t.elem) : '?'}[${t.count}]`;
      case 'struct': return 'struct ' + t.struct;
      case 'func': return 'function';
      case 'bool': return 'bool';
      case 'float': return 'float';
      default: return 'void';
    }
  }

  // ---------- cdb ----------
  private parseCdb(text: string) {
    const lines = text.split(/\r?\n/);
    const funcAddr = new Map<string, number>();
    const globAddr = new Map<string, number>();
    const rawGlobals: { name: string; typ: string; key: string }[] = [];
    const rawLocals: RegExpExecArray[] = [];
    const fnNames: string[] = [];
    for (const ln of lines) {
      if (!ln) continue;
      const k = ln[0];
      if (k === 'M') { this.module = ln.slice(2); continue; }
      if (k === 'T') {
        const m = /^T:F[^$]*\$([^\[]+)\[(.*)\]$/.exec(ln);
        if (m) {
          const fields: StructField[] = [];
          const re = /\(\{(\d+)\}S:S\$(\w+)\$0_0\$0\((\{\d+\}[^)]*)\),Z,0,0\)/g;
          let fm: RegExpExecArray | null;
          while ((fm = re.exec(m[2]))) fields.push({ name: fm[2], offset: parseInt(fm[1], 10), type: this.parseType(fm[3]) });
          this.structs.set(m[1], fields);
        }
        continue;
      }
      if (k === 'F') {
        const m = /^F:G\$(\w+)\$/.exec(ln); if (m) fnNames.push(m[1]);
        continue;
      }
      if (k === 'L') {
        let m: RegExpExecArray | null;
        if ((m = /^L:C\$([^$]+)\$(\d+)\$(\d+)_(\d+)\$\d+:([0-9A-Fa-f]+)$/.exec(ln))) {
          this.lines.push({ file: m[1], line: +m[2], lvl: +m[3], blk: +m[4], addr: parseInt(m[5], 16) });
        } else if ((m = /^L:G\$(\w+)\$0\$0:([0-9A-Fa-f]+)$/.exec(ln))) {
          funcAddr.set(m[1], parseInt(m[2], 16));
        } else if ((m = /^L:([GF][^$]*\$?)(\w+)\$0_0\$0:([0-9A-Fa-f]+)$/.exec(ln))) {
          globAddr.set(m[2], parseInt(m[3], 16));
        }
        continue;
      }
      if (k === 'S') {
        let m: RegExpExecArray | null;
        if ((m = /^S:L([^.]+)\.(\w+)\$(\w+)\$(\d+)_(\d+)\$(\d+)\((\{\d+\}[^)]*)\),([BRE]),(\d+),(-?\d+)(?:,\[(.*)\])?/.exec(ln))) {
          rawLocals.push(m);
        } else if ((m = /^S:[GF][^$]*\$?(\w+)\$0_0\$0\((\{\d+\}[^)]*)\),E,0,0/.exec(ln)) || (m = /^S:G\$(\w+)\$0_0\$0\((\{\d+\}[^)]*)\),E,0,0/.exec(ln))) {
          rawGlobals.push({ name: m[1], typ: m[2], key: m[1] });
        }
      }
    }
    for (const n of fnNames) {
      const a = funcAddr.get(n);
      if (a !== undefined) this.funcs.push({ name: n, start: a, end: a + 1 });
    }
    for (const m of rawLocals) {
      const [, , func, name, lvl, blk, id, typ, cls, , off, regs] = m;
      const type = this.parseType(typ);
      const v: VarInfo = { name, func, lvl: +lvl, blk: +blk, id: +id, type, where: 'none', isParam: id === '0' && +lvl === 1 };
      if (cls === 'B') { v.where = 'stack'; v.offset = parseInt(off, 10); }
      else if (cls === 'R') { if (regs) { v.where = 'reg'; v.regs = regs.split(',').map((r) => r.toUpperCase()); } else v.where = 'none'; }
      else continue;
      this.vars.push(v);
    }
    for (const g of rawGlobals) {
      const a = globAddr.get(g.key);
      if (a === undefined) continue;
      this.globals.push({ name: g.name, lvl: 0, blk: 0, id: 0, type: this.parseType(g.typ), where: 'global', addr: a, isParam: false });
    }
  }

  private parseNoi(text: string) {
    const set = new Set<number>();
    for (const ln of text.split(/\r?\n/)) {
      const m = /^DEF (\S+) 0x([0-9A-Fa-f]+)$/.exec(ln);
      if (!m) continue;
      const a = parseInt(m[2], 16);
      const n = m[1];
      if (!n.startsWith('_') || /^(l__|s__)/.test(n)) continue;
      set.add(a);
      this.symByName.set(n, a);
      if (n === '_g_CurrentSegment') this.segAddr = a;
      if (!this.symNames.has(a)) this.symNames.set(a, n.slice(1));
    }
    this.symAddrs = [...set].sort((a, b) => a - b);
  }

  private finish() {
    let lo = 0x10000, hi = 0;
    for (const l of this.lines) if (l.addr > 0xFFFF) { lo = Math.min(lo, l.addr & 0xFFFF); hi = Math.max(hi, (l.addr & 0xFFFF) + 1); }
    for (const f of this.funcs) if (f.start > 0xFFFF) { lo = Math.min(lo, f.start & 0xFFFF); hi = Math.max(hi, (f.start & 0xFFFF) + 1); }
    if (hi > 0) { this.bankLo = lo & ~0x1FFF; this.bankHi = (hi + 0x1FFF) & ~0x1FFF; }
    this.lines.sort((a, b) => a.addr - b.addr);
    this.funcs.sort((a, b) => a.start - b.start);
    for (const f of this.funcs) {
      let end = f.start + 1;
      const next = this.symAddrs.find((a) => a > f.start);
      if (next !== undefined) end = next;
      f.end = end;
      this.funcByName.set(f.name, f);
    }
    for (const l of this.lines) {
      const k = path.basename(l.file).toLowerCase();
      if (!this.linesByFile.has(k)) this.linesByFile.set(k, []);
      this.linesByFile.get(k)!.push(l);
    }
  }

  // ---------- queries ----------
  funcAt(addr: number): FuncInfo | undefined {
    let lo = 0, hi = this.funcs.length - 1, r: FuncInfo | undefined;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.funcs[mid].start <= addr) { r = this.funcs[mid]; lo = mid + 1; } else hi = mid - 1;
    }
    return r && addr < r.end ? r : undefined;
  }
  funcByNameGet(name: string) { return this.funcByName.get(name); }

  /** Name of the closest preceding symbol (library functions without debug info). */
  symbolAt(addr: number): string | undefined {
    let best: number | undefined;
    for (const a of this.symAddrs) { if (a <= addr) { if (this.symNames.has(a)) best = a; } else break; }
    return best !== undefined && addr - best < 0x600 ? this.symNames.get(best) : undefined;
  }

  /** Line entry whose address is the last one <= addr (inside the same function). */
  lineAt(addr: number): LineEntry | undefined {
    const f = this.funcAt(addr);
    if (!f) return undefined;
    let lo = 0, hi = this.lines.length - 1, r: LineEntry | undefined;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.lines[mid].addr <= addr) { r = this.lines[mid]; lo = mid + 1; } else hi = mid - 1;
    }
    return r && r.addr >= f.start ? r : undefined;
  }

  /** All addresses where a statement of `line` begins. If the line has no code, moves to the next line that has. */
  addrsForLine(file: string, line: number): { line: number; addrs: number[] } | undefined {
    const arr = this.linesByFile.get(path.basename(file).toLowerCase());
    if (!arr) return undefined;
    let best: number | undefined;
    for (const l of arr) if (l.line >= line && (best === undefined || l.line < best)) best = l.line;
    if (best === undefined || best - line > 12) return undefined;
    return { line: best, addrs: [...new Set(arr.filter((l) => l.line === best).map((l) => l.addr))] };
  }

  /** Locals visible in a function at a given line (approximation based on block level). */
  localsFor(func: string, at?: LineEntry): VarInfo[] {
    const all = this.vars.filter((v) => v.func === func && !v.name.startsWith('__') && !/^sloc\d+$/.test(v.name));
    if (!at) return all;
    return all.filter((v) => v.isParam || v.lvl < at.lvl || (v.lvl === at.lvl && v.blk === at.blk) || v.lvl <= 1 && at.lvl <= 1);
  }

  structFields(key: string): StructField[] { return this.structs.get(key) ?? []; }

  /** Tcl that defines the line-start table and the user function ranges for the openMSX stepper. */
  staticTcl(files?: Set<string>): string {
    const pairs: string[] = [];
    for (const l of this.lines) if (!files || files.has(path.basename(l.file).toLowerCase())) pairs.push(`${l.addr} ${l.line}`);
    const ur = this.funcs.map((f) => `{${f.start} ${f.end}}`).join(' ');
    return `array set ::LA {${pairs.join(' ')}}\nset ::UR {${ur}}\nset ::BLO ${this.banked ? this.bankLo : 0}\nset ::BHI ${this.banked ? this.bankHi : 0}\nset ::SEGADDR ${this.segAddr}\n`;
  }

  get banked(): boolean { return this.bankHi > 0 && this.segAddr > 0; }
  /** CPU address + segment mapped in the switchable page -> linear address used by the debug info. */
  toLin(cpu: number, seg: number): number {
    return this.banked && seg > 0 && cpu >= this.bankLo && cpu < this.bankHi ? seg * 0x10000 + cpu : cpu;
  }

  /** Source file names present in the line table (lower-case basenames). */
  sourceFiles(): string[] { return [...this.linesByFile.keys()]; }
}
