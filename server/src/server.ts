import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  TextDocumentSyncKind,
  InitializeResult,
  Diagnostic,
  DiagnosticSeverity,
  CompletionItem,
  CompletionItemKind,
  Position,
  Location,
  CodeLens,
  DocumentHighlight,
  DocumentHighlightKind
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

connection.onInitialize((_params: InitializeParams): InitializeResult => {
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: { triggerCharacters: [':', ' ', '\t'] },
      codeLensProvider: { resolveProvider: false },
      documentHighlightProvider: true,
      referencesProvider: true,
      definitionProvider: true,
      // Additional features (hovers, etc.) can be added over time
    }
  };
});

function collectVariablesAndPipelines(text: string): {
  variablesByType: Map<string, Set<string>>;
  pipelineNames: Set<string>;
} {
  // Variables: <type> <name> = `...`
  const varDeclRe = /(^|\n)\s*([A-Za-z_][\w-]*)\s+([A-Za-z_][\w-]*)\s*=\s*`[\s\S]*?`/g;
  const variablesByType = new Map<string, Set<string>>();
  for (let m; (m = varDeclRe.exec(text)); ) {
    const varType = m[2];
    const varName = m[3];
    if (!variablesByType.has(varType)) variablesByType.set(varType, new Set());
    variablesByType.get(varType)!.add(varName);
  }

  // Pipelines: pipeline <name> =
  const pipeDeclRe = /(^|\n)\s*pipeline\s+([A-Za-z_][\w-]*)\s*=/g;
  const pipelineNames = new Set<string>();
  for (let m; (m = pipeDeclRe.exec(text)); ) {
    pipelineNames.add(m[2]);
  }

  return { variablesByType, pipelineNames };
}

function collectDeclarationPositions(text: string): {
  variablePositions: Map<string, { start: number; length: number }>;
  pipelinePositions: Map<string, { start: number; length: number }>;
} {
  const variablePositions = new Map<string, { start: number; length: number }>();
  const varDeclRe = /(^|\n)\s*([A-Za-z_][\w-]*)\s+([A-Za-z_][\w-]*)\s*=\s*`[\s\S]*?`/g;
  for (let m; (m = varDeclRe.exec(text)); ) {
    const varType = m[2];
    const varName = m[3];
    const nameStart = m.index + m[0].lastIndexOf(varName);
    variablePositions.set(`${varType}::${varName}`, { start: nameStart, length: varName.length });
  }

  const pipelinePositions = new Map<string, { start: number; length: number }>();
  const pipeDeclRe = /(^|\n)\s*pipeline\s+([A-Za-z_][\w-]*)\s*=/g;
  for (let m; (m = pipeDeclRe.exec(text)); ) {
    const name = m[2];
    const nameStart = m.index + m[0].lastIndexOf(name);
    pipelinePositions.set(name, { start: nameStart, length: name.length });
  }

  return { variablePositions, pipelinePositions };
}

