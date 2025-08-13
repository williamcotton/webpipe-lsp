import { TextDocument } from 'vscode-languageserver-textdocument';
import { Diagnostic, DiagnosticSeverity, Connection } from 'vscode-languageserver/node';
import { VALID_HTTP_METHODS, KNOWN_MIDDLEWARE, KNOWN_STEPS, REGEX_PATTERNS } from './constants';
import { collectHandlebarsSymbols } from './symbol-collector';
import { parseProgramWithDiagnostics } from './parser';

interface DiagnosticPush {
  (severity: DiagnosticSeverity, start: number, end: number, message: string): void;
}

export class DocumentValidator {
  constructor(private connection: Connection) {}

  async validateDocument(doc: TextDocument): Promise<void> {
    const text = doc.getText();
    const diagnostics: Diagnostic[] = [];

    this.validateTrailingNewline(text, doc, diagnostics);
    this.validateReferences(text, doc, diagnostics);

    this.connection.sendDiagnostics({ uri: doc.uri, diagnostics });
  }

  private validateTrailingNewline(text: string, doc: TextDocument, diagnostics: Diagnostic[]): void {
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
  }

  private validateReferences(text: string, doc: TextDocument, diagnostics: Diagnostic[]): void {
    try {
      const push: DiagnosticPush = (severity, start, end, message) => {
        diagnostics.push({
          severity,
          range: { start: doc.positionAt(start), end: doc.positionAt(end) },
          message,
          source: 'webpipe-lsp'
        });
      };

      // Parse AST and include parser diagnostics
      const { program, diagnostics: parseDiagnostics } = parseProgramWithDiagnostics(text);
      for (const d of parseDiagnostics) {
        push(
          d.severity === 'error' ? DiagnosticSeverity.Error : d.severity === 'warning' ? DiagnosticSeverity.Warning : DiagnosticSeverity.Information,
          d.start,
          d.end,
          d.message
        );
      }

      const { variablesByType, pipelineNames } = this.collectDeclarations(text, push, program);
      const routePatterns = this.validateRoutes(text, push);
      
      this.validateStepReferences(text, variablesByType, push);
      this.validatePipelineReferences(text, pipelineNames, push);
      this.validateBDDReferences(text, variablesByType, pipelineNames, push);
      this.validateMockReferences(text, variablesByType, pipelineNames, push);
      this.validateRouteReferences(text, routePatterns, push);
      this.validateJsonBlocks(text, push);
      this.validateMiddlewareReferences(text, push);
      this.validateAuthFlows(text, push);
      this.validateResultBlocks(text, push);
      this.validateAssertions(text, push);
      this.validateUnknownSteps(text, push);
      this.validateHandlebarsPartialReferences(text, push);
      
    } catch (_e) {
      // Best-effort validation; avoid crashing on regex issues
    }
  }

  private collectDeclarations(text: string, push: DiagnosticPush, program?: { variables: Array<{ varType: string; name: string }>; pipelines: Array<{ name: string }> }): {
    variablesByType: Map<string, Set<string>>;
    pipelineNames: Set<string>;
  } {
    // Prefer AST to build declarations
    const variablesByType = new Map<string, Set<string>>();
    const pipelineNames = new Set<string>();

    if (program) {
      for (const v of program.variables) {
        if (!variablesByType.has(v.varType)) variablesByType.set(v.varType, new Set());
        variablesByType.get(v.varType)!.add(v.name);
      }
      for (const p of program.pipelines) {
        pipelineNames.add(p.name);
      }
    }

    // Use regex only to locate duplicates precisely for diagnostics
    const varDeclRe = new RegExp(REGEX_PATTERNS.VAR_DECL.source, REGEX_PATTERNS.VAR_DECL.flags);
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
    }

