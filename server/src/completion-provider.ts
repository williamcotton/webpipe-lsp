import { TextDocument } from 'vscode-languageserver-textdocument';
import { CompletionItem, CompletionItemKind, Position, CompletionParams } from 'vscode-languageserver/node';
import { KNOWN_MIDDLEWARE, KNOWN_STEPS, VALID_HTTP_METHODS, REGEX_PATTERNS } from './constants';
import { collectHandlebarsSymbols } from './symbol-collector';
import { DocumentCache } from './document-cache';

export class CompletionProvider {
  constructor(private cache: DocumentCache) {}

  onCompletion(params: CompletionParams, doc: TextDocument): CompletionItem[] {
    const text = this.cache.getText(doc);
    const program = this.cache.getProgram(doc);

    const variablesByType = new Map<string, Set<string>>();
    for (const v of program.variables) {
      if (!variablesByType.has(v.varType)) variablesByType.set(v.varType, new Set());
      variablesByType.get(v.varType)!.add(v.name);
    }
    const pipelineNames = new Set<string>(program.pipelines.map((p: any) => p.name));

    const pos = params.position as Position;
    const offset = doc.offsetAt(pos);
    const startOfLine = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
    const linePrefix = text.slice(startOfLine, offset);

    // Pipeline reference completion
    const pipelineCompletion = this.getPipelineCompletion(linePrefix, pipelineNames, doc, startOfLine, offset);
    if (pipelineCompletion) return pipelineCompletion;

    // Variable reference completion  
    const variableCompletion = this.getVariableCompletion(linePrefix, variablesByType, doc, startOfLine, offset);
    if (variableCompletion) return variableCompletion;

    // Middleware step name completion
    const middlewareCompletion = this.getMiddlewareCompletion(linePrefix, doc, startOfLine, offset);
    if (middlewareCompletion) return middlewareCompletion;

    // Config block name completion
    const configCompletion = this.getConfigNameCompletion(linePrefix, doc, startOfLine, offset);
    if (configCompletion) return configCompletion;

    // Auth flow values completion
    const authFlowCompletion = this.getAuthFlowCompletion(linePrefix, doc, startOfLine, offset);
    if (authFlowCompletion) return authFlowCompletion;

    // Test pipeline name completion
    const testPipelineCompletion = this.getTestPipelineCompletion(linePrefix, pipelineNames, doc, startOfLine, offset);
    if (testPipelineCompletion) return testPipelineCompletion;

    // Route method/path completion in tests
    const routeCompletion = this.getWhenCallingCompletion(linePrefix, text, doc, startOfLine, offset);
    if (routeCompletion) return routeCompletion;

    // Handlebars partial completion inside template content
    const handlebarsCompletion = this.getHandlebarsPartialCompletion(linePrefix, text, doc, offset, startOfLine);
    if (handlebarsCompletion) return handlebarsCompletion;

    return [];
  }

  private getPipelineCompletion(
    linePrefix: string, 
    pipelineNames: Set<string>, 
    doc: TextDocument, 
    startOfLine: number, 
    offset: number
  ): CompletionItem[] | null {
    const pipeLineRe = /^\s*\|>\s*pipeline\s*:\s*([A-Za-z_][\w-]*)?$/;
    const pm = pipeLineRe.exec(linePrefix);
    
    if (!pm) return null;

    const typed = pm[1] || '';
    const typedLen = typed.length;
    const colonIdx = linePrefix.lastIndexOf(':');
    const varStartInLine = linePrefix.length - typedLen;
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

  private getVariableCompletion(
    linePrefix: string, 
    variablesByType: Map<string, Set<string>>, 
    doc: TextDocument, 
    startOfLine: number, 
    offset: number
  ): CompletionItem[] | null {
    const stepVarLineRe = /^\s*\|>\s*([A-Za-z_][\w-]*)\s*:\s*([A-Za-z_][\w-]*)?$/;
    const m = stepVarLineRe.exec(linePrefix);
    
    if (!m) return null;

    const stepType = m[1];
    const typed = m[2] || '';
    const typedLen = typed.length;
    
    if (stepType === 'pipeline') return null;

    const candidates = variablesByType.get(stepType);
    if (!candidates || candidates.size === 0) return null;

    const colonIdx = linePrefix.lastIndexOf(':');
    const varStartInLine = linePrefix.length - typedLen;
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

  private getMiddlewareCompletion(
    linePrefix: string,
    doc: TextDocument,
    startOfLine: number,
    offset: number
  ): CompletionItem[] | null {
    const m = /^\s*\|>\s*([A-Za-z_][\w-]*)?$/.exec(linePrefix);
    if (!m) return null;
    const typed = m[1] || '';
    const typedLen = typed.length;
    const varStartInLine = linePrefix.length - typedLen;
    const startAbs = startOfLine + varStartInLine;
    const endAbs = offset;
    const range = { start: doc.positionAt(startAbs), end: doc.positionAt(endAbs) };

    return Array.from(KNOWN_STEPS).map<CompletionItem>(name => ({
      label: name,
      kind: CompletionItemKind.Keyword,
      textEdit: { range, newText: name + ': ' }
    }));
  }

  private getConfigNameCompletion(
    linePrefix: string,
    doc: TextDocument,
    startOfLine: number,
    offset: number
  ): CompletionItem[] | null {
    const m = /^\s*config\s+([A-Za-z_][\w-]*)?$/.exec(linePrefix);
    if (!m) return null;
    const typed = m[1] || '';
    const typedLen = typed.length;
    const varStartInLine = linePrefix.length - typedLen;
    const startAbs = startOfLine + varStartInLine;
    const endAbs = offset;
    const range = { start: doc.positionAt(startAbs), end: doc.positionAt(endAbs) };

    return Array.from(KNOWN_MIDDLEWARE).map<CompletionItem>(name => ({
      label: name,
      kind: CompletionItemKind.Keyword,
      textEdit: { range, newText: name + ' ' }
    }));
  }

  private getAuthFlowCompletion(
    linePrefix: string,
    doc: TextDocument,
    startOfLine: number,
    offset: number
  ): CompletionItem[] | null {
    const m = /^\s*\|>\s*auth\s*:\s*"([^"]*)?$/.exec(linePrefix);
    if (!m) return null;
    const quoteStartInLine = linePrefix.lastIndexOf('"');
    const startAbs = startOfLine + quoteStartInLine + 1;
    const endAbs = startOfLine + linePrefix.length;
    const range = { start: doc.positionAt(startAbs), end: doc.positionAt(endAbs) };

    const flows = ['optional', 'required', 'login', 'register', 'logout'];
    return flows.map<CompletionItem>(flow => ({
      label: flow,
      kind: CompletionItemKind.Value,
      textEdit: { range, newText: flow }
    }));
  }

