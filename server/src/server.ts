import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  TextDocumentSyncKind,
  InitializeResult
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { DocumentValidator } from './validation';
import { CompletionProvider } from './completion-provider';
import { LanguageProviders } from './language-providers';
import { UIProviders } from './ui-providers';
import { WorkspaceManager } from './workspace-manager';
import { FormattingProvider } from './formatting-provider';

const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

// WorkspaceManager will be initialized in onInitialize
let workspaceManager: WorkspaceManager;
let documentValidator: DocumentValidator;
let completionProvider: CompletionProvider;
let languageProviders: LanguageProviders;
let uiProviders: UIProviders;
let formattingProvider: FormattingProvider;

connection.onInitialize((params: InitializeParams): InitializeResult => {
  // Extract workspace root from initialization params
  const workspaceRoot = params.workspaceFolders?.[0]?.uri || '';

  // Initialize workspace manager with multi-file support
  workspaceManager = new WorkspaceManager(connection, documents, workspaceRoot);

  // Initialize providers with workspace manager
  documentValidator = new DocumentValidator(connection, workspaceManager);
  completionProvider = new CompletionProvider(workspaceManager);
  languageProviders = new LanguageProviders(workspaceManager, connection);
  uiProviders = new UIProviders(workspaceManager);
  formattingProvider = new FormattingProvider(workspaceManager);

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: { triggerCharacters: [':', ' ', '\t', '>'] },
      codeLensProvider: { resolveProvider: false },
      documentHighlightProvider: true,
      hoverProvider: true,
      referencesProvider: true,
      definitionProvider: true,
      renameProvider: true,
      codeActionProvider: true,
      documentFormattingProvider: true,
    }
  };
});

// Document event handlers
documents.onDidChangeContent(async change => {
  await documentValidator.validateDocument(change.document);
});

documents.onDidOpen(async open => {
  await documentValidator.validateDocument(open.document);
});

connection.onInitialized(async () => {
  // Initialize file system watching
  await workspaceManager.initialize();

  // Validate all open documents once the server is ready
  for (const doc of documents.all()) {
    documentValidator.validateDocument(doc);
  }
});

// Language server provider handlers
connection.onCompletion((params) => {
  const doc = documents.get(params.textDocument.uri);
  return doc ? completionProvider.onCompletion(params, doc) : [];
});

connection.onReferences((params) => {
  const doc = documents.get(params.textDocument.uri);
  return doc ? languageProviders.onReferences(params, doc) : null;
});

connection.onHover((params) => {
  const doc = documents.get(params.textDocument.uri);
  return doc ? languageProviders.onHover(params, doc) : null;
});

connection.onDefinition((params) => {
  const doc = documents.get(params.textDocument.uri);
  return doc ? languageProviders.onDefinition(params, doc) : null;
});

connection.onCodeLens((params) => {
  const doc = documents.get(params.textDocument.uri);
  return doc ? uiProviders.onCodeLens(params, doc) : [];
});

connection.onDocumentHighlight((params) => {
  const doc = documents.get(params.textDocument.uri);
  return doc ? uiProviders.onDocumentHighlight(params, doc) : null;
});

connection.onRenameRequest((params) => {
  const doc = documents.get(params.textDocument.uri);
  return doc ? languageProviders.onRename(params, doc) : null;
});

connection.onCodeAction((params) => {
  const doc = documents.get(params.textDocument.uri);
  return doc ? uiProviders.onCodeAction(params, doc) : [];
});

connection.onDocumentFormatting((params) => {
  const doc = documents.get(params.textDocument.uri);
  return doc ? formattingProvider.onFormatting(params, doc) : [];
});

connection.onRequest('webpipe/extractPipeline', (params: { uri: string; range: any; pipelineName: string }) => {
  const doc = documents.get(params.uri);
  if (!doc) return;

  const edit = uiProviders.createExtractPipelineEdit(params.range, params.pipelineName, doc);
  if (edit) {
    connection.workspace.applyEdit(edit);
  }
});

// Clean up cache when document is closed
documents.onDidClose((event) => {
  workspaceManager.invalidate(event.document.uri);
});

// Start the server
documents.listen(connection);
connection.listen();