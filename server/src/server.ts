import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  TextDocumentSyncKind,
  InitializeResult,
  Diagnostic,
  DiagnosticSeverity
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

connection.onInitialize((_params: InitializeParams): InitializeResult => {
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      // Completions, hovers, etc. can be added over time
    }
  };
});

async function validateDocument(doc: TextDocument) {
  const text = doc.getText();
  const diagnostics: Diagnostic[] = [];

  // Rule 1: trailing newline warning
  if (text.length > 0 && !text.endsWith('\n')) {
    diagnostics.push({
      severity: DiagnosticSeverity.Warning,
      range: {
        start: doc.positionAt(Math.max(0, text.length - 1)),
        end: doc.positionAt(text.length)
      },
      message: 'File does not end with a newline',
      source: 'webpipe-lsp'
    });
  }

  // Rule 2: unknown variable references in steps and unknown pipeline references
  try {
    // Collect declared variables: <type> <name> = `...`
    const varDeclRe = /(^|\n)\s*([A-Za-z_][\w-]*)\s+([A-Za-z_][\w-]*)\s*=\s*`[\s\S]*?`/g;
    const variablesByType = new Map<string, Set<string>>();
    for (let m; (m = varDeclRe.exec(text)); ) {
      const varType = m[2];
      const varName = m[3];
      if (!variablesByType.has(varType)) variablesByType.set(varType, new Set());
      variablesByType.get(varType)!.add(varName);
    }

    // Collect named pipelines: pipeline <name> =
    const pipeDeclRe = /(^|\n)\s*pipeline\s+([A-Za-z_][\w-]*)\s*=/g;
    const pipelineNames = new Set<string>();
    for (let m; (m = pipeDeclRe.exec(text)); ) {
      pipelineNames.add(m[2]);
    }

    // Step references: |> <stepName>: <config>
    // If config is bare identifier (not starting with ` or ") then validate variable reference for that step type
    const stepRefRe = /(^|\n)\s*\|>\s*([A-Za-z_][\w-]*)\s*:\s*([^\s\n`"].*?)(?=\n|$)/g;
    for (let m; (m = stepRefRe.exec(text)); ) {
      const stepName = m[2];
      const configText = m[3].trim();
      // Ignore pipeline: it has its own check
      if (stepName === 'pipeline') continue;
      // Only treat as variable reference if it's a single identifier without spaces
      const identMatch = /^(?<id>[A-Za-z_][\w-]*)$/.exec(configText);
      if (!identMatch) continue;
      const id = identMatch.groups!.id;
      const declared = variablesByType.get(stepName);
      if (!declared || !declared.has(id)) {
        // underline the identifier occurrence
        const idStart = m.index + m[0].lastIndexOf(id);
        const idEnd = idStart + id.length;
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          range: { start: doc.positionAt(idStart), end: doc.positionAt(idEnd) },
          message: `Unknown ${stepName} variable: ${id}`,
          source: 'webpipe-lsp'
        });
      }
    }

    // Pipeline references: |> pipeline: <name>
    const pipeRefRe = /(^|\n)\s*\|>\s*pipeline:\s*([A-Za-z_][\w-]*)/g;
    for (let m; (m = pipeRefRe.exec(text)); ) {
      const name = m[2];
      if (!pipelineNames.has(name)) {
        const nameStart = m.index + m[0].lastIndexOf(name);
        const nameEnd = nameStart + name.length;
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          range: { start: doc.positionAt(nameStart), end: doc.positionAt(nameEnd) },
          message: `Unknown pipeline: ${name}`,
          source: 'webpipe-lsp'
        });
      }
    }

    // BDD: when executing pipeline <name>
    const whenExecPipelineRe = /(^|\n)\s*when\s+executing\s+pipeline\s+([A-Za-z_][\w-]*)/g;
    for (let m; (m = whenExecPipelineRe.exec(text)); ) {
      const name = m[2];
      if (!pipelineNames.has(name)) {
        const nameStart = m.index + m[0].lastIndexOf(name);
        const nameEnd = nameStart + name.length;
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          range: { start: doc.positionAt(nameStart), end: doc.positionAt(nameEnd) },
          message: `Unknown pipeline: ${name}`,
          source: 'webpipe-lsp'
        });
      }
    }

    // BDD: when executing variable <type> <name>
    const whenExecVarRe = /(^|\n)\s*when\s+executing\s+variable\s+([A-Za-z_][\w-]*)\s+([A-Za-z_][\w-]*)/g;
    for (let m; (m = whenExecVarRe.exec(text)); ) {
      const varType = m[2];
      const varName = m[3];
      const declared = variablesByType.get(varType);
      if (!declared || !declared.has(varName)) {
        const nameStart = m.index + m[0].lastIndexOf(varName);
        const nameEnd = nameStart + varName.length;
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          range: { start: doc.positionAt(nameStart), end: doc.positionAt(nameEnd) },
          message: `Unknown ${varType} variable: ${varName}`,
          source: 'webpipe-lsp'
        });
      }
    }

    // BDD: with/and mock pipeline <name> returning ...
    const mockPipelineRe = /(^|\n)\s*(?:with|and)\s+mock\s+pipeline\s+([A-Za-z_][\w-]*)\s+returning\s+`/g;
    for (let m; (m = mockPipelineRe.exec(text)); ) {
      const name = m[2];
      if (!pipelineNames.has(name)) {
        const nameStart = m.index + m[0].lastIndexOf(name);
        const nameEnd = nameStart + name.length;
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          range: { start: doc.positionAt(nameStart), end: doc.positionAt(nameEnd) },
          message: `Unknown pipeline in mock: ${name}`,
          source: 'webpipe-lsp'
        });
      }
    }

    // BDD: with/and mock <type>.<name> returning ...
    const mockVarRe = /(^|\n)\s*(?:with|and)\s+mock\s+([A-Za-z_][\w-]*)\.([A-Za-z_][\w-]*)\s+returning\s+`/g;
    for (let m; (m = mockVarRe.exec(text)); ) {
      const varType = m[2];
      const varName = m[3];
      const declared = variablesByType.get(varType);
      if (!declared || !declared.has(varName)) {
        const nameStart = m.index + m[0].lastIndexOf(varName);
        const nameEnd = nameStart + varName.length;
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          range: { start: doc.positionAt(nameStart), end: doc.positionAt(nameEnd) },
          message: `Unknown ${varType} variable in mock: ${varName}`,
          source: 'webpipe-lsp'
        });
      }
    }
  } catch (_e) {
    // best-effort; avoid crashing diagnostics on regex issues
  }

  connection.sendDiagnostics({ uri: doc.uri, diagnostics });
}

documents.onDidChangeContent(async change => {
  await validateDocument(change.document);
});

documents.onDidOpen(async open => {
  await validateDocument(open.document);
});

connection.onInitialized(() => {
  // Validate all open documents once the server is ready
  for (const doc of documents.all()) {
    validateDocument(doc);
  }
});

documents.listen(connection);
connection.listen();


