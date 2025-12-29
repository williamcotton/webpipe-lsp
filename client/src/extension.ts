import * as path from 'node:path';
import * as vscode from 'vscode';
import * as net from 'node:net';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind
} from 'vscode-languageclient/node';

let client: LanguageClient | undefined;

export function activate(context: vscode.ExtensionContext) {
  const serverModule = context.asAbsolutePath(path.join('server', 'out', 'server.js'));

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: { execArgv: ['--nolazy', '--inspect=6009'] }
    }
  };

  // Create an output channel for the language server
  const outputChannel = vscode.window.createOutputChannel('Web Pipe Language Server');
  outputChannel.appendLine('Web Pipe Language Server starting...');

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', language: 'webpipe' }],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher('**/*.wp')
    },
    outputChannel: outputChannel
  };

  client = new LanguageClient(
    'webpipeLanguageServer',
    'Web Pipe Language Server',
    serverOptions,
    clientOptions
  );

  context.subscriptions.push(client);
  client.start();

  // Command to show references when clicking code lenses, converting to VS Code types
  const showRefs = vscode.commands.registerCommand('webpipe.showReferences', async (uri: string, posLike: any, locationsLike: Array<any>) => {
    try {
      const docUri = vscode.Uri.parse(uri);
      const position = new vscode.Position(posLike.line, posLike.character);
      const locations = (locationsLike || []).map(loc => new vscode.Location(vscode.Uri.parse(loc.uri), new vscode.Range(
        new vscode.Position(loc.range.start.line, loc.range.start.character),
        new vscode.Position(loc.range.end.line, loc.range.end.character)
      )));
      await vscode.commands.executeCommand('editor.action.showReferences', docUri, position, locations);
    } catch (e) {
      console.error('webpipe.showReferences error', e);
    }
  });
  context.subscriptions.push(showRefs);

  // Command to extract pipeline with custom name
  const extractPipeline = vscode.commands.registerCommand('webpipe.extractPipeline', async (uri: string, rangeLike: any) => {
    try {
      const pipelineName = await vscode.window.showInputBox({
        prompt: 'Enter a name for the new pipeline',
        value: 'newPipeline',
        validateInput: (value) => {
          if (!value || !/^[A-Za-z_][\w-]*$/.test(value)) {
            return 'Pipeline name must start with a letter or underscore and contain only letters, numbers, underscores, and hyphens';
          }
          return null;
        }
      });

      if (!pipelineName) {
        return; // User cancelled
      }

      // Send the pipeline name back to the server to perform the extraction
      await client?.sendRequest('webpipe/extractPipeline', {
        uri,
        range: rangeLike,
        pipelineName
      });
    } catch (e) {
      console.error('webpipe.extractPipeline error', e);
    }
  });
  context.subscriptions.push(extractPipeline);

  // Register debug adapter
  const provider = new WebPipeDebugConfigurationProvider();
  context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('webpipe', provider));

  const factory = new WebPipeDebugAdapterDescriptorFactory();
  context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('webpipe', factory));

  // Clean up debug processes when session ends
  context.subscriptions.push(vscode.debug.onDidTerminateDebugSession(session => {
    if (session.type === 'webpipe') {
      factory.dispose();
    }
  }));
}

export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }
  return client.stop();
}

/**
 * Debug configuration provider - provides default configuration and resolves variables
 */
class WebPipeDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
  /**
   * Provide initial debug configurations (when user creates launch.json)
   */
  provideDebugConfigurations(folder: vscode.WorkspaceFolder | undefined): vscode.ProviderResult<vscode.DebugConfiguration[]> {
    return [
      {
        type: 'webpipe',
        request: 'launch',
        name: 'Debug Web Pipe',
        program: '${file}',
        port: 7770,
        debugPort: 5858,
        stopOnEntry: false
      }
    ];
  }

  /**
   * Resolve configuration before launching debugger
   */
  resolveDebugConfiguration(
    folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
    token?: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.DebugConfiguration> {
    // If no configuration provided, use defaults
    if (!config.type && !config.request && !config.name) {
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document.languageId === 'webpipe') {
        config.type = 'webpipe';
        config.request = 'launch';
        config.name = 'Debug Web Pipe';
        config.program = '${file}';
        config.port = 7770;
        config.debugPort = 5858;
        config.stopOnEntry = false;
      }
    }

    // Ensure program is set
    if (!config.program) {
      return vscode.window.showErrorMessage('Cannot find a .wp file to debug').then(_ => undefined);
    }

    // Set defaults for optional fields
    config.port = config.port || 7770;
    config.debugPort = config.debugPort || 5858;
    config.stopOnEntry = config.stopOnEntry || false;

    return config;
  }
}

