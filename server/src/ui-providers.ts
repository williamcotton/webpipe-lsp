import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  CodeLens, Location, DocumentHighlight, DocumentHighlightKind,
  CodeLensParams, DocumentHighlightParams, CodeActionParams, CodeAction,
  CodeActionKind, TextEdit
} from 'vscode-languageserver/node';
import { getWordAt } from './utils';
import { WorkspaceManager } from './workspace-manager';
import { filterReferencesInScope } from './symbol-collector';
import { findNodeAtOffset, getPipelineReferenceFromStep, getVariableReferenceFromStep } from './ast-utils';

export class UIProviders {
  constructor(private cache: WorkspaceManager) {}

  onCodeLens(_params: CodeLensParams, doc: TextDocument): CodeLens[] {
    const program = this.cache.getProgram(doc);
    const text = this.cache.getText(doc);
    const symbols = this.cache.getSymbols(doc);
    const lenses: CodeLens[] = [];

    // Pipeline code lenses
    for (const [name, pos] of symbols.pipelinePositions.entries()) {
      const refs = symbols.pipelineRefs.get(name) || [];
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

    // Variable code lenses (excluding handlebars)
    for (const [varType, byName] of symbols.variablePositions.entries()) {
      if (varType === 'handlebars') continue;
      for (const [varName, pos] of byName.entries()) {
        const refsByName = symbols.variableRefs.get(varType);
        const refs = refsByName?.get(varName) || [];
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
    }

    // Test let variable code lenses
    for (const pos of symbols.testLetVariablePositions) {
      // Get all references for this variable name
      const allRefs = symbols.testLetVariableRefs.get(pos.name) || [];

      // Filter to only references in scope using AST positions
      const scopedRefs = filterReferencesInScope(pos, allRefs, program);

      const range = { start: doc.positionAt(pos.start), end: doc.positionAt(pos.start + pos.length) };
      const locations = scopedRefs.map(r => Location.create(doc.uri, { start: doc.positionAt(r.start), end: doc.positionAt(r.start + r.length) }));
      lenses.push({
        range,
        command: {
          title: `${locations.length} reference${locations.length === 1 ? '' : 's'}`,
          command: 'webpipe.showReferences',
          arguments: [doc.uri, range.start, locations]
        }
      });
    }

    // Handlebars partial code lenses
    for (const [name, decl] of symbols.handlebars.declByName.entries()) {
      const range = { start: doc.positionAt(decl.nameStart), end: doc.positionAt(decl.nameEnd) };
      const uses = symbols.handlebars.usagesByName.get(name) || [];
      const locations = uses.map(u => Location.create(doc.uri, { start: doc.positionAt(u.start), end: doc.positionAt(u.end) }));
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
  }

  onDocumentHighlight(params: DocumentHighlightParams, doc: TextDocument): DocumentHighlight[] | null {
    const text = this.cache.getText(doc);
    const program = this.cache.getProgram(doc);
    const symbols = this.cache.getSymbols(doc);
    const pos = params.position;
    const offset = doc.offsetAt(pos);
    const wordInfo = getWordAt(text, offset);
    if (!wordInfo) return null;

    const { word } = wordInfo;
    const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
    const nextNl = text.indexOf('\n', offset);
    const lineEnd = nextNl === -1 ? text.length : nextNl;
    const lineText = text.slice(lineStart, lineEnd);
    const astNode = findNodeAtOffset(program, offset) as any;

    const highlights: DocumentHighlight[] = [];
    const addRanges = (decl: { start: number; length: number } | undefined, refs: Array<{ start: number; length: number }>) => {
      if (decl) {
        highlights.push({ 
          range: { start: doc.positionAt(decl.start), end: doc.positionAt(decl.start + decl.length) }, 
          kind: DocumentHighlightKind.Write 
        });
      }
      for (const r of refs) {
        highlights.push({ 
          range: { start: doc.positionAt(r.start), end: doc.positionAt(r.start + r.length) }, 
          kind: DocumentHighlightKind.Read 
        });
      }
    };

    // Pipeline highlights
    if (this.isPipelineContext(lineText, astNode)) {
      const decl = symbols.pipelinePositions.get(word);
      const refs = symbols.pipelineRefs.get(word) || [];
      addRanges(decl, refs);
      return highlights.length ? highlights : null;
    }

    // Variable highlights
    const variableKey = this.getVariableKey(lineText, word, astNode);
    if (variableKey) {
      const declsByName = symbols.variablePositions.get(variableKey.varType);
      const decl = declsByName?.get(variableKey.varName);
      const refsByName = symbols.variableRefs.get(variableKey.varType);
      const refs = refsByName?.get(variableKey.varName) || [];
      addRanges(decl, refs);
      return highlights.length ? highlights : null;
    }

    return null;
  }

  private isPipelineContext(lineText: string, node?: any): boolean {
    if (node?.kind === 'Regular' && getPipelineReferenceFromStep(node)) {
      return true;
    }

    return /^\s*\|>\s*pipeline\s*:/.test(lineText) ||
           /^\s*when\s+executing\s+pipeline\s+/.test(lineText) ||
           /^\s*(with|and)\s+mock\s+pipeline\s+/.test(lineText) ||
           /^\s*pipeline\s+[A-Za-z_][\w-]*\s*=/.test(lineText);
  }

  private getVariableKey(lineText: string, word: string, node?: any): { varType: string; varName: string } | null {
    let m: RegExpExecArray | null;

    if (node?.kind === 'Regular') {
      const variableRef = getVariableReferenceFromStep(node);
      if (variableRef && word === variableRef.varName) {
        return { varType: variableRef.varType, varName: variableRef.varName };
      }
      if (getPipelineReferenceFromStep(node)) {
        return null;
      }
    }

    if ((m = /^\s*([A-Za-z_][\w-]*)\s+([A-Za-z_][\w-]*)\s*=\s*`/.exec(lineText))) {
      const varType = m[1];
      const varName = m[2];
      if (word === varName) return { varType, varName };
    }

    if (/^\s*\|>\s*([A-Za-z_][\w-]*)\s*:/.test(lineText) ||
        /^\s*when\s+executing\s+variable\s+/.test(lineText) ||
         /^\s*(with|and)\s+mock\s+[A-Za-z_][\w-]*\./.test(lineText)) {

      const stepTypeMatch = /^\s*\|>\s*([A-Za-z_][\w-]*)\s*:/.exec(lineText);
      const execVarMatch = /^\s*when\s+executing\s+variable\s+([A-Za-z_][\w-]*)\s+/.exec(lineText);
      const mockTypeMatch = /^\s*(with|and)\s+mock\s+([A-Za-z_][\w-]*)\./.exec(lineText);

      const varType = (stepTypeMatch && stepTypeMatch[1] !== 'pipeline') ? stepTypeMatch[1] :
                     (execVarMatch ? execVarMatch[1] :
                     (mockTypeMatch ? mockTypeMatch[2] : undefined));

      if (varType) return { varType, varName: word };
    }

    return null;
  }

  onCodeAction(params: CodeActionParams, doc: TextDocument): CodeAction[] {
    const text = this.cache.getText(doc);
    const range = params.range;
    const start = doc.offsetAt(range.start);
    const end = doc.offsetAt(range.end);

    // Check if selection is empty
    if (start === end) return [];

    const selectedText = text.slice(start, end);

    // Check if the selection contains pipeline steps (|> ...)
    // Match |> followed by any identifier and optional colon
    const stepPattern = /\|>\s+[A-Za-z_][\w-]*\s*:/;
    if (!stepPattern.test(selectedText)) return [];

    // Count pipeline steps in selection - at least one step required
    const stepMatches = selectedText.match(/\|>\s+[A-Za-z_][\w-]*\s*:/g);
    if (!stepMatches || stepMatches.length === 0) return [];

    // Create the code action with a command that will prompt for the name
    const codeAction: CodeAction = {
      title: 'Extract Pipeline',
      kind: CodeActionKind.RefactorExtract,
      command: {
        title: 'Extract Pipeline',
        command: 'webpipe.extractPipeline',
        arguments: [doc.uri, range]
      }
    };

    return [codeAction];
  }

  createExtractPipelineEdit(rangeLike: any, pipelineName: string, doc: TextDocument) {
    const text = this.cache.getText(doc);
    const range = {
      start: { line: rangeLike.start.line, character: rangeLike.start.character },
      end: { line: rangeLike.end.line, character: rangeLike.end.character }
    };
    const start = doc.offsetAt(range.start);
    const end = doc.offsetAt(range.end);
    const selectedText = text.slice(start, end);

    // Find a good insertion point for the pipeline declaration using AST
    // Look for the node containing the selection and insert before it
    const program = this.cache.getProgram(doc);
    const node = findNodeAtOffset(program, start);

    let insertionOffset = 0;

    // If we found a node, use its start position as the insertion point
    if (node && 'start' in node) {
      insertionOffset = (node as any).start;
    } else {
      // Fallback: find the last declaration before the selection
      const beforeSelection = text.slice(0, start);
      const routeOrDeclPattern = /(^|\n)((?:GET|POST|PUT|DELETE)\s|(?:pipeline\s+[A-Za-z_][\w-]*\s*=)|(?:[A-Za-z_][\w-]*\s+[A-Za-z_][\w-]*\s*=))/g;
      let lastMatch = null;
      let match;
      while ((match = routeOrDeclPattern.exec(beforeSelection)) !== null) {
        lastMatch = match;
      }
      insertionOffset = lastMatch ? lastMatch.index : 0;
    }

    const insertionPos = doc.positionAt(insertionOffset);

    // Create the pipeline declaration
    const indent = selectedText.match(/^(\s*)/)?.[1] || '  ';
    const pipelineDecl = `pipeline ${pipelineName} =\n${selectedText}\n\n`;

    // Create the edits
    const edits: TextEdit[] = [
      // Insert the pipeline declaration
      TextEdit.insert(insertionPos, pipelineDecl),
      // Replace the selected steps with |> pipeline: pipelineName
      TextEdit.replace(range, `${indent}|> pipeline: ${pipelineName}`)
    ];

    return { changes: { [doc.uri]: edits } };
  }
}
