import * as vscode from 'vscode';
import * as path from 'path';
import { MsxSession } from './adapter';

class Factory implements vscode.DebugAdapterDescriptorFactory {
  createDebugAdapterDescriptor(): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    return new vscode.DebugAdapterInlineImplementation(new MsxSession() as unknown as vscode.DebugAdapter);
  }
}

class ConfigProvider implements vscode.DebugConfigurationProvider {
  constructor(private ctx: vscode.ExtensionContext) {}
  resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, cfg: vscode.DebugConfiguration): vscode.ProviderResult<vscode.DebugConfiguration> {
    const s = vscode.workspace.getConfiguration('msxglDebugger');
    if (!cfg.type) {
      const name = folder ? path.basename(folder.uri.fsPath) : 'project';
      cfg = { type: 'msxgl', request: 'launch', name: 'MSXgl: debug', rom: `\${workspaceFolder}/out/${name}.rom`, debugMode: 'normal' };
    }
    cfg.openmsx = cfg.openmsx ?? s.get<string>('openmsxPath') ?? 'openmsx.exe';
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
