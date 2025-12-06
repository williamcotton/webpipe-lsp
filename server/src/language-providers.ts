import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  Location, Position, Hover, MarkupKind, ReferenceParams,
  HoverParams, DefinitionParams, RenameParams, WorkspaceEdit, TextEdit
} from 'vscode-languageserver/node';
import { Describe } from 'webpipe-js';
import { getWordAt, createMarkdownCodeBlock } from './utils';
import { RangeAbs, SymbolTable, HandlebarsSymbols } from './types';
import { getMiddlewareDoc, formatMiddlewareHover } from './middleware-docs';
import { getConfigDoc, formatConfigHover } from './config-docs';
import { DocumentCache } from './document-cache';
import { findTestContextAtOffset, findDescribeBlockRange, getLetVariableValue } from './test-variable-utils';

/**
 * Language providers for hover, definition, and references.
 * Uses centralized symbol table from DocumentCache to avoid repeated parsing.
 */
export class LanguageProviders {
  constructor(private cache: DocumentCache) {}

  onReferences(params: ReferenceParams, doc: TextDocument): Location[] | null {
    const text = this.cache.getText(doc);
    const symbols = this.cache.getSymbols(doc);
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

    // Context-based reference resolution
    return this.resolveReferences(lineText, word, addDeclAndRefsForPipeline, addDeclAndRefsForVariable, symbols.handlebars, offset, doc, includeDecl, results);
  }

