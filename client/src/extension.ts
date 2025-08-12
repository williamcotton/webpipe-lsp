import * as path from 'node:path';
import * as vscode from 'vscode';
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

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', language: 'webpipe' }],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher('**/*.wp')
    }
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
}

export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }
  return client.stop();
}


