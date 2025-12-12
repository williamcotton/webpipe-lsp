import { Program, TestLetVariable } from 'webpipe-js';
import { getVariableRanges, getPipelineRanges, getTestLetVariables } from 'webpipe-js';
import { SymbolTable, PositionInfo, TestLetVariablePosition } from './types';
import { collectReferencesFromAST, collectHandlebarsSymbols, collectTestLetVariableReferences, collectGraphQLReferencesFromAST } from './symbol-collector';

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
  const testLetVariables = getTestLetVariables(text);

  const variablePositions = new Map<string, Map<string, PositionInfo>>();
  for (const [varType, byName] of variableRanges.entries()) {
    const positionsByName = new Map<string, PositionInfo>();
    for (const [varName, r] of byName.entries()) {
      positionsByName.set(varName, { start: r.start, length: r.end - r.start });
    }
    variablePositions.set(varType, positionsByName);
  }

  const pipelinePositions = new Map<string, PositionInfo>();
  for (const [name, r] of pipelineRanges.entries()) {
    pipelinePositions.set(name, { start: r.start, length: r.end - r.start });
  }

  const testLetVariablePositions: TestLetVariablePosition[] = testLetVariables.map(v => ({
    name: v.name,
    describeName: v.describeName,
    testName: v.testName,
    start: v.start,
    length: v.end - v.start
  }));

  // Build GraphQL resolver positions
  const queryPositions = new Map<string, PositionInfo>();
  for (const query of program.queries) {
    // The name starts after "query "
    const nameStart = query.start + 'query '.length;
    queryPositions.set(query.name, {
      start: nameStart,
      length: query.name.length
    });
  }

  const mutationPositions = new Map<string, PositionInfo>();
  for (const mutation of program.mutations) {
    // The name starts after "mutation "
    const nameStart = mutation.start + 'mutation '.length;
    mutationPositions.set(mutation.name, {
      start: nameStart,
      length: mutation.name.length
    });
  }

  // Get reference positions using AST traversal (no more regex!)
  const { variableRefs, pipelineRefs } = collectReferencesFromAST(program);

  // Get GraphQL resolver references
  const { queryRefs, mutationRefs } = collectGraphQLReferencesFromAST(program, text);

  // Get test let variable references (scope-aware)
  const testLetVariableRefs = collectTestLetVariableReferences(text, program);

  // Get handlebars symbols (AST-based)
  const handlebars = collectHandlebarsSymbols(text, program);

  return {
    variables,
    pipelines,
    variableRefs,
    pipelineRefs,
    testLetVariableRefs,
    variablePositions,
    pipelinePositions,
    testLetVariablePositions,
    queryPositions,
    mutationPositions,
    queryRefs,
    mutationRefs,
    handlebars
  };
}
