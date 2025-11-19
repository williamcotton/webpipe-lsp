import { Program } from 'webpipe-js';
import { getVariableRanges, getPipelineRanges } from 'webpipe-js';
import { SymbolTable, PositionInfo } from './types';
import { collectReferencePositions, collectHandlebarsSymbols } from './symbol-collector';

/**
 * Builds a complete symbol table from the parsed AST and source text.
 * This centralizes all symbol information needed by language providers.
 *
 * The symbol table is computed once per document version and cached,
 * eliminating repeated regex parsing on every hover/definition/reference request.
 */
export function buildSymbolTable(program: Program, text: string): SymbolTable {
  // Extract declarations from AST
  const variables = new Map<string, Set<string>>();
  for (const v of program.variables) {
    if (!variables.has(v.varType)) {
      variables.set(v.varType, new Set());
    }
    variables.get(v.varType)!.add(v.name);
  }

  const pipelines = new Set<string>();
  for (const p of program.pipelines) {
    pipelines.add(p.name);
  }

  // Get declaration positions from webpipe-js utilities
  const variableRanges = getVariableRanges(text);
  const pipelineRanges = getPipelineRanges(text);

  const variablePositions = new Map<string, PositionInfo>();
  for (const [key, r] of variableRanges.entries()) {
    variablePositions.set(key, { start: r.start, length: r.end - r.start });
  }

  const pipelinePositions = new Map<string, PositionInfo>();
  for (const [name, r] of pipelineRanges.entries()) {
    pipelinePositions.set(name, { start: r.start, length: r.end - r.start });
  }

  // Get reference positions (still using regex for now, but centralized)
  const { variableRefs, pipelineRefs } = collectReferencePositions(text);

  // Get handlebars symbols
  const handlebars = collectHandlebarsSymbols(text);

  return {
    variables,
    pipelines,
    variableRefs,
    pipelineRefs,
    variablePositions,
    pipelinePositions,
    handlebars
  };
}
