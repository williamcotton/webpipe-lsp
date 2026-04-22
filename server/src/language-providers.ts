import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  Location, LocationLink, Position, Hover, MarkupKind, ReferenceParams,
  HoverParams, DefinitionParams, RenameParams, WorkspaceEdit, TextEdit, Connection, Range
} from 'vscode-languageserver/node';
import { Describe, PipelineStep, Route } from 'webpipe-js';
import { getWordAt, createMarkdownCodeBlock } from './utils';
import { RangeAbs, SymbolTable, HandlebarsSymbols } from './types';
import { getMiddlewareDoc, formatMiddlewareHover } from './middleware-docs';
import { getConfigDoc, formatConfigHover } from './config-docs';
import { WorkspaceManager } from './workspace-manager';
import { SymbolResolver } from './symbol-resolver';
import { findTestContextAtOffset, findDescribeBlockRange, getLetVariableValue } from './test-variable-utils';
import { findNodeAtOffset, ASTNode, isImplicitPipelineCallStep } from './ast-utils';

/**
 * Language providers for hover, definition, and references.
 * Uses centralized symbol table from WorkspaceManager with multi-file support.
 */
export class LanguageProviders {
  private symbolResolver: SymbolResolver;

  constructor(private workspace: WorkspaceManager, private connection?: Connection) {
    this.symbolResolver = new SymbolResolver();
  }

  /**
   * Get AST-based context information at a given offset
   * This provides more accurate context than regex-based line parsing
   */
  private getASTContext(offset: number, doc: TextDocument): {
    node: ASTNode | null;
    kind: 'variable' | 'pipeline' | 'config' | 'route' | 'step' | 'test' | 'mock' | 'graphql' | 'unknown';
    varType?: string;
    graphqlType?: 'query' | 'mutation';
    graphqlName?: string;
  } {
    const program = this.workspace.getProgram(doc);
    const node = findNodeAtOffset(program, offset);

    if (!node) {
      return { node: null, kind: 'unknown' };
    }

    const nodeAny = node as any;

    // Determine the kind of node
    if ('varType' in node && 'name' in node && 'value' in node) {
      return { node, kind: 'variable', varType: nodeAny.varType };
    }
    if ('name' in node && 'pipeline' in node && !('varType' in node)) {
      return { node, kind: 'pipeline' };
    }
    if ('name' in node && 'properties' in node) {
      return { node, kind: 'config' };
    }
    if ('method' in node && 'path' in node) {
      return { node, kind: 'route' };
    }
    if ('kind' in node && nodeAny.kind === 'Regular') {
      const step = nodeAny;

      // Check if we're in a GraphQL middleware step
      if (step.name === 'graphql' && step.configType === 'backtick') {
        // Find where the config string actually starts in the document
        // The step.start is the start of the entire step (including |>)
        // We need to find the opening backtick
        const text = this.workspace.getText(doc);
        const configStart = text.indexOf(step.config, step.start);

        if (configStart !== -1) {
          const graphqlInfo = this.getGraphQLOperationAtOffset(
            step.config,
            configStart,
            offset
          );

          if (graphqlInfo) {
            return {
              node,
              kind: 'graphql',
              graphqlType: graphqlInfo.type,
              graphqlName: graphqlInfo.name
            };
          }
        }
      }

      return {
        node,
        kind: 'step',
        varType: isImplicitPipelineCallStep(step) ? 'pipeline' : step.name,
      };
    }
    if ('when' in node && 'conditions' in node) {
      return { node, kind: 'test' };
    }
    if ('target' in node && 'returnValue' in node) {
      return { node, kind: 'mock' };
    }

    // Check if this is a When node (test when clauses)
    if ('kind' in node) {
      const whenNode = nodeAny;
      if (whenNode.kind === 'ExecutingPipeline') {
        // Check if we're hovering over the pipeline name
        if (offset >= whenNode.nameStart && offset < whenNode.nameStart + whenNode.name.length) {
          return { node, kind: 'pipeline' };
        }
      }
      if (whenNode.kind === 'ExecutingVariable') {
        // Check if we're hovering over the variable name
        if (offset >= whenNode.nameStart && offset < whenNode.nameStart + whenNode.name.length) {
          return { node, kind: 'variable', varType: whenNode.varType };
        }
      }
      if (whenNode.kind === 'CallingRoute') {
        // Check if hovering over HTTP method
        if (offset >= whenNode.methodStart && offset < whenNode.methodStart + whenNode.method.length) {
          return { node, kind: 'route' };
        }
        // Check if hovering over route path
        if (offset >= whenNode.pathStart && offset < whenNode.pathStart + whenNode.path.length) {
          return { node, kind: 'route' };
        }
      }
    }

    // Check if we're on a condition node (e.g., call assertion)
    // If so, find the parent test node
    if ((nodeAny.kind === 'CallAssertion' || nodeAny.isCallAssertion) &&
        (nodeAny.callTarget || nodeAny.target)) {
      // Search through all test nodes to find which one contains this offset
      if (program.describes) {
        for (const describe of program.describes) {
          if (describe.tests) {
            for (const test of describe.tests) {
              if (test.start !== undefined && test.end !== undefined &&
                  offset >= test.start && offset <= test.end) {
                return { node: test as any, kind: 'test' };
              }
            }
          }
        }
      }
    }

    return { node, kind: 'unknown' };
  }

  onReferences(params: ReferenceParams, doc: TextDocument): Location[] | null {
    const text = this.workspace.getText(doc);
    const symbols = this.workspace.getSymbols(doc);
    const pos = params.position as Position;
    const offset = doc.offsetAt(pos);
    const wordInfo = getWordAt(text, offset);
    if (!wordInfo) return null;

    const { word } = wordInfo;
    const includeDecl = !!(params as any).context?.includeDeclaration;
    const results: Location[] = [];

    const addDeclAndRefsForPipeline = (name: string) => {
      if (includeDecl) {
        const decl = symbols.pipelinePositions.get(name);
        if (decl) results.push(Location.create(doc.uri, { start: doc.positionAt(decl.start), end: doc.positionAt(decl.start + decl.length) }));
      }
      const refs = symbols.pipelineRefs.get(name) || [];
      for (const r of refs) results.push(Location.create(doc.uri, { start: doc.positionAt(r.start), end: doc.positionAt(r.start + r.length) }));
    };

    const addDeclAndRefsForVariable = (key: { varType: string; varName: string }) => {
      if (includeDecl) {
        const declsByName = symbols.variablePositions.get(key.varType);
        const decl = declsByName?.get(key.varName);
        if (decl) results.push(Location.create(doc.uri, { start: doc.positionAt(decl.start), end: doc.positionAt(decl.start + decl.length) }));
      }
      const refsByName = symbols.variableRefs.get(key.varType);
      const refs = refsByName?.get(key.varName) || [];
      for (const r of refs) results.push(Location.create(doc.uri, { start: doc.positionAt(r.start), end: doc.positionAt(r.start + r.length) }));
    };

    // Use AST-based context detection
    const context = this.getASTContext(offset, doc);

    // Pipeline references
    if (context.kind === 'pipeline' || this.isPipelineContextAST(offset, doc)) {
      addDeclAndRefsForPipeline(word);
      return results.length ? results : null;
    }

    // Variable references
    const variableKey = this.getVariableKeyAST(context, word);
    if (variableKey) {
      addDeclAndRefsForVariable(variableKey);
      return results.length ? results : null;
    }

    // Handlebars context
    const withinContent = symbols.handlebars.contentRanges.some((r: any) => offset >= r.start && offset <= r.end);
    if (withinContent) {
      return this.getHandlebarsReferences(symbols.handlebars, offset, doc, includeDecl);
    }

    return null;
  }

