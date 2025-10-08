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
import { DocumentCache } from './document-cache';

const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

// Initialize document cache
const documentCache = new DocumentCache();

// Initialize providers with cache
const documentValidator = new DocumentValidator(connection, documentCache);
const completionProvider = new CompletionProvider(documentCache);
const languageProviders = new LanguageProviders(documentCache);
const uiProviders = new UIProviders(documentCache);

connection.onInitialize((_params: InitializeParams): InitializeResult => {
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: { triggerCharacters: [':', ' ', '\t', '>'] },
      codeLensProvider: { resolveProvider: false },
      documentHighlightProvider: true,
      hoverProvider: true,
      referencesProvider: true,
      definitionProvider: true,
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

connection.onInitialized(() => {
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

// Clean up cache when document is closed
documents.onDidClose((event) => {
  documentCache.invalidate(event.document.uri);
});

// Start the server
documents.listen(connection);
connection.listen();