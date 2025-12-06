import { TextDocument } from 'vscode-languageserver-textdocument';
import { Diagnostic, DiagnosticSeverity, Connection } from 'vscode-languageserver/node';
import { VALID_HTTP_METHODS, KNOWN_MIDDLEWARE, KNOWN_STEPS, REGEX_PATTERNS } from './constants';
import { collectHandlebarsSymbols } from './symbol-collector';
import { DocumentCache } from './document-cache';
import { Describe } from 'webpipe-js';
import { findTestContextAtOffset, extractHandlebarsVariables, extractJqVariables, escapeRegex } from './test-variable-utils';

interface DiagnosticPush {
  (severity: DiagnosticSeverity, start: number, end: number, message: string): void;
}

export class DocumentValidator {
  constructor(private connection: Connection, private cache: DocumentCache) {}

  async validateDocument(doc: TextDocument): Promise<void> {
    const text = this.cache.getText(doc);
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

      // Get cached parse result
      const { program, diagnostics: parseDiagnostics } = this.cache.get(doc);
      for (const d of parseDiagnostics) {
        push(
          d.severity === 'error' ? DiagnosticSeverity.Error : d.severity === 'warning' ? DiagnosticSeverity.Warning : DiagnosticSeverity.Information,
          d.start,
          d.end,
          d.message
        );
      }

      const { variablesByType, pipelineNames } = this.collectDeclarations(text, push, program);
      const routePatterns = this.validateRoutes(text, push, program);
      
      this.validateStepReferences(text, variablesByType, push);
      this.validatePipelineReferences(text, pipelineNames, push);
      this.validateBDDReferences(text, variablesByType, pipelineNames, push);
      this.validateMockReferences(text, variablesByType, pipelineNames, push);
      this.validateRouteReferences(text, routePatterns, push);
      this.validateJsonBlocks(text, push);
      this.validateMiddlewareReferences(text, push);
      this.validateConfigBlocks(text, push, program);
      this.validateUnknownVariableTypes(text, push, program);
      this.validateAuthFlows(text, push);
      this.validateResultBlocks(text, push);
      this.validateAssertions(text, push);
      this.validateUnknownSteps(text, push);
      this.validateHandlebarsPartialReferences(text, push);
      this.validateJoinAsyncReferences(text, push);
      this.validateTestLetVariables(text, push, program);

    } catch (e) {
      // Log validation errors instead of silently swallowing them
      // This helps debug validation issues while preventing LSP crashes
      console.error('Validation error:', e);

      // Still add a diagnostic so the user knows something went wrong
      diagnostics.push({
        severity: DiagnosticSeverity.Warning,
        range: {
          start: doc.positionAt(0),
          end: doc.positionAt(0)
        },
        message: 'Some validations could not complete due to an internal error',
        source: 'webpipe-lsp'
      });
    }
  }

  private validateUnknownVariableTypes(text: string, push: DiagnosticPush, program?: { variables: Array<{ varType: string; name: string; start: number; end: number }> }): void {
    if (!program) return;

    // Use AST to check for unknown variable types
    for (const variable of program.variables) {
      const varType = variable.varType;
      if (!KNOWN_MIDDLEWARE.has(varType)) {
        // Calculate the position of the varType within the variable declaration
        // The varType comes before the name in the declaration
        push(
          DiagnosticSeverity.Warning,
          variable.start,
          variable.start + varType.length,
          `Unknown variable type '${varType}'. If this is custom middleware, ignore.`
        );
      }
    }
  }

  private validateConfigBlocks(text: string, push: DiagnosticPush, program?: { configs: Array<{ name: string; start: number; end: number }> }): void {
    if (!program) return;

    // Use AST to validate config blocks
    for (const config of program.configs) {
      const name = config.name;
      if (!KNOWN_MIDDLEWARE.has(name)) {
        // Calculate position of the name within the config declaration
        push(
          DiagnosticSeverity.Error,
          config.start + 'config '.length,
          config.start + 'config '.length + name.length,
          `Unknown middleware in config: ${name}`
        );
      }
    }
  }

  private collectDeclarations(text: string, push: DiagnosticPush, program?: { variables: Array<{ varType: string; name: string; start: number; end: number }>; pipelines: Array<{ name: string; start: number; end: number }> }): {
    variablesByType: Map<string, Set<string>>;
    pipelineNames: Set<string>;
  } {
    const variablesByType = new Map<string, Set<string>>();
    const pipelineNames = new Set<string>();

    if (!program) return { variablesByType, pipelineNames };

    // Use AST to build declarations and detect duplicates
    const varDeclSeen = new Map<string, { varType: string; name: string; start: number; end: number }>();
    for (const v of program.variables) {
      if (!variablesByType.has(v.varType)) variablesByType.set(v.varType, new Set());
      variablesByType.get(v.varType)!.add(v.name);

      // Check for duplicates
      const key = `${v.varType}::${v.name}`;
      if (varDeclSeen.has(key)) {
        // This is a duplicate - report it
        const nameStart = v.start + v.varType.length + 1; // skip "varType "
        push(DiagnosticSeverity.Warning, nameStart, nameStart + v.name.length, `Duplicate ${v.varType} variable: ${v.name}`);
      }
      varDeclSeen.set(key, v);
    }

    const pipelineSeen = new Map<string, { name: string; start: number; end: number }>();
    for (const p of program.pipelines) {
      pipelineNames.add(p.name);

      // Check for duplicates
      if (pipelineSeen.has(p.name)) {
        // This is a duplicate - report it
        const nameStart = p.start + 'pipeline '.length;
        push(DiagnosticSeverity.Warning, nameStart, nameStart + p.name.length, `Duplicate pipeline: ${p.name}`);
      }
      pipelineSeen.set(p.name, p);
    }

    return { variablesByType, pipelineNames };
  }

  private validateRoutes(text: string, push: DiagnosticPush, program?: { routes: Array<{ method: string; path: string; start: number; end: number }> }): Array<{ method: string; path: string; regex: RegExp }> {
    const routePatterns: Array<{ method: string; path: string; regex: RegExp }> = [];

    if (!program) return routePatterns;

    // Use AST to validate routes
    const routes = new Set<string>();
    for (const route of program.routes) {
      const method = route.method;
      const path = route.path;

      if (!VALID_HTTP_METHODS.has(method)) {
        // Method starts at route.start
        push(DiagnosticSeverity.Error, route.start, route.start + method.length, `Unknown HTTP method: ${method}`);
        continue;
      }

      const key = `${method} ${path}`;
      if (routes.has(key)) {
        // Path starts after method and space
        const pathStart = route.start + method.length + 1;
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

    // Extract GraphQL schema for validation
    const graphqlSchemaMatch = /graphqlSchema\s*=\s*`([\s\S]*?)`/m.exec(text);
    const queries = new Set<string>();
    const mutations = new Set<string>();

    if (graphqlSchemaMatch) {
      const schema = graphqlSchemaMatch[1];

      // Extract query names from schema
      const queryTypeMatch = /type\s+Query\s*\{([^}]*)\}/s.exec(schema);
      if (queryTypeMatch) {
        const queryFields = queryTypeMatch[1].matchAll(/\s*([A-Za-z_][\w-]*)\s*(?:\([^)]*\))?\s*:\s*/g);
        for (const match of queryFields) {
          queries.add(match[1]);
        }
      }

      // Extract mutation names from schema
      const mutationTypeMatch = /type\s+Mutation\s*\{([^}]*)\}/s.exec(schema);
      if (mutationTypeMatch) {
        const mutationFields = mutationTypeMatch[1].matchAll(/\s*([A-Za-z_][\w-]*)\s*(?:\([^)]*\))?\s*:\s*/g);
        for (const match of mutationFields) {
          mutations.add(match[1]);
        }
      }
    }

    // Also check for query/mutation resolver definitions
    const queryResolverRe = /query\s+([A-Za-z_][\w-]*)\s*=/g;
    for (let m; (m = queryResolverRe.exec(text)); ) {
      queries.add(m[1]);
    }

    const mutationResolverRe = /mutation\s+([A-Za-z_][\w-]*)\s*=/g;
    for (let m; (m = mutationResolverRe.exec(text)); ) {
      mutations.add(m[1]);
    }

    // Mock GraphQL query/mutation references (query users, mutation createUser)
    const mockGraphQLRe = /(^|\n)\s*(?:with|and)\s+mock\s+(query|mutation)\s+([A-Za-z_][\w-]*)\s+returning\s+`/g;
    for (let m; (m = mockGraphQLRe.exec(text)); ) {
      const type = m[2];
      const name = m[3];
      const resolverSet = type === 'query' ? queries : mutations;

      // Only validate if we have schema/resolver information
      if (resolverSet.size > 0 && !resolverSet.has(name)) {
        const nameStart = m.index + m[0].lastIndexOf(name);
        push(DiagnosticSeverity.Warning, nameStart, nameStart + name.length, `Unknown GraphQL ${type} in mock: ${name}`);
      }
    }

    // Mock variable references
    const mockVarRe = /(^|\n)\s*(?:with|and)\s+mock\s+([A-Za-z_][\w-]*)\.([A-Za-z_][\w-]*)\s+returning\s+`/g;
    for (let m; (m = mockVarRe.exec(text)); ) {
      const varType = m[2];
      const varName = m[3];

      // Skip GraphQL mocks (query.users, mutation.createUser)
      if (varType === 'query' || varType === 'mutation') {
        continue;
      }

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
    // Note: with input now uses JQ syntax instead of JSON, so no JSON validation needed

    // Head validation for with input
    const withInputHeadAny = /(^|\n)\s*with\s+input\b([^\n]*)/g;
    for (let m; (m = withInputHeadAny.exec(text)); ) {
      const lineStart = m.index + (m[1] ? m[1].length : 0);
      const head = ('with input' + m[2]).trim();
      if (!/^with\s+input\s+`/.test(head)) {
        push(DiagnosticSeverity.Error, lineStart, lineStart + head.length, 'Malformed with input syntax. Expected: with input `...`');
      }
    }

    // Note: mock returning now uses JQ syntax instead of JSON, so no JSON validation needed
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
    const mockHeadValid = /^(with|and)\s+mock\s+(?:pipeline\s+[A-Za-z_][\w-]*|(?:query|mutation)\s+[A-Za-z_][\w-]*|[A-Za-z_][\w-]*\.[A-Za-z_][\w-]*|[A-Za-z_][\w-]*)\s+returning\s+`/;
    for (let m; (m = mockHeadLineRe.exec(text)); ) {
      const lineStart = m.index + (m[1] ? m[1].length : 0);
      const head = m[2].trim();
      if (!mockHeadValid.test(head)) {
        push(DiagnosticSeverity.Error, lineStart, lineStart + head.length, 'Malformed mock syntax. Expected: with|and mock <middleware>[.<name>] returning `...`, with|and mock pipeline <name> returning `...`, or with|and mock query|mutation <name> returning `...`');
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
    const resultBlockRe = /(^|\n)\s*\|>\s*result([\s\S]*?)(?=(\n\s*\|>|\n\s*(GET|POST|PUT|DELETE)|$))/g;
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
    // Extract GraphQL schema for validation
    const graphqlSchemaMatch = /graphqlSchema\s*=\s*`([\s\S]*?)`/m.exec(text);
    const queries = new Set<string>();
    const mutations = new Set<string>();

    if (graphqlSchemaMatch) {
      const schema = graphqlSchemaMatch[1];

      // Extract query names
      const queryTypeMatch = /type\s+Query\s*\{([^}]*)\}/s.exec(schema);
      if (queryTypeMatch) {
        const queryFields = queryTypeMatch[1].matchAll(/\s*([A-Za-z_][\w-]*)\s*(?:\([^)]*\))?\s*:\s*/g);
        for (const match of queryFields) {
          queries.add(match[1]);
        }
      }

      // Extract mutation names
      const mutationTypeMatch = /type\s+Mutation\s*\{([^}]*)\}/s.exec(schema);
      if (mutationTypeMatch) {
        const mutationFields = mutationTypeMatch[1].matchAll(/\s*([A-Za-z_][\w-]*)\s*(?:\([^)]*\))?\s*:\s*/g);
        for (const match of mutationFields) {
          mutations.add(match[1]);
        }
      }
    }

    // Also check for query/mutation resolver definitions
    const queryResolverRe = /query\s+([A-Za-z_][\w-]*)\s*=/g;
    for (let m; (m = queryResolverRe.exec(text)); ) {
      queries.add(m[1]);
    }

    const mutationResolverRe = /mutation\s+([A-Za-z_][\w-]*)\s*=/g;
    for (let m; (m = mutationResolverRe.exec(text)); ) {
      mutations.add(m[1]);
    }

    // call query/mutation assertions (call query users with `...`)
    const callAssertionRe = /(^|\n)\s*(then|and)\s+call\s+(query|mutation)\s+([A-Za-z_][\w-]*)\s+(with(?:\s+arguments)?)\s+`/g;
    for (let m; (m = callAssertionRe.exec(text)); ) {
      const callType = m[3]; // query or mutation
      const callName = m[4];
      const resolverSet = callType === 'query' ? queries : mutations;

      // Only validate if we have schema/resolver information
      if (resolverSet.size > 0 && !resolverSet.has(callName)) {
        const nameStart = m.index + m[0].lastIndexOf(callName);
        push(DiagnosticSeverity.Warning, nameStart, nameStart + callName.length, `Unknown GraphQL ${callType} in assertion: ${callName}`);
      }
    }

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
        push(DiagnosticSeverity.Warning, stepStart, stepStart + step.length, `Unknown step '${step}'. If this is custom middleware, ignore.`);
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

  /**
   * Validates that names referenced in join middleware exist as @async(name) tags
   * in the same pipeline context.
   */
  private validateJoinAsyncReferences(text: string, push: DiagnosticPush): void {
    // Find pipeline context boundaries (routes, named pipelines, query/mutation resolvers)
    // Each context can have its own @async tags and join steps
    const boundaryRe = /(^|\n)\s*(GET|POST|PUT|DELETE|pipeline\s+[A-Za-z_][\w-]*\s*=|query\s+[A-Za-z_][\w-]*\s*=|mutation\s+[A-Za-z_][\w-]*\s*=|describe\s+|config\s+)/gm;

    const contexts: Array<{ start: number; end: number; type: string }> = [];
    let match;

    while ((match = boundaryRe.exec(text)) !== null) {
      const type = match[2].split(/\s/)[0];
      const start = match.index + (match[1] === '\n' ? 1 : 0);

      // Close previous context
      if (contexts.length > 0) {
        contexts[contexts.length - 1].end = start;
      }

      contexts.push({ start, end: text.length, type });
    }

    // Process each pipeline context
    for (const ctx of contexts) {
      // Skip non-pipeline contexts (describe blocks for tests, config blocks)
      if (ctx.type === 'describe' || ctx.type === 'config') continue;

      const slice = text.slice(ctx.start, ctx.end);

      // Collect @async(name) tag names from this context
      const asyncNames = new Set<string>();
      const asyncTagRe = /@async\(\s*([A-Za-z_][\w-]*)\s*\)/g;
      while ((match = asyncTagRe.exec(slice)) !== null) {
        asyncNames.add(match[1]);
      }

      // Find join steps and validate their references
      // Match: |> join: `config` or |> join: "config"
      const joinStepRe = /\|>\s*join\s*:\s*(?:`([^`]*)`|"([^"]*)")/g;
      while ((match = joinStepRe.exec(slice)) !== null) {
        const joinConfig = match[1] ?? match[2];
        if (!joinConfig) continue;

        // Find where the config content starts in the match
        const configStart = match[0].indexOf(joinConfig);
        const joinNames = this.parseJoinConfigNames(joinConfig);

        for (const { name, offset } of joinNames) {
          if (!asyncNames.has(name)) {
            const absStart = ctx.start + match.index + configStart + offset;
            push(
              DiagnosticSeverity.Error,
              absStart,
              absStart + name.length,
              `Unknown async task '${name}'. No @async(${name}) tag found in this pipeline.`
            );
          }
        }
      }
    }
  }

  /**
   * Parses a join config string and extracts the task names with their positions.
   * Handles: comma-separated names, JSON arrays, quoted and unquoted names.
   * Examples: "user,posts,todos", '["github","bitcoin"]', "req1, req2, req3"
   */
  private parseJoinConfigNames(config: string): Array<{ name: string; offset: number }> {
    const results: Array<{ name: string; offset: number }> = [];

    // Match: "name", 'name', or bare identifier
    // This handles all formats: plain comma-separated, JSON arrays, quoted strings
    const nameRe = /"([A-Za-z_][\w-]*)"|'([A-Za-z_][\w-]*)'|\b([A-Za-z_][\w-]*)\b/g;

    let match;
    while ((match = nameRe.exec(config)) !== null) {
      const name = match[1] ?? match[2] ?? match[3];
      if (!name) continue;

      // Calculate offset: +1 if quoted to skip the opening quote
      const offset = match.index + (match[1] !== undefined || match[2] !== undefined ? 1 : 0);
      results.push({ name, offset });
    }

    return results;
  }

  /**
   * Validates that Handlebars template variables ({{varName}}) used in test blocks
   * are defined with 'let' statements within the same test or describe block.
   */
  private validateTestLetVariables(text: string, push: DiagnosticPush, program?: { describes: Array<Describe> }): void {
    if (!program || !program.describes) return;

    // Helper to find the offset of a substring in text after a given position
    const findOffset = (searchAfter: number, searchFor: string): number => {
      const idx = text.indexOf(searchFor, searchAfter);
      return idx !== -1 ? idx : searchAfter;
    };

    // Process each describe block
    for (const describe of program.describes) {
      // Find the describe block in the text
      const describeRe = new RegExp(`\\bdescribe\\s+"${escapeRegex(describe.name || '')}"`, 'g');
      const describeMatch = describeRe.exec(text);
      if (!describeMatch) continue;

      const describeStart = describeMatch.index;

      // Collect describe-level variables for validating describe-level mocks
      const describeVariables = new Set<string>();
      if (describe.variables) {
        for (const variable of describe.variables) {
          describeVariables.add(variable.name);
        }
      }

      // Helper to validate a string and report undefined variables (reusable)
      const makeValidator = (definedVars: Set<string>, searchAfter: number) => {
        return (str: string | undefined) => {
          if (!str) return;

          const offset = findOffset(searchAfter, str.substring(0, Math.min(50, str.length)));

          // Check Handlebars variables {{varName}}
          const handlebarsVars = extractHandlebarsVariables(str, offset);
          for (const v of handlebarsVars) {
            if (!definedVars.has(v.name)) {
              push(
                DiagnosticSeverity.Error,
                v.start,
                v.end,
                `Variable '${v.name}' is not defined in this test block`
              );
            }
          }

          // Check JQ variables $varName
          const jqVars = extractJqVariables(str, offset);
          for (const v of jqVars) {
            if (!definedVars.has(v.name)) {
              push(
                DiagnosticSeverity.Error,
                v.start,
                v.end,
                `Variable '${v.name}' is not defined in this test block`
              );
            }
          }
        };
      };

      // Validate describe-level mocks
      if (describe.mocks) {
        const validateDescribeMock = makeValidator(describeVariables, describeStart);
        for (const mock of describe.mocks) {
          if (mock.returnValue) {
            validateDescribeMock(mock.returnValue);
          }
        }
      }

      if (!describe.tests) continue;

      for (const test of describe.tests) {
        if (!test.name) continue;

        // Find this specific test in the text after the describe block
        const itRe = new RegExp(`\\bit\\s+"${escapeRegex(test.name)}"`, 'g');
        itRe.lastIndex = describeStart;
        const itMatch = itRe.exec(text);
        if (!itMatch) continue;

        const testStart = itMatch.index;

        // Track which variables are defined in this test
        // Start with describe-level variables
        const definedVariables = new Set<string>();
        if (describe.variables) {
          for (const variable of describe.variables) {
            definedVariables.add(variable.name);
          }
        }
        // Test-level variables override describe-level
        if (test.variables) {
          for (const variable of test.variables) {
            definedVariables.add(variable.name);
          }
        }

        // Use makeValidator for test-level validation
        const validateString = makeValidator(definedVariables, testStart);

        // Validate path in 'when calling' statements
        if (test.when && test.when.kind === 'CallingRoute' && test.when.path) {
          validateString(test.when.path);
        }

        // Validate input, body, headers, cookies
        validateString(test.input);
        validateString(test.body);
        validateString(test.headers);
        validateString(test.cookies);

        // Validate conditions (assertions)
        if (test.conditions) {
          for (const condition of test.conditions) {
            if (condition.value) {
              validateString(condition.value);
            }
            if (condition.selector) {
              validateString(condition.selector);
            }
          }
        }

        // Validate mock return values
        if (test.mocks) {
          for (const mock of test.mocks) {
            if (mock.returnValue) {
              validateString(mock.returnValue);
            }
          }
        }
      }
    }
  }
}