  onHover(params: HoverParams, doc: TextDocument): Hover | null {
    const text = this.workspace.getText(doc);
    const symbols = this.workspace.getSymbols(doc);
    const pos = params.position as Position;
    const offset = doc.offsetAt(pos);
    const wordInfo = getWordAt(text, offset);
    if (!wordInfo) return null;

    const { word } = wordInfo;
    const context = this.getASTContext(offset, doc);

    // Handle scoped references (cross-file hover)
    if (this.symbolResolver.isScoped(word)) {
      // Pipeline or query/mutation hover
      if (context.kind === 'pipeline' || context.kind === 'graphql' || this.isPipelineContextAST(offset, doc)) {
        const resolved = this.symbolResolver.resolveReference(
          doc.uri,
          word,
          (uri) => this.workspace.getDocument(uri)
        );

        if (resolved) {
          const targetMetadata = this.workspace.getDocument(resolved.uri);
          if (targetMetadata) {
            const filename = resolved.uri.split('/').pop() || resolved.uri;
            const snippet = this.extractCodeSnippet(targetMetadata.text, resolved.symbol);
            const md = `**${word}** (imported from \`${filename}\`)\n\n\`\`\`webpipe\n${snippet}\n\`\`\``;
            return { contents: { kind: MarkupKind.Markdown, value: md } };
          }
        }
      }

      // Variable hover
      const variableKey = this.getVariableKeyAST(context, word);
      if (variableKey) {
        const resolved = this.symbolResolver.resolveVariableReference(
          doc.uri,
          variableKey.varType,
          word,
          (uri) => this.workspace.getDocument(uri)
        );

        if (resolved) {
          const targetMetadata = this.workspace.getDocument(resolved.uri);
          if (targetMetadata) {
            const filename = resolved.uri.split('/').pop() || resolved.uri;
            const snippet = this.extractCodeSnippet(targetMetadata.text, resolved.symbol);
            const md = `**${word}** (imported from \`${filename}\`)\n\n\`\`\`webpipe\n${snippet}\n\`\`\``;
            return { contents: { kind: MarkupKind.Markdown, value: md } };
          }
        }
      }
    }

    // Config hover (check first)
    if (context.kind === 'config') {
      const configDoc = getConfigDoc(word);
      if (configDoc) {
        const md = formatConfigHover(configDoc);
        return { contents: { kind: MarkupKind.Markdown, value: md } };
      }
    }

    // Middleware hover (check second, before pipeline)
    if (context.kind === 'step' && context.varType === word) {
      const middlewareDoc = getMiddlewareDoc(word);
      if (middlewareDoc) {
        const md = formatMiddlewareHover(middlewareDoc);
        return { contents: { kind: MarkupKind.Markdown, value: md } };
      }
    }

    // Pipeline keyword hover
    if (context.kind === 'pipeline' && word === 'pipeline') {
      const middlewareDoc = getMiddlewareDoc(word);
      if (middlewareDoc) {
        const md = formatMiddlewareHover(middlewareDoc);
        return { contents: { kind: MarkupKind.Markdown, value: md } };
      }
    }

    // Test let variable hover (check for {{variable}} in test blocks)
    const testLetHover = this.getTestLetVariableHoverAST(text, offset, word, doc);
    if (testLetHover) return testLetHover;

    // Test JQ variable hover (check for $variable in test blocks)
    const testJqHover = this.getTestJqVariableHover(text, offset, word, wordInfo.start, doc);
    if (testJqHover) return testJqHover;

    // Pipeline hover
    if (context.kind === 'pipeline' || this.isPipelineContextAST(offset, doc)) {
      const md = this.formatPipelineHover(text, word, doc);
      if (md) return { contents: { kind: MarkupKind.Markdown, value: md } };
    }

    // Variable hover
    const variableKey = this.getVariableKeyAST(context, word);
    if (variableKey) {
      const md = this.formatVariableHover(text, variableKey.varType, word, doc);
      if (md) return { contents: { kind: MarkupKind.Markdown, value: md } };
    }

    // GraphQL resolver hover (middleware context)
    if (context.kind === 'graphql') {
      const md = this.formatGraphQLHover(
        text,
        context.graphqlType!,
        context.graphqlName!,
        doc
      );
      if (md) return { contents: { kind: MarkupKind.Markdown, value: md } };
    }

    // GraphQL query/mutation hover (mock/call assertion context)
    const graphqlHover = this.getGraphQLHoverAST(context, text, word, offset, doc);
    if (graphqlHover) return graphqlHover;

    // Pipeline hover (mock/call assertion context)
    const pipelineHover = this.getPipelineHoverAST(context, text, offset, doc);
    if (pipelineHover) return pipelineHover;

    // Route calling hover (when calling METHOD /path)
    if (context.kind === 'route' && context.node) {
      const whenNode = context.node as any;
      if (whenNode.kind === 'CallingRoute') {
        const hoverText = this.formatRouteHover(
          text,
          whenNode.method,
          whenNode.path,
          doc
        );
        if (hoverText) {
          return { contents: { kind: MarkupKind.Markdown, value: hoverText } };
        }
      }
    }

    // Handlebars partial hover
    const handlebarsHover = this.getHandlebarsHover(text, offset, word, doc, symbols);
    if (handlebarsHover) return handlebarsHover;

    return null;
  }