/**
 * Debug adapter descriptor factory - creates the debug adapter connection
 */
class WebPipeDebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
  private debugProcess: any = null;

  createDebugAdapterDescriptor(
    session: vscode.DebugSession,
    executable: vscode.DebugAdapterExecutable | undefined
  ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    const config = session.configuration;
    const program = config.program;
    const port = config.port || 7770;
    const debugPort = config.debugPort || 5858;

    // Find webpipe binary
    const webpipePath = this.findWebpipe();
    if (!webpipePath) {
      vscode.window.showErrorMessage('Cannot find webpipe binary. Please ensure webpipe is installed with the debugger feature enabled (cargo build --features debugger).');
      return undefined;
    }

    // Kill any existing process before spawning a new one
    this.dispose();

    // Launch webpipe process in inspect mode
    const spawn = require('child_process').spawn;
    this.debugProcess = spawn(webpipePath, [
      program,
      '--inspect',
      '--port', port.toString(),
      '--inspect-port', debugPort.toString()
    ], {
      cwd: path.dirname(program),
      env: { ...process.env }
    });

    // Log output for debugging
    this.debugProcess.stdout?.on('data', (data: Buffer) => {
      console.log(`[webpipe] ${data.toString()}`);
    });

    this.debugProcess.stderr?.on('data', (data: Buffer) => {
      console.error(`[webpipe] ${data.toString()}`);
    });

    this.debugProcess.on('exit', (code: number) => {
      console.log(`[webpipe] Process exited with code ${code}`);
    });

    // Wait a moment for the DAP server to start, then connect
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve(new vscode.DebugAdapterServer(debugPort, '127.0.0.1'));
      }, 1000);
    });
  }

  dispose() {
    if (this.debugProcess) {
      const processToKill = this.debugProcess;
      this.debugProcess = null;

      try {
        // Try graceful shutdown first (SIGTERM)
        processToKill.kill('SIGTERM');

        // Force kill after 1 second if still running
        setTimeout(() => {
          try {
            if (!processToKill.killed) {
              processToKill.kill('SIGKILL');
            }
          } catch (e) {
            // Process might have already exited
          }
        }, 1000);
      } catch (e) {
        console.error('[webpipe-dap] Error killing process:', e);
      }
    }
  }

  /**
   * Find webpipe binary in common locations
   */
  private findWebpipe(): string | null {
    const { execSync } = require('child_process');

    try {
      // Try to find in PATH using 'which' (Unix) or 'where' (Windows)
      const command = process.platform === 'win32' ? 'where' : 'which';
      const result = execSync(`${command} webpipe`, { encoding: 'utf8' }).trim();
      if (result) {
        return result.split('\n')[0]; // First result if multiple
      }
    } catch (e) {
      // Not in PATH
    }

    // Try common development locations relative to workspace
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      const candidates = [
        path.join(workspaceFolder.uri.fsPath, 'webpipe', 'target', 'debug', 'webpipe'),
        path.join(workspaceFolder.uri.fsPath, 'webpipe', 'target', 'release', 'webpipe'),
        path.join(workspaceFolder.uri.fsPath, 'target', 'debug', 'webpipe'),
        path.join(workspaceFolder.uri.fsPath, 'target', 'release', 'webpipe'),
      ];

      for (const candidate of candidates) {
        try {
          const fs = require('fs');
          if (fs.existsSync(candidate)) {
            return candidate;
          }
        } catch (e) {
          // Continue to next candidate
        }
      }
    }

    return null;
  }
}

