import { TextDocument } from 'vscode-languageserver-textdocument';
import { CompletionItem, CompletionItemKind, Position, CompletionParams } from 'vscode-languageserver/node';
import { collectVariablesAndPipelines } from './symbol-collector';

export class CompletionProvider {
  onCompletion(params: CompletionParams, documents: Map<string, TextDocument>): CompletionItem[] {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    
    const text = doc.getText();
    const { variablesByType, pipelineNames } = collectVariablesAndPipelines(text);

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
}