  onDefinition(params: DefinitionParams, doc: TextDocument): Location | LocationLink[] | null {
    const text = this.workspace.getText(doc);
    const symbols = this.workspace.getSymbols(doc);
    const pos = params.position as Position;
    const offset = doc.offsetAt(pos);
    const wordInfo = getWordAt(text, offset);
    if (!wordInfo) return null;

    const { word } = wordInfo;
    const context = this.getASTContext(offset, doc);

    // Check for import statement navigation (click on file path in import line)
    const program = this.workspace.getProgram(doc);
    if (program.imports) {
      for (const imp of program.imports) {
        // Check if cursor is on the import path
        if (offset >= imp.start && offset <= imp.end) {
          const metadata = this.workspace.getDocument(doc.uri);
          if (metadata) {
            const resolved = metadata.imports.find(i => i.alias === imp.alias);
            if (resolved && resolved.resolved && resolved.uri) {
              return Location.create(resolved.uri, Range.create(0, 0, 0, 0));
            }
          }
        }
      }
    }

    // Handle scoped references (cross-file navigation)
    if (this.symbolResolver.isScoped(word)) {
      // Pipeline or query/mutation reference
      if (context.kind === 'pipeline' || context.kind === 'graphql' || this.isPipelineContextAST(offset, doc)) {
        const resolved = this.symbolResolver.resolveReference(
          doc.uri,
          word,
          (uri) => this.workspace.getDocument(uri)
        );

        if (resolved) {
          const range = {
            start: Position.create(0, 0),  // Will be calculated from target metadata
            end: Position.create(0, 0)
          };

          // Get the target document to calculate position
          const targetMetadata = this.workspace.getDocument(resolved.uri);
          if (targetMetadata) {
            // Create a virtual TextDocument for position calculation
            const targetDoc = {
              uri: resolved.uri,
              positionAt: (offset: number) => {
                const text = targetMetadata.text;
                let line = 0, col = 0;
                for (let i = 0; i < offset && i < text.length; i++) {
                  if (text[i] === '\n') {
                    line++;
                    col = 0;
                  } else {
                    col++;
                  }
                }
                return Position.create(line, col);
              }
            } as any;

            range.start = targetDoc.positionAt(resolved.symbol.start);
            range.end = targetDoc.positionAt(resolved.symbol.start + resolved.symbol.length);
          }

          return Location.create(resolved.uri, range);
        }
      }

      // Variable reference
      const variableKey = this.getVariableKeyAST(context, word);
      if (variableKey) {
        const resolved = this.symbolResolver.resolveVariableReference(
          doc.uri,
          variableKey.varType,
          word,
          (uri) => this.workspace.getDocument(uri)
        );

        if (resolved) {
          const range = {
            start: Position.create(0, 0),
            end: Position.create(0, 0)
          };

          // Get the target document to calculate position
          const targetMetadata = this.workspace.getDocument(resolved.uri);
          if (targetMetadata) {
            const targetDoc = {
              uri: resolved.uri,
              positionAt: (offset: number) => {
                const text = targetMetadata.text;
                let line = 0, col = 0;
                for (let i = 0; i < offset && i < text.length; i++) {
                  if (text[i] === '\n') {
                    line++;
                    col = 0;
                  } else {
                    col++;
                  }
                }
                return Position.create(line, col);
              }
            } as any;

            range.start = targetDoc.positionAt(resolved.symbol.start);
            range.end = targetDoc.positionAt(resolved.symbol.start + resolved.symbol.length);
          }

          return Location.create(resolved.uri, range);
        }
      }
    }

    // Pipeline definition (local)
    if (context.kind === 'pipeline' || this.isPipelineContextAST(offset, doc)) {
      const hit = symbols.pipelinePositions.get(word);
      if (hit) {
        const range = { start: doc.positionAt(hit.start), end: doc.positionAt(hit.start + hit.length) };
        return Location.create(doc.uri, range);
      }
    }

    // Variable definition
    const variableKey = this.getVariableKeyAST(context, word);
    if (variableKey) {
      const declsByName = symbols.variablePositions.get(variableKey.varType);
      const hit = declsByName?.get(variableKey.varName);
      if (hit) {
        const range = { start: doc.positionAt(hit.start), end: doc.positionAt(hit.start + hit.length) };
        return Location.create(doc.uri, range);
      }
    }

    // GraphQL resolver definition (middleware context)
    if (context.kind === 'graphql') {
      const resolverMap = context.graphqlType === 'query'
        ? symbols.queryPositions
        : symbols.mutationPositions;

      const hit = resolverMap.get(context.graphqlName!);
      if (hit) {
        const range = {
          start: doc.positionAt(hit.start),
          end: doc.positionAt(hit.start + hit.length)
        };
        return Location.create(doc.uri, range);
      }
    }

    // GraphQL resolver definition (mock/call assertion context)
    const graphqlDef = this.getGraphQLDefinitionAST(context, word, symbols, doc, offset);
    if (graphqlDef) return graphqlDef;

    // Pipeline definition (mock/call assertion context)
    const pipelineDef = this.getPipelineDefinitionAST(context, symbols, doc, offset);
    if (pipelineDef) return pipelineDef;

    // Test let variable definition (Handlebars {{var}})
    const testLetDefinition = this.getTestLetVariableDefinitionAST(text, offset, word, doc);
    if (testLetDefinition) return testLetDefinition;

    // Test JQ variable definition ($var)
    const testJqDefinition = this.getTestJqVariableDefinition(text, offset, word, wordInfo.start, doc);
    if (testJqDefinition) return testJqDefinition;

    // Handlebars definition
    const handlebarsDefinition = this.getHandlebarsDefinition(symbols.handlebars, offset, doc);
    if (handlebarsDefinition) return handlebarsDefinition;

    // Route calling definition (when calling METHOD /path)
    if (context.kind === 'route' && context.node) {
      const whenNode = context.node as any;
      if (whenNode.kind === 'CallingRoute') {
        const program = this.workspace.getProgram(doc);
        const matchingRoute = this.findMatchingRoute(
          whenNode.method,
          whenNode.path,
          program.routes
        );

        if (matchingRoute) {
          // Navigate to route definition, position cursor at method
          const targetRange = {
            start: doc.positionAt(matchingRoute.start),
            end: doc.positionAt(matchingRoute.start + matchingRoute.method.length)
          };

          // Highlight the entire "METHOD /path" in the source (when calling line)
          const originRange = {
            start: doc.positionAt(whenNode.methodStart),
            end: doc.positionAt(whenNode.pathStart + whenNode.path.length)
          };

          // Return DefinitionLink with origin range to control the blue underline
          return [{
            targetUri: doc.uri,
            targetRange: targetRange,
            targetSelectionRange: targetRange,
            originSelectionRange: originRange
          }];
        }
      }
    }

    return null;
  }

  onRename(params: RenameParams, doc: TextDocument): WorkspaceEdit | null {
    const text = this.workspace.getText(doc);
    const symbols = this.workspace.getSymbols(doc);
    const pos = params.position as Position;
    const offset = doc.offsetAt(pos);
    const wordInfo = getWordAt(text, offset);
    if (!wordInfo) return null;

    const { word } = wordInfo;
    const newName = params.newName;
    const context = this.getASTContext(offset, doc);
    const edits: TextEdit[] = [];

    // Pipeline rename
    if (context.kind === 'pipeline' || this.isPipelineContextAST(offset, doc)) {
      const decl = symbols.pipelinePositions.get(word);
      if (decl) {
        edits.push(TextEdit.replace(
          { start: doc.positionAt(decl.start), end: doc.positionAt(decl.start + decl.length) },
          newName
        ));
      }
      const refs = symbols.pipelineRefs.get(word) || [];
      for (const r of refs) {
        edits.push(TextEdit.replace(
          { start: doc.positionAt(r.start), end: doc.positionAt(r.start + r.length) },
          newName
        ));
      }

      if (edits.length > 0) {
        return { changes: { [doc.uri]: edits } };
      }
    }

    // Variable rename
    const variableKey = this.getVariableKeyAST(context, word);
    if (variableKey) {
      const declsByName = symbols.variablePositions.get(variableKey.varType);
      const decl = declsByName?.get(variableKey.varName);
      if (decl) {
        edits.push(TextEdit.replace(
          { start: doc.positionAt(decl.start), end: doc.positionAt(decl.start + decl.length) },
          newName
        ));
      }
      const refsByName = symbols.variableRefs.get(variableKey.varType);
      const refs = refsByName?.get(variableKey.varName) || [];
      for (const r of refs) {
        edits.push(TextEdit.replace(
          { start: doc.positionAt(r.start), end: doc.positionAt(r.start + r.length) },
          newName
        ));
      }

      if (edits.length > 0) {
        return { changes: { [doc.uri]: edits } };
      }
    }

    // Handlebars partial rename
    const withinContent = symbols.handlebars.contentRanges.some((r: RangeAbs) => offset >= r.start && offset <= r.end);
    if (withinContent) {
      for (const [name, uses] of symbols.handlebars.usagesByName.entries()) {
        for (const u of uses) {
          if (offset >= u.start && offset <= u.end) {
            // Rename declaration
            const decl = symbols.handlebars.declByName.get(name);
            if (decl) {
              edits.push(TextEdit.replace(
                { start: doc.positionAt(decl.nameStart), end: doc.positionAt(decl.nameEnd) },
                newName
              ));
            }

            // Rename all usages
            for (const r of uses) {
              edits.push(TextEdit.replace(
                { start: doc.positionAt(r.start), end: doc.positionAt(r.end) },
                newName
              ));
            }

            if (edits.length > 0) {
              return { changes: { [doc.uri]: edits } };
            }
          }
        }
      }
    }

    return null;
  }

