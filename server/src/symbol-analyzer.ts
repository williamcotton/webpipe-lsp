import { Program } from 'webpipe-js';
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
  const variablePositions = new Map<string, Map<string, PositionInfo>>();

  for (const v of program.variables) {
    if (!variables.has(v.varType)) {
      variables.set(v.varType, new Set());
      variablePositions.set(v.varType, new Map());
    }
    variables.get(v.varType)!.add(v.name);

    // Calculate name position from AST
    // v.start usually points to the start of the line/keyword (e.g. "pg " or "handlebars ")
    // We search for the name starting after the type keyword
    const searchStart = v.start + v.varType.length;
    const nameIndex = text.indexOf(v.name, searchStart);

    if (nameIndex !== -1 && nameIndex < v.end) {
      variablePositions.get(v.varType)!.set(v.name, {
        start: nameIndex,
        length: v.name.length
      });
    } else {
      // Fallback if strict parsing fails (e.g. malformed)
      variablePositions.get(v.varType)!.set(v.name, {
        start: v.start,
        length: v.name.length
      });
    }
  }

  const pipelines = new Set<string>();
  const pipelinePositions = new Map<string, PositionInfo>();

  for (const p of program.pipelines) {
    pipelines.add(p.name);

    // Search for name after "pipeline "
    const searchStart = p.start + 'pipeline'.length;
    const nameIndex = text.indexOf(p.name, searchStart);

    if (nameIndex !== -1 && nameIndex < p.end) {
      pipelinePositions.set(p.name, {
        start: nameIndex,
        length: p.name.length
      });
    } else {
      pipelinePositions.set(p.name, {
        start: p.start,
        length: p.name.length
      });
    }
  }

  // Test Let Variables (AST based)
  const testLetVariablePositions: TestLetVariablePosition[] = [];

  for (const describe of program.describes) {
    // Describe-level variables
    if (describe.variables) {
      for (const v of describe.variables) {
        // Look for name after "let "
        const searchStart = v.start + 'let'.length;
        const nameIndex = text.indexOf(v.name, searchStart);

        if (nameIndex !== -1 && nameIndex < v.end) {
          testLetVariablePositions.push({
            name: v.name,
            describeName: describe.name,
            start: nameIndex,
            length: v.name.length
          });
        }
      }
    }

    // Test-level variables
    if (describe.tests) {
      for (const test of describe.tests) {
        if (test.variables) {
          for (const v of test.variables) {
            const searchStart = v.start + 'let'.length;
            const nameIndex = text.indexOf(v.name, searchStart);

            if (nameIndex !== -1 && nameIndex < v.end) {
              testLetVariablePositions.push({
                name: v.name,
                describeName: describe.name,
                testName: test.name,
                start: nameIndex,
                length: v.name.length
              });
            }
          }
        }
      }
    }
  }

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
