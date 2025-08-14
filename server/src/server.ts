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

const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

// Initialize providers
const documentValidator = new DocumentValidator(connection);
const completionProvider = new CompletionProvider();
const languageProviders = new LanguageProviders();
const uiProviders = new UIProviders();

// Convert TextDocuments to Map for provider compatibility
function getDocumentMap(): Map<string, TextDocument> {
  const docMap = new Map<string, TextDocument>();
  for (const doc of documents.all()) {
    docMap.set(doc.uri, doc);
  }
  return docMap;
}

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
  return completionProvider.onCompletion(params, getDocumentMap());
});

connection.onReferences((params) => {
  return languageProviders.onReferences(params, getDocumentMap());
});

connection.onHover((params) => {
  return languageProviders.onHover(params, getDocumentMap());
});

connection.onDefinition((params) => {
  return languageProviders.onDefinition(params, getDocumentMap());
});

connection.onCodeLens((params) => {
  return uiProviders.onCodeLens(params, getDocumentMap());
});

connection.onDocumentHighlight((params) => {
  return uiProviders.onDocumentHighlight(params, getDocumentMap());
});

// Start the server
documents.listen(connection);
connection.listen();