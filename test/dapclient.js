// Headless DAP client: drives dist/adapterMain.js against openMSX.
const { spawn } = require('child_process');
const path = require('path');
const mode = process.argv[2] || 'normal';
const PROJ = process.env.PROJ_DIR || 'E:/Dropbox/FAUSTO/SVILUPPI/MSX/CODE/C/MSXgl/projects/sampradv_dbg';
const NAME = process.env.NAME || 'sampradv';
const SRCF = process.env.SRC || 'sampradv.c';
const adapter = spawn('node', [path.join(__dirname, '..', 'dist', 'adapterMain.js')], { stdio: ['pipe', 'pipe', 'inherit'] });
let seq = 1, buf = Buffer.alloc(0); const pending = new Map(); const events = [];
adapter.stdout.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const i = buf.indexOf('\r\n\r\n'); if (i < 0) return;
    const len = parseInt(/Content-Length: (\d+)/i.exec(buf.slice(0, i).toString())[1], 10);
    if (buf.length < i + 4 + len) return;
    const msg = JSON.parse(buf.slice(i + 4, i + 4 + len).toString()); buf = buf.slice(i + 4 + len);
    if (msg.type === 'response') { const p = pending.get(msg.request_seq); if (p) { pending.delete(msg.request_seq); msg.success ? p.res(msg.body || {}) : p.rej(new Error(msg.message)); } }
    else { events.push(msg); if (msg.event !== 'output') console.log('  [event]', msg.event, JSON.stringify(msg.body||{})); if (msg.event === 'output') process.stdout.write('  [out] ' + msg.body.output); }
  }
});
const send = (command, args = {}) => new Promise((res, rej) => {
  const m = { seq: seq, type: 'request', command, arguments: args }; pending.set(seq++, { res, rej });
  const j = JSON.stringify(m); adapter.stdin.write(`Content-Length: ${Buffer.byteLength(j)}\r\n\r\n${j}`);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitEvent = async (name, ms = 90000, keys) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const i = events.findIndex((e) => e.event === name);
    if (i >= 0) return events.splice(i, 1)[0];
    if (keys) { for (const k of ['0x80 7', '0x01 8', '0x02 0']) { await send('evaluate', { expression: `!keymatrixdown ${k.split(' ')[1]} ${k.split(' ')[0]}`, context: 'repl' }).catch((e) => { if (!globalThis.__w) { globalThis.__w = 1; console.log('  evaluate err', e.message); } }); } await sleep(150); for (const k of ['0x80 7', '0x01 8', '0x02 0']) { await send('evaluate', { expression: `!keymatrixup ${k.split(' ')[1]} ${k.split(' ')[0]}`, context: 'repl' }).catch(() => 0); } }
    await sleep(keys ? 400 : 50);
  }
  throw new Error('timeout waiting for ' + name);
};
const where = async (tag) => {
  const st = await send('stackTrace', { threadId: 1 });
  console.log(`${tag}: ` + st.stackFrames.slice(0, 5).map((f) => `${f.name}:${f.line}`).join('  <-  '));
  return st;
};
const showLocals = async (frameId = 0) => {
  const sc = await send('scopes', { frameId });
  const vs = await send('variables', { variablesReference: sc.scopes[0].variablesReference });
  console.log('  locals: ' + vs.variables.map((v) => `${v.name}=${v.value}`).join(', '));
  return vs.variables;
};
(async () => {
  const caps = await send('initialize', { adapterID: 'msxgl', pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true });
  const cfg = { rom: PROJ + '/out/' + NAME + '.rom', openmsx: 'E:/Dropbox/FAUSTO/SVILUPPI/MSX/EMULATORI/openMSX/openmsx.exe', sourceRoot: PROJ, debugMode: mode };
  if (mode === 'full') { cfg.projectDir = PROJ; cfg.rom = PROJ + '/out/' + NAME + '.rom'; cfg.sourceRoot = cfg.projectDir; }
  const lp = send('launch', cfg);
  await waitEvent('initialized', 600000);
  await lp;
  const src = (cfg.sourceRoot + '/' + SRCF);
  const bp = await send('setBreakpoints', { source: { path: src }, breakpoints: [{ line: +(process.env.BP_LINE || 254) }] });
  console.log('breakpoints', JSON.stringify(bp.breakpoints));
  await send('configurationDone');
  if (process.env.PROBE) {
    await sleep(20000);
    for (let i = 0; i < 6; i++) { const r = await send('evaluate', { expression: '!format %04X [reg PC]', context: 'repl' }); console.log('  PC', r.result); await sleep(700); }
    for (const q of ['machine_info config_name', 'peek 0x2D', 'peek 0x2D 0 0', 'debug read_block {Sony HB-75P bios} 0x2D 1', 'machine_info version']) console.log('  q:', q, '=>', (await send('evaluate', { expression: '!' + q, context: 'repl' }).catch(e => ({ result: 'ERR ' + e.message.slice(0, 60) }))).result);
    console.log('  bps:', (await send('evaluate', { expression: '!debug breakpoint list', context: 'repl' })).result.split(String.fromCharCode(10)).join(' | '));
    console.log('  machine:', (await send('evaluate', { expression: '!machine_info type', context: 'repl' }).catch(e => ({ result: e.message }))).result);
    await send('evaluate', { expression: '!screenshot -raw -doublesize ' + (process.env.SHOT || 'C:/Windows/Temp/shot.png'), context: 'repl' }).catch((e) => console.log('shot err', e.message)); await sleep(1500);
    const hx = (await send('evaluate', { expression: '!binary scan [debug read_block VRAM 0 960] H* x; set x', context: 'repl' })).result.trim();
    const txt = Buffer.from(hx, 'hex').toString('latin1').replace(/[^ -~]/g, '.');
    for (let r = 0; r < 24; r++) { const l = txt.slice(r * 40, r * 40 + 40); if (/[A-Za-z]/.test(l)) console.log('  screen:', l); }
    await send('disconnect', {}); console.log('PROBE-DONE'); setTimeout(() => process.exit(0), 500); return;
  }
  const ev = await waitEvent('stopped', 120000, true);
  console.log('stopped:', ev.body.reason);
  await where('hit');
  if (process.env.DUMP) {
    for (let q = 0; q < 3; q++) { const r0 = await send('evaluate', { expression: '!dbg_regs; debug breaked', context: 'repl' }); console.log('  probe', r0.result.split(' ').map(Number).map(n => n.toString(16)).join(' ')); await sleep(300); }
    const rg = await send('evaluate', { expression: '!dbg_regs', context: 'repl' }); console.log('regs(PC SP IX IY AF BC DE HL)=', rg.result.split(' ').map(Number).map(n => n.toString(16)).join(' '));
    const hx = (await send('evaluate', { expression: '!dbg_rd [reg SP] 40', context: 'repl' })).result.trim();
    const w = []; for (let i = 0; i < hx.length; i += 4) w.push(hx.slice(i + 2, i + 4) + hx.slice(i, i + 2)); console.log('stack words:', w.join(' '));
  }
  await showLocals();
  for (const ex of (process.env.EXPRS || 'x,y,pos,tile,x + y*32,g_Maze.type,g_SamSprite.location.x,g_Maze.grid[1][2],$HL').split(',')) {
    try { const r = await send('evaluate', { expression: ex, frameId: 0, context: 'watch' }); console.log(`  ${ex} = ${r.result}`); } catch (e) { console.log(`  ${ex} -> ERR ${e.message}`); }
  }
  if (process.env.NOSTEP) { await send('disconnect', {}); console.log('OK'); setTimeout(() => process.exit(0), 500); return; }
  await send('next', { threadId: 1 }); await waitEvent('stopped', 20000); await where('next');
  await send('next', { threadId: 1 }); await waitEvent('stopped', 20000); await where('next');
  await send('stepOut', { threadId: 1 }); await waitEvent('stopped', 20000); await where('stepOut');
  await showLocals();
  await send('stepIn', { threadId: 1 }); await waitEvent('stopped', 20000); await where('stepIn');
  await send('continue', { threadId: 1 }); await waitEvent('stopped', 60000, false); await where('2nd hit');
  await showLocals();
  await send('disconnect', {});
  console.log('OK');
  setTimeout(() => process.exit(0), 500);
})().catch((e) => { console.log('FAIL', e.message); adapter.kill(); process.exit(1); });