function getWordAt(text: string, offset: number): { word: string; start: number; end: number } | null {
  const isWordChar = (ch: string) => /[A-Za-z0-9_-]/.test(ch);
  let start = offset;
  let end = offset;
  while (start > 0 && isWordChar(text[start - 1])) start--;
  while (end < text.length && isWordChar(text[end])) end++;
  if (start === end) return null;
  const word = text.slice(start, end);
  if (!/^[A-Za-z_][\w-]*$/.test(word)) return null;
  return { word, start, end };
}

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
    const push = (severity: DiagnosticSeverity, start: number, end: number, message: string) => {
      diagnostics.push({
        severity,
        range: { start: doc.positionAt(start), end: doc.positionAt(end) },
        message,
        source: 'webpipe-lsp'
      });
    };

    // Collect declared variables: <type> <name> = `...`
    const varDeclRe = /(^|\n)\s*([A-Za-z_][\w-]*)\s+([A-Za-z_][\w-]*)\s*=\s*`[\s\S]*?`/g;
    const variablesByType = new Map<string, Set<string>>();
    const varDeclSeen = new Set<string>();
    for (let m; (m = varDeclRe.exec(text)); ) {
      const varType = m[2];
      const varName = m[3];
      const key = `${varType}::${varName}`;
      if (varDeclSeen.has(key)) {
        const nameStart = m.index + m[0].lastIndexOf(varName);
        push(DiagnosticSeverity.Warning, nameStart, nameStart + varName.length, `Duplicate ${varType} variable: ${varName}`);
      }
      varDeclSeen.add(key);
      if (!variablesByType.has(varType)) variablesByType.set(varType, new Set());
      variablesByType.get(varType)!.add(varName);
    }

    // Collect named pipelines: pipeline <name> =
    const pipeDeclRe = /(^|\n)\s*pipeline\s+([A-Za-z_][\w-]*)\s*=/g;
    const pipelineNames = new Set<string>();
    const pipelineSeen = new Set<string>();
    for (let m; (m = pipeDeclRe.exec(text)); ) {
      const name = m[2];
      if (pipelineSeen.has(name)) {
        const nameStart = m.index + m[0].lastIndexOf(name);
        push(DiagnosticSeverity.Warning, nameStart, nameStart + name.length, `Duplicate pipeline: ${name}`);
      }
      pipelineSeen.add(name);
      pipelineNames.add(name);
    }

    // Collect routes: METHOD /path
    const validMethods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
    const routeDeclRe = /(^|\n)\s*([A-Z]+)\s+(\/[\S]*)/g;
    const routes = new Set<string>();
    const routePatterns: { method: string; path: string; regex: RegExp }[] = [];
    for (let m; (m = routeDeclRe.exec(text)); ) {
      const method = m[2];
      const path = (m[3] || '').trim();
      if (!validMethods.has(method)) {
        const methodStart = m.index + m[0].indexOf(method);
        push(DiagnosticSeverity.Error, methodStart, methodStart + method.length, `Unknown HTTP method: ${method}`);
        continue;
      }
      const key = `${method} ${path}`;
      if (routes.has(key)) {
        const pathStart = m.index + m[0].lastIndexOf(path);
        push(DiagnosticSeverity.Warning, pathStart, pathStart + path.length, `Duplicate route: ${key}`);
      }
      routes.add(key);

      // Build a matching regex for calls, converting :param to [^/]+ and escaping other chars
      const pattern = '^' + path
        .replace(/[.*+?^${}()|[\]\\]/g, (ch) => `\\${ch}`) // escape regex meta
        .replace(/:(?:[A-Za-z_][\w-]*)/g, '[^/]+') + '$';
      try {
        routePatterns.push({ method, path, regex: new RegExp(pattern) });
      } catch (_e) {
        // ignore bad pattern
      }
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
        const idStart = m.index + m[0].lastIndexOf(id);
        push(DiagnosticSeverity.Error, idStart, idStart + id.length, `Unknown ${stepName} variable: ${id}`);
      }
    }

    // Pipeline references: |> pipeline: <name>
    const pipeRefRe = /(^|\n)\s*\|>\s*pipeline:\s*([A-Za-z_][\w-]*)/g;
    for (let m; (m = pipeRefRe.exec(text)); ) {
      const name = m[2];
      if (!pipelineNames.has(name)) {
        const nameStart = m.index + m[0].lastIndexOf(name);
        push(DiagnosticSeverity.Error, nameStart, nameStart + name.length, `Unknown pipeline: ${name}`);
      }
    }

    // BDD: when executing pipeline <name>
    const whenExecPipelineRe = /(^|\n)\s*when\s+executing\s+pipeline\s+([A-Za-z_][\w-]*)/g;
    for (let m; (m = whenExecPipelineRe.exec(text)); ) {
      const name = m[2];
      if (!pipelineNames.has(name)) {
        const nameStart = m.index + m[0].lastIndexOf(name);
        push(DiagnosticSeverity.Error, nameStart, nameStart + name.length, `Unknown pipeline: ${name}`);
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
        push(DiagnosticSeverity.Error, nameStart, nameStart + varName.length, `Unknown ${varType} variable: ${varName}`);
      }
    }

    // BDD: with/and mock pipeline <name> returning ...
    const mockPipelineRe = /(^|\n)\s*(?:with|and)\s+mock\s+pipeline\s+([A-Za-z_][\w-]*)\s+returning\s+`/g;
    for (let m; (m = mockPipelineRe.exec(text)); ) {
      const name = m[2];
      if (!pipelineNames.has(name)) {
        const nameStart = m.index + m[0].lastIndexOf(name);
        push(DiagnosticSeverity.Error, nameStart, nameStart + name.length, `Unknown pipeline in mock: ${name}`);
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
        push(DiagnosticSeverity.Error, nameStart, nameStart + varName.length, `Unknown ${varType} variable in mock: ${varName}`);
      }
    }

    // BDD: when calling METHOD /path[?query]
    const whenCallingRe = /(^|\n)\s*when\s+calling\s+([A-Z]+)\s+([^\s\n]+)/g;
    for (let m; (m = whenCallingRe.exec(text)); ) {
      const method = m[2];
      const pathWithQuery = m[3];
      const path = pathWithQuery.split('?')[0];
      if (!validMethods.has(method)) {
        const methodStart = m.index + m[0].indexOf(method);
        push(DiagnosticSeverity.Error, methodStart, methodStart + method.length, `Unknown HTTP method: ${method}`);
        continue;
      }
      // Match against declared route patterns (support :params)
      const anyMatch = routePatterns.some(r => r.method === method && r.regex.test(path));
      if (!anyMatch) {
        const pathStart = m.index + m[0].lastIndexOf(path);
        push(DiagnosticSeverity.Error, pathStart, pathStart + path.length, `Unknown route: ${method} ${path}`);
      }
    }

    // JSON validation for with input `...`
    const withInputRe = /(^|\n)\s*with\s+input\s+`([\s\S]*?)`/g;
    for (let m; (m = withInputRe.exec(text)); ) {
      const whole = m[0];
      const content = m[2];
      try {
        JSON.parse(content);
      } catch (e) {
        const relStart = whole.indexOf(content);
        const start = m.index + relStart;
        push(DiagnosticSeverity.Error, start, start + content.length, `Invalid JSON in with input: ${(e as Error).message}`);
      }
    }
    // Head validation for with input
    const withInputHeadAny = /(^|\n)\s*with\s+input\b([^\n]*)/g;
    for (let m; (m = withInputHeadAny.exec(text)); ) {
      const lineStart = m.index + (m[1] ? m[1].length : 0);
      const head = ('with input' + m[2]).trim();
      if (!/^with\s+input\s+`/.test(head)) {
        push(DiagnosticSeverity.Error, lineStart, lineStart + head.length, 'Malformed with input syntax. Expected: with input `...`');
      }
    }

    // JSON validation for mocks: with/and mock ... returning `...`
    const mockJsonRe = /(^|\n)\s*(?:with|and)\s+mock\s+(?:pipeline\s+[A-Za-z_][\w-]*|[A-Za-z_][\w-]*\.[A-Za-z_][\w-]*|[A-Za-z_][\w-]*)\s+returning\s+`([\s\S]*?)`/g;
    for (let m; (m = mockJsonRe.exec(text)); ) {
      const whole = m[0];
      const content = m[2];
      try {
        JSON.parse(content);
      } catch (e) {
        const relStart = whole.indexOf(content);
        const start = m.index + relStart;
        push(DiagnosticSeverity.Error, start, start + content.length, `Invalid JSON in mock returning: ${(e as Error).message}`);
      }
    }

    // Validate middleware name in type-only mocks: with/and mock <type> returning `...`
    const knownMiddleware = new Set(['jq','pg','fetch','handlebars','lua','auth','cache','log','debug','validate']);
    const mockTypeOnlyRe = /(^|\n)\s*(?:with|and)\s+mock\s+([A-Za-z_][\w-]*)\s+returning\s+`/g;
    for (let m; (m = mockTypeOnlyRe.exec(text)); ) {
      const mw = m[2];
      if (mw === 'pipeline') {
        const typeStart = m.index + m[0].indexOf(mw);
        push(DiagnosticSeverity.Error, typeStart, typeStart + mw.length, 'Use "mock pipeline <name>" for pipeline mocks');
        continue;
      }
      if (!knownMiddleware.has(mw)) {
        const typeStart = m.index + m[0].indexOf(mw);
        push(DiagnosticSeverity.Warning, typeStart, typeStart + mw.length, `Unknown middleware in mock: ${mw}`);
      }
    }

    // Malformed mock head detection (spelling/structure)
    const mockHeadLineRe = /(^|\n)(\s*(with|and)\s+mock\b[^\n]*)/g;
    const mockHeadValid = /^(with|and)\s+mock\s+(?:pipeline\s+[A-Za-z_][\w-]*|[A-Za-z_][\w-]*\.[A-Za-z_][\w-]*|[A-Za-z_][\w-]*)\s+returning\s+`/;
    for (let m; (m = mockHeadLineRe.exec(text)); ) {
      const lineStart = m.index + (m[1] ? m[1].length : 0);
      const head = m[2].trim();
      if (!mockHeadValid.test(head)) {
        push(DiagnosticSeverity.Error, lineStart, lineStart + head.length, 'Malformed mock syntax. Expected: with|and mock <middleware>[.<name>] returning `...` or with|and mock pipeline <name> returning `...`');
      }
    }

    // Auth flow validation: |> auth: "flow"
    const authFlowRe = /(^|\n)\s*\|>\s*auth:\s*"([^"]*)"/g;
    for (let m; (m = authFlowRe.exec(text)); ) {
      const flow = m[2];
      const ok = flow === 'optional' || flow === 'required' || flow === 'login' || flow === 'register' || flow === 'logout' || flow.startsWith('type:');
      if (!ok) {
        const flowStart = m.index + m[0].lastIndexOf(flow);
        push(DiagnosticSeverity.Warning, flowStart, flowStart + flow.length, `Unknown auth flow: ${flow}`);
      }
    }

    // Result blocks: validate status code range and duplicate branch types per block
    const resultBlockRe = /(^|\n)\s*\|>\s*result([\s\S]*?)(?=(\n\s*\|>|\n\s*(GET|POST|PUT|PATCH|DELETE)|$))/g;
    for (let m; (m = resultBlockRe.exec(text)); ) {
      const block = m[2] || '';
      const seenTypes = new Set<string>();
      const branchRe = /\n\s*([A-Za-z_][\w-]*)\((\d{3})\):/g;
      let bm: RegExpExecArray | null;
      while ((bm = branchRe.exec(block))) {
        const type = bm[1];
        const status = parseInt(bm[2], 10);
        const typeAbsStart = m.index + bm.index + bm[0].indexOf(type);
        const statusAbsStart = m.index + bm.index + bm[0].indexOf(bm[2]);
        if (status < 100 || status > 599) {
          push(DiagnosticSeverity.Error, statusAbsStart, statusAbsStart + bm[2].length, `Invalid HTTP status code: ${status}`);
        }
        if (seenTypes.has(type)) {
          push(DiagnosticSeverity.Warning, typeAbsStart, typeAbsStart + type.length, `Duplicate result branch type: ${type}`);
        }
        seenTypes.add(type);
      }
    }

    // Assertions: status is NNN
    const statusIsRe = /(^|\n)\s*(then|and)\s+status\s+is\s+(\d{3})\b/g;
    for (let m; (m = statusIsRe.exec(text)); ) {
      const code = parseInt(m[3], 10);
      if (code < 100 || code > 599) {
        const start = m.index + m[0].lastIndexOf(m[3]);
        push(DiagnosticSeverity.Error, start, start + m[3].length, `Invalid HTTP status code: ${code}`);
      }
    }
    // Assertions: status in NNN..NNN
    const statusInRe = /(^|\n)\s*(then|and)\s+status\s+in\s+(\d{3})\.\.(\d{3})\b/g;
    for (let m; (m = statusInRe.exec(text)); ) {
      const a = parseInt(m[3], 10);
      const b = parseInt(m[4], 10);
      if (a < 100 || a > 599) {
        const start = m.index + m[0].indexOf(m[3]);
        push(DiagnosticSeverity.Error, start, start + m[3].length, `Invalid HTTP status code: ${a}`);
      }
      if (b < 100 || b > 599 || b < a) {
        const start = m.index + m[0].indexOf(m[4]);
        push(DiagnosticSeverity.Error, start, start + m[4].length, `Invalid HTTP status range end: ${b}`);
      }
    }

    // Assertions: contentType is "..."
    const ctAny = /(^|\n)\s*(then|and)\s+contentType\b([^\n]*)/g;
    for (let m; (m = ctAny.exec(text)); ) {
      const lineStart = m.index + (m[1] ? m[1].length : 0);
      const tail = m[3];
      const head = `contentType${tail}`.trim();
      if (!/^contentType\s+is\s+"[^"]+"$/.test(head)) {
        push(DiagnosticSeverity.Error, lineStart + m[0].indexOf('contentType'), lineStart + m[0].length, 'Malformed contentType assertion. Expected: then|and contentType is "<type>"');
      }
    }

    // Assertions: output [`<jq>`] (equals|contains|matches) <value>
    // Note: output can be HTML or other strings; do not attempt JSON validation here.
    const outRe = /(^|\n)\s*(then|and)\s+output(?:\s+`([\s\S]*?)`)?\s+(equals|contains|matches)\s+(`([\s\S]*?)`|"([^"\n]*)")/g;
    for (let _m; (_m = outRe.exec(text)); ) {
      // intentionally no JSON parsing
    }
    // Unknown step names (informational)
    const knownSteps = new Set(['jq','pg','fetch','handlebars','lua','auth','cache','log','debug','validate','result','pipeline']);
    const stepNameRe = /(^|\n)\s*\|>\s*([A-Za-z_][\w-]*)\s*:/g;
    for (let m; (m = stepNameRe.exec(text)); ) {
      const step = m[2];
      if (!knownSteps.has(step)) {
        const stepStart = m.index + m[0].indexOf(step);
        push(DiagnosticSeverity.Information, stepStart, stepStart + step.length, `Unknown step '${step}'. If this is custom middleware, ignore.`);
      }
    }

    // Unclosed backtick detection (very simple heuristic)
    const backtickCount = (text.match(/`/g) || []).length;
    if (backtickCount % 2 === 1) {
      const idx = text.lastIndexOf('`');
      push(DiagnosticSeverity.Warning, Math.max(0, idx), Math.max(0, idx + 1), 'Unclosed backtick-delimited string');
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

connection.onCompletion((params): CompletionItem[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const text = doc.getText();
  const { variablesByType, pipelineNames } = collectVariablesAndPipelines(text);

  const pos = params.position as Position;
  const offset = doc.offsetAt(pos);
  const startOfLine = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  const linePrefix = text.slice(startOfLine, offset);

  // Match pipeline reference line: |> pipeline: <name>
  const pipeLineRe = /^\s*\|>\s*pipeline\s*:\s*([A-Za-z_][\w-]*)?$/;
  const pm = pipeLineRe.exec(linePrefix);
  if (pm) {
    const typed = pm[1] || '';
    const typedLen = typed.length;
    const colonIdx = linePrefix.lastIndexOf(':');
    const varStartInLine = linePrefix.length - typedLen; // start of typed token
    const between = linePrefix.slice(colonIdx + 1, varStartInLine);
    const needsSpace = !/\s/.test(between);
    const startAbs = startOfLine + varStartInLine;
    const endAbs = offset;
    const range = { start: doc.positionAt(startAbs), end: doc.positionAt(endAbs) };
    return Array.from(pipelineNames).map<CompletionItem>(name => ({
      label: name,
      kind: CompletionItemKind.Function,
      textEdit: { range, newText: (needsSpace ? ' ' : '') + name }
    }));
  }

  // Match step variable reference line: |> <step>: <var>
  const stepVarLineRe = /^\s*\|>\s*([A-Za-z_][\w-]*)\s*:\s*([A-Za-z_][\w-]*)?$/;
  const m = stepVarLineRe.exec(linePrefix);
  if (m) {
    const stepType = m[1];
    const typed = m[2] || '';
    const typedLen = typed.length;
    if (stepType !== 'pipeline') {
      const candidates = variablesByType.get(stepType);
      if (candidates && candidates.size > 0) {
        const colonIdx = linePrefix.lastIndexOf(':');
        const varStartInLine = linePrefix.length - typedLen; // start of typed token
        const between = linePrefix.slice(colonIdx + 1, varStartInLine);
        const needsSpace = !/\s/.test(between);
        const startAbs = startOfLine + varStartInLine;
        const endAbs = offset;
        const range = { start: doc.positionAt(startAbs), end: doc.positionAt(endAbs) };
        return Array.from(candidates).map<CompletionItem>(name => ({
          label: name,
          kind: CompletionItemKind.Variable,
          textEdit: { range, newText: (needsSpace ? ' ' : '') + name }
        }));
      }
    }
  }

  return [];
});

function collectReferencePositions(text: string): {
  variableRefs: Map<string, Array<{ start: number; length: number }>>;
  pipelineRefs: Map<string, Array<{ start: number; length: number }>>;
} {
  const variableRefs = new Map<string, Array<{ start: number; length: number }>>();
  const pipelineRefs = new Map<string, Array<{ start: number; length: number }>>();

  const pushVar = (key: string, start: number, length: number) => {
    if (!variableRefs.has(key)) variableRefs.set(key, []);
    variableRefs.get(key)!.push({ start, length });
  };
  const pushPipe = (name: string, start: number, length: number) => {
    if (!pipelineRefs.has(name)) pipelineRefs.set(name, []);
    pipelineRefs.get(name)!.push({ start, length });
  };

  // |> pipeline: <name>
  const pipeRefRe = /(^|\n)(\s*\|>\s*pipeline\s*:\s*)([A-Za-z_][\w-]*)/g;
  for (let m; (m = pipeRefRe.exec(text)); ) {
    const name = m[3];
    const prefixLen = (m[1] ? m[1].length : 0) + m[2].length;
    const start = m.index + prefixLen;
    pushPipe(name, start, name.length);
  }

  // when executing pipeline <name>
  const whenPipeRe = /(^|\n)(\s*when\s+executing\s+pipeline\s+)([A-Za-z_][\w-]*)/g;
  for (let m; (m = whenPipeRe.exec(text)); ) {
    const name = m[3];
    const prefixLen = (m[1] ? m[1].length : 0) + m[2].length;
    const start = m.index + prefixLen;
    pushPipe(name, start, name.length);
  }

  // with/and mock pipeline <name> returning `...`
  const mockPipeRe = /(^|\n)(\s*(?:with|and)\s+mock\s+pipeline\s+)([A-Za-z_][\w-]*)\s+returning\s+`/g;
  for (let m; (m = mockPipeRe.exec(text)); ) {
    const name = m[3];
    const prefixLen = (m[1] ? m[1].length : 0) + m[2].length;
    const start = m.index + prefixLen;
    pushPipe(name, start, name.length);
  }

  // |> <step>: <var>
  const stepVarRe = /(^|\n)(\s*\|>\s*([A-Za-z_][\w-]*)\s*:\s*)([A-Za-z_][\w-]*)/g;
  for (let m; (m = stepVarRe.exec(text)); ) {
    const stepType = m[3];
    if (stepType === 'pipeline') continue;
    const varName = m[4];
    const key = `${stepType}::${varName}`;
    const prefixLen = (m[1] ? m[1].length : 0) + m[2].length;
    const start = m.index + prefixLen;
    pushVar(key, start, varName.length);
  }

  // when executing variable <type> <name>
  const whenVarRe = /(^|\n)(\s*when\s+executing\s+variable\s+([A-Za-z_][\w-]*)\s+)([A-Za-z_][\w-]*)/g;
  for (let m; (m = whenVarRe.exec(text)); ) {
    const varType = m[3];
    const varName = m[4];
    const key = `${varType}::${varName}`;
    const prefixLen = (m[1] ? m[1].length : 0) + m[2].length;
    const start = m.index + prefixLen;
    pushVar(key, start, varName.length);
  }

  // with/and mock <type>.<name> returning `...`
  const mockVarRe = /(^|\n)(\s*(?:with|and)\s+mock\s+([A-Za-z_][\w-]*)\.)([A-Za-z_][\w-]*)\s+returning\s+`/g;
  for (let m; (m = mockVarRe.exec(text)); ) {
    const varType = m[3];
    const varName = m[4];
    const key = `${varType}::${varName}`;
    const prefixLen = (m[1] ? m[1].length : 0) + m[2].length;
    const start = m.index + prefixLen;
    pushVar(key, start, varName.length);
  }

  return { variableRefs, pipelineRefs };
}

connection.onReferences((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const text = doc.getText();
  const { variablePositions, pipelinePositions } = collectDeclarationPositions(text);
  const { variableRefs, pipelineRefs } = collectReferencePositions(text);
  const pos = params.position as Position;
  const offset = doc.offsetAt(pos);
  const wordInfo = getWordAt(text, offset);
  if (!wordInfo) return null;
  const { word } = wordInfo;
  const includeDecl = !!(params as any).context?.includeDeclaration;

  const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  const nextNl = text.indexOf('\n', offset);
  const lineEnd = nextNl === -1 ? text.length : nextNl;
  const lineText = text.slice(lineStart, lineEnd);

  const results: Location[] = [];

  const addDeclAndRefsForPipeline = (name: string) => {
    if (includeDecl) {
      const decl = pipelinePositions.get(name);
      if (decl) results.push(Location.create(doc.uri, { start: doc.positionAt(decl.start), end: doc.positionAt(decl.start + decl.length) }));
    }
    const refs = pipelineRefs.get(name) || [];
    for (const r of refs) results.push(Location.create(doc.uri, { start: doc.positionAt(r.start), end: doc.positionAt(r.start + r.length) }));
  };

  const addDeclAndRefsForVariable = (key: string) => {
    if (includeDecl) {
      const decl = variablePositions.get(key);
      if (decl) results.push(Location.create(doc.uri, { start: doc.positionAt(decl.start), end: doc.positionAt(decl.start + decl.length) }));
    }
    const refs = variableRefs.get(key) || [];
    for (const r of refs) results.push(Location.create(doc.uri, { start: doc.positionAt(r.start), end: doc.positionAt(r.start + r.length) }));
  };

  // Determine identity based on context
  // Pipeline decl
  let m: RegExpExecArray | null;
  if ((m = /^\s*pipeline\s+([A-Za-z_][\w-]*)\s*=/.exec(lineText))) {
    if (word === m[1]) {
      addDeclAndRefsForPipeline(m[1]);
      return results;
    }
  }

  // Variable decl
  if ((m = /^\s*([A-Za-z_][\w-]*)\s+([A-Za-z_][\w-]*)\s*=\s*`/.exec(lineText))) {
    const varType = m[1];
    const varName = m[2];
    if (word === varName) {
      addDeclAndRefsForVariable(`${varType}::${varName}`);
      return results;
    }
  }

  // |> pipeline: <name>
  if (/^\s*\|>\s*pipeline\s*:/.test(lineText)) {
    addDeclAndRefsForPipeline(word);
    return results.length ? results : null;
  }

  // |> <stepType>: <varName>
  if ((m = /^\s*\|>\s*([A-Za-z_][\w-]*)\s*:\s*([A-Za-z_][\w-]*)?/.exec(lineText))) {
    const stepType = m[1];
    if (stepType !== 'pipeline') {
      addDeclAndRefsForVariable(`${stepType}::${word}`);
      return results.length ? results : null;
    }
  }

  // when executing pipeline <name>
  if (/^\s*when\s+executing\s+pipeline\s+/.test(lineText)) {
    addDeclAndRefsForPipeline(word);
    return results.length ? results : null;
  }

  // when executing variable <type> <name>
  if ((m = /^\s*when\s+executing\s+variable\s+([A-Za-z_][\w-]*)\s+([A-Za-z_][\w-]*)/.exec(lineText))) {
    const varType = m[1];
    addDeclAndRefsForVariable(`${varType}::${word}`);
    return results.length ? results : null;
  }

  // with/and mock pipeline <name> returning `...`
  if (/^\s*(with|and)\s+mock\s+pipeline\s+/.test(lineText)) {
    addDeclAndRefsForPipeline(word);
    return results.length ? results : null;
  }

  // with/and mock <type>.<name> returning `...`
  if ((m = /^\s*(with|and)\s+mock\s+([A-Za-z_][\w-]*)\.([A-Za-z_][\w-]*)/.exec(lineText))) {
    const varType = m[2];
    addDeclAndRefsForVariable(`${varType}::${word}`);
    return results.length ? results : null;
  }

  return null;
});

connection.onCodeLens((params): CodeLens[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const text = doc.getText();
  const { variablePositions, pipelinePositions } = collectDeclarationPositions(text);
  const { variableRefs, pipelineRefs } = collectReferencePositions(text);

  const lenses: CodeLens[] = [];

  for (const [name, pos] of pipelinePositions.entries()) {
    const refs = pipelineRefs.get(name) || [];
    const range = { start: doc.positionAt(pos.start), end: doc.positionAt(pos.start + pos.length) };
    const locations = refs.map(r => Location.create(doc.uri, { start: doc.positionAt(r.start), end: doc.positionAt(r.start + r.length) }));
    lenses.push({
      range,
      command: {
        title: `${locations.length} reference${locations.length === 1 ? '' : 's'}`,
        command: 'webpipe.showReferences',
        arguments: [doc.uri, range.start, locations]
      }
    });
  }

  for (const [key, pos] of variablePositions.entries()) {
    const refs = variableRefs.get(key) || [];
    const range = { start: doc.positionAt(pos.start), end: doc.positionAt(pos.start + pos.length) };
    const locations = refs.map(r => Location.create(doc.uri, { start: doc.positionAt(r.start), end: doc.positionAt(r.start + r.length) }));
    lenses.push({
      range,
      command: {
        title: `${locations.length} reference${locations.length === 1 ? '' : 's'}`,
        command: 'webpipe.showReferences',
        arguments: [doc.uri, range.start, locations]
      }
    });
  }

  return lenses;
});

connection.onDocumentHighlight((params): DocumentHighlight[] | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const text = doc.getText();
  const { variablePositions, pipelinePositions } = collectDeclarationPositions(text);
  const { variableRefs, pipelineRefs } = collectReferencePositions(text);
  const pos = params.position as Position;
  const offset = doc.offsetAt(pos);
  const wordInfo = getWordAt(text, offset);
  if (!wordInfo) return null;
  const { word } = wordInfo;

  const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  const nextNl = text.indexOf('\n', offset);
  const lineEnd = nextNl === -1 ? text.length : nextNl;
  const lineText = text.slice(lineStart, lineEnd);

  const highlights: DocumentHighlight[] = [];
  const addRanges = (decl: { start: number; length: number } | undefined, refs: Array<{ start: number; length: number }>) => {
    if (decl) {
      highlights.push({ range: { start: doc.positionAt(decl.start), end: doc.positionAt(decl.start + decl.length) }, kind: DocumentHighlightKind.Write });
    }
    for (const r of refs) {
      highlights.push({ range: { start: doc.positionAt(r.start), end: doc.positionAt(r.start + r.length) }, kind: DocumentHighlightKind.Read });
    }
  };

  // Pipelines
  if (/^\s*\|>\s*pipeline\s*:/.test(lineText) || /^\s*when\s+executing\s+pipeline\s+/.test(lineText) || /^\s*(with|and)\s+mock\s+pipeline\s+/.test(lineText) || /^\s*pipeline\s+[A-Za-z_][\w-]*\s*=/.test(lineText)) {
    const decl = pipelinePositions.get(word);
    const refs = pipelineRefs.get(word) || [];
    addRanges(decl, refs);
    return highlights.length ? highlights : null;
  }

  // Variables
  let m: RegExpExecArray | null;
  if ((m = /^\s*([A-Za-z_][\w-]*)\s+([A-Za-z_][\w-]*)\s*=\s*`/.exec(lineText))) {
    const varType = m[1];
    const key = `${varType}::${word}`;
    const decl = variablePositions.get(key);
    const refs = variableRefs.get(key) || [];
    addRanges(decl, refs);
    return highlights.length ? highlights : null;
  }
  if (/^\s*\|>\s*([A-Za-z_][\w-]*)\s*:/.test(lineText) || /^\s*when\s+executing\s+variable\s+/.test(lineText) || /^\s*(with|and)\s+mock\s+[A-Za-z_][\w-]*\./.test(lineText)) {
    // Try both: assume the step type is the first identifier after |> or after 'variable'
    const stepTypeMatch = /^\s*\|>\s*([A-Za-z_][\w-]*)\s*:/.exec(lineText);
    const execVarMatch = /^\s*when\s+executing\s+variable\s+([A-Za-z_][\w-]*)\s+/.exec(lineText);
    const mockTypeMatch = /^\s*(with|and)\s+mock\s+([A-Za-z_][\w-]*)\./.exec(lineText);
    const varType = (stepTypeMatch && stepTypeMatch[1] !== 'pipeline') ? stepTypeMatch[1] : (execVarMatch ? execVarMatch[1] : (mockTypeMatch ? mockTypeMatch[2] : undefined));
    if (varType) {
      const key = `${varType}::${word}`;
      const decl = variablePositions.get(key);
      const refs = variableRefs.get(key) || [];
      addRanges(decl, refs);
      return highlights.length ? highlights : null;
    }
  }

  return null;
});
connection.onDefinition((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const text = doc.getText();
  const { variablePositions, pipelinePositions } = collectDeclarationPositions(text);
  const pos = params.position as Position;
  const offset = doc.offsetAt(pos);
  const wordInfo = getWordAt(text, offset);
  if (!wordInfo) return null;
  const { word } = wordInfo;

  const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  const nextNl = text.indexOf('\n', offset);
  const lineEnd = nextNl === -1 ? text.length : nextNl;
  const lineText = text.slice(lineStart, lineEnd);

  // |> pipeline: <name>
  if (/^\s*\|>\s*pipeline\s*:/.test(lineText)) {
    const hit = pipelinePositions.get(word);
    if (hit) {
      const range = { start: doc.positionAt(hit.start), end: doc.positionAt(hit.start + hit.length) };
      return Location.create(doc.uri, range);
    }
  }

  // |> <stepType>: <varName>
  const stepVarLine = /^\s*\|>\s*([A-Za-z_][\w-]*)\s*:\s*([A-Za-z_][\w-]*)?/;
  const svm = stepVarLine.exec(lineText);
  if (svm) {
    const stepType = svm[1];
    if (stepType !== 'pipeline') {
      const key = `${stepType}::${word}`;
      const hit = variablePositions.get(key);
      if (hit) {
        const range = { start: doc.positionAt(hit.start), end: doc.positionAt(hit.start + hit.length) };
        return Location.create(doc.uri, range);
      }
    }
  }

  // when executing pipeline <name>
  if (/^\s*when\s+executing\s+pipeline\s+/.test(lineText)) {
    const hit = pipelinePositions.get(word);
    if (hit) {
      const range = { start: doc.positionAt(hit.start), end: doc.positionAt(hit.start + hit.length) };
      return Location.create(doc.uri, range);
    }
  }

  // when executing variable <type> <name>
  const whenVar = /^\s*when\s+executing\s+variable\s+([A-Za-z_][\w-]*)\s+([A-Za-z_][\w-]*)/;
  const wvm = whenVar.exec(lineText);
  if (wvm) {
    const varType = wvm[1];
    const key = `${varType}::${word}`;
    const hit = variablePositions.get(key);
    if (hit) {
      const range = { start: doc.positionAt(hit.start), end: doc.positionAt(hit.start + hit.length) };
      return Location.create(doc.uri, range);
    }
  }

  // with/and mock pipeline <name> returning `...`
  if (/^\s*(with|and)\s+mock\s+pipeline\s+/.test(lineText)) {
    const hit = pipelinePositions.get(word);
    if (hit) {
      const range = { start: doc.positionAt(hit.start), end: doc.positionAt(hit.start + hit.length) };
      return Location.create(doc.uri, range);
    }
  }

  // with/and mock <type>.<name> returning `...`
  const mockVar = /^\s*(with|and)\s+mock\s+([A-Za-z_][\w-]*)\.([A-Za-z_][\w-]*)/;
  const mv = mockVar.exec(lineText);
  if (mv) {
    const varType = mv[2];
    const key = `${varType}::${word}`;
    const hit = variablePositions.get(key);
    if (hit) {
      const range = { start: doc.positionAt(hit.start), end: doc.positionAt(hit.start + hit.length) };
      return Location.create(doc.uri, range);
    }
  }

  return null;
});

documents.listen(connection);
connection.listen();


