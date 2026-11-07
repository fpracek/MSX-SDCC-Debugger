// Bridge to openMSX: openMSX runs a Tcl poller (loaded with -script) that picks up command
// files from a session folder and writes back reply files. No network socket is opened.
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';

export interface BridgeOptions {
  openmsx: string;
  machine: string;
  rom: string;
  romType?: string;
  extraArgs: string[];
  staticTcl: string;   // Tcl that defines ::LA (line addresses) and ::UR (user function ranges)
}

const fwd = (p: string) => p.replace(/\\/g, '/');

function bridgeTcl(dir: string): string {
  return `
set D {${fwd(dir)}}
set ::lastbreak 0
set ::seq 0
proc rdword {a} { binary scan [debug read_block memory $a 2] cu2 b; return [expr {[lindex $b 0] | ([lindex $b 1] << 8)}] }
proc rdbyte {a} { binary scan [debug read_block memory $a 1] cu1 b; return $b }
proc dbg_rd {a n} { binary scan [debug read_block memory $a $n] H* hx; return $hx }
proc dbg_regs {} { return [list [reg PC] [reg SP] [reg IX] [reg IY] [reg AF] [reg BC] [reg DE] [reg HL]] }
proc dbg_cont {} { set ::lastbreak 0; debug cont; return ok }
proc lin {pc} { if {$::BHI > 0 && $pc >= $::BLO && $pc < $::BHI} { set s [peek $::SEGADDR]; if {$s > 0} { return [expr {($s << 16) | $pc}] } }; return $pc }
proc dbg_seg {} { if {$::SEGADDR == 0} { return 0 }; return [peek $::SEGADDR] }
proc inuser {pc} { foreach r $::UR { if {$pc >= [lindex $r 0] && $pc < [lindex $r 1]} {return 1} }; return 0 }
proc dbg_stepline {startLine mode} {
  set n 0
  while {$n < 4000} {
    incr n
    set pc0 [reg PC]; set sp0 [reg SP]
    debug step
    set pc [reg PC]; set sp [reg SP]
    if {$sp == (($sp0 - 2) & 0xFFFF)} {
      set ret [rdword $sp]
      if {$ret != $pc} {
        set b0 [rdbyte $pc0]
        set ispush [expr {$b0 == 0xC5 || $b0 == 0xD5 || $b0 == 0xE5 || $b0 == 0xF5 || (($b0 == 0xDD || $b0 == 0xFD) && [rdbyte [expr {$pc0+1}]] == 0xE5)}]
        if {!$ispush} {
          if {$mode eq "over" || ![inuser [lin $pc]]} { return "call $ret $sp0" }
        }
      }
    }
    set lpc [lin $pc]
    if {[info exists ::LA($lpc)] && $::LA($lpc) != $startLine} { return "stop" }
  }
  return "more"
}
proc poll {} {
  global D
  if {[file exists $D/in.tcl]} {
    set fh [open $D/in.tcl r]; fconfigure $fh -translation binary; set data [read $fh]; close $fh
    file delete $D/in.tcl
    set nl [string first "\\n" $data]
    set id [string range $data 0 [expr {$nl-1}]]
    set script [string range $data [expr {$nl+1}] end]
    set code [catch {uplevel #0 $script} res]
    set fh [open $D/out.tmp w]; fconfigure $fh -translation binary; puts -nonewline $fh "$code\\n$res"; close $fh
    file rename -force $D/out.tmp $D/out.$id
  }
  set b [debug breaked]
  if {$b != $::lastbreak} {
    set ::lastbreak $b
    incr ::seq
    set fh [open $D/status.tmp w]; puts -nonewline $fh "$::seq $b [reg PC]"; close $fh
    file rename -force $D/status.tmp $D/status.txt
  }
  after realtime 0.02 poll
}
source {${fwd(path.join(dir, 'static.tcl'))}}
debug break
set fh [open $D/ready w]; puts $fh ready; close $fh
poll
`;
}

export class OpenMsx extends EventEmitter {
  private proc?: ChildProcess;
  private dir: string;
  private nextId = 1;
  private lastSeq = 0;
  private timer?: NodeJS.Timeout;
  breaked = false;
  exited = false;
  exitInfo = '';

  constructor(private opts: BridgeOptions) {
    super();
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msxgl-dbg-'));
  }