  private getTestPipelineCompletion(
    linePrefix: string,
    pipelineNames: Set<string>,
    doc: TextDocument,
    startOfLine: number,
    offset: number
  ): CompletionItem[] | null {
    let m = /^\s*when\s+executing\s+pipeline\s+([A-Za-z_][\w-]*)?$/.exec(linePrefix);
    if (!m) {
      m = /^\s*(with|and)\s+mock\s+pipeline\s+([A-Za-z_][\w-]*)?$/.exec(linePrefix);
    }
    if (!m) return null;
    const typed = (m[1] && m[1] !== 'with' && m[1] !== 'and') ? m[1] : (m[2] || '');
    const typedLen = typed.length;
    const varStartInLine = linePrefix.length - typedLen;
    const startAbs = startOfLine + varStartInLine;
    const endAbs = offset;
    const range = { start: doc.positionAt(startAbs), end: doc.positionAt(endAbs) };

    return Array.from(pipelineNames).map<CompletionItem>(name => ({
      label: name,
      kind: CompletionItemKind.Function,
      textEdit: { range, newText: name }
    }));
  }

  private getWhenCallingCompletion(
    linePrefix: string,
    fullText: string,
    doc: TextDocument,
    startOfLine: number,
    offset: number
  ): CompletionItem[] | null {
    let m = /^\s*when\s+calling\s+([A-Z]*)$/.exec(linePrefix);
    if (m) {
      const typed = m[1] || '';
      const typedLen = typed.length;
      const varStartInLine = linePrefix.length - typedLen;
      const startAbs = startOfLine + varStartInLine;
      const endAbs = offset;
      const range = { start: doc.positionAt(startAbs), end: doc.positionAt(endAbs) };
      return Array.from(VALID_HTTP_METHODS).map<CompletionItem>(method => ({
        label: method,
        kind: CompletionItemKind.Keyword,
        textEdit: { range, newText: method + ' ' }
      }));
    }

    m = /^\s*when\s+calling\s+([A-Z]+)\s+([^\s]*)$/.exec(linePrefix);
    if (!m) return null;
    const method = m[1];
    const typedPath = m[2] || '';
    if (!VALID_HTTP_METHODS.has(method)) return null;

    const routeDeclRe = new RegExp(REGEX_PATTERNS.ROUTE_DECL.source, REGEX_PATTERNS.ROUTE_DECL.flags);
    const paths: string[] = [];
    for (let rm; (rm = routeDeclRe.exec(fullText)); ) {
      const mth = rm[2];
      const p = (rm[3] || '').trim();
      if (mth === method) paths.push(p);
    }

    const typedLen = typedPath.length;
    const varStartInLine = linePrefix.length - typedLen;
    const startAbs = startOfLine + varStartInLine;
    const endAbs = offset;
    const range = { start: doc.positionAt(startAbs), end: doc.positionAt(endAbs) };

    return paths.map<CompletionItem>(p => ({
      label: p,
      kind: CompletionItemKind.Value,
      textEdit: { range, newText: p }
    }));
  }

  private getHandlebarsPartialCompletion(
    linePrefix: string,
    fullText: string,
    doc: TextDocument,
    offset: number,
    startOfLine: number
  ): CompletionItem[] | null {
    const hb = collectHandlebarsSymbols(fullText);
    const withinContent = hb.contentRanges.some((r: { start: number; end: number }) => offset >= r.start && offset <= r.end);
    if (!withinContent) return null;

    // Allow triggering with or without a space; also trigger right after '>'
    // Examples: '{{> header', '{{>header', '{{>:' (Cursor immediately after '>')
    const usable = linePrefix.replace(/\s*\}\}\s*$/, '');
    const includeMatch = /\{\{>\s*([A-Za-z_][\w./-]*)?$|\{\{>$/ .exec(usable);
    if (!includeMatch) return null;
    const typed = includeMatch[1] || '';

    const names = new Set<string>();
    for (const name of hb.declByName.keys()) names.add(name);
    for (const entry of hb.inlineDefsByContent) {
      if (offset >= entry.range.start && offset <= entry.range.end) {
        for (const name of entry.inlineByName.keys()) names.add(name);
        for (const name of entry.inlineBlockByName.keys()) names.add(name);
        break;
      }
    }

    const typedLen = typed.length;
    const varStartInLine = usable.endsWith('{{>') ? usable.length : usable.length - typedLen;
    const startAbs = startOfLine + varStartInLine;
    const endAbs = startOfLine + usable.length;
    const range = { start: doc.positionAt(startAbs), end: doc.positionAt(endAbs) };

    return Array.from(names).map<CompletionItem>(name => ({
      label: name,
      kind: CompletionItemKind.Reference,
      textEdit: { range, newText: name }
    }));
  }
}