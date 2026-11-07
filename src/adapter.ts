import {
  DebugSession, InitializedEvent, StoppedEvent, TerminatedEvent, OutputEvent, Thread, StackFrame,
  Scope, Source, Handles, Breakpoint, ContinuedEvent,
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import * as fs from 'fs';
import * as path from 'path';
import { DebugInfo, TypeInfo, VarInfo, LineEntry, FuncInfo } from './cdb';
import { OpenMsx } from './bridge';
import { evaluate, scalar, decodeInt, EvalEnv, Value } from './expr';
import { prepareFullBuild } from './fullmode';

export interface LaunchConfig extends DebugProtocol.LaunchRequestArguments {
  rom: string;
  cdb?: string;
  openmsx?: string;
  machine?: string;
  extraArgs?: string[];
  sourceRoot?: string;
  debugMode?: 'normal' | 'full';
  projectDir?: string;
  module?: string;
  stopOnEntry?: boolean;
  romType?: string;               // openMSX -romtype (auto for ASCII8/ASCII16/KONAMI mappers)
  target?: string;                // MSXgl Target (auto-read from project_config.js)
  showRegisterValues?: boolean;   // normal mode: also show (possibly stale) register values
  autovolScript?: string;   // injected by the extension
}

interface Frame {
  pc: number; sp: number; func?: FuncInfo; line?: LineEntry; name: string;
  localsIx?: number;        // IX valid for this frame's locals
  ret?: number; callerSp?: number; callerIx?: number;
  isTop: boolean;
}
type Ref =
  | { k: 'locals'; frame: number }
  | { k: 'globals' }
  | { k: 'regs' }
  | { k: 'val'; type: TypeInfo; addr: number };

const DEFAULT_OPENMSX = 'openmsx.exe';

function detectTarget(rom: string, projectDir?: string): string {
  for (const d of [projectDir, path.resolve(path.dirname(rom), '..')]) {
    if (!d) continue;
    const f = path.join(d, 'project_config.js');
    if (!fs.existsSync(f)) continue;
    const m = [...fs.readFileSync(f, 'utf8').matchAll(/^\s*Target\s*=\s*"(\w+)"/gm)];
    if (m.length) return m[m.length - 1][1];
  }
  return '';
}
function segSizeFor(target: string, di: DebugInfo): number {
  if (/ASCII16|NEO16/.test(target)) return 0x4000;
  if (/ASCII8|KONAMI|NEO8|YAMANOOTO/.test(target)) return 0x2000;
  return di.bankHi - di.bankLo > 0x2000 ? 0x4000 : 0x2000;
}
function romTypeFor(target: string): string | undefined {
  const t: Record<string, string> = { ROM_ASCII8: 'ASCII8', ROM_ASCII16: 'ASCII16', ROM_KONAMI: 'Konami', ROM_KONAMI_SCC: 'KonamiSCC', ROM_NEO8: 'NEO8', ROM_NEO16: 'NEO16' };
  return t[target];
}
const THREAD = 1;

export class MsxSession extends DebugSession {
  private cfg!: LaunchConfig;
  private di!: DebugInfo;
  private msx?: OpenMsx;
  private srcMap = new Map<string, string>();
  private bpIds = new Map<string, string[]>();          // source path -> openMSX bp ids
  private bpCond = new Map<number, string>();           // address -> condition
  private refs = new Handles<Ref>();
  private frames: Frame[] = [];
  private regsCache?: Awaited<ReturnType<OpenMsx['regs']>>;
  private codeCache = new Map<number, number>();
  private live = false;
  private busy = false;
  private pauseRequested = false;
  private fullMode = false;
  private curSeg = 0;
  private romBuf?: Buffer;
  private segSize = 0x4000;
  private bcallEhl?: number;

  constructor() {
    super();
    this.setDebuggerLinesStartAt1(true);
    this.setDebuggerColumnsStartAt1(true);
  }

  // ---------- DAP lifecycle ----------
  protected initializeRequest(resp: DebugProtocol.InitializeResponse): void {
    resp.body = {
      supportsConfigurationDoneRequest: true,
      supportsEvaluateForHovers: true,
      supportsConditionalBreakpoints: true,
      supportsTerminateRequest: true,
      supportsSetVariable: false,
    };
    this.sendResponse(resp);
  }

  protected async launchRequest(resp: DebugProtocol.LaunchResponse, args: LaunchConfig): Promise<void> {
    try {
      this.cfg = args;
      this.fullMode = args.debugMode === 'full';
      let rom = args.rom;
      let cdb = args.cdb;
      let sourceRoot = args.sourceRoot;
      if (this.fullMode) {
        this.log('Full mode: building a copy with automatic volatile…');
        const r = await prepareFullBuild(args, (m) => this.log(m));
        rom = r.rom; cdb = r.cdb;
        sourceRoot = sourceRoot ?? args.projectDir;
      }
      if (!fs.existsSync(rom)) throw new Error(`ROM not found: ${rom}`);
      cdb = cdb ?? rom.replace(/\.rom$/i, '.cdb');
      if (!fs.existsSync(cdb)) throw new Error(`.cdb not found: ${cdb} (build with Debug = true)`);
      this.di = DebugInfo.load(cdb);
      sourceRoot = sourceRoot ?? path.resolve(path.dirname(rom), '..');
      this.indexSources(sourceRoot);
      const target = args.target ?? detectTarget(rom, args.projectDir);
      let romType = args.romType;
      if (this.di.banked) {
        this.segSize = segSizeFor(target, this.di);
        this.di.bankLo &= ~(this.segSize - 1); this.di.bankHi = this.di.bankLo + this.segSize;   // the whole switchable page
        this.romBuf = fs.readFileSync(rom);
        romType = romType ?? romTypeFor(target);
        this.log(`Banked ROM (${target || 'unknown target'}): segment size 0x${this.segSize.toString(16)}, switchable window 0x${this.di.bankLo.toString(16)}-0x${this.di.bankHi.toString(16)}, current segment variable at 0x${this.di.segAddr.toString(16)}.`);
      }
      const files = new Set<string>([...this.srcMap.keys(), (this.di.module + '.c').toLowerCase()]);
      this.msx = new OpenMsx({
        openmsx: args.openmsx || DEFAULT_OPENMSX,
        machine: args.machine || 'Sony_HB-55P',
        rom,
        romType,
        extraArgs: args.extraArgs ?? [],
        staticTcl: this.di.staticTcl(files),
      });
      this.msx.on('exit', () => this.sendEvent(new TerminatedEvent()));
      this.msx.on('break', (pc: number) => this.onAsyncBreak(pc));
      await this.msx.start();
      this.log(`openMSX started (${this.di.funcs.length} functions, ${this.di.lines.length} line entries, mode ${this.fullMode ? 'full' : 'normal'}).`);
      this.sendResponse(resp);
      this.sendEvent(new InitializedEvent());
    } catch (e) {
      this.sendErrorResponse(resp, 1001, (e as Error).message);
    }
  }

  protected async configurationDoneRequest(resp: DebugProtocol.ConfigurationDoneResponse): Promise<void> {
    this.sendResponse(resp);
    this.live = true;
    if (this.cfg.stopOnEntry) {
      this.sendEvent(new StoppedEvent('entry', THREAD));
    } else {
      void this.runFree();
    }
  }

  protected async disconnectRequest(resp: DebugProtocol.DisconnectResponse): Promise<void> {
    this.msx?.kill();
    this.sendResponse(resp);
  }
  protected terminateRequest(resp: DebugProtocol.TerminateResponse): void {
    this.msx?.kill();
    this.sendResponse(resp);
  }

  private log(m: string) { this.sendEvent(new OutputEvent(m + '\n', 'console')); }

  private indexSources(root: string) {
    const walk = (d: string, depth: number) => {
      if (depth > 4) return;
      let ents: fs.Dirent[] = [];
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (e.isDirectory()) { if (!/^(out|node_modules|\.git|\.vscode)$/i.test(e.name)) walk(path.join(d, e.name), depth + 1); }
        else if (/\.(c|h)$/i.test(e.name)) { const k = e.name.toLowerCase(); if (!this.srcMap.has(k)) this.srcMap.set(k, path.join(d, e.name)); }
      }
    };
    walk(root, 0);
  }

  // ---------- breakpoints ----------
  protected async setBreakPointsRequest(resp: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {
    try {
      const file = args.source.path ?? '';
      const key = file.toLowerCase();
      for (const id of this.bpIds.get(key) ?? []) await this.msx!.exec(`debug remove_bp ${id}`);
      const ids: string[] = [];
      const out: DebugProtocol.Breakpoint[] = [];
      for (const sb of args.breakpoints ?? []) {
        const hit = this.di.addrsForLine(file, sb.line);
        if (!hit) { out.push(new Breakpoint(false, sb.line)); (out[out.length - 1] as DebugProtocol.Breakpoint).message = 'no code at this line'; continue; }
        for (const a of hit.addrs) {
          const seg = Math.floor(a / 0x10000);
          const when = seg > 0 ? ` {[peek ${this.di.segAddr}] == ${seg}}` : '';
          ids.push((await this.msx!.exec(`debug set_bp ${a & 0xFFFF}${when}`)).trim());
          if (sb.condition) this.bpCond.set(a, sb.condition); else this.bpCond.delete(a);
        }
        const b = new Breakpoint(true, hit.line) as DebugProtocol.Breakpoint;
        out.push(b);
      }
      this.bpIds.set(key, ids);
      resp.body = { breakpoints: out };
      this.sendResponse(resp);
    } catch (e) { this.sendErrorResponse(resp, 1002, (e as Error).message); }
  }

  // ---------- execution control ----------
  protected threadsRequest(resp: DebugProtocol.ThreadsResponse): void {
    resp.body = { threads: [new Thread(THREAD, 'Z80')] };
    this.sendResponse(resp);
  }

  private invalidate() { this.frames = []; this.regsCache = undefined; this.refs.reset(); }

  private async cont() { this.msx!.breaked = false; this.invalidate(); await this.msx!.exec('dbg_cont'); }

  /** Called for every break event. Only handles breaks nobody is waiting for (free run / pause). */
  private onAsyncBreak(_pc: number) {
    if (!this.live || this.busy) return;
    if (this.pauseRequested) { this.pauseRequested = false; this.invalidate(); this.sendEvent(new StoppedEvent('pause', THREAD)); }
  }

  private async runFree() {
    this.busy = true;
    try {
      for (;;) {
        await this.cont();
        await this.msx!.waitBreak();
        if (this.pauseRequested) { this.pauseRequested = false; this.sendEvent(new StoppedEvent('pause', THREAD)); return; }
        const r = await this.regs();
        if (process.env.MSXDBG_TRACE) this.log(`break at PC=${r.PC.toString(16)} SP=${r.SP.toString(16)} IX=${r.IX.toString(16)}`);
        const cond = this.bpCond.get(this.di.toLin(r.PC, this.curSeg));
        if (cond) {
          try { const v = await this.evalExpr(cond, 0); if (!(await scalar(this.env(0), v))) continue; } catch { /* stop on error */ }
        }
        this.sendEvent(new StoppedEvent('breakpoint', THREAD));
        return;
      }
    } catch (e) { if (!this.msx?.exited) this.log('run error: ' + (e as Error).message); }
    finally { this.busy = false; }
  }

  protected continueRequest(resp: DebugProtocol.ContinueResponse): void {
    resp.body = { allThreadsContinued: true };
    this.sendResponse(resp);
    void this.runFree();
  }

  protected pauseRequest(resp: DebugProtocol.PauseResponse): void {
    this.pauseRequested = true;
    this.sendResponse(resp);
    this.msx!.exec('debug break').catch(() => undefined);
  }

  protected nextRequest(resp: DebugProtocol.NextResponse): void { this.sendResponse(resp); void this.stepLine('over'); }
  protected stepInRequest(resp: DebugProtocol.StepInResponse): void { this.sendResponse(resp); void this.stepLine('into'); }
  protected stepOutRequest(resp: DebugProtocol.StepOutResponse): void { this.sendResponse(resp); void this.stepOut(); }

  private async stepLine(mode: 'over' | 'into') {
    this.busy = true;
    try {
      const frames = await this.getFrames();
      const startLine = frames[0]?.line?.line ?? 0;
      if (!frames[0]?.func) { await this.stepOutInner(); return; }
      this.invalidate();
      for (;;) {
        const r = (await this.msx!.exec(`dbg_stepline ${startLine} ${mode}`)).trim().split(/\s+/);
        if (r[0] === 'stop') break;
        if (r[0] === 'more') continue;
        if (r[0] === 'call') {
          const ret = Number(r[1]), sp0 = Number(r[2]);
          if (await this.runToReturn(ret, `[reg SP] == ${sp0}`)) continue;
          return;               // a user breakpoint stopped us inside the callee
        }
        break;
      }
      this.invalidate();
      this.sendEvent(new StoppedEvent('step', THREAD));
    } catch (e) { if (!this.msx?.exited) this.log('step error: ' + (e as Error).message); }
    finally { this.busy = false; }
  }

  /** Runs until `ret` (with condition). Returns true when it got there; false when something else stopped it. */
  private async runToReturn(ret: number, cond: string): Promise<boolean> {
    const tmp = (await this.msx!.exec(`debug set_bp ${ret} {${cond}}`)).trim();
    await this.cont();
    await this.msx!.waitBreak();
    await this.msx!.exec(`debug remove_bp ${tmp}`).catch(() => undefined);
    if (this.pauseRequested) { this.pauseRequested = false; this.invalidate(); this.sendEvent(new StoppedEvent('pause', THREAD)); return false; }
    const r = await this.regs();
    if (r.PC === ret) return true;
    const c = this.bpCond.get(this.di.toLin(r.PC, this.curSeg));
    if (c) { try { const v = await this.evalExpr(c, 0); if (!(await scalar(this.env(0), v))) return this.runToReturn(ret, cond); } catch { /* stop */ } }
    this.invalidate();
    this.sendEvent(new StoppedEvent('breakpoint', THREAD));
    return false;
  }

  private async stepOut() {
    this.busy = true;
    try { await this.stepOutInner(); } catch (e) { this.log('step out error: ' + (e as Error).message); } finally { this.busy = false; }
  }
  private async stepOutInner() {
    const frames = await this.getFrames();
    const f0 = frames[0];
    if (!f0 || f0.ret === undefined) { this.invalidate(); this.sendEvent(new StoppedEvent('step', THREAD)); return; }
    const ok = await this.runToReturn(f0.ret, `[reg SP] >= ${f0.callerSp}`);
    if (ok) { this.invalidate(); this.sendEvent(new StoppedEvent('step', THREAD)); }
  }

  // ---------- machine state ----------
  private async regs() {
    if (!this.regsCache) {
      this.regsCache = await this.msx!.regs();
      this.curSeg = this.di.banked ? (await this.msx!.readMem(this.di.segAddr, 1))[0] : 0;
    }
    return this.regsCache;
  }

  /** Code bytes at a linear address (reads the ROM image when that segment is not the one currently mapped). */
  private async code(lin: number, len: number): Promise<Buffer> {
    const seg = Math.floor(lin / 0x10000), cpu = lin & 0xFFFF;
    if (seg > 0 && seg !== this.curSeg && this.romBuf) {
      const off = seg * this.segSize + (cpu - this.di.bankLo);
      return Buffer.from(this.romBuf.subarray(off, off + len));
    }
    const out = Buffer.alloc(len);
    let missing = false;
    for (let i = 0; i < len; i++) { const c = this.codeCache.get(lin + i); if (c === undefined) missing = true; else out[i] = c; }
    if (missing) {
      const b = await this.msx!.readMem(cpu, len);
      for (let i = 0; i < len; i++) { out[i] = b[i]; const c = cpu + i; if (c >= 0x4000 && c < 0xC000) this.codeCache.set(lin + i, b[i]); }
    }
    return out;
  }
  private w(b: Buffer, o: number) { return b[o] | (b[o + 1] << 8); }

  private async isFramed(f: FuncInfo): Promise<boolean> {
    const b = await this.code(f.start, 8);
    return b[0] === 0xDD && b[1] === 0xE5 && b[2] === 0xDD && b[3] === 0x21 && b[4] === 0 && b[5] === 0 && b[6] === 0xDD && b[7] === 0x39;
  }

  /** Return address inside the SDCC banked-call trampoline (___sdcc_bcall_ehl, right after its inner call). */
  private isBcallRet(cpu: number): boolean {
    if (this.bcallEhl === undefined) {
      this.bcallEhl = -1;
      for (const [a, n] of this.di.symNames) if (n === '__sdcc_bcall_ehl') this.bcallEhl = a;
    }
    return this.bcallEhl > 0 && cpu === this.bcallEhl + 8;
  }

  private looksLikeReturn(cand: number, before: Buffer): boolean {
    if (this.isBcallRet(cand)) return true;
    if (before[0] !== 0xCD) return false;
    const tgt = this.w(before, 1);
    return this.di.funcAt(this.di.toLin(tgt, this.curSeg)) !== undefined || this.di.symAddrs.includes(tgt);
  }

  private async getFrames(): Promise<Frame[]> {
    if (this.frames.length) return this.frames;
    const r = await this.regs();
    let cpu = r.PC, sp = r.SP, ix = r.IX, seg = this.curSeg;
    const frames: Frame[] = [];
    for (let depth = 0; depth < 24; depth++) {
      const pc = this.di.toLin(cpu, seg);
      const f = this.di.funcAt(pc);
      const line = f ? this.di.lineAt(depth === 0 ? pc : pc - 1) : undefined;
      const sym = f?.name ?? this.di.symbolAt(pc);
      const fr: Frame = { pc, sp, func: f, line, name: cpu < 0x4100 ? '<startup>' : sym ? sym : `0x${cpu.toString(16)}`, isTop: depth === 0 };
      frames.push(fr);
      const stack = await this.msx!.readMem(sp, 96);
      const rd = (a: number) => (a >= sp && a + 1 < sp + stack.length) ? this.w(stack, a - sp) : undefined;
      const opc = await this.code(pc, 2);
      let ret: number | undefined, callerIx = ix, callerSp = sp;
      const framed = f ? await this.isFramed(f) : false;
      if (f && framed && opc[0] !== 0xC9) {
        const off = pc - f.start;
        if (off === 0) { ret = rd(sp); callerSp = sp + 2; }
        else if (off < 8) { ret = rd(sp + 2); callerIx = rd(sp) ?? ix; callerSp = sp + 4; }
        else {
          fr.localsIx = ix;
          const mem = await this.msx!.readMem(ix, 4);
          ret = this.w(mem, 2); callerIx = this.w(mem, 0); callerSp = ix + 4;
        }
      } else if (opc[0] === 0xC9 || (f && pc === f.start)) {
        ret = rd(sp); callerSp = sp + 2;
      } else {
        for (let k = 0; k < 90; k++) {
          const cand = rd(sp + k);
          if (cand === undefined || cand < 0x4000 || cand >= 0xC000) continue;
          const before = await this.code(this.di.toLin(cand - 3, seg), 3);
          if (this.looksLikeReturn(cand, before)) { ret = cand; callerSp = sp + k + 2; break; }
        }
        // a frameless function leaves IX untouched: it still belongs to the caller
      }
      let nextSeg = seg;
      if (ret !== undefined && this.isBcallRet(ret)) {
        // banked call: [old segment byte][real return address] sit above the trampoline's return address
        const t = await this.msx!.readMem(callerSp, 3);
        nextSeg = t[0]; ret = t[1] | (t[2] << 8); callerSp += 3;
      }
      fr.ret = ret; fr.callerSp = callerSp; fr.callerIx = callerIx;
      if (process.env.MSXDBG_TRACE) this.log(`frame ${depth}: ${fr.name} pc=${pc.toString(16)} seg=${seg} sp=${sp.toString(16)} ix=${ix.toString(16)} framed=${framed} ret=${ret?.toString(16)} nextSeg=${nextSeg}`);
      if (ret === undefined || ret < 0x4000 || ret >= 0xC000) break;
      if (!f && (depth > 0 || cpu < 0x4100)) break;      // below user code (startup / library): stop unwinding
      cpu = ret; sp = callerSp; ix = callerIx; seg = nextSeg;
    }
    // locals IX for callers: the IX chain value when the caller is framed
    for (let i = 1; i < frames.length; i++) {
      const fr = frames[i];
      if (fr.func && fr.localsIx === undefined && await this.isFramed(fr.func)) fr.localsIx = frames[i - 1].callerIx;
    }
    this.frames = frames;
    return frames;
  }

  // ---------- stack / scopes / variables ----------
  protected async stackTraceRequest(resp: DebugProtocol.StackTraceResponse): Promise<void> {
    try {
      const frames = await this.getFrames();
      resp.body = {
        stackFrames: frames.map((f, i) => {
          const file = f.line ? this.srcMap.get(path.basename(f.line.file).toLowerCase()) : undefined;
          const src = f.line ? new Source(path.basename(f.line.file), file) : undefined;
          const sf = new StackFrame(i, f.name, src, f.line?.line ?? 0, 1) as DebugProtocol.StackFrame;
          sf.instructionPointerReference = '0x' + (f.pc & 0xFFFF).toString(16);
          if (!f.line) sf.presentationHint = 'subtle';
          return sf;
        }),
        totalFrames: frames.length,
      };
      this.sendResponse(resp);
    } catch (e) { this.sendErrorResponse(resp, 1003, (e as Error).message); }
  }

  protected scopesRequest(resp: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
    resp.body = {
      scopes: [
        new Scope('Locals', this.refs.create({ k: 'locals', frame: args.frameId }), false),
        new Scope('Registers', this.refs.create({ k: 'regs' }), false),
        new Scope('Globals', this.refs.create({ k: 'globals' }), true),
      ],
    };
    this.sendResponse(resp);
  }

  private regValue(name: string, r: NonNullable<typeof this.regsCache>): number | undefined {
    const hi = (v: number) => (v >> 8) & 0xFF, lo = (v: number) => v & 0xFF;
    switch (name) {
      case 'A': return hi(r.AF); case 'F': return lo(r.AF);
      case 'B': return hi(r.BC); case 'C': return lo(r.BC);
      case 'D': return hi(r.DE); case 'E': return lo(r.DE);
      case 'H': return hi(r.HL); case 'L': return lo(r.HL);
      case 'IXH': return hi(r.IX); case 'IXL': return lo(r.IX);
      case 'IYH': return hi(r.IY); case 'IYL': return lo(r.IY);
    }
    return undefined;
  }

  private fmt(t: TypeInfo, b: Buffer): string {
    switch (t.kind) {
      case 'int': {
        const v = decodeInt(b, t);
        if (t.isChar) return `${v}${v >= 32 && v < 127 ? ` '${String.fromCharCode(v & 0xFF)}'` : ''}`;
        return Math.abs(v) > 9 ? `${v} (0x${(v >>> 0 & (t.size === 4 ? 0xFFFFFFFF : (1 << (8 * t.size)) - 1)).toString(16).toUpperCase()})` : `${v}`;
      }
      case 'bool': return b[0] ? 'true' : 'false';
      case 'ptr': return '0x' + decodeInt(b, { kind: 'int', size: 2, signed: false, text: '' }).toString(16).toUpperCase().padStart(4, '0');
      case 'func': return '<function>';
      case 'struct': return '{…}';
      case 'array': return `${this.di.typeName(t.elem!)}[${t.count}]`;
      default: return '?';
    }
  }

  private env(frameIdx: number): EvalEnv {
    return {
      di: this.di,
      read: (a, n) => this.msx!.readMem(a, n),
      lookup: async (name) => {
        const frames = await this.getFrames();
        const fr = frames[frameIdx];
        const r = await this.regs();
        const loc = fr?.func ? this.visibleLocals(fr).find((v) => v.name === name) : undefined;
        if (loc) return this.varToValue(loc, fr, frameIdx === 0 ? r : undefined);
        const g = this.di.globals.find((v) => v.name === name);
        if (g) return { type: g.type, addr: g.addr };
        const rv = { PC: r.PC, SP: r.SP, IX: r.IX, IY: r.IY, AF: r.AF, BC: r.BC, DE: r.DE, HL: r.HL } as Record<string, number>;
        const up = name.replace(/^\$/, '').toUpperCase();
        if (rv[up] !== undefined) return { type: { kind: 'int', size: 2, signed: false, text: '' }, num: rv[up] };
        return undefined;
      },
    };
  }

  private visibleLocals(fr: Frame): VarInfo[] {
    if (!fr.func) return [];
    let vars = this.di.localsFor(fr.func.name, fr.line);
    // keep the innermost declaration per name
    const best = new Map<string, VarInfo>();
    for (const v of vars) {
      const o = best.get(v.name);
      if (!o || (v.lvl > o.lvl && (!fr.line || v.lvl <= fr.line.lvl))) best.set(v.name, v);
    }
    vars = [...best.values()];
    // full mode: hide the original parameter 'x_' when the shadow copy 'x' exists
    const names = new Set(vars.map((v) => v.name));
    vars = vars.filter((v) => !(v.isParam && v.name.endsWith('_') && names.has(v.name.slice(0, -1))));
    return vars.sort((a, b) => Number(b.isParam) - Number(a.isParam) || a.name.localeCompare(b.name));
  }

  private varToValue(v: VarInfo, fr: Frame, r?: Awaited<ReturnType<OpenMsx['regs']>>): Value {
    if (v.where === 'stack') {
      if (fr.localsIx === undefined) return { type: v.type, unavailable: '<frame not set up yet>' };
      return { type: v.type, addr: (fr.localsIx + (v.offset ?? 0)) & 0xFFFF };
    }
    if (v.where === 'reg') {
      const rn = v.regs!.join(',');
      if (!r) return { type: v.type, unavailable: `<in register ${rn}: not available in this frame>` };
      if (!this.cfg.showRegisterValues) return { type: v.type, unavailable: `<in register ${rn}: not reliable here - use full mode>` };
      let n = 0;
      v.regs!.forEach((rn, i) => { n |= (this.regValue(rn, r) ?? 0) << (8 * i); });
      return { type: v.type, num: n };
    }
    return { type: v.type, unavailable: '<optimized out>' };
  }

  private async toVariable(name: string, val: Value, v?: VarInfo): Promise<DebugProtocol.Variable> {
    const t = val.type;
    const tn = this.di.typeName(t);
    const out: DebugProtocol.Variable = { name, value: '', type: tn, variablesReference: 0 };
    if (val.unavailable) { out.value = val.unavailable; return out; }
    try {
      let bytes: Buffer;
      let addr = val.addr;
      if (val.num !== undefined) { bytes = Buffer.from([val.num & 0xFF, (val.num >> 8) & 0xFF, (val.num >> 16) & 0xFF, (val.num >> 24) & 0xFF]); addr = undefined; }
      else bytes = await this.msx!.readMem(val.addr!, Math.max(1, Math.min(t.size, 8)));
      out.value = this.fmt(t, bytes);
      if (v?.where === 'reg') out.value += `   [reg ${v.regs!.join(',')} - may be stale after calls; use full mode]`;
      if (t.kind === 'struct' && addr !== undefined) out.variablesReference = this.refs.create({ k: 'val', type: t, addr });
      else if (t.kind === 'array' && addr !== undefined) { out.variablesReference = this.refs.create({ k: 'val', type: t, addr }); out.indexedVariables = t.count; }
      else if (t.kind === 'ptr' && t.elem && (t.elem.kind === 'struct' || t.elem.kind === 'int' || t.elem.kind === 'array')) {
        const p = decodeInt(bytes, { kind: 'int', size: 2, signed: false, text: '' });
        if (p) out.variablesReference = this.refs.create({ k: 'val', type: t, addr: addr ?? 0 });
        (out as { memoryReference?: string }).memoryReference = '0x' + p.toString(16);
      }
    } catch (e) { out.value = `<error: ${(e as Error).message}>`; }
    return out;
  }

  protected async variablesRequest(resp: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): Promise<void> {
    try {
      const ref = this.refs.get(args.variablesReference);
      const out: DebugProtocol.Variable[] = [];
      if (!ref) { resp.body = { variables: [] }; return this.sendResponse(resp); }
      if (ref.k === 'locals') {
        const fr = (await this.getFrames())[ref.frame];
        const r = ref.frame === 0 ? await this.regs() : undefined;
        for (const v of fr ? this.visibleLocals(fr) : []) out.push(await this.toVariable(v.name, this.varToValue(v, fr, r), v));
      } else if (ref.k === 'regs') {
        const r = await this.regs();
        const h = (n: number) => '0x' + n.toString(16).toUpperCase().padStart(4, '0');
        for (const k of ['PC', 'SP', 'IX', 'IY', 'AF', 'BC', 'DE', 'HL'] as const) out.push({ name: k, value: h(r[k]), variablesReference: 0 });
      } else if (ref.k === 'globals') {
        for (const g of this.di.globals.slice().sort((a, b) => a.name.localeCompare(b.name))) {
          if (/^(PT3_|g_ayFX|g_MSXMusic|g_PSG)/.test(g.name)) continue;
          out.push(await this.toVariable(g.name, { type: g.type, addr: g.addr }));
        }
      } else {
        const t = ref.type;
        if (t.kind === 'struct') {
          for (const f of this.di.structFields(t.struct!)) out.push(await this.toVariable(f.name, { type: f.type, addr: ref.addr + f.offset }));
        } else if (t.kind === 'array') {
          const start = args.start ?? 0, count = Math.min(args.count ?? t.count!, t.count! - start, 256);
          for (let i = start; i < start + count; i++) out.push(await this.toVariable(`[${i}]`, { type: t.elem!, addr: ref.addr + i * t.elem!.size }));
        } else if (t.kind === 'ptr' && t.elem) {
          const p = decodeInt(await this.msx!.readMem(ref.addr, 2), { kind: 'int', size: 2, signed: false, text: '' });
          out.push(await this.toVariable('*', { type: t.elem, addr: p }));
        }
      }
      resp.body = { variables: out };
      this.sendResponse(resp);
    } catch (e) { this.sendErrorResponse(resp, 1004, (e as Error).message); }
  }

  private async evalExpr(expr: string, frameIdx: number): Promise<Value> {
    return evaluate(this.env(frameIdx), expr);
  }

  protected async evaluateRequest(resp: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): Promise<void> {
    try {
      if (args.expression.startsWith('!')) {          // raw Tcl for openMSX (debug aid): !keymatrixdown 7 0x80
        const r = await this.msx!.exec(args.expression.slice(1));
        resp.body = { result: r, variablesReference: 0 };
        return this.sendResponse(resp);
      }
      if (!this.msx?.breaked) throw new Error('not available while running');
      const v = await this.evalExpr(args.expression, args.frameId ?? 0);
      const dv = await this.toVariable(args.expression, v);
      resp.body = { result: dv.value, type: dv.type, variablesReference: dv.variablesReference, indexedVariables: dv.indexedVariables };
      this.sendResponse(resp);
    } catch (e) { this.sendErrorResponse(resp, 1005, (e as Error).message); }
  }
}
