import { TextDocument } from 'vscode-languageserver-textdocument';
import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';
import { VALID_HTTP_METHODS, KNOWN_MIDDLEWARE, KNOWN_STEPS } from './constants';
import { collectHandlebarsSymbols } from './symbol-collector';
import { WorkspaceManager } from './workspace-manager';
import { SymbolResolver } from './symbol-resolver';
import { Describe, Variable, NamedPipeline, PipelineStep, Program } from 'webpipe-js';
import { findTestContextAtOffset, extractHandlebarsVariables, extractJqVariables, escapeRegex } from './test-variable-utils';
import { getPipelineReferenceFromStep, walkPipelineSteps } from './ast-utils';

interface DiagnosticPush {
  (severity: DiagnosticSeverity, start: number, end: number, message: string): void;
}

interface DiagnosticSink {
  sendDiagnostics(payload: { uri: string; diagnostics: Diagnostic[] }): void;
}

export class DocumentValidator {
  private symbolResolver: SymbolResolver;

  constructor(private workspace: WorkspaceManager, private sink?: DiagnosticSink) {
    this.symbolResolver = new SymbolResolver();
  }

  collectDiagnostics(doc: TextDocument): Diagnostic[] {
    const text = this.workspace.getText(doc);
    const diagnostics: Diagnostic[] = [];

    this.validateTrailingNewline(text, doc, diagnostics);
    this.validateReferences(text, doc, diagnostics);

    return diagnostics;
  }