  /**
   * AST-based GraphQL hover
   */
  private getGraphQLHoverAST(context: ReturnType<typeof this.getASTContext>, text: string, word: string, offset: number, doc: TextDocument): Hover | null {
    if (context.kind === 'mock' && context.node) {
      const mockNode = context.node as any;
      const target = mockNode.target || '';

      // Check if it's a GraphQL mock: "query <name>" or "mutation <name>"
      const match = /^(query|mutation)[.\s]+([A-Za-z_][\w-]*)/.exec(target);

      if (match) {
        const operationType = match[1];
        const operationName = match[2];

        // Get the precise range of the operation name
        const nameRange = this.getGraphQLNameRange(text, mockNode.start, mockNode.end, operationType, operationName);

        if (nameRange) {
          // Check if cursor is within the name range
          if (offset >= nameRange.start && offset <= nameRange.end) {
            const md = this.formatGraphQLHover(text, operationType, operationName, doc);
            if (md) {
              return { contents: { kind: MarkupKind.Markdown, value: md } };
            }
          }
        }
      }
    }

    if (context.kind === 'test' && context.node) {
      // Check for GraphQL call assertions in test conditions
      const testNode = context.node as any;
      if (testNode.conditions) {
        for (const cond of testNode.conditions) {
          // Check both 'kind' and 'isCallAssertion' for compatibility
          const isCallAssertion = cond.kind === 'CallAssertion' || cond.isCallAssertion;
          const target = cond.target || cond.callTarget;

          if (isCallAssertion && target) {
            // Call assertions use dot notation: "mutation.deleteTodo"
            // Mocks use space notation: "mutation deleteTodo"
            const match = /^(query|mutation)[.\s]+([A-Za-z_][\w-]*)/.exec(target);

            if (match) {
              const operationType = match[1];
              const operationName = match[2];

              // Get the precise range of the operation name
              const nameRange = this.getGraphQLNameRange(text, testNode.start, testNode.end, operationType, operationName);

              if (nameRange) {
                // Check if cursor is within the name range
                if (offset >= nameRange.start && offset <= nameRange.end) {
                  const md = this.formatGraphQLHover(text, operationType, operationName, doc);
                  if (md) {
                    return { contents: { kind: MarkupKind.Markdown, value: md } };
                  }
                }
              }
            }
          }
        }
      }
    }

    return null;
  }

  /**
   * AST-based pipeline hover for mocks and call assertions
   * Handles "with mock pipeline <name>" and "and call pipeline <name>"
   */
  private getPipelineHoverAST(context: ReturnType<typeof this.getASTContext>, text: string, offset: number, doc: TextDocument): Hover | null {
    // Check mock context for pipeline mocks
    if (context.kind === 'mock' && context.node) {
      const mockNode = context.node as any;
      const target = mockNode.target || '';

      // Check if it's a pipeline mock: "pipeline.<name>"
      const match = /^pipeline\.([A-Za-z_][\w-]*)/.exec(target);

      if (match) {
        const pipelineName = match[1];

        // Get the precise range of the pipeline name
        const nameRange = this.getPipelineNameRange(text, mockNode.start, mockNode.end, pipelineName);

        if (nameRange) {
          // Check if cursor is within the name range
          if (offset >= nameRange.start && offset <= nameRange.end) {
            const md = this.formatPipelineHover(text, pipelineName, doc);
            if (md) {
              return { contents: { kind: MarkupKind.Markdown, value: md } };
            }
          }
        }
      }
    }

    // Check test context for pipeline call assertions
    if (context.kind === 'test' && context.node) {
      const testNode = context.node as any;
      if (testNode.conditions) {
        for (const cond of testNode.conditions) {
          const isCallAssertion = cond.kind === 'CallAssertion' || cond.isCallAssertion;
          const target = cond.target || cond.callTarget;

          if (isCallAssertion && target) {
            // Call assertions use dot notation: "pipeline.processItem"
            const match = /^pipeline\.([A-Za-z_][\w-]*)/.exec(target);

            if (match) {
              const pipelineName = match[1];

              // Get the precise range of the pipeline name
              const nameRange = this.getPipelineNameRange(text, cond.start, cond.end, pipelineName);

              if (nameRange) {
                // Check if cursor is within the name range
                if (offset >= nameRange.start && offset <= nameRange.end) {
                  const md = this.formatPipelineHover(text, pipelineName, doc);
                  if (md) {
                    return { contents: { kind: MarkupKind.Markdown, value: md } };
                  }
                }
              }
            }
          }
        }
      }
    }

    return null;
  }

  /**
   * Get the range of a pipeline name within mock or call assertion text
   */
  private getPipelineNameRange(text: string, blockStart: number, blockEnd: number, pipelineName: string): { start: number; end: number } | null {
    const blockText = text.slice(blockStart, blockEnd);

    // Look for "pipeline <name>" pattern (with space, as written in source)
    const spacePattern = new RegExp(`pipeline\\s+(${pipelineName})\\b`);
    const spaceMatch = spacePattern.exec(blockText);

    if (spaceMatch) {
      const nameStart = blockStart + spaceMatch.index + spaceMatch[0].length - pipelineName.length;
      return { start: nameStart, end: nameStart + pipelineName.length };
    }

    return null;
  }

  /**
   * AST-based test let variable hover
   * Uses AST to detect if we're within a template string node rather than fragile lastIndexOf
   */
  private getTestLetVariableHoverAST(text: string, offset: number, word: string, doc: TextDocument): Hover | null {
    // Still use the string check for {{...}} detection since template content isn't in AST
    // But we use AST to find the test context
    const beforeCursor = text.slice(Math.max(0, offset - 100), offset);
    const afterCursor = text.slice(offset, Math.min(text.length, offset + 100));

    const lastOpenBrace = beforeCursor.lastIndexOf('{{');
    const lastCloseBrace = beforeCursor.lastIndexOf('}}');
    const nextCloseBrace = afterCursor.indexOf('}}');

    if (lastOpenBrace === -1 || lastCloseBrace > lastOpenBrace || nextCloseBrace === -1) {
      return null;
    }

    const program = this.workspace.getProgram(doc);
    if (!program || !program.describes) {
      return null;
    }

    const testContext = findTestContextAtOffset(text, offset, program.describes);

    if (testContext) {
      const varInfo = getLetVariableValue(word, testContext);
      if (!varInfo) return null;

      const formattedValue = varInfo.format === 'quoted'
        ? `"${varInfo.value}"`
        : varInfo.format === 'backtick'
        ? `\`${varInfo.value}\``
        : varInfo.value;

      const snippet = `let ${word} = ${formattedValue}`;
      const md = createMarkdownCodeBlock('webpipe', snippet);
      return { contents: { kind: MarkupKind.Markdown, value: md } };
    }

    // Fallback to describe-level variables
    const symbols = this.workspace.getSymbols(doc);
    let bestMatch: { describe: Describe; value: string; format: 'quoted' | 'backtick' | 'bare' } | null = null;
    let smallestRange = Infinity;

    for (const pos of symbols.testLetVariablePositions) {
      if (pos.testName || pos.name !== word) continue;

      const describe = program.describes.find(d => d.name === pos.describeName);
      if (!describe) continue;

      const describeRange = findDescribeBlockRange(text, describe);
      if (!describeRange) continue;

      if (offset >= describeRange.start && offset < describeRange.end) {
        const rangeSize = describeRange.end - describeRange.start;

        if (rangeSize < smallestRange && describe.variables) {
          for (const variable of describe.variables) {
            if (variable.name === word) {
              bestMatch = { describe, value: variable.value, format: variable.format };
              smallestRange = rangeSize;
              break;
            }
          }
        }
      }
    }

    if (bestMatch) {
      const formattedValue = bestMatch.format === 'quoted'
        ? `"${bestMatch.value}"`
        : bestMatch.format === 'backtick'
        ? `\`${bestMatch.value}\``
        : bestMatch.value;

      const snippet = `let ${word} = ${formattedValue}`;
      const md = createMarkdownCodeBlock('webpipe', snippet);
      return { contents: { kind: MarkupKind.Markdown, value: md } };
    }

    return null;
  }

