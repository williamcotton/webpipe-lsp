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

documents.listen(connection);
connection.listen();


