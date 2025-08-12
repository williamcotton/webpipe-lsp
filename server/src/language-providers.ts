import { TextDocument } from 'vscode-languageserver-textdocument';
import { 
  Location, Position, Hover, MarkupKind, ReferenceParams, 
  HoverParams, DefinitionParams
} from 'vscode-languageserver/node';
import { 
  collectDeclarationPositions, collectReferencePositions, 
  collectHandlebarsSymbols 
} from './symbol-collector';
import { getVariableRanges, getPipelineRanges } from './parser';
import { getWordAt, createMarkdownCodeBlock } from './utils';
import { RangeAbs } from './types';

export class LanguageProviders {
  onReferences(params: ReferenceParams, documents: Map<string, TextDocument>): Location[] | null {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;
    
    const text = doc.getText();
    const { variablePositions, pipelinePositions } = collectDeclarationPositions(text);
    const { variableRefs, pipelineRefs } = collectReferencePositions(text);
    const hb = collectHandlebarsSymbols(text);
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

    // Context-based reference resolution
    return this.resolveReferences(lineText, word, addDeclAndRefsForPipeline, addDeclAndRefsForVariable, hb, offset, doc, includeDecl, results);
  }

  onHover(params: HoverParams, documents: Map<string, TextDocument>): Hover | null {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;
    
    const text = doc.getText();
    const pos = params.position as Position;
    const offset = doc.offsetAt(pos);
    const wordInfo = getWordAt(text, offset);
    if (!wordInfo) return null;
    
    const { word } = wordInfo;
    const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
    const nextNl = text.indexOf('\n', offset);
    const lineEnd = nextNl === -1 ? text.length : nextNl;
    const lineText = text.slice(lineStart, lineEnd);

    // Pipeline hover
    if (this.isPipelineContext(lineText)) {
      const md = this.formatPipelineHover(text, word);
      if (md) return { contents: { kind: MarkupKind.Markdown, value: md } };
    }

    // Variable hover
    const variableHover = this.getVariableHover(lineText, text, word);
    if (variableHover) return variableHover;

    // Handlebars partial hover
    const handlebarsHover = this.getHandlebarsHover(text, offset, word, doc);
    if (handlebarsHover) return handlebarsHover;

    return null;
  }

  onDefinition(params: DefinitionParams, documents: Map<string, TextDocument>): Location | null {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;
    
    const text = doc.getText();
    const { variablePositions, pipelinePositions } = collectDeclarationPositions(text);
    const hb = collectHandlebarsSymbols(text);
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
      const hit = pipelinePositions.get(word);
      if (hit) {
        const range = { start: doc.positionAt(hit.start), end: doc.positionAt(hit.start + hit.length) };
        return Location.create(doc.uri, range);
      }
    }

    // Variable definition
    const variableDefinition = this.getVariableDefinition(lineText, word, variablePositions, doc);
    if (variableDefinition) return variableDefinition;

    // Handlebars definition
    const handlebarsDefinition = this.getHandlebarsDefinition(hb, offset, doc);
    if (handlebarsDefinition) return handlebarsDefinition;

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

  private getVariableHover(lineText: string, text: string, word: string): Hover | null {
    let m: RegExpExecArray | null;
    
    if ((m = /^\s*([A-Za-z_][\w-]*)\s+([A-Za-z_][\w-]*)\s*=\s*`/.exec(lineText))) {
      const varType = m[1];
      const md = this.formatVariableHover(text, varType, word);
      if (md) return { contents: { kind: MarkupKind.Markdown, value: md } };
    }
    
    if ((m = /^\s*\|>\s*([A-Za-z_][\w-]*)\s*:/.exec(lineText))) {
      const varType = m[1];
      if (varType !== 'pipeline') {
        const md = this.formatVariableHover(text, varType, word);
        if (md) return { contents: { kind: MarkupKind.Markdown, value: md } };
      }
    }
    
    if ((m = /^\s*when\s+executing\s+variable\s+([A-Za-z_][\w-]*)\s+/.exec(lineText))) {
      const varType = m[1];
      const md = this.formatVariableHover(text, varType, word);
      if (md) return { contents: { kind: MarkupKind.Markdown, value: md } };
    }
    
    if ((m = /^\s*(with|and)\s+mock\s+([A-Za-z_][\w-]*)\\./.exec(lineText))) {
      const varType = m[2];
      const md = this.formatVariableHover(text, varType, word);
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

    const mockVar = /^\s*(with|and)\s+mock\s+([A-Za-z_][\w-]*)\\.([A-Za-z_][\w-]*)/;
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

  private getHandlebarsHover(text: string, offset: number, word: string, doc: TextDocument): Hover | null {
    const hb = collectHandlebarsSymbols(text);
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
              const varRanges = getVariableRanges(text);
              const full = varRanges.get(`handlebars::${name}`);
              if (full) defRange = { start: full.start, end: full.end };
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

  private formatVariableHover(text: string, varType: string, varName: string): string | null {
    const ranges = getVariableRanges(text);
    const r = ranges.get(`${varType}::${varName}`);
    if (!r) return null;
    let snippet = text.slice(r.start, r.end).trimEnd();
    if (snippet.length > 2400) snippet = snippet.slice(0, 2400) + '\n…';
    return createMarkdownCodeBlock('webpipe', snippet);
  }

  private formatPipelineHover(text: string, pipelineName: string): string | null {
    const ranges = getPipelineRanges(text);
    const r = ranges.get(pipelineName);
    if (!r) return null;
    let snippet = text.slice(r.start, r.end).trimEnd();
    if (snippet.length > 2400) snippet = snippet.slice(0, 2400) + '\n…';
    return createMarkdownCodeBlock('webpipe', snippet);
  }
}