  /**
   * AST-based test let variable definition
   */
  private getTestLetVariableDefinitionAST(text: string, offset: number, word: string, doc: TextDocument): Location | null {
    const beforeCursor = text.slice(Math.max(0, offset - 100), offset);
    const afterCursor = text.slice(offset, Math.min(text.length, offset + 100));

    const lastOpenBrace = beforeCursor.lastIndexOf('{{');
    const lastCloseBrace = beforeCursor.lastIndexOf('}}');
    const nextCloseBrace = afterCursor.indexOf('}}');

    const inHandlebars = lastOpenBrace !== -1 && lastCloseBrace < lastOpenBrace && nextCloseBrace !== -1;

    if (!inHandlebars) {
      return null;
    }

    const program = this.workspace.getProgram(doc);
    const symbols = this.workspace.getSymbols(doc);

    const testContext = findTestContextAtOffset(text, offset, program.describes);

    if (testContext) {
      for (const pos of symbols.testLetVariablePositions) {
        if (pos.name === word &&
            pos.testName === testContext.test.name &&
            pos.describeName === testContext.describe.name) {
          const range = { start: doc.positionAt(pos.start), end: doc.positionAt(pos.start + pos.length) };
          return Location.create(doc.uri, range);
        }
      }

      for (const pos of symbols.testLetVariablePositions) {
        if (pos.name === word &&
            !pos.testName &&
            pos.describeName === testContext.describe.name) {
          const range = { start: doc.positionAt(pos.start), end: doc.positionAt(pos.start + pos.length) };
          return Location.create(doc.uri, range);
        }
      }

      return null;
    }

    let bestMatch: { start: number; length: number } | null = null;
    let smallestRange = Infinity;

    for (const pos of symbols.testLetVariablePositions) {
      if (pos.testName || pos.name !== word) continue;

      const describe = program.describes.find(d => d.name === pos.describeName);
      if (!describe) continue;

      const describeRange = findDescribeBlockRange(text, describe);
      if (!describeRange) continue;

      if (offset >= describeRange.start && offset < describeRange.end) {
        const rangeSize = describeRange.end - describeRange.start;
        if (rangeSize < smallestRange) {
          bestMatch = { start: pos.start, length: pos.length };
          smallestRange = rangeSize;
        }
      }
    }

    if (bestMatch) {
      const range = { start: doc.positionAt(bestMatch.start), end: doc.positionAt(bestMatch.start + bestMatch.length) };
      return Location.create(doc.uri, range);
    }

    return null;
  }

  /**
   * AST-based version of isPipelineContext
   * This is more accurate than regex-based detection and can be used to replace isPipelineContext
   */
  private isPipelineContextAST(offset: number, doc: TextDocument): boolean {
    const context = this.getASTContext(offset, doc);

    // Check if we're in a pipeline-related node
    if (context.kind === 'pipeline') return true;

    // Check if we're in a pipeline step that references another pipeline
    // This includes |> pipeline: Name and |> loader(...): Name
    // Note: step.name is just the identifier (e.g., "loader"), args are stored separately
    if (context.kind === 'step' && (context.varType === 'pipeline' || context.varType === 'loader')) {
      return true;
    }

    // Check if we're in a mock that mocks a pipeline (dot notation: pipeline.name)
    if (context.kind === 'mock') {
      const mockNode = context.node as any;
      if (mockNode.target && mockNode.target.startsWith('pipeline.')) return true;
    }

    // Check if we're in a call assertion that calls a pipeline
    if (context.kind === 'test' && context.node) {
      const testNode = context.node as any;
      if (testNode.conditions) {
        for (const cond of testNode.conditions) {
          const isCallAssertion = cond.kind === 'CallAssertion' || cond.isCallAssertion;
          const target = cond.target || cond.callTarget;
          if (isCallAssertion && target && target.startsWith('pipeline.')) {
            // Check if offset is within the pipeline name
            if (cond.start !== undefined && cond.end !== undefined &&
                offset >= cond.start && offset <= cond.end) {
              return true;
            }
          }
        }
      }
    }

    // Check if we're in a test when clause that executes a pipeline
    const program = this.workspace.getProgram(doc);
    for (const describe of program.describes) {
      for (const test of describe.tests) {
        const when = test.when;
        if (when.kind === 'ExecutingPipeline') {
          // Check if offset is within the pipeline name in the when clause
          if (offset >= when.nameStart && offset < when.nameStart + when.name.length) {
            return true;
          }
        }
      }
    }

    return false;
  }

  /**
   * AST-based version of getVariableKey
   * Returns the variable key (varType, varName) based on AST context
   */
  private getVariableKeyAST(context: ReturnType<typeof this.getASTContext>, word: string): { varType: string; varName: string } | null {
    if (context.kind === 'variable' && context.varType) {
      // We're at a variable declaration or reference (includes ExecutingVariable when clauses)
      return { varType: context.varType, varName: word };
    }

    if (context.kind === 'step' && context.varType && context.varType !== 'pipeline' && context.varType !== 'loader') {
      // We're at a pipeline step that references a variable
      // Exclude 'pipeline' and 'loader' steps as they reference pipelines, not variables
      return { varType: context.varType, varName: word };
    }

    if (context.kind === 'test' && context.node) {
      // We're in a test context - check if it's executing a variable
      const testNode = context.node as any;
      if (testNode.when && testNode.when.kind === 'ExecutingVariable') {
        return { varType: testNode.when.varType, varName: word };
      }
    }

    if (context.kind === 'mock' && context.node) {
      // We're in a mock context
      const mockNode = context.node as any;
      if (mockNode.target && !mockNode.target.startsWith('pipeline ')) {
        // Mock format is "varType.varName"
        const dotIndex = mockNode.target.indexOf('.');
        if (dotIndex !== -1) {
          const varType = mockNode.target.substring(0, dotIndex);
          return { varType, varName: word };
        }
      }
    }

    return null;
  }