  onHover(params: HoverParams, doc: TextDocument): Hover | null {
    const text = this.cache.getText(doc);
    const symbols = this.cache.getSymbols(doc);
    const pos = params.position as Position;
    const offset = doc.offsetAt(pos);
    const wordInfo = getWordAt(text, offset);
    if (!wordInfo) return null;

    const { word } = wordInfo;
    const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
    const nextNl = text.indexOf('\n', offset);
    const lineEnd = nextNl === -1 ? text.length : nextNl;
    const lineText = text.slice(lineStart, lineEnd);

    // Config hover (check first)
    const configHover = this.getConfigHover(lineText, word);
    if (configHover) return configHover;

    // Middleware hover (check second, before pipeline)
    const middlewareHover = this.getMiddlewareHover(lineText, word);
    if (middlewareHover) return middlewareHover;

    // Test let variable hover (check for {{variable}} in test blocks)
    const testLetHover = this.getTestLetVariableHover(text, offset, word, doc);
    if (testLetHover) return testLetHover;

    // Test JQ variable hover (check for $variable in test blocks)
    const testJqHover = this.getTestJqVariableHover(text, offset, word, wordInfo.start, doc);
    if (testJqHover) return testJqHover;

    // Pipeline hover
    if (this.isPipelineContext(lineText)) {
      const md = this.formatPipelineHover(text, word, symbols);
      if (md) return { contents: { kind: MarkupKind.Markdown, value: md } };
    }

    // Variable hover
    const variableHover = this.getVariableHover(lineText, text, word, symbols);
    if (variableHover) return variableHover;

    // GraphQL query/mutation hover
    const graphqlHover = this.getGraphQLHover(lineText, text, word);
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
    const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
    const nextNl = text.indexOf('\n', offset);
    const lineEnd = nextNl === -1 ? text.length : nextNl;
    const lineText = text.slice(lineStart, lineEnd);

    // Pipeline definition
    if (/^\s*\|>\s*pipeline\s*:/.test(lineText) || /^\s*when\s+executing\s+pipeline\s+/.test(lineText) || /^\s*(with|and)\s+mock\s+pipeline\s+/.test(lineText)) {
      const hit = symbols.pipelinePositions.get(word);
      if (hit) {
        const range = { start: doc.positionAt(hit.start), end: doc.positionAt(hit.start + hit.length) };
        return Location.create(doc.uri, range);
      }
    }

    // Variable definition
    const variableDefinition = this.getVariableDefinition(lineText, word, symbols.variablePositions, doc);
    if (variableDefinition) return variableDefinition;

    // Test let variable definition (Handlebars {{var}})
    const testLetDefinition = this.getTestLetVariableDefinition(text, offset, word, doc);
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
    const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
    const nextNl = text.indexOf('\n', offset);
    const lineEnd = nextNl === -1 ? text.length : nextNl;
    const lineText = text.slice(lineStart, lineEnd);

    const edits: TextEdit[] = [];

    // Pipeline rename
    if (this.isPipelineContext(lineText)) {
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
    const variableKey = this.getVariableKey(lineText, word);
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

  private resolveReferences(
    lineText: string, 
    word: string, 
    addDeclAndRefsForPipeline: (name: string) => void,
    addDeclAndRefsForVariable: (key: string) => void,
    hb: any,
    offset: number,
    doc: TextDocument,
    includeDecl: boolean,
    results: Location[]
  ): Location[] | null {
    // Pipeline contexts
    if (this.isPipelineContext(lineText)) {
      addDeclAndRefsForPipeline(word);
      return results.length ? results : null;
    }

    // Variable contexts  
    const variableKey = this.getVariableKey(lineText, word);
    if (variableKey) {
      addDeclAndRefsForVariable(variableKey);
      return results.length ? results : null;
    }

    // Handlebars context
    const withinContent = hb.contentRanges.some((r: any) => offset >= r.start && offset <= r.end);
    if (withinContent) {
      return this.getHandlebarsReferences(hb, offset, doc, includeDecl);
    }

    return null;
  }

  private isPipelineContext(lineText: string): boolean {
    return /^\s*\|>\s*pipeline\s*:/.test(lineText) ||
           /^\s*when\s+executing\s+pipeline\s+/.test(lineText) ||
           /^\s*(with|and)\s+mock\s+pipeline\s+/.test(lineText) ||
           /^\s*pipeline\s+[A-Za-z_][\w-]*\s*=/.test(lineText);
  }

  private getVariableKey(lineText: string, word: string): string | null {
    // Variable declaration
    let m: RegExpExecArray | null;
    if ((m = /^\s*([A-Za-z_][\w-]*)\s+([A-Za-z_][\w-]*)\s*=\s*`/.exec(lineText))) {
      const varType = m[1];
      const varName = m[2];
      if (word === varName) return `${varType}::${varName}`;
    }

    // Step variable reference
    if ((m = /^\s*\|>\s*([A-Za-z_][\w-]*)\s*:\s*([A-Za-z_][\w-]*)?/.exec(lineText))) {
      const stepType = m[1];
      if (stepType !== 'pipeline') return `${stepType}::${word}`;
    }

    // BDD variable reference
    if ((m = /^\s*when\s+executing\s+variable\s+([A-Za-z_][\w-]*)\s+([A-Za-z_][\w-]*)/.exec(lineText))) {
      const varType = m[1];
      return `${varType}::${word}`;
    }

    // Mock variable reference
    if ((m = /^\s*(with|and)\s+mock\s+([A-Za-z_][\w-]*)\\.([A-Za-z_][\w-]*)/.exec(lineText))) {
      const varType = m[2];
      return `${varType}::${word}`;
    }

    return null;
  }

  private getVariableHover(lineText: string, text: string, word: string, symbols: SymbolTable): Hover | null {
    let m: RegExpExecArray | null;

    if ((m = /^\s*([A-Za-z_][\w-]*)\s+([A-Za-z_][\w-]*)\s*=\s*`/.exec(lineText))) {
      const varType = m[1];
      const md = this.formatVariableHover(text, varType, word, symbols);
      if (md) return { contents: { kind: MarkupKind.Markdown, value: md } };
    }

    if ((m = /^\s*\|>\s*([A-Za-z_][\w-]*)\s*:/.exec(lineText))) {
      const varType = m[1];
      if (varType !== 'pipeline') {
        const md = this.formatVariableHover(text, varType, word, symbols);
        if (md) return { contents: { kind: MarkupKind.Markdown, value: md } };
      }
    }

    if ((m = /^\s*when\s+executing\s+variable\s+([A-Za-z_][\w-]*)\s+/.exec(lineText))) {
      const varType = m[1];
      const md = this.formatVariableHover(text, varType, word, symbols);
      if (md) return { contents: { kind: MarkupKind.Markdown, value: md } };
    }

    if ((m = /^\s*(with|and)\s+mock\s+([A-Za-z_][\w-]*)\./.exec(lineText))) {
      const varType = m[2];
      const md = this.formatVariableHover(text, varType, word, symbols);
      if (md) return { contents: { kind: MarkupKind.Markdown, value: md } };
    }

    return null;
  }

  private getVariableDefinition(lineText: string, word: string, variablePositions: Map<string, any>, doc: TextDocument): Location | null {
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

    // Additional variable definition contexts...
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

  private getGraphQLHover(lineText: string, text: string, word: string): Hover | null {
    let m: RegExpExecArray | null;

    // Check for GraphQL mock context: "with mock query users" or "and mock mutation createUser"
    if ((m = /^\s*(with|and)\s+mock\s+(query|mutation)\s+([A-Za-z_][\w-]*)/.exec(lineText))) {
      const resolverType = m[2]; // "query" or "mutation"
      const resolverName = m[3];
      if (resolverName === word) {
        const md = this.formatGraphQLHover(text, resolverType, resolverName);
        if (md) return { contents: { kind: MarkupKind.Markdown, value: md } };
      }
    }

    // Check for GraphQL call assertion context: "and call query users with" or "then call mutation createUser with"
    if ((m = /^\s*(then|and)\s+call\s+(query|mutation)\s+([A-Za-z_][\w-]*)/.exec(lineText))) {
      const resolverType = m[2]; // "query" or "mutation"
      const resolverName = m[3];
      if (resolverName === word) {
        const md = this.formatGraphQLHover(text, resolverType, resolverName);
        if (md) return { contents: { kind: MarkupKind.Markdown, value: md } };
      }
    }

    return null;
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

  private getMiddlewareHover(lineText: string, word: string): Hover | null {
    // Check if this line contains a pipeline step with middleware name
    // Pattern: |> middlewareName: (config)
    const middlewareMatch = /^\s*\|>\s*([A-Za-z_][\w-]*)\s*:/.exec(lineText);
    if (middlewareMatch && middlewareMatch[1] === word) {
      // This is a middleware name in a pipeline step
      const middlewareDoc = getMiddlewareDoc(word);
      if (middlewareDoc) {
        const md = formatMiddlewareHover(middlewareDoc);
        return { contents: { kind: MarkupKind.Markdown, value: md } };
      }
    }

    // Check for result step (special case - no colon)
    // Pattern: |> result
    const resultMatch = /^\s*\|>\s*(result)\s*$/.exec(lineText);
    if (resultMatch && resultMatch[1] === word) {
      const middlewareDoc = getMiddlewareDoc(word);
      if (middlewareDoc) {
        const md = formatMiddlewareHover(middlewareDoc);
        return { contents: { kind: MarkupKind.Markdown, value: md } };
      }
    }

    // Check for pipeline declaration
    // Pattern: pipeline name =
    const pipelineDeclarationMatch = /^\s*(pipeline)\s+[A-Za-z_][\w-]*\s*=/.exec(lineText);
    if (pipelineDeclarationMatch && pipelineDeclarationMatch[1] === word) {
      const middlewareDoc = getMiddlewareDoc(word);
      if (middlewareDoc) {
        const md = formatMiddlewareHover(middlewareDoc);
        return { contents: { kind: MarkupKind.Markdown, value: md } };
      }
    }

    return null;
  }

  private getConfigHover(lineText: string, word: string): Hover | null {
    // Check if this line contains a config declaration
    // Pattern: config middlewareName {
    const configMatch = /^\s*config\s+([A-Za-z_][\w-]*)\s*\{/.exec(lineText);
    if (configMatch && configMatch[1] === word) {
      // This is a config name in a config declaration
      const configDoc = getConfigDoc(word);
      if (configDoc) {
        const md = formatConfigHover(configDoc);
        return { contents: { kind: MarkupKind.Markdown, value: md } };
      }
    }

    return null;
  }

  /**
   * Provides hover for Handlebars template variables ({{varName}}) in test blocks
   * by showing their let variable definitions.
   */
  private getTestLetVariableHover(text: string, offset: number, word: string, doc: TextDocument): Hover | null {
    // Check if we're inside a Handlebars template variable {{...}}
    const beforeCursor = text.slice(Math.max(0, offset - 100), offset);
    const afterCursor = text.slice(offset, Math.min(text.length, offset + 100));

    // Check if cursor is within {{...}}
    const lastOpenBrace = beforeCursor.lastIndexOf('{{');
    const lastCloseBrace = beforeCursor.lastIndexOf('}}');
    const nextCloseBrace = afterCursor.indexOf('}}');

    // We're inside {{...}} if the last {{ comes after the last }}
    if (lastOpenBrace === -1 || lastCloseBrace > lastOpenBrace || nextCloseBrace === -1) {
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
   * Provides go-to-definition for Handlebars and JQ variables in test blocks
   * Reuses the same context detection logic as hover
   */
  private getTestLetVariableDefinition(text: string, offset: number, word: string, doc: TextDocument): Location | null {
    // Check if we're in a Handlebars context {{...}}
    const beforeCursor = text.slice(Math.max(0, offset - 100), offset);
    const afterCursor = text.slice(offset, Math.min(text.length, offset + 100));

    const lastOpenBrace = beforeCursor.lastIndexOf('{{');
    const lastCloseBrace = beforeCursor.lastIndexOf('}}');
    const nextCloseBrace = afterCursor.indexOf('}}');

    const inHandlebars = lastOpenBrace !== -1 && lastCloseBrace < lastOpenBrace && nextCloseBrace !== -1;

    if (!inHandlebars) {
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