  async start(timeoutMs = 30000): Promise<void> {
    fs.writeFileSync(path.join(this.dir, 'static.tcl'), this.opts.staticTcl);
    const tcl = path.join(this.dir, 'bridge.tcl');
    fs.writeFileSync(tcl, bridgeTcl(this.dir));
    const args = ['-machine', this.opts.machine, '-cart', this.opts.rom, ...(this.opts.romType ? ['-romtype', this.opts.romType] : []), '-script', tcl, ...this.opts.extraArgs];
    this.proc = spawn(this.opts.openmsx, args, { cwd: path.dirname(this.opts.openmsx), windowsHide: false });
    this.proc.on('exit', (code, sig) => { this.exitInfo = `code=${code} signal=${sig}`; this.exited = true; this.stopTimer(); this.emit('exit'); });
    this.proc.on('error', (e) => this.emit('error', e));
    const t0 = Date.now();
    while (!fs.existsSync(path.join(this.dir, 'ready'))) {
      if (this.exited) throw new Error('openMSX closed during start-up (' + this.exitInfo + ')');
      if (Date.now() - t0 > timeoutMs) throw new Error('openMSX did not become ready');
      await new Promise((r) => setTimeout(r, 50));
    }
    this.timer = setInterval(() => this.pollStatus(), 20);
  }

  private stopTimer() { if (this.timer) { clearInterval(this.timer); this.timer = undefined; } }

  private pollStatus() {
    try {
      const f = path.join(this.dir, 'status.txt');
      if (!fs.existsSync(f)) return;
      const [seq, b, pc] = fs.readFileSync(f, 'latin1').trim().split(/\s+/).map(Number);
      if (seq === this.lastSeq) return;
      this.lastSeq = seq;
      this.breaked = b === 1;
      this.emit(this.breaked ? 'break' : 'run', pc);
    } catch { /* file being replaced */ }
  }

  /** Runs a Tcl script inside openMSX; resolves with the result string. */
  exec(script: string, timeoutMs = 60000): Promise<string> {
    if (this.exited) return Promise.reject(new Error('openMSX closed (' + this.exitInfo + ')'));
    const id = this.nextId++;
    const inTmp = path.join(this.dir, `in.${id}.tmp`);
    fs.writeFileSync(inTmp, `${id}\n${script}`);
    // wait until the previous command was consumed
    const inFile = path.join(this.dir, 'in.tcl');
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const outFile = path.join(this.dir, `out.${id}`);
      let sent = false;
      const tick = () => {
        if (this.exited) return reject(new Error('openMSX closed'));
        if (!sent && !fs.existsSync(inFile)) { fs.renameSync(inTmp, inFile); sent = true; }
        if (sent && fs.existsSync(outFile)) {
          const raw = fs.readFileSync(outFile, 'latin1'); fs.unlinkSync(outFile);
          const nl = raw.indexOf('\n');
          const code = parseInt(raw.slice(0, nl), 10);
          const res = raw.slice(nl + 1);
          return code === 0 ? resolve(res) : reject(new Error(res));
        }
        if (Date.now() - t0 > timeoutMs) return reject(new Error('openMSX command timeout: ' + script.slice(0, 80)));
        setTimeout(tick, 5);
      };
      tick();
    });
  }

  waitBreak(timeoutMs = 600000): Promise<number> {
    return new Promise((resolve, reject) => {
      if (this.breaked) return resolve(-1);
      const onB = (pc: number) => { cleanup(); resolve(pc); };
      const onX = () => { cleanup(); reject(new Error('openMSX closed')); };
      const t = setTimeout(() => { cleanup(); reject(new Error('timeout waiting for break')); }, timeoutMs);
      const cleanup = () => { clearTimeout(t); this.off('break', onB); this.off('exit', onX); };
      this.on('break', onB); this.on('exit', onX);
    });
  }

  async readMem(addr: number, len: number): Promise<Buffer> {
    if (len <= 0) return Buffer.alloc(0);
    const hx = await this.exec(`dbg_rd ${addr & 0xFFFF} ${len}`);
    return Buffer.from(hx.trim(), 'hex');
  }

  async regs(): Promise<{ PC: number; SP: number; IX: number; IY: number; AF: number; BC: number; DE: number; HL: number }> {
    const v = (await this.exec('dbg_regs')).trim().split(/\s+/).map(Number);
    return { PC: v[0], SP: v[1], IX: v[2], IY: v[3], AF: v[4], BC: v[5], DE: v[6], HL: v[7] };
  }

  kill() {
    this.stopTimer();
    if (this.proc && !this.exited) {
      try { spawn('taskkill', ['/pid', String(this.proc.pid), '/t', '/f'], { windowsHide: true }); } catch { this.proc.kill(); }
    }
    setTimeout(() => { try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch { /* ignore */ } }, 1500);
  }
}