  async validateDocument(doc: TextDocument): Promise<Diagnostic[]> {
    const diagnostics = this.collectDiagnostics(doc);
    this.sink?.sendDiagnostics({ uri: doc.uri, diagnostics });
    return diagnostics;
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
      const { program, diagnostics: parseDiagnostics } = this.workspace.get(doc);
      for (const d of parseDiagnostics) {
        push(
          d.severity === 'error' ? DiagnosticSeverity.Error : d.severity === 'warning' ? DiagnosticSeverity.Warning : DiagnosticSeverity.Information,
          d.start,
          d.end,
          d.message
        );
      }

      // Get merged program for GraphQL validation (includes imported schemas/resolvers)
      const mergedProgram = this.workspace.computeMergedProgram(doc.uri) || program;

      const { variablesByType, pipelineNames } = this.collectDeclarations(push, program);
      const routePatterns = this.validateRoutes(push, program, doc, mergedProgram);

      // Validate import paths (multi-file support)
      this.validateImportPaths(program, doc, push);

      // Unified AST-based step validation (includes auth flows, result blocks, variable/pipeline refs, unknown steps)
      this.validatePipelineSteps(mergedProgram, variablesByType, pipelineNames, push, doc);

      // Unified AST-based BDD validation (replaces regex-based when clause validation)
      this.validateBDDReferences(program, variablesByType, pipelineNames, routePatterns, push, doc);

      // Unified AST-based mock validation
      this.validateMockReferences(mergedProgram, variablesByType, pipelineNames, push, doc);

      this.validateJsonBlocks(text, push);
      this.validateMiddlewareReferences(text, push);
      this.validateConfigBlocks(text, push, program);
      this.validateUnknownVariableTypes(text, push, program);
      this.validateAssertions(text, push, program);
      this.validateHandlebarsPartialReferences(text, push, program, doc);
      // Use merged program to validate routes and pipelines from imports
      this.validateJoinAsyncReferences(mergedProgram, text, push);
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

  private collectDeclarations(push: DiagnosticPush, program?: Program): {
    variablesByType: Map<string, Set<string>>;
    pipelineNames: Set<string>;
  } {
    const variablesByType = new Map<string, Set<string>>();
    const pipelineNames = new Set<string>();

    if (!program) return { variablesByType, pipelineNames };

    // Build variable declarations from AST and detect duplicates
    const varDeclByKey = new Map<string, Variable>();
    for (const v of program.variables) {
      if (!variablesByType.has(v.varType)) {
        variablesByType.set(v.varType, new Set());
      }
      variablesByType.get(v.varType)!.add(v.name);

      // Check for duplicates using a composite key
      const key = `${v.varType}::${v.name}`;
      if (varDeclByKey.has(key)) {
        // Duplicate found - calculate position of the name within the declaration
        const nameStart = v.start + v.varType.length + 1; // skip "varType "
        push(DiagnosticSeverity.Warning, nameStart, nameStart + v.name.length, `Duplicate ${v.varType} variable: ${v.name}`);
      }
      varDeclByKey.set(key, v);
    }

    // Build pipeline declarations from AST and detect duplicates
    const pipelineDeclByName = new Map<string, NamedPipeline>();
    for (const p of program.pipelines) {
      pipelineNames.add(p.name);

      if (pipelineDeclByName.has(p.name)) {
        // Duplicate found
        const nameStart = p.start + 'pipeline '.length;
        push(DiagnosticSeverity.Warning, nameStart, nameStart + p.name.length, `Duplicate pipeline: ${p.name}`);
      }
      pipelineDeclByName.set(p.name, p);
    }

    return { variablesByType, pipelineNames };
  }

  private validateRoutes(push: DiagnosticPush, program: Program | undefined, doc: TextDocument, mergedProgram: Program | undefined): Array<{ method: string; path: string; regex: RegExp }> {
    const routePatterns: Array<{ method: string; path: string; regex: RegExp }> = [];

    if (!program) return routePatterns;

    // Use merged program if available (includes routes from imports)
    const programToValidate = mergedProgram || program;

    // Use AST to validate routes
    const routes = new Set<string>();
    for (const route of programToValidate.routes) {
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

    // Add automatic GraphQL endpoint if configured
    // This mirrors the server behavior in server.rs lines 335-369
    // Get all configs including imported ones
    const allConfigs = this.workspace.getAllConfigs(doc.uri);
    const graphqlConfig = allConfigs.find((c: any) => c.name === 'graphql');
    // Use merged program (passed as parameter) to check for GraphQL schema (includes imported schemas)
    if (graphqlConfig && mergedProgram && mergedProgram.graphqlSchema) {
      const endpointProp = graphqlConfig.properties.find((p: any) => p.key === 'endpoint');
      if (endpointProp && endpointProp.value.kind === 'String') {
        const endpoint = endpointProp.value.value;
        const routeKey = `POST ${endpoint}`;

        // Only add if user hasn't defined this route explicitly (same logic as server.rs)
        if (!routes.has(routeKey)) {
          routes.add(routeKey);

          // Build matching regex for calls
          const pattern = '^' + endpoint
            .replace(/[.*+?^${}()|[\]\\]/g, (ch: string) => `\\${ch}`)
            .replace(/:(?:[A-Za-z_][\w-]*)/g, '[^/]+') + '$';

          try {
            routePatterns.push({ method: 'POST', path: endpoint, regex: new RegExp(pattern) });
          } catch (_e) {
            // Ignore bad pattern
          }
        }
      }
    }

    return routePatterns;
  }

  /**
   * Validates import paths (multi-file support)
   * Checks: import files exist, no circular imports
   */
  private validateImportPaths(program: Program, doc: TextDocument, push: DiagnosticPush): void {
    if (!program.imports || program.imports.length === 0) {
      return;
    }

    const metadata = this.workspace.getDocument(doc.uri);
    if (!metadata) {
      return;
    }

    // Validate each import
    for (let i = 0; i < program.imports.length; i++) {
      const imp = program.imports[i];
      const resolved = metadata.imports[i];

      if (!resolved || !resolved.resolved) {
        // Import resolution failed
        const errorMsg = resolved?.error || `Import file not found: ${imp.path}`;
        push(DiagnosticSeverity.Error, imp.start, imp.end, errorMsg);
      }
    }
  }

  /**
   * Validates all pipeline steps using AST traversal.
   * Checks: variable references, pipeline references, unknown step names, auth flows, and result branches.
   */
  private validatePipelineSteps(program: Program, variablesByType: Map<string, Set<string>>, pipelineNames: Set<string>, push: DiagnosticPush, doc: TextDocument): void {
    for (const step of walkPipelineSteps(program)) {
      // Handle Regular steps
      if (step.kind === 'Regular') {
        const stepName = step.name;
        const pipelineRef = getPipelineReferenceFromStep(step);

        // Validate pipeline references (|> pipeline: Name or |> loader(...): Name)
        if (pipelineRef) {
          const name = pipelineRef.name;
          const refStart = pipelineRef.offset;

          if (!pipelineRef.shorthand && this.symbolResolver.isScoped(name)) {
            const resolved = this.symbolResolver.resolveReference(
              doc.uri,
              name,
              (uri) => this.workspace.getDocument(uri)
            );

            if (!resolved) {
              const alias = this.symbolResolver.getAlias(name);
              const symbolName = this.symbolResolver.getSymbolName(name);
              const metadata = this.workspace.getDocument(doc.uri);
              const hasImport = metadata?.imports?.some(i => i.alias === alias);
              const msg = hasImport
                ? `Pipeline '${symbolName}' not found in module '${alias}'`
                : `Unknown import alias '${alias}'`;
              push(DiagnosticSeverity.Error, refStart, refStart + name.length, msg);
            }
          } else if (!pipelineNames.has(name)) {
            push(DiagnosticSeverity.Error, refStart, refStart + name.length, `Unknown pipeline: ${name}`);
          }
          continue;
        }

        // Validate auth flow configurations
        if (stepName === 'auth' && step.configType === 'quoted') {
          const flow = step.config;
          const ok = flow === 'optional' || flow === 'required' || flow === 'login' || flow === 'register' || flow === 'logout' || flow.startsWith('type:');
          if (!ok) {
            const configStart = step.configStart ?? step.start;
            push(DiagnosticSeverity.Warning, configStart, configStart + flow.length, `Unknown auth flow: ${flow}`);
          }
        }

        // Validate variable references (|> pg: myQuery)
        if (step.configType === 'identifier') {
          const varName = step.config;
          const configStart = step.configStart ?? step.start;

          // Handle scoped references (cross-file)
          if (this.symbolResolver.isScoped(varName)) {
            const resolved = this.symbolResolver.resolveVariableReference(
              doc.uri,
              stepName,
              varName,
              (uri) => this.workspace.getDocument(uri)
            );

            if (!resolved) {
              const alias = this.symbolResolver.getAlias(varName);
              const symbolName = this.symbolResolver.getSymbolName(varName);
              const metadata = this.workspace.getDocument(doc.uri);
              const hasImport = metadata?.imports?.some(i => i.alias === alias);
              const msg = hasImport
                ? `Variable '${symbolName}' not found in module '${alias}'`
                : `Unknown import alias '${alias}'`;
              push(DiagnosticSeverity.Error, configStart, configStart + varName.length, msg);
            }
          } else {
            // Local reference - validate as before
            const declared = variablesByType.get(stepName);
            if (!declared || !declared.has(varName)) {
              push(DiagnosticSeverity.Error, configStart, configStart + varName.length, `Unknown ${stepName} variable: ${varName}`);
            }
          }
        }

        // Validate unknown step names using precise AST positions
        if (!KNOWN_STEPS.has(stepName) && !KNOWN_MIDDLEWARE.has(stepName)) {
          push(DiagnosticSeverity.Warning, step.nameStart, step.nameEnd, `Unknown step '${stepName}'. If this is custom middleware, ignore.`);
        }
      }

      // Handle Result steps - validate status codes and check for duplicate branch types
      else if (step.kind === 'Result') {
        const seenTypes = new Set<string>();
        for (const branch of step.branches) {
          const status = branch.statusCode;

          // Validate status code range
          if (status < 100 || status > 599) {
            push(DiagnosticSeverity.Error, branch.start, branch.start + String(status).length, `Invalid HTTP status code: ${status}`);
          }

          // Check for duplicate branch types
          if (branch.branchType.kind === 'Custom') {
            const typeName = branch.branchType.name;
            if (seenTypes.has(typeName)) {
              push(DiagnosticSeverity.Warning, branch.start, branch.start + typeName.length, `Duplicate result branch type: ${typeName}`);
            }
            seenTypes.add(typeName);
          } else if (branch.branchType.kind === 'Ok') {
            if (seenTypes.has('Ok')) {
              push(DiagnosticSeverity.Warning, branch.start, branch.end, 'Duplicate result branch type: Ok');
            }
            seenTypes.add('Ok');
          }
        }
      }
    }
  }

  /**
   * Validates test 'when' clauses using AST.
   */
  private validateBDDReferences(program: Program, variablesByType: Map<string, Set<string>>, pipelineNames: Set<string>, routePatterns: Array<{ method: string; path: string; regex: RegExp }>, push: DiagnosticPush, doc: TextDocument): void {
    if (!program) return;

    for (const describe of program.describes) {
      for (const test of describe.tests) {
        const when = test.when;

        if (when.kind === 'ExecutingPipeline') {
          // Validate: when executing pipeline <name>
          if (this.symbolResolver.isScoped(when.name)) {
            const resolved = this.symbolResolver.resolveReference(
              doc.uri,
              when.name,
              (uri) => this.workspace.getDocument(uri)
            );

            if (!resolved) {
              const alias = this.symbolResolver.getAlias(when.name);
              const symbolName = this.symbolResolver.getSymbolName(when.name);
              const metadata = this.workspace.getDocument(doc.uri);
              const hasImport = metadata?.imports?.some(i => i.alias === alias);
              const msg = hasImport
                ? `Pipeline '${symbolName}' not found in module '${alias}'`
                : `Unknown import alias '${alias}'`;
              push(DiagnosticSeverity.Error, when.nameStart, when.nameStart + when.name.length, msg);
            }
          } else if (!pipelineNames.has(when.name)) {
            push(DiagnosticSeverity.Error, when.nameStart, when.nameStart + when.name.length, `Unknown pipeline: ${when.name}`);
          }
        } else if (when.kind === 'ExecutingVariable') {
          // Validate: when executing variable <type> <name>
          if (this.symbolResolver.isScoped(when.name)) {
            const resolved = this.symbolResolver.resolveVariableReference(
              doc.uri,
              when.varType,
              when.name,
              (uri) => this.workspace.getDocument(uri)
            );

            if (!resolved) {
              const alias = this.symbolResolver.getAlias(when.name);
              const symbolName = this.symbolResolver.getSymbolName(when.name);
              const metadata = this.workspace.getDocument(doc.uri);
              const hasImport = metadata?.imports?.some(i => i.alias === alias);
              const msg = hasImport
                ? `Variable '${symbolName}' not found in module '${alias}'`
                : `Unknown import alias '${alias}'`;
              push(DiagnosticSeverity.Error, when.nameStart, when.nameStart + when.name.length, msg);
            }
          } else {
            const declared = variablesByType.get(when.varType);
            if (!declared || !declared.has(when.name)) {
              push(DiagnosticSeverity.Error, when.nameStart, when.nameStart + when.name.length, `Unknown ${when.varType} variable: ${when.name}`);
            }
          }
        } else if (when.kind === 'CallingRoute') {
          // Validate: when calling METHOD /path
          if (!VALID_HTTP_METHODS.has(when.method)) {
            // Use precise method position from AST
            push(DiagnosticSeverity.Error, when.methodStart, when.methodStart + when.method.length, `Unknown HTTP method: ${when.method}`);
          }

          // Validate route exists
          const path = when.path.split('?')[0];
          const anyMatch = routePatterns.some(r => r.method === when.method && r.regex.test(path));
          if (!anyMatch) {
            // Use precise path position from AST
            push(DiagnosticSeverity.Error, when.pathStart, when.pathStart + path.length, `Unknown route: ${when.method} ${path}`);
          }
        }
      }
    }
  }

  /**
   * Validates mock references using AST.
   * Builds GraphQL schema info from AST, then validates all mocks in tests.
   */
  private validateMockReferences(program: Program, variablesByType: Map<string, Set<string>>, pipelineNames: Set<string>, push: DiagnosticPush, doc: TextDocument): void {
    if (!program) return;

    // Build GraphQL resolver sets from AST
    const queries = new Set<string>();
    const mutations = new Set<string>();

    // Extract from GraphQL schema if present
    if (program.graphqlSchema) {
      const schema = program.graphqlSchema.sdl;
      const queryTypeMatch = /type\s+Query\s*\{([^}]*)\}/s.exec(schema);
      if (queryTypeMatch) {
        const queryFields = queryTypeMatch[1].matchAll(/\s*([A-Za-z_][\w-]*)\s*(?:\([^)]*\))?\s*:\s*/g);
        for (const match of queryFields) {
          queries.add(match[1]);
        }
      }

      const mutationTypeMatch = /type\s+Mutation\s*\{([^}]*)\}/s.exec(schema);
      if (mutationTypeMatch) {
        const mutationFields = mutationTypeMatch[1].matchAll(/\s*([A-Za-z_][\w-]*)\s*(?:\([^)]*\))?\s*:\s*/g);
        for (const match of mutationFields) {
          mutations.add(match[1]);
        }
      }
    }

    // Add query and mutation resolvers from AST
    for (const query of program.queries) {
      queries.add(query.name);
    }
    for (const mutation of program.mutations) {
      mutations.add(mutation.name);
    }

    // Validate mocks in all tests
    for (const describe of program.describes) {
      // Validate describe-level mocks
      for (const mock of describe.mocks) {
        this.validateMock(mock, variablesByType, pipelineNames, queries, mutations, push, doc);
      }

      // Validate test-level mocks
      for (const test of describe.tests) {
        for (const mock of test.mocks) {
          this.validateMock(mock, variablesByType, pipelineNames, queries, mutations, push, doc);
        }
      }
    }
  }

  /**
   * Validates a single mock target.
   * Target formats:
   * - "pipeline Name"
   * - "query name" or "mutation name"
   * - "type.name"
   */
  private validateMock(
    mock: { target: string; targetStart: number; returnValue: string; start: number; end: number },
    variablesByType: Map<string, Set<string>>,
    pipelineNames: Set<string>,
    queries: Set<string>,
    mutations: Set<string>,
    push: DiagnosticPush,
    doc: TextDocument
  ): void {
    const target = mock.target;

    // Mock pipeline: "pipeline Name"
    if (target.startsWith('pipeline ')) {
      const name = target.substring('pipeline '.length);
      const nameStart = mock.targetStart + 'pipeline '.length;

      if (this.symbolResolver.isScoped(name)) {
        const resolved = this.symbolResolver.resolveReference(
          doc.uri,
          name,
          (uri) => this.workspace.getDocument(uri)
        );

        if (!resolved) {
          const alias = this.symbolResolver.getAlias(name);
          const symbolName = this.symbolResolver.getSymbolName(name);
          const metadata = this.workspace.getDocument(doc.uri);
          const hasImport = metadata?.imports?.some(i => i.alias === alias);
          const msg = hasImport
            ? `Pipeline '${symbolName}' not found in module '${alias}'`
            : `Unknown import alias '${alias}'`;
          push(DiagnosticSeverity.Error, nameStart, mock.targetStart + target.length, msg);
        }
      } else if (!pipelineNames.has(name)) {
        push(DiagnosticSeverity.Error, nameStart, mock.targetStart + target.length, `Unknown pipeline in mock: ${name}`);
      }
      return;
    }

    // Mock GraphQL: "query name" or "mutation name"
    if (target.startsWith('query ')) {
      const name = target.substring('query '.length);
      if (queries.size > 0 && !queries.has(name)) {
        push(DiagnosticSeverity.Warning, mock.targetStart + 'query '.length, mock.targetStart + target.length, `Unknown GraphQL query in mock: ${name}`);
      }
      return;
    }

    if (target.startsWith('mutation ')) {
      const name = target.substring('mutation '.length);
      if (mutations.size > 0 && !mutations.has(name)) {
        push(DiagnosticSeverity.Warning, mock.targetStart + 'mutation '.length, mock.targetStart + target.length, `Unknown GraphQL mutation in mock: ${name}`);
      }
      return;
    }

    // Mock variable: "type.name"
    const dotIndex = target.indexOf('.');
    if (dotIndex > 0) {
      const varType = target.substring(0, dotIndex);
      const varName = target.substring(dotIndex + 1);

      // Skip GraphQL mocks (handled above)
      if (varType === 'query' || varType === 'mutation') {
        return;
      }

      const nameStart = mock.targetStart + dotIndex + 1;

      // Handle pipeline mocks in dot notation (pipeline.name)
      if (varType === 'pipeline') {
        if (this.symbolResolver.isScoped(varName)) {
          const resolved = this.symbolResolver.resolveReference(
            doc.uri,
            varName,
            (uri) => this.workspace.getDocument(uri)
          );

          if (!resolved) {
            const alias = this.symbolResolver.getAlias(varName);
            const symbolName = this.symbolResolver.getSymbolName(varName);
            const metadata = this.workspace.getDocument(doc.uri);
            const hasImport = metadata?.imports?.some(i => i.alias === alias);
            const msg = hasImport
              ? `Pipeline '${symbolName}' not found in module '${alias}'`
              : `Unknown import alias '${alias}'`;
            push(DiagnosticSeverity.Error, nameStart, mock.targetStart + target.length, msg);
          }
        } else if (!pipelineNames.has(varName)) {
          push(DiagnosticSeverity.Error, nameStart, mock.targetStart + target.length, `Unknown pipeline in mock: ${varName}`);
        }
        return;
      }

      if (this.symbolResolver.isScoped(varName)) {
        const resolved = this.symbolResolver.resolveVariableReference(
          doc.uri,
          varType,
          varName,
          (uri) => this.workspace.getDocument(uri)
        );

        if (!resolved) {
          const alias = this.symbolResolver.getAlias(varName);
          const symbolName = this.symbolResolver.getSymbolName(varName);
          const metadata = this.workspace.getDocument(doc.uri);
          const hasImport = metadata?.imports?.some(i => i.alias === alias);
          const msg = hasImport
            ? `Variable '${symbolName}' not found in module '${alias}'`
            : `Unknown import alias '${alias}'`;
          push(DiagnosticSeverity.Error, nameStart, mock.targetStart + target.length, msg);
        }
      } else {
        const declared = variablesByType.get(varType);
        if (!declared || !declared.has(varName)) {
          push(DiagnosticSeverity.Error, nameStart, mock.targetStart + target.length, `Unknown ${varType} variable in mock: ${varName}`);
        }
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
    // Allow scoped identifiers with :: in variable names (e.g., pg.db::listUsers)
    const scopedIdent = '[A-Za-z_][\\w-]*(?:::[A-Za-z_][\\w-]*)?';
    const mockHeadValid = new RegExp(`^(with|and)\\s+mock\\s+(?:pipeline\\s+${scopedIdent}|(?:query|mutation)\\s+${scopedIdent}|[A-Za-z_][\\w-]*\\.${scopedIdent}|[A-Za-z_][\\w-]*)\\s+returning\\s+\``);
    for (let m; (m = mockHeadLineRe.exec(text)); ) {
      const lineStart = m.index + (m[1] ? m[1].length : 0);
      const head = m[2].trim();
      if (!mockHeadValid.test(head)) {
        push(DiagnosticSeverity.Error, lineStart, lineStart + head.length, 'Malformed mock syntax. Expected: with|and mock <middleware>[.<name>] returning `...`, with|and mock pipeline <name> returning `...`, or with|and mock query|mutation <name> returning `...`');
      }
    }
  }

  private validateAssertions(text: string, push: DiagnosticPush, program?: Program): void {
    if (!program) return;

    // Extract from AST (NO REGEX on full document!)
    const queries = new Set<string>();
    const mutations = new Set<string>();

    // Extract query/mutation names from AST
    for (const query of program.queries) {
      queries.add(query.name);
    }
    for (const mutation of program.mutations) {
      mutations.add(mutation.name);
    }

    // Also extract from GraphQL schema if available
    if (program.graphqlSchema) {
      const schema = program.graphqlSchema.sdl;

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

    // Validate test assertions using test.conditions (AST data)
    for (const describe of program.describes) {
      for (const test of describe.tests) {
        for (const condition of test.conditions) {
          // Validate call assertions
          if (condition.isCallAssertion && condition.callTarget) {
            // Parse the callTarget: "query users" or "mutation createUser"
            const match = /^(query|mutation)\s+([A-Za-z_][\w-]*)/.exec(condition.callTarget);
            if (match) {
              const callType = match[1];
              const callName = match[2];
              const resolverSet = callType === 'query' ? queries : mutations;

              // Only validate if we have schema/resolver information
              if (resolverSet.size > 0 && !resolverSet.has(callName)) {
                // Find the position of the name in the callTarget
                const nameOffset = condition.start + match[1].length + 1;
                push(
                  DiagnosticSeverity.Warning,
                  nameOffset,
                  nameOffset + callName.length,
                  `Unknown GraphQL ${callType} in assertion: ${callName}`
                );
              }
            }
          }

          // Validate status code assertions
          if (condition.field === 'status' && condition.value) {
            if (condition.comparison === 'is') {
              const code = parseInt(condition.value, 10);
              if (code < 100 || code > 599) {
                push(
                  DiagnosticSeverity.Error,
                  condition.start,
                  condition.end,
                  `Invalid HTTP status code: ${code}`
                );
              }
            } else if (condition.comparison === 'in') {
              // Parse range: "200..299"
              const rangeMatch = /(\d{3})\.\.(\d{3})/.exec(condition.value);
              if (rangeMatch) {
                const a = parseInt(rangeMatch[1], 10);
                const b = parseInt(rangeMatch[2], 10);
                if (a < 100 || a > 599) {
                  push(
                    DiagnosticSeverity.Error,
                    condition.start,
                    condition.end,
                    `Invalid HTTP status code: ${a}`
                  );
                }
                if (b < 100 || b > 599 || b < a) {
                  push(
                    DiagnosticSeverity.Error,
                    condition.start,
                    condition.end,
                    `Invalid HTTP status range end: ${b}`
                  );
                }
              }
            }
          }

          // Validate contentType assertions
          if (condition.field === 'contentType' && condition.comparison !== 'is') {
            push(
              DiagnosticSeverity.Error,
              condition.start,
              condition.end,
              'Malformed contentType assertion. Expected: then|and contentType is "<type>"'
            );
          }
        }
      }
    }
  }

  private validateHandlebarsPartialReferences(text: string, push: DiagnosticPush, program?: any, doc?: TextDocument): void {
    if (!program) return;
    const hb = collectHandlebarsSymbols(text, program);

    // Collect imported Handlebars partials (converted from :: to / for Handlebars compatibility)
    const importedPartials = new Set<string>();
    if (doc && program.imports) {
      // Get the file metadata which has resolved imports
      const metadata = this.workspace.getDocument(doc.uri);
      if (metadata && metadata.imports) {
        for (const resolvedImport of metadata.imports) {
          if (resolvedImport.resolved && resolvedImport.uri) {
            // Ensure the imported file is loaded
            this.workspace.ensureImportLoaded(resolvedImport.uri);
            const importedMeta = this.workspace.getDocument(resolvedImport.uri);

            if (importedMeta && importedMeta.program && importedMeta.program.variables) {
              for (const v of importedMeta.program.variables) {
                if (v.varType === 'handlebars' || v.varType === 'mustache') {
                  // Imported partials are registered as namespace/name (Handlebars syntax)
                  const partialName = `${resolvedImport.alias}/${v.name}`;
                  importedPartials.add(partialName);
                }
              }
            }
          }
        }
      }
    }

    for (const [name, uses] of hb.usagesByName.entries()) {
      const hasGlobalDecl = hb.declByName.has(name);
      // Any inline decl anywhere in the file (best-effort since scope can cross into called partials)
      const hasAnyInlineDecl = hb.inlineDefsByContent.some(entry => entry.inlineByName.has(name) || entry.inlineBlockByName.has(name));

      // Check if it's an imported partial
      const hasImportedDecl = importedPartials.has(name);

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
        if (!hasInlineDeclInSameBlock && !hasGlobalDecl && !hasAnyInlineDecl && !hasImportedDecl) {
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
   * in the same pipeline context using AST.
   */
  private validateJoinAsyncReferences(program: Program, text: string, push: DiagnosticPush): void {
    if (!program) return;

    // Helper to validate a single pipeline
    const validatePipeline = (pipeline: { steps: PipelineStep[]; start: number; end: number }) => {
      // Collect @async(name) tags from this pipeline (using regex on the pipeline slice for now)
      const pipelineText = text.slice(pipeline.start, pipeline.end);
      const asyncNames = new Set<string>();
      const asyncTagRe = /@async\(\s*([A-Za-z_][\w-]*)\s*\)/g;
      let match;
      while ((match = asyncTagRe.exec(pipelineText)) !== null) {
        asyncNames.add(match[1]);
      }

      // Find join steps and validate their references
      const findJoinSteps = (steps: PipelineStep[]): void => {
        for (const step of steps) {
          // Check for join steps using AST-provided parsedJoinTargets
          if (step.kind === 'Regular' && step.name === 'join' && step.parsedJoinTargets) {
            for (const taskName of step.parsedJoinTargets) {
              if (!asyncNames.has(taskName)) {
                // Use config position for error reporting
                const configStart = step.configStart ?? step.start;
                push(
                  DiagnosticSeverity.Error,
                  configStart,
                  step.configEnd ?? (configStart + step.config.length),
                  `Unknown async task '${taskName}'. No @async(${taskName}) tag found in this pipeline.`
                );
              }
            }
          }

          // Recursively check nested pipelines
          if (step.kind === 'If') {
            findJoinSteps(step.condition.steps);
            findJoinSteps(step.thenBranch.steps);
            if (step.elseBranch) findJoinSteps(step.elseBranch.steps);
          } else if (step.kind === 'Dispatch') {
            for (const branch of step.branches) {
              findJoinSteps(branch.pipeline.steps);
            }
            if (step.default) findJoinSteps(step.default.steps);
          } else if (step.kind === 'Foreach') {
            findJoinSteps(step.pipeline.steps);
          } else if (step.kind === 'Result') {
            for (const branch of step.branches) {
              findJoinSteps(branch.pipeline.steps);
            }
          }
        }
      };

      findJoinSteps(pipeline.steps);
    };

    // Validate all route pipelines
    for (const route of program.routes) {
      if (route.pipeline.kind === 'Inline') {
        validatePipeline(route.pipeline.pipeline);
      }
    }

    // Validate all named pipelines
    for (const namedPipeline of program.pipelines) {
      validatePipeline(namedPipeline.pipeline);
    }

    // Validate GraphQL query resolvers
    for (const query of program.queries) {
      validatePipeline(query.pipeline);
    }

    // Validate GraphQL mutation resolvers
    for (const mutation of program.mutations) {
      validatePipeline(mutation.pipeline);
    }

    // Validate GraphQL field resolvers
    for (const resolver of program.resolvers) {
      validatePipeline(resolver.pipeline);
    }

    // Validate feature flags pipeline
    if (program.featureFlags) {
      validatePipeline(program.featureFlags);
    }
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
      // Use AST position directly (NO REGEX!)
      const describeStart = describe.start;

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

        // Use AST position directly (NO REGEX!)
        const testStart = test.start;

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