  private getHandlebarsHover(text: string, offset: number, word: string, doc: TextDocument, symbols: SymbolTable): Hover | null {
    const hb = symbols.handlebars;
    const withinContent = hb.contentRanges.some((r: RangeAbs) => offset >= r.start && offset <= r.end);
    
    if (!withinContent) return null;

    for (const [name, uses] of hb.usagesByName.entries()) {
      for (const u of uses) {
        if (offset >= u.start && offset <= u.end) {
          let defRange: RangeAbs | undefined = undefined;
          let hoverLang: string | undefined = undefined;
          
          for (const entry of hb.inlineDefsByContent) {
            if (offset >= entry.range.start && offset <= entry.range.end) {
              const localBlock = entry.inlineBlockByName.get(name);
              if (localBlock) { defRange = localBlock; hoverLang = 'handlebars'; }
              else {
                const local = entry.inlineByName.get(name);
                if (local) defRange = local;
              }
              break;
            }
          }
          
          if (!defRange) {
            const decl = hb.declByName.get(name);
            if (decl) {
              const handlebarsByName = symbols.variablePositions.get('handlebars');
              const fullPos = handlebarsByName?.get(name);
              if (fullPos) defRange = { start: fullPos.start, end: fullPos.start + fullPos.length };
              else defRange = { start: decl.nameStart, end: decl.nameEnd };
              hoverLang = 'webpipe';
            } else {
              // Check for imported partial (namespace/name format)
              const slashIndex = name.indexOf('/');
              if (slashIndex > 0) {
                const namespace = name.substring(0, slashIndex);
                const partialName = name.substring(slashIndex + 1);

                // Find the import with this alias
                const program = this.workspace.getProgram(doc);
                if (program.imports) {
                  const importDecl = program.imports.find((imp: any) => imp.alias === namespace);
                  if (importDecl) {
                    // Resolve the imported file
                    const metadata = this.workspace.getDocument(doc.uri);
                    if (metadata && metadata.imports) {
                      const resolvedImport = metadata.imports.find((imp: any) => imp.alias === namespace);
                      if (resolvedImport && resolvedImport.resolved && resolvedImport.uri) {
                        this.workspace.ensureImportLoaded(resolvedImport.uri);
                        const importedMeta = this.workspace.getDocument(resolvedImport.uri);
                        if (importedMeta && importedMeta.symbols && importedMeta.text) {
                          const importedHandlebars = importedMeta.symbols.variablePositions.get('handlebars');
                          const importedPos = importedHandlebars?.get(partialName);
                          if (importedPos) {
                            const importedText = importedMeta.text;
                            defRange = { start: importedPos.start, end: importedPos.start + importedPos.length };
                            const snippet = importedText.slice(defRange.start, defRange.end);
                            const md = createMarkdownCodeBlock('webpipe', snippet);
                            return { contents: { kind: MarkupKind.Markdown, value: md } };
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
          
          if (defRange) {
            const snippet = text.slice(defRange.start, defRange.end);
            const md = createMarkdownCodeBlock(hoverLang || 'webpipe', snippet);
            return { contents: { kind: MarkupKind.Markdown, value: md } };
          }
        }
      }
    }

    return null;
  }

  private getHandlebarsDefinition(hb: any, offset: number, doc: TextDocument): Location | null {
    const withinContent = hb.contentRanges.some((r: any) => offset >= r.start && offset <= r.end);
    if (!withinContent) return null;

    for (const [name, uses] of hb.usagesByName.entries()) {
      for (const u of uses) {
        if (offset >= u.start && offset <= u.end) {
          // Inline def in same content has priority
          for (const entry of hb.inlineDefsByContent) {
            if (offset >= entry.range.start && offset <= entry.range.end) {
              const local = entry.inlineByName.get(name);
              if (local) {
                return Location.create(doc.uri, { start: doc.positionAt(local.start), end: doc.positionAt(local.end) });
              }
            }
          }
          const decl = hb.declByName.get(name);
          if (decl) {
            return Location.create(doc.uri, { start: doc.positionAt(decl.nameStart), end: doc.positionAt(decl.nameEnd) });
          }

          // Check for imported partial (namespace/name format)
          const slashIndex = name.indexOf('/');
          if (slashIndex > 0) {
            const namespace = name.substring(0, slashIndex);
            const partialName = name.substring(slashIndex + 1);

            // Find the import with this alias
            const program = this.workspace.getProgram(doc);
            if (program.imports) {
              const importDecl = program.imports.find((imp: any) => imp.alias === namespace);
              if (importDecl) {
                // Resolve the imported file
                const metadata = this.workspace.getDocument(doc.uri);
                if (metadata && metadata.imports) {
                  const resolvedImport = metadata.imports.find((imp: any) => imp.alias === namespace);
                  if (resolvedImport && resolvedImport.resolved && resolvedImport.uri) {
                    this.workspace.ensureImportLoaded(resolvedImport.uri);
                    const importedMeta = this.workspace.getDocument(resolvedImport.uri);
                    if (importedMeta && importedMeta.symbols && importedMeta.text) {
                      const importedHandlebars = importedMeta.symbols.variablePositions.get('handlebars');
                      const importedPos = importedHandlebars?.get(partialName);
                      if (importedPos) {
                        // Calculate the position of the variable name in the imported file
                        const importedText = importedMeta.text;
                        const nameStart = importedPos.start + 'handlebars '.length;
                        const lines = importedText.substring(0, nameStart).split('\n');
                        const line = lines.length - 1;
                        const character = lines[lines.length - 1].length;

                        return Location.create(
                          resolvedImport.uri,
                          {
                            start: { line, character },
                            end: { line, character: character + partialName.length }
                          }
                        );
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    return null;
  }

  private getHandlebarsReferences(hb: any, offset: number, doc: TextDocument, includeDecl: boolean): Location[] | null {
    const results: Location[] = [];
    
    for (const [name, uses] of hb.usagesByName.entries()) {
      for (const u of uses) {
        if (offset >= u.start && offset <= u.end) {
          if (includeDecl) {
            const decl = hb.declByName.get(name);
            if (decl) results.push(Location.create(doc.uri, { start: doc.positionAt(decl.nameStart), end: doc.positionAt(decl.nameEnd) }));
          }
          for (const r of uses) results.push(Location.create(doc.uri, { start: doc.positionAt(r.start), end: doc.positionAt(r.end) }));
          return results.length ? results : null;
        }
      }
    }

    return null;
  }

  private formatVariableHover(text: string, varType: string, varName: string, doc: TextDocument): string | null {
    // Use AST to find the exact boundaries of the variable
    const program = this.workspace.getProgram(doc);
    const variable = program.variables.find(v => v.varType === varType && v.name === varName);
    if (!variable) return null;

    let snippet = text.slice(variable.start, variable.end).trimEnd();
    if (snippet.length > 2400) snippet = snippet.slice(0, 2400) + '\n…';
    return createMarkdownCodeBlock('webpipe', snippet);
  }

  private formatPipelineHover(text: string, pipelineName: string, doc: TextDocument): string | null {
    // Use AST to find the exact boundaries of the pipeline
    const program = this.workspace.getProgram(doc);
    const pipeline = program.pipelines.find(p => p.name === pipelineName);
    if (!pipeline) return null;

    let snippet = text.slice(pipeline.start, pipeline.end).trimEnd();
    if (snippet.length > 2400) snippet = snippet.slice(0, 2400) + '\n…';
    return createMarkdownCodeBlock('webpipe', snippet);
  }

  private formatGraphQLHover(text: string, resolverType: string, resolverName: string, doc: TextDocument): string | null {
    // Use AST to find the exact boundaries of the resolver
    const program = this.workspace.getProgram(doc);
    const resolvers = resolverType === 'query' ? program.queries : program.mutations;

    const resolver = resolvers.find(r => r.name === resolverName);
    if (!resolver) return null;

    let snippet = text.slice(resolver.start, resolver.end).trimEnd();
    if (snippet.length > 2400) snippet = snippet.slice(0, 2400) + '\n…';
    return createMarkdownCodeBlock('webpipe', snippet);
  }

  /**
   * Determines which GraphQL operation the cursor is on within a query string
   */
  private getGraphQLOperationAtOffset(
    queryString: string,
    queryStart: number,
    cursorOffset: number
  ): { type: 'query' | 'mutation'; name: string } | null {
    // Determine query vs mutation and find where the keyword ends
    const typeMatch = /^\s*(query|mutation)/.exec(queryString);
    if (!typeMatch) return null;

    const type = typeMatch[1] as 'query' | 'mutation';
    const keywordEnd = typeMatch[0].length;

    // Find the opening brace of the selection set
    // This could be: "query {" or "query($var: Type) {"
    const selectionSetStart = queryString.indexOf('{', keywordEnd);
    if (selectionSetStart === -1) return null;

    // Extract field names from the selection set (top-level only)
    // Match: fieldName or fieldName(args)
    const selectionSetContent = queryString.substring(selectionSetStart);
    const fieldRe = /\{\s*([A-Za-z_][\w-]*)\s*[({]/g;
    let match;

    while ((match = fieldRe.exec(selectionSetContent)) !== null) {
      const name = match[1];
      const nameStart = queryStart + selectionSetStart + match.index + match[0].indexOf(name);
      const nameEnd = nameStart + name.length;

      // Check if cursor is within this name
      if (cursorOffset >= nameStart && cursorOffset <= nameEnd) {
        return { type, name };
      }
    }

    return null;
  }

  /**
   * Helper to find the absolute range of the operation name within a target string
   *
   * Note: The AST stores targets with dot notation (e.g., "mutation.deleteTodo"),
   * but the source code uses space notation (e.g., "mutation deleteTodo").
   * We search for the operation name directly in the source within the node's range.
   */
  private getGraphQLNameRange(
    text: string,
    nodeStart: number,
    nodeEnd: number,
    operationType: string,
    operationName: string
  ): { start: number; end: number } | null {
    // Extract the source text for this node
    const nodeText = text.slice(nodeStart, nodeEnd);

    // Search for the pattern "mutation operationName" or "query operationName" in the source
    // The source uses space notation, not dot notation
    const pattern = new RegExp(`\\b(${operationType})\\s+(${operationName})\\b`);
    const match = pattern.exec(nodeText);

    if (!match) {
      return null;
    }

    // Calculate absolute position of the operation name
    // match.index is where the match starts within nodeText
    // match[0].indexOf(match[2]) gives us where the name starts within the match
    const nameIndexInMatch = match[0].indexOf(match[2]);
    const absoluteStart = nodeStart + match.index + nameIndexInMatch;
    const absoluteEnd = absoluteStart + operationName.length;

    return { start: absoluteStart, end: absoluteEnd };
  }

  /**
   * Get GraphQL definition from mock or call assertion context
   */
  private getGraphQLDefinitionAST(
    context: ReturnType<typeof this.getASTContext>,
    word: string,
    symbols: SymbolTable,
    doc: TextDocument,
    offset: number
  ): Location | null {
    const text = this.workspace.getText(doc);

    // Handle mock context
    if (context.kind === 'mock' && context.node) {
      const mockNode = context.node as any;
      const target = mockNode.target || '';

      const match = /^(query|mutation)[.\s]+([A-Za-z_][\w-]*)/.exec(target);

      if (match) {
        const operationType = match[1];
        const operationName = match[2];

        // Get the precise range of the operation name
        const nameRange = this.getGraphQLNameRange(text, mockNode.start, mockNode.end, operationType, operationName);

        if (nameRange) {
          // Check if cursor is within the name range
          if (offset >= nameRange.start && offset <= nameRange.end) {
            const resolverMap = operationType === 'query'
              ? symbols.queryPositions
              : symbols.mutationPositions;

            const hit = resolverMap.get(operationName);

            if (hit) {
              const range = {
                start: doc.positionAt(hit.start),
                end: doc.positionAt(hit.start + hit.length)
              };
              return Location.create(doc.uri, range);
            }
          }
        }
      }
    }

    // Handle test call assertion context
    if (context.kind === 'test' && context.node) {
      const testNode = context.node as any;
      if (testNode.conditions) {
        for (const cond of testNode.conditions) {
          if (cond.isCallAssertion && cond.callTarget) {
            const target = cond.callTarget;

            // Call assertions use dot notation: "mutation.deleteTodo"
            // Mocks use space notation: "mutation deleteTodo"
            const match = /^(query|mutation)[.\s]+([A-Za-z_][\w-]*)/.exec(target);

            if (match) {
              const operationType = match[1];
              const operationName = match[2];

              // Get the precise range of the operation name
              // For call assertions, we need to find where the condition starts
              const nameRange = this.getGraphQLNameRange(text, testNode.start, testNode.end, operationType, operationName);

              if (nameRange) {
                // Check if cursor is within the name range
                if (offset >= nameRange.start && offset <= nameRange.end) {
                  const resolverMap = operationType === 'query'
                    ? symbols.queryPositions
                    : symbols.mutationPositions;

                  const hit = resolverMap.get(operationName);

                  if (hit) {
                    const range = {
                      start: doc.positionAt(hit.start),
                      end: doc.positionAt(hit.start + hit.length)
                    };
                    return Location.create(doc.uri, range);
                  }
                }
              }
            }
          }
        }
      }
    }

    return null;
  }

  /**
   * Get pipeline definition from mock or call assertion context
   */
  private getPipelineDefinitionAST(
    context: ReturnType<typeof this.getASTContext>,
    symbols: SymbolTable,
    doc: TextDocument,
    offset: number
  ): Location | null {
    const text = this.workspace.getText(doc);

    // Handle mock context
    if (context.kind === 'mock' && context.node) {
      const mockNode = context.node as any;
      const target = mockNode.target || '';

      const match = /^pipeline\.([A-Za-z_][\w-]*)/.exec(target);

      if (match) {
        const pipelineName = match[1];

        // Get the precise range of the pipeline name
        const nameRange = this.getPipelineNameRange(text, mockNode.start, mockNode.end, pipelineName);

        if (nameRange) {
          // Check if cursor is within the name range
          if (offset >= nameRange.start && offset <= nameRange.end) {
            const hit = symbols.pipelinePositions.get(pipelineName);

            if (hit) {
              const range = {
                start: doc.positionAt(hit.start),
                end: doc.positionAt(hit.start + hit.length)
              };
              return Location.create(doc.uri, range);
            }
          }
        }
      }
    }

    // Handle test call assertion context
    if (context.kind === 'test' && context.node) {
      const testNode = context.node as any;
      if (testNode.conditions) {
        for (const cond of testNode.conditions) {
          if (cond.isCallAssertion && cond.callTarget) {
            const target = cond.callTarget;

            const match = /^pipeline\.([A-Za-z_][\w-]*)/.exec(target);

            if (match) {
              const pipelineName = match[1];

              // Get the precise range of the pipeline name
              const nameRange = this.getPipelineNameRange(text, testNode.start, testNode.end, pipelineName);

              if (nameRange) {
                // Check if cursor is within the name range
                if (offset >= nameRange.start && offset <= nameRange.end) {
                  const hit = symbols.pipelinePositions.get(pipelineName);

                  if (hit) {
                    const range = {
                      start: doc.positionAt(hit.start),
                      end: doc.positionAt(hit.start + hit.length)
                    };
                    return Location.create(doc.uri, range);
                  }
                }
              }
            }
          }
        }
      }
    }

    return null;
  }

  /**
   * Provides hover for JQ variables ($varName) in test blocks
   * by showing their let variable definitions.
   */
  private getTestJqVariableHover(text: string, offset: number, word: string, wordStart: number, doc: TextDocument): Hover | null {
    // Check if we're at a JQ variable ($varName)
    // The character before the word should be '$'
    if (wordStart === 0 || text[wordStart - 1] !== '$') {
      return null;
    }

    // Get the program to access test structures
    const program = this.workspace.getProgram(doc);
    if (!program || !program.describes) {
      return null;
    }

    // Try to find a test context first (if we're inside a test)
    const testContext = findTestContextAtOffset(text, offset, program.describes);

    if (testContext) {
      // We're inside a test - get variable value from test context
      const varInfo = getLetVariableValue(word, testContext);
      if (!varInfo) return null;

      const formattedValue = varInfo.format === 'quoted'
        ? `"${varInfo.value}"`
        : varInfo.format === 'backtick'
        ? `\`${varInfo.value}\``
        : varInfo.value;

      const snippet = `let ${word} = ${formattedValue}`;
      const md = createMarkdownCodeBlock('webpipe', snippet);
      return { contents: { kind: MarkupKind.Markdown, value: md } };
    }

    // No test context - try matching against describe-level variables
    // Strategy: Find the most specific (smallest) matching describe block
    const symbols = this.workspace.getSymbols(doc);

    let bestMatch: { describe: Describe; value: string; format: 'quoted' | 'backtick' | 'bare' } | null = null;
    let smallestRange = Infinity;

    for (const pos of symbols.testLetVariablePositions) {
      // Only check describe-level variables (no testName)
      if (pos.testName || pos.name !== word) continue;

      // Check if this variable's describe block contains the current offset
      const describe = program.describes.find(d => d.name === pos.describeName);
      if (!describe) continue;

      const describeRange = findDescribeBlockRange(text, describe);
      if (!describeRange) continue;

      if (offset >= describeRange.start && offset < describeRange.end) {
        const rangeSize = describeRange.end - describeRange.start;

        // Only update if this is a smaller (more specific) range
        if (rangeSize < smallestRange && describe.variables) {
          for (const variable of describe.variables) {
            if (variable.name === word) {
              bestMatch = { describe, value: variable.value, format: variable.format };
              smallestRange = rangeSize;
              break;
            }
          }
        }
      }
    }

    if (bestMatch) {
      const formattedValue = bestMatch.format === 'quoted'
        ? `"${bestMatch.value}"`
        : bestMatch.format === 'backtick'
        ? `\`${bestMatch.value}\``
        : bestMatch.value;

      const snippet = `let ${word} = ${formattedValue}`;
      const md = createMarkdownCodeBlock('webpipe', snippet);
      return { contents: { kind: MarkupKind.Markdown, value: md } };
    }

    return null;
  }

  /**
   * Provides go-to-definition for JQ variables ($varName) in test blocks
   */
  private getTestJqVariableDefinition(text: string, offset: number, word: string, wordStart: number, doc: TextDocument): Location | null {
    // Check if we're at a JQ variable (character before word is '$')
    if (wordStart === 0 || text[wordStart - 1] !== '$') {
      return null;
    }

    // Look up in symbol table with scope awareness
    const program = this.workspace.getProgram(doc);
    const symbols = this.workspace.getSymbols(doc);

    // Try to find a test context first (if we're inside a test)
    const testContext = findTestContextAtOffset(text, offset, program.describes);

    if (testContext) {
      // We're inside a test block - check test-level variables first
      for (const pos of symbols.testLetVariablePositions) {
        if (pos.name === word &&
            pos.testName === testContext.test.name &&
            pos.describeName === testContext.describe.name) {
          // Found test-level variable - this shadows any describe-level variable
          const range = { start: doc.positionAt(pos.start), end: doc.positionAt(pos.start + pos.length) };
          return Location.create(doc.uri, range);
        }
      }

      // Not found at test level, try describe level
      for (const pos of symbols.testLetVariablePositions) {
        if (pos.name === word &&
            !pos.testName &&
            pos.describeName === testContext.describe.name) {
          // Found describe-level variable
          const range = { start: doc.positionAt(pos.start), end: doc.positionAt(pos.start + pos.length) };
          return Location.create(doc.uri, range);
        }
      }

      return null;
    }

    // No test context - try matching against describe-level variables
    // Strategy: Find the most specific (smallest) matching describe block
    let bestMatch: { start: number; length: number } | null = null;
    let smallestRange = Infinity;

    for (const pos of symbols.testLetVariablePositions) {
      // Only check describe-level variables (no testName)
      if (pos.testName || pos.name !== word) continue;

      // Check if this variable's describe block contains the current offset
      const describe = program.describes.find(d => d.name === pos.describeName);
      if (!describe) continue;

      const describeRange = findDescribeBlockRange(text, describe);
      if (!describeRange) continue;

      if (offset >= describeRange.start && offset < describeRange.end) {
        const rangeSize = describeRange.end - describeRange.start;
        if (rangeSize < smallestRange) {
          bestMatch = { start: pos.start, length: pos.length };
          smallestRange = rangeSize;
        }
      }
    }

    if (bestMatch) {
      const range = { start: doc.positionAt(bestMatch.start), end: doc.positionAt(bestMatch.start + bestMatch.length) };
      return Location.create(doc.uri, range);
    }

    return null;
  }

  /**
   * Parse a route path into segments for AST-based comparison.
   * Example: "/users/:id/posts" → ["users", ":id", "posts"]
   */
  private parsePathSegments(path: string): string[] {
    return path.split('/').filter(s => s.length > 0);
  }

  /**
   * Match two paths using segment-by-segment AST comparison (no regex).
   * Template path can have parameters like ":id", incoming path has actual values.
   *
   * Example:
   *   matchPathSegments("/users/:id", "/users/123") → true
   *   matchPathSegments("/users/:id/posts", "/users/123/comments") → false
   */
  private matchPathSegments(templatePath: string, incomingPath: string): boolean {
    const templateSegments = this.parsePathSegments(templatePath);
    const incomingSegments = this.parsePathSegments(incomingPath);

    // Must have same number of segments
    if (templateSegments.length !== incomingSegments.length) {
      return false;
    }

    // Compare segment by segment
    for (let i = 0; i < templateSegments.length; i++) {
      const templateSeg = templateSegments[i];
      const incomingSeg = incomingSegments[i];

      // Parameter segment (starts with ':') matches anything
      if (templateSeg.startsWith(':')) {
        continue;
      }

      // Static segment must match exactly
      if (templateSeg !== incomingSeg) {
        return false;
      }
    }

    return true;
  }

  /**
   * Find route definition matching the given method and path using AST-based comparison
   */
  private findMatchingRoute(method: string, path: string, routes: Route[]): Route | null {
    // Strip query string if present
    const cleanPath = path.split('?')[0];

    // Find routes matching the HTTP method and path pattern
    for (const route of routes) {
      // Method must match (case-insensitive)
      if (route.method.toUpperCase() !== method.toUpperCase()) {
        continue;
      }

      // Use AST-based path segment comparison instead of regex
      if (this.matchPathSegments(route.path, cleanPath)) {
        return route;
      }
    }

    return null;
  }

  /**
   * Format hover text for route definition
   */
  private formatRouteHover(
    text: string,
    method: string,
    path: string,
    doc: TextDocument
  ): string | null {
    const program = this.workspace.getProgram(doc);
    const matchingRoute = this.findMatchingRoute(method, path, program.routes);

    if (!matchingRoute) return null;

    // Extract route definition text from source
    let snippet = text.slice(matchingRoute.start, matchingRoute.end).trimEnd();

    // Truncate if too long (same as pipeline hover)
    if (snippet.length > 2400) {
      snippet = snippet.slice(0, 2400) + '\n…';
    }

    return createMarkdownCodeBlock('webpipe', snippet);
  }

  /**
   * Extract code snippet from text at a given position
   */
  private extractCodeSnippet(text: string, position: { start: number; length: number }): string {
    let snippet = text.slice(position.start, position.start + position.length).trimEnd();

    // Truncate if too long
    if (snippet.length > 2400) {
      snippet = snippet.slice(0, 2400) + '\n…';
    }

    return snippet;
  }
}
