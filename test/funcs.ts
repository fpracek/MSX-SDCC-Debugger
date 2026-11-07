import { DebugInfo } from '../src/cdb';
const di = DebugInfo.load(process.argv[2]);
for (const n of ['main','ShowMenu','PrintStringAt','PrintTileAt']) { const f = di.funcByNameGet(n)!; console.log(n, f.start.toString(16), f.end.toString(16)); }
for (const w of process.argv.slice(3)) { const a = parseInt(w, 16); const f = di.funcAt(a); console.log(w, f ? f.name + '+' + (a - f.start) : '-', di.symbolAt(a) ?? ''); }
