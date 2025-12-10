import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  Location, Position, Hover, MarkupKind, ReferenceParams,
  HoverParams, DefinitionParams, RenameParams, WorkspaceEdit, TextEdit, Connection
} from 'vscode-languageserver/node';
import { Describe, PipelineStep } from 'webpipe-js';
import { getWordAt, createMarkdownCodeBlock } from './utils';
import { RangeAbs, SymbolTable, HandlebarsSymbols } from './types';
import { getMiddlewareDoc, formatMiddlewareHover } from './middleware-docs';
import { getConfigDoc, formatConfigHover } from './config-docs';
import { DocumentCache } from './document-cache';
import { findTestContextAtOffset, findDescribeBlockRange, getLetVariableValue } from './test-variable-utils';
import { findNodeAtOffset, ASTNode } from './ast-utils';

/**
 * Language providers for hover, definition, and references.
 * Uses centralized symbol table from DocumentCache to avoid repeated parsing.
 */
export class LanguageProviders {
  constructor(private cache: DocumentCache, private connection?: Connection) {}

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
    const program = this.cache.getProgram(doc);
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
        const text = this.cache.getText(doc);
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

      return { node, kind: 'step', varType: step.name };
    }
    if ('when' in node && 'conditions' in node) {
      return { node, kind: 'test' };
    }
    if ('target' in node && 'returnValue' in node) {
      return { node, kind: 'mock' };
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
    const text = this.cache.getText(doc);
    const symbols = this.cache.getSymbols(doc);
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

    const addDeclAndRefsForVariable = (key: string) => {
      if (includeDecl) {
        const decl = symbols.variablePositions.get(key);
        if (decl) results.push(Location.create(doc.uri, { start: doc.positionAt(decl.start), end: doc.positionAt(decl.start + decl.length) }));
      }
      const refs = symbols.variableRefs.get(key) || [];
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
    const text = this.cache.getText(doc);
    const symbols = this.cache.getSymbols(doc);
    const pos = params.position as Position;
    const offset = doc.offsetAt(pos);
    const wordInfo = getWordAt(text, offset);
    if (!wordInfo) return null;

    const { word } = wordInfo;
    const context = this.getASTContext(offset, doc);

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
      const md = this.formatPipelineHover(text, word, symbols);
      if (md) return { contents: { kind: MarkupKind.Markdown, value: md } };
    }

    // Variable hover
    const variableKey = this.getVariableKeyAST(context, word);
    if (variableKey) {
      const [varType] = variableKey.split('::');
      const md = this.formatVariableHover(text, varType, word, symbols);
      if (md) return { contents: { kind: MarkupKind.Markdown, value: md } };
    }

    // GraphQL resolver hover (middleware context)
    if (context.kind === 'graphql') {
      const md = this.formatGraphQLHover(
        text,
        context.graphqlType!,
        context.graphqlName!
      );
      if (md) return { contents: { kind: MarkupKind.Markdown, value: md } };
    }

    // GraphQL query/mutation hover (mock/call assertion context)
    const graphqlHover = this.getGraphQLHoverAST(context, text, word, offset);
    if (graphqlHover) return graphqlHover;

    // Handlebars partial hover
    const handlebarsHover = this.getHandlebarsHover(text, offset, word, doc, symbols);
    if (handlebarsHover) return handlebarsHover;

    return null;
  }

  onDefinition(params: DefinitionParams, doc: TextDocument): Location | null {
    const text = this.cache.getText(doc);
    const symbols = this.cache.getSymbols(doc);
    const pos = params.position as Position;
    const offset = doc.offsetAt(pos);
    const wordInfo = getWordAt(text, offset);
    if (!wordInfo) return null;

    const { word } = wordInfo;
    const context = this.getASTContext(offset, doc);

    // Pipeline definition
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
      const hit = symbols.variablePositions.get(variableKey);
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

    // Test let variable definition (Handlebars {{var}})
    const testLetDefinition = this.getTestLetVariableDefinitionAST(text, offset, word, doc);
    if (testLetDefinition) return testLetDefinition;

    // Test JQ variable definition ($var)
    const testJqDefinition = this.getTestJqVariableDefinition(text, offset, word, wordInfo.start, doc);
    if (testJqDefinition) return testJqDefinition;

    // Handlebars definition
    const handlebarsDefinition = this.getHandlebarsDefinition(symbols.handlebars, offset, doc);
    if (handlebarsDefinition) return handlebarsDefinition;

    return null;
  }

  onRename(params: RenameParams, doc: TextDocument): WorkspaceEdit | null {
    const text = this.cache.getText(doc);
    const symbols = this.cache.getSymbols(doc);
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
      const decl = symbols.variablePositions.get(variableKey);
      if (decl) {
        edits.push(TextEdit.replace(
          { start: doc.positionAt(decl.start), end: doc.positionAt(decl.start + decl.length) },
          newName
        ));
      }
      const refs = symbols.variableRefs.get(variableKey) || [];
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
  private getGraphQLHoverAST(context: ReturnType<typeof this.getASTContext>, text: string, word: string, offset: number): Hover | null {
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
            const md = this.formatGraphQLHover(text, operationType, operationName);
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
                  const md = this.formatGraphQLHover(text, operationType, operationName);
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

    const program = this.cache.getProgram(doc);
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
    const symbols = this.cache.getSymbols(doc);
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

    const program = this.cache.getProgram(doc);
    const symbols = this.cache.getSymbols(doc);

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
    if (context.kind === 'step' && context.varType === 'pipeline') return true;

    // Check if we're in a mock that mocks a pipeline
    if (context.kind === 'mock') {
      const mockNode = context.node as any;
      if (mockNode.target && mockNode.target.startsWith('pipeline ')) return true;
    }

    return false;
  }

  /**
   * AST-based version of getVariableKey
   * Returns the variable key (varType::varName) based on AST context
   */
  private getVariableKeyAST(context: ReturnType<typeof this.getASTContext>, word: string): string | null {
    if (context.kind === 'variable' && context.varType) {
      // We're at a variable declaration
      return `${context.varType}::${word}`;
    }

    if (context.kind === 'step' && context.varType && context.varType !== 'pipeline') {
      // We're at a pipeline step that references a variable
      return `${context.varType}::${word}`;
    }

    if (context.kind === 'test' && context.node) {
      // We're in a test context - check if it's executing a variable
      const testNode = context.node as any;
      if (testNode.when && testNode.when.kind === 'ExecutingVariable') {
        return `${testNode.when.varType}::${word}`;
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
          return `${varType}::${word}`;
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
              const fullPos = symbols.variablePositions.get(`handlebars::${name}`);
              if (fullPos) defRange = { start: fullPos.start, end: fullPos.start + fullPos.length };
              else defRange = { start: decl.nameStart, end: decl.nameEnd };
              hoverLang = 'webpipe';
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

  private formatVariableHover(text: string, varType: string, varName: string, symbols: SymbolTable): string | null {
    const pos = symbols.variablePositions.get(`${varType}::${varName}`);
    if (!pos) return null;

    // Find the end of the variable declaration (until next var/pipeline/route/etc)
    const start = pos.start;
    const nextDeclRe = /\n(?:(?:[A-Za-z_][\w-]*\s+[A-Za-z_][\w-]*\s*=)|(?:pipeline\s+[A-Za-z_][\w-]*\s*=)|(?:GET|POST|PUT|DELETE\s)|(?:describe\s))/g;
    nextDeclRe.lastIndex = start;
    const nextMatch = nextDeclRe.exec(text);
    const end = nextMatch ? nextMatch.index : text.length;

    let snippet = text.slice(start, end).trimEnd();
    if (snippet.length > 2400) snippet = snippet.slice(0, 2400) + '\n…';
    return createMarkdownCodeBlock('webpipe', snippet);
  }

  private formatPipelineHover(text: string, pipelineName: string, symbols: SymbolTable): string | null {
    const pos = symbols.pipelinePositions.get(pipelineName);
    if (!pos) return null;

    // Find the end of the pipeline declaration
    const start = pos.start;
    const nextDeclRe = /\n(?:(?:[A-Za-z_][\w-]*\s+[A-Za-z_][\w-]*\s*=)|(?:pipeline\s+[A-Za-z_][\w-]*\s*=)|(?:GET|POST|PUT|DELETE\s)|(?:describe\s))/g;
    nextDeclRe.lastIndex = start;
    const nextMatch = nextDeclRe.exec(text);
    const end = nextMatch ? nextMatch.index : text.length;

    let snippet = text.slice(start, end).trimEnd();
    if (snippet.length > 2400) snippet = snippet.slice(0, 2400) + '\n…';
    return createMarkdownCodeBlock('webpipe', snippet);
  }

  private formatGraphQLHover(text: string, resolverType: string, resolverName: string): string | null {
    // Find the GraphQL resolver definition: "query <name> =" or "mutation <name> ="
    const resolverRe = new RegExp(`\\n(${resolverType}\\s+${resolverName}\\s*=)`, 'g');
    const match = resolverRe.exec(text);
    if (!match) return null;

    const start = match.index + 1; // Skip the newline

    // Find the end of the resolver declaration (until next declaration)
    const nextDeclRe = /\n(?:(?:query|mutation)\s+[A-Za-z_][\w-]*\s*=|(?:[A-Za-z_][\w-]*\s+[A-Za-z_][\w-]*\s*=)|(?:pipeline\s+[A-Za-z_][\w-]*\s*=)|(?:GET|POST|PUT|DELETE|PATCH\s)|(?:describe\s))/g;
    nextDeclRe.lastIndex = start;
    const nextMatch = nextDeclRe.exec(text);
    const end = nextMatch ? nextMatch.index : text.length;

    let snippet = text.slice(start, end).trimEnd();
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
    const text = this.cache.getText(doc);

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
    const program = this.cache.getProgram(doc);
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
    const symbols = this.cache.getSymbols(doc);

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
    const program = this.cache.getProgram(doc);
    const symbols = this.cache.getSymbols(doc);

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
}