// "Full" mode: build a COPY of the project in which every local/parameter that SDCC would keep in a register
// (or drop) is declared volatile, so that the debugger can always read it from the stack.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';

export interface FullCfg {
  rom: string;
  projectDir?: string;
  module?: string;
  autovolScript?: string;
  pythonPath?: string;
  engineBuild?: string;
  workDir?: string;      // where the volatile copy is built (default: system temp, outside Dropbox/OneDrive)
}

function newestMtime(dir: string): number {
  let m = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (/^(out|\.git|\.vscode|node_modules)$/i.test(e.name) || e.name.startsWith('autovol_') || e.name.endsWith('.orig')) continue;
    const p = path.join(dir, e.name);
    m = Math.max(m, e.isDirectory() ? newestMtime(p) : fs.statSync(p).mtimeMs);
  }
  return m;
}

function run(cmd: string, args: string[], cwd: string, log: (m: string) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, windowsHide: true });
    const out = (d: Buffer) => d.toString().split(/\r?\n/).filter(Boolean).forEach((l) => log('  ' + l));
    p.stdout.on('data', out); p.stderr.on('data', out);
    p.on('error', reject);
    p.on('exit', (c) => resolve(c ?? -1));
  });
}

export async function prepareFullBuild(cfg: FullCfg, log: (m: string) => void): Promise<{ rom: string; cdb: string; dir: string }> {
  if (!cfg.projectDir) throw new Error('debugMode "full" needs "projectDir" in the launch configuration');
  const proj = path.resolve(cfg.projectDir);
  const mod = cfg.module ?? path.basename(cfg.rom).replace(/\.rom$/i, '');
  if (!fs.existsSync(path.join(proj, mod + '.c'))) throw new Error(`${mod}.c not found in ${proj} (set "module")`);
  // The MSXgl build renames files between the engine folder and the project, so the copy must live on the SAME drive
  // as the engine, and its path must be short (the SDCC link command line is limited to 8191 characters).
  let copy = cfg.workDir ? path.resolve(cfg.workDir) : path.join(path.parse(proj).root, 'msxdbg', path.basename(proj));
  try { fs.mkdirSync(path.dirname(copy), { recursive: true }); }
  catch { copy = path.join(os.tmpdir(), 'msxdbg', path.basename(proj)); fs.mkdirSync(path.dirname(copy), { recursive: true }); }
  const romName = path.basename(cfg.rom);
  const outRom = path.join(copy, 'out', romName);
  const outCdb = outRom.replace(/\.rom$/i, '.cdb');
  const stamp = path.join(copy, 'autovol_done.txt');

  const srcTime = newestMtime(proj);
  if (fs.existsSync(stamp) && fs.existsSync(outRom) && fs.existsSync(outCdb) && fs.statSync(stamp).mtimeMs > srcTime) {
    log('Full mode: the volatile build is up to date, reusing it.');
    return { rom: outRom, cdb: outCdb, dir: copy };
  }
  log(`Full mode: preparing ${copy}`);
  // keep what autovol already learned (which variables need volatile): a rebuild after an edit then needs 1-2 builds instead of 4-6
  const keep: { name: string; data: string }[] = [];
  if (fs.existsSync(copy)) {
    for (const f of fs.readdirSync(copy)) if (/^autovol_(state|params)_.*\.json$/.test(f)) keep.push({ name: f, data: fs.readFileSync(path.join(copy, f), 'utf8') });
  }
  fs.rmSync(copy, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  fs.cpSync(proj, copy, {
    recursive: true,
    filter: (s) => !/[\\/](out|\.git|\.vscode|node_modules)([\\/]|$)|autovol_[^\\/]*$|\.orig$/i.test(s.slice(proj.length)),
  });
  for (const k of keep) fs.writeFileSync(path.join(copy, k.name), k.data);
  const cfgFile = path.join(copy, 'project_config.js');
  if (fs.existsSync(cfgFile)) {
    let t = fs.readFileSync(cfgFile, 'utf8');
    t += '\n// --- added by msxgl-debugger (full mode) ---\nDebug = true;\nDoRun = false;\n';
    fs.writeFileSync(cfgFile, t);
  }
  const nModules = fs.readdirSync(copy).filter((f) => f.endsWith('.c')).length;
  const script = cfg.autovolScript ?? path.join(__dirname, '..', 'tools', 'autovol.py');
  const engineBuild = cfg.engineBuild ?? path.resolve(proj, '..', '..', 'engine', 'script', 'js', 'build.js');
  const code = await run(cfg.pythonPath ?? 'python', [script, copy, mod, '--iterate', String(nModules > 20 ? 2 : 6), '--engine-build', engineBuild], copy, log);
  if (code !== 0) throw new Error(`autovol failed (exit ${code}); see ${path.join(copy, 'autovol_build.log')}. If the log ends with "Link error" and the project has many modules, the Windows command line (8191 chars) is exceeded: set a shorter "workDir" (e.g. C:/msxdbg/name).`);
  if (!fs.existsSync(outRom)) throw new Error('the full-mode build did not produce ' + outRom);
  fs.writeFileSync(stamp, new Date().toISOString());
  return { rom: outRom, cdb: outCdb, dir: copy };
}