    const pipeDeclRe = new RegExp(REGEX_PATTERNS.PIPE_DECL.source, REGEX_PATTERNS.PIPE_DECL.flags);
    const pipelineSeen = new Set<string>();
    for (let m; (m = pipeDeclRe.exec(text)); ) {
      const name = m[2];
      if (pipelineSeen.has(name)) {
        const nameStart = m.index + m[0].lastIndexOf(name);
        push(DiagnosticSeverity.Warning, nameStart, nameStart + name.length, `Duplicate pipeline: ${name}`);
      }
      pipelineSeen.add(name);
    }

    return { variablesByType, pipelineNames };
  }

  private validateRoutes(text: string, push: DiagnosticPush): Array<{ method: string; path: string; regex: RegExp }> {
    const routeDeclRe = new RegExp(REGEX_PATTERNS.ROUTE_DECL.source, REGEX_PATTERNS.ROUTE_DECL.flags);
    const routes = new Set<string>();
    const routePatterns: Array<{ method: string; path: string; regex: RegExp }> = [];
    
    for (let m; (m = routeDeclRe.exec(text)); ) {
      const method = m[2];
      const path = (m[3] || '').trim();
      
      if (!VALID_HTTP_METHODS.has(method)) {
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

      // Build matching regex for calls
      const pattern = '^' + path
        .replace(/[.*+?^${}()|[\]\\]/g, (ch) => `\\${ch}`)
        .replace(/:(?:[A-Za-z_][\w-]*)/g, '[^/]+') + '$';
      
      try {
        routePatterns.push({ method, path, regex: new RegExp(pattern) });
      } catch (_e) {
        // Ignore bad pattern
      }
    }
    
    return routePatterns;
  }

  private validateStepReferences(text: string, variablesByType: Map<string, Set<string>>, push: DiagnosticPush): void {
    const stepRefRe = new RegExp(REGEX_PATTERNS.STEP_REF.source, REGEX_PATTERNS.STEP_REF.flags);
    
    for (let m; (m = stepRefRe.exec(text)); ) {
      const stepName = m[2];
      const configText = m[3].trim();
      
      if (stepName === 'pipeline') continue;
      
      const identMatch = REGEX_PATTERNS.SINGLE_IDENTIFIER.exec(configText);
      if (!identMatch) continue;
      
      const id = identMatch.groups!.id;
      const declared = variablesByType.get(stepName);
      if (!declared || !declared.has(id)) {
        const idStart = m.index + m[0].lastIndexOf(id);
        push(DiagnosticSeverity.Error, idStart, idStart + id.length, `Unknown ${stepName} variable: ${id}`);
      }
    }
  }

  private validatePipelineReferences(text: string, pipelineNames: Set<string>, push: DiagnosticPush): void {
    const pipeRefRe = new RegExp(REGEX_PATTERNS.PIPE_REF.source, REGEX_PATTERNS.PIPE_REF.flags);
    
    for (let m; (m = pipeRefRe.exec(text)); ) {
      const name = m[2];
      if (!pipelineNames.has(name)) {
        const nameStart = m.index + m[0].lastIndexOf(name);
        push(DiagnosticSeverity.Error, nameStart, nameStart + name.length, `Unknown pipeline: ${name}`);
      }
    }
  }

  private validateBDDReferences(text: string, variablesByType: Map<string, Set<string>>, pipelineNames: Set<string>, push: DiagnosticPush): void {
    // when executing pipeline <name>
    const whenExecPipelineRe = /(^|\n)\s*when\s+executing\s+pipeline\s+([A-Za-z_][\w-]*)/g;
    for (let m; (m = whenExecPipelineRe.exec(text)); ) {
      const name = m[2];
      if (!pipelineNames.has(name)) {
        const nameStart = m.index + m[0].lastIndexOf(name);
        push(DiagnosticSeverity.Error, nameStart, nameStart + name.length, `Unknown pipeline: ${name}`);
      }
    }

    // when executing variable <type> <name>
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

    // when calling METHOD /path
    const whenCallingRe = /(^|\n)\s*when\s+calling\s+([A-Z]+)\s+([^\s\n]+)/g;
    for (let m; (m = whenCallingRe.exec(text)); ) {
      const method = m[2];
      if (!VALID_HTTP_METHODS.has(method)) {
        const methodStart = m.index + m[0].indexOf(method);
        push(DiagnosticSeverity.Error, methodStart, methodStart + method.length, `Unknown HTTP method: ${method}`);
      }
    }
  }

  private validateMockReferences(text: string, variablesByType: Map<string, Set<string>>, pipelineNames: Set<string>, push: DiagnosticPush): void {
    // Mock pipeline references
    const mockPipelineRe = /(^|\n)\s*(?:with|and)\s+mock\s+pipeline\s+([A-Za-z_][\w-]*)\s+returning\s+`/g;
    for (let m; (m = mockPipelineRe.exec(text)); ) {
      const name = m[2];
      if (!pipelineNames.has(name)) {
        const nameStart = m.index + m[0].lastIndexOf(name);
        push(DiagnosticSeverity.Error, nameStart, nameStart + name.length, `Unknown pipeline in mock: ${name}`);
      }
    }

    // Mock variable references  
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
  }

  private validateRouteReferences(text: string, routePatterns: Array<{ method: string; path: string; regex: RegExp }>, push: DiagnosticPush): void {
    const whenCallingRe = /(^|\n)\s*when\s+calling\s+([A-Z]+)\s+([^\s\n]+)/g;
    
    for (let m; (m = whenCallingRe.exec(text)); ) {
      const method = m[2];
      const pathWithQuery = m[3];
      const path = pathWithQuery.split('?')[0];
      
      if (!VALID_HTTP_METHODS.has(method)) continue;
      
      const anyMatch = routePatterns.some(r => r.method === method && r.regex.test(path));
      if (!anyMatch) {
        const pathStart = m.index + m[0].lastIndexOf(path);
        push(DiagnosticSeverity.Error, pathStart, pathStart + path.length, `Unknown route: ${method} ${path}`);
      }
    }
  }

  private validateJsonBlocks(text: string, push: DiagnosticPush): void {
    // JSON validation for with input
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

    // JSON validation for mocks
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
  }

  private validateMiddlewareReferences(text: string, push: DiagnosticPush): void {
    // Type-only mocks
    const mockTypeOnlyRe = /(^|\n)\s*(?:with|and)\s+mock\s+([A-Za-z_][\w-]*)\s+returning\s+`/g;
    for (let m; (m = mockTypeOnlyRe.exec(text)); ) {
      const mw = m[2];
      if (mw === 'pipeline') {
        const typeStart = m.index + m[0].indexOf(mw);
        push(DiagnosticSeverity.Error, typeStart, typeStart + mw.length, 'Use "mock pipeline <name>" for pipeline mocks');
        continue;
      }
      if (!KNOWN_MIDDLEWARE.has(mw)) {
        const typeStart = m.index + m[0].indexOf(mw);
        push(DiagnosticSeverity.Warning, typeStart, typeStart + mw.length, `Unknown middleware in mock: ${mw}`);
      }
    }

    // Malformed mock syntax
    const mockHeadLineRe = /(^|\n)(\s*(with|and)\s+mock\b[^\n]*)/g;
    const mockHeadValid = /^(with|and)\s+mock\s+(?:pipeline\s+[A-Za-z_][\w-]*|[A-Za-z_][\w-]*\.[A-Za-z_][\w-]*|[A-Za-z_][\w-]*)\s+returning\s+`/;
    for (let m; (m = mockHeadLineRe.exec(text)); ) {
      const lineStart = m.index + (m[1] ? m[1].length : 0);
      const head = m[2].trim();
      if (!mockHeadValid.test(head)) {
        push(DiagnosticSeverity.Error, lineStart, lineStart + head.length, 'Malformed mock syntax. Expected: with|and mock <middleware>[.<name>] returning `...` or with|and mock pipeline <name> returning `...`');
      }
    }
  }

  private validateAuthFlows(text: string, push: DiagnosticPush): void {
    const authFlowRe = /(^|\n)\s*\|>\s*auth:\s*"([^"]*)"/g;
    for (let m; (m = authFlowRe.exec(text)); ) {
      const flow = m[2];
      const ok = flow === 'optional' || flow === 'required' || flow === 'login' || flow === 'register' || flow === 'logout' || flow.startsWith('type:');
      if (!ok) {
        const flowStart = m.index + m[0].lastIndexOf(flow);
        push(DiagnosticSeverity.Warning, flowStart, flowStart + flow.length, `Unknown auth flow: ${flow}`);
      }
    }
  }

  private validateResultBlocks(text: string, push: DiagnosticPush): void {
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
  }

  private validateAssertions(text: string, push: DiagnosticPush): void {
    // status is NNN
    const statusIsRe = /(^|\n)\s*(then|and)\s+status\s+is\s+(\d{3})\b/g;
    for (let m; (m = statusIsRe.exec(text)); ) {
      const code = parseInt(m[3], 10);
      if (code < 100 || code > 599) {
        const start = m.index + m[0].lastIndexOf(m[3]);
        push(DiagnosticSeverity.Error, start, start + m[3].length, `Invalid HTTP status code: ${code}`);
      }
    }

    // status in NNN..NNN
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

    // contentType assertions
    const ctAny = /(^|\n)\s*(then|and)\s+contentType\b([^\n]*)/g;
    for (let m; (m = ctAny.exec(text)); ) {
      const lineStart = m.index + (m[1] ? m[1].length : 0);
      const tail = m[3];
      const head = `contentType${tail}`.trim();
      if (!/^contentType\s+is\s+"[^"]+"$/.test(head)) {
        push(DiagnosticSeverity.Error, lineStart + m[0].indexOf('contentType'), lineStart + m[0].length, 'Malformed contentType assertion. Expected: then|and contentType is "<type>"');
      }
    }
  }

  private validateUnknownSteps(text: string, push: DiagnosticPush): void {
    const stepNameRe = /(^|\n)\s*\|>\s*([A-Za-z_][\w-]*)\s*:/g;
    for (let m; (m = stepNameRe.exec(text)); ) {
      const step = m[2];
      if (!KNOWN_STEPS.has(step)) {
        const stepStart = m.index + m[0].indexOf(step);
        push(DiagnosticSeverity.Information, stepStart, stepStart + step.length, `Unknown step '${step}'. If this is custom middleware, ignore.`);
      }
    }
  }

  private validateUnclosedBackticks(text: string, push: DiagnosticPush): void {
    const backtickCount = (text.match(/`/g) || []).length;
    if (backtickCount % 2 === 1) {
      const idx = text.lastIndexOf('`');
      push(DiagnosticSeverity.Warning, Math.max(0, idx), Math.max(0, idx + 1), 'Unclosed backtick-delimited string');
    }
  }

  private validateHandlebarsPartialReferences(text: string, push: DiagnosticPush): void {
    const hb = collectHandlebarsSymbols(text);
    for (const [name, uses] of hb.usagesByName.entries()) {
      const hasGlobalDecl = hb.declByName.has(name);
      // Any inline decl anywhere in the file (best-effort since scope can cross into called partials)
      const hasAnyInlineDecl = hb.inlineDefsByContent.some(entry => entry.inlineByName.has(name) || entry.inlineBlockByName.has(name));
      for (const u of uses) {
        // Inline def within same content block
        let hasInlineDeclInSameBlock = false;
        for (const entry of hb.inlineDefsByContent) {
          if (u.start >= entry.range.start && u.start <= entry.range.end) {
            if (entry.inlineByName.has(name) || entry.inlineBlockByName.has(name)) {
              hasInlineDeclInSameBlock = true;
            }
            break;
          }
        }
        if (!hasInlineDeclInSameBlock && !hasGlobalDecl && !hasAnyInlineDecl) {
          push(
            DiagnosticSeverity.Warning,
            u.start,
            u.end,
            `Unknown Handlebars partial: ${name}`
          );
        }
      }
    }
  }
}