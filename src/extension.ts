import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { MsxSession } from './adapter';

class Factory implements vscode.DebugAdapterDescriptorFactory {
  createDebugAdapterDescriptor(): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    return new vscode.DebugAdapterInlineImplementation(new MsxSession() as unknown as vscode.DebugAdapter);
  }
}

/** a bare name is looked up in PATH and in the usual install folders, so the default setting works out of the box */
function findOpenMsx(name: string): string {
  if (path.isAbsolute(name) || /[\/]/.test(name)) return name;
  const exts = name.toLowerCase().endsWith('.exe') ? [''] : ['', '.exe'];
  const dirs = (process.env.PATH ?? '').split(path.delimiter);
  for (const r of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')])
    if (r) dirs.push(path.join(r, 'openMSX'));
  for (const d of dirs) for (const e of exts) { const f = path.join(d, name + e); try { if (d && fs.statSync(f).isFile()) return f; } catch { /* next */ } }
  return name;
}

class ConfigProvider implements vscode.DebugConfigurationProvider {
  constructor(private ctx: vscode.ExtensionContext) {}
  resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, cfg: vscode.DebugConfiguration): vscode.ProviderResult<vscode.DebugConfiguration> {
    const s = vscode.workspace.getConfiguration('msxglDebugger');
    if (!cfg.type) {
      const name = folder ? path.basename(folder.uri.fsPath) : 'project';
      cfg = { type: 'msxgl', request: 'launch', name: 'MSXgl: debug', rom: `\${workspaceFolder}/out/${name}.rom`, debugMode: 'normal' };
    }
    cfg.openmsx = findOpenMsx(cfg.openmsx ?? s.get<string>('openmsxPath') ?? 'openmsx.exe');
    cfg.pythonPath = cfg.pythonPath ?? s.get<string>('pythonPath') ?? 'python';
    cfg.autovolScript = path.join(this.ctx.extensionPath, 'tools', 'autovol.py');
    return cfg;
  }
}

export function activate(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory('msxgl', new Factory()),
    vscode.debug.registerDebugConfigurationProvider('msxgl', new ConfigProvider(ctx)),
    vscode.commands.registerCommand('msxgl.debugNormal', () => vscode.debug.startDebugging(undefined, { type: 'msxgl', request: 'launch', name: 'MSXgl: normal', debugMode: 'normal', rom: '${workspaceFolder}/out/${workspaceFolderBasename}.rom' })),
    vscode.commands.registerCommand('msxgl.debugFull', () => vscode.debug.startDebugging(undefined, { type: 'msxgl', request: 'launch', name: 'MSXgl: full', debugMode: 'full', projectDir: '${workspaceFolder}', rom: '${workspaceFolder}/out/${workspaceFolderBasename}.rom' })),
  );
}
export function deactivate() {}
