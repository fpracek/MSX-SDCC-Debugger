import { OpenMsx } from '../src/bridge';
import { DebugInfo } from '../src/cdb';
(async () => {
  const di = DebugInfo.load('E:/Dropbox/FAUSTO/SVILUPPI/MSX/CODE/C/MSXgl/projects/sampradv_dbg/out/sampradv.cdb');
  const m = new OpenMsx({ openmsx: 'E:/Dropbox/FAUSTO/SVILUPPI/MSX/EMULATORI/openMSX/openmsx.exe', machine: 'Sony_HB-55P', rom: 'E:/Dropbox/FAUSTO/SVILUPPI/MSX/CODE/C/MSXgl/projects/sampradv_dbg/out/sampradv.rom', extraArgs: [], staticTcl: di.staticTcl(new Set(['sampradv.c'])) });
  m.on('break', (pc) => console.log('EVENT break', pc));
  await m.start(); console.log('started, breaked=', m.breaked, await m.exec('debug breaked'));
  console.log('regs', JSON.stringify(await m.regs()));
  console.log('set_bp ->', await m.exec('debug set_bp 27170'));
  m.breaked = false; console.log('cont ->', await m.exec('dbg_cont'));
  await new Promise(r => setTimeout(r, 3000));
  console.log('after 3s: breaked', await m.exec('debug breaked'), 'PC', await m.exec('reg PC'));
  for (let i = 0; i < 30; i++) {
    await m.exec('keymatrixdown 7 0x80; keymatrixdown 8 0x01'); await new Promise(r => setTimeout(r, 150));
    await m.exec('keymatrixup 7 0x80; keymatrixup 8 0x01'); await new Promise(r => setTimeout(r, 400));
    if (m.breaked) break;
  }
  console.log('end: breaked', m.breaked, await m.exec('debug breaked'), 'PC', await m.exec('reg PC'));
  m.kill(); setTimeout(() => process.exit(0), 1000);
})().catch((e) => { console.log('FAIL', e.message); process.exit(1); });
