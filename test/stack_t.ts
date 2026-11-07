import { OpenMsx } from '../src/bridge';
import { DebugInfo } from '../src/cdb';
(async () => {
  const P = 'E:/Dropbox/FAUSTO/SVILUPPI/MSX/CODE/C/MSXgl/projects/sampradv_dbg/out/sampradv';
  const di = DebugInfo.load(P + '.cdb');
  const m = new OpenMsx({ openmsx: 'E:/Dropbox/FAUSTO/SVILUPPI/MSX/EMULATORI/openMSX/openmsx.exe', machine: 'Sony_HB-55P', rom: P + '.rom', extraArgs: [], staticTcl: di.staticTcl(new Set(['sampradv.c'])) });
  await m.start(); const T0 = Date.now(); m.on('exit', () => console.log('EXIT after', Date.now() - T0, 'ms', m.exitInfo));
  await m.exec('debug set_bp 27170'); m.breaked = false; await m.exec('dbg_cont');
  await new Promise(r => setTimeout(r, 1500)); for (let i = 0; i < 80 && Number(await m.exec('reg PC')) !== 27170; i++) { await m.exec('keymatrixdown 7 0x80; keymatrixdown 8 0x01'); await new Promise(r => setTimeout(r, 150)); await m.exec('keymatrixup 7 0x80; keymatrixup 8 0x01'); await new Promise(r => setTimeout(r, 400)); }
  const r = await m.regs(); console.log('regs', Object.entries(r).map(([k, v]) => k + '=' + v.toString(16)).join(' '));
  const st = await m.readMem(r.SP, 64);
  for (let k = 0; k + 1 < 64; k += 2) { const w = st[k] | (st[k + 1] << 8); const f = di.funcAt(w); console.log(`SP+${k}: ${w.toString(16).padStart(4, '0')}  ${f ? f.name + '+' + (w - f.start) : ''}`); }
  console.log('ShowMenu', di.funcByNameGet('ShowMenu'), 'main', di.funcByNameGet('main'));
  m.kill(); setTimeout(() => process.exit(0), 1000);
})();
