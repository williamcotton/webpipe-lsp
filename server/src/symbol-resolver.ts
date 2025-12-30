import { SymbolResolutionResult, PositionInfo } from './types';

/**
 * SymbolResolver handles cross-file symbol resolution
 * Resolves scoped references like "db::query" to their definitions in imported files
 */
export class SymbolResolver {
  /**
   * Resolve a scoped reference (alias::symbol) to its definition
   * Works for pipelines, queries, and mutations
   * @param fromUri URI of the file containing the reference
   * @param scopedRef The scoped reference (e.g., "db::loadUsers")
   * @param getFileMetadata Function to get file metadata by URI
   * @returns Symbol resolution result or null if not found
   */
  resolveReference(
    fromUri: string,
    scopedRef: string,
    getFileMetadata: (uri: string) => any
  ): SymbolResolutionResult | null {
    // Parse scoped reference
    const parts = scopedRef.split('::');
    if (parts.length !== 2) {
      return null; // Not a scoped reference
    }

    const [alias, symbolName] = parts;

    // Get metadata for the source file
    const sourceMetadata = getFileMetadata(fromUri);
    if (!sourceMetadata) {
      return null;
    }

    // Find the import with matching alias
    const importDecl = sourceMetadata.imports?.find((imp: any) => imp.alias === alias);
    if (!importDecl || !importDecl.resolved) {
      return null; // Import not found or not resolved
    }

    // Get metadata for the imported file
    const targetMetadata = getFileMetadata(importDecl.uri);
    if (!targetMetadata) {
      return null; // Imported file not loaded
    }

    // Check if symbol exists in exported symbols
    const { exportedSymbols, symbols } = targetMetadata;

    // Try to find as pipeline
    if (exportedSymbols.pipelines?.has(symbolName)) {
      const position = symbols.pipelinePositions?.get(symbolName);
      if (position) {
        return {
          uri: importDecl.uri,
          symbol: position,
          type: 'pipeline'
        };
      }
      // Pipeline exists in exports but position not found - return a placeholder
      // This can happen if the symbol table wasn't fully built yet
      return {
        uri: importDecl.uri,
        symbol: { start: 0, length: symbolName.length },
        type: 'pipeline'
      };
    }

    // Try to find as query
    if (exportedSymbols.queries?.has(symbolName)) {
      const position = symbols.queryPositions?.get(symbolName);
      if (position) {
        return {
          uri: importDecl.uri,
          symbol: position,
          type: 'query'
        };
      }
      return {
        uri: importDecl.uri,
        symbol: { start: 0, length: symbolName.length },
        type: 'query'
      };
    }

    // Try to find as mutation
    if (exportedSymbols.mutations?.has(symbolName)) {
      const position = symbols.mutationPositions?.get(symbolName);
      if (position) {
        return {
          uri: importDecl.uri,
          symbol: position,
          type: 'mutation'
        };
      }
      return {
        uri: importDecl.uri,
        symbol: { start: 0, length: symbolName.length },
        type: 'mutation'
      };
    }

    return null; // Symbol not found in imported file
  }

  /**
   * Resolve a scoped variable reference (alias::varName) with type information
   * @param fromUri URI of the file containing the reference
   * @param varType The variable type (e.g., "pg", "handlebars", "jq")
   * @param scopedRef The scoped reference (e.g., "db::query")
   * @param getFileMetadata Function to get file metadata by URI
   * @returns Symbol resolution result or null if not found
   */
  resolveVariableReference(
    fromUri: string,
    varType: string,
    scopedRef: string,
    getFileMetadata: (uri: string) => any
  ): SymbolResolutionResult | null {
    // Parse scoped reference
    const parts = scopedRef.split('::');
    if (parts.length !== 2) {
      return null; // Not a scoped reference
    }

    const [alias, varName] = parts;

    // Get metadata for the source file
    const sourceMetadata = getFileMetadata(fromUri);
    if (!sourceMetadata) {
      return null;
    }

    // Find the import with matching alias
    const importDecl = sourceMetadata.imports?.find((imp: any) => imp.alias === alias);
    if (!importDecl || !importDecl.resolved) {
      return null; // Import not found or not resolved
    }

    // Get metadata for the imported file
    const targetMetadata = getFileMetadata(importDecl.uri);
    if (!targetMetadata) {
      return null; // Imported file not loaded
    }

    // Check if variable exists in exported symbols with the correct type
    const { exportedSymbols, symbols } = targetMetadata;
    const varsOfType = exportedSymbols.variables?.get(varType);

    if (varsOfType?.has(varName)) {
      const position = symbols.variablePositions?.get(varType)?.get(varName);
      if (position) {
        return {
          uri: importDecl.uri,
          symbol: position,
          type: 'variable'
        };
      }
      // Variable exists in exports but position not found - return a placeholder
      return {
        uri: importDecl.uri,
        symbol: { start: 0, length: varName.length },
        type: 'variable'
      };
    }

    return null; // Variable not found in imported file
  }

  /**
   * Get all references to a symbol in files that import the given file
   * Used for "Find All References" across files
   * @param symbolUri URI of the file containing the symbol definition
   * @param symbolName Name of the symbol
   * @param symbolType Type of the symbol ('pipeline', 'variable', 'query', 'mutation')
   * @param varType For variables, the variable type (e.g., "pg", "handlebars")
   * @param getAllFileMetadata Function to get all file metadata
   * @returns Array of {uri, positions} for each file that references the symbol
   */
  findCrossFileReferences(
    symbolUri: string,
    symbolName: string,
    symbolType: 'pipeline' | 'variable' | 'query' | 'mutation',
    varType: string | undefined,
    getAllFileMetadata: () => Map<string, any>
  ): Array<{ uri: string; positions: PositionInfo[] }> {
    const results: Array<{ uri: string; positions: PositionInfo[] }> = [];
    const allMetadata = getAllFileMetadata();

    // Get metadata for the symbol's file
    const symbolMetadata = allMetadata.get(symbolUri);
    if (!symbolMetadata) {
      return results;
    }

    // Iterate through all files that import the symbol's file
    for (const dependentUri of symbolMetadata.dependents || []) {
      const dependentMetadata = allMetadata.get(dependentUri);
      if (!dependentMetadata) {
        continue;
      }

      // Find the import alias for the symbol's file
      const importDecl = dependentMetadata.imports?.find((imp: any) => imp.uri === symbolUri);
      if (!importDecl) {
        continue;
      }

      // Construct the scoped name (alias::symbol)
      const scopedName = `${importDecl.alias}::${symbolName}`;

      // Find references to the scoped name in the dependent file
      let positions: PositionInfo[] = [];

      if (symbolType === 'pipeline') {
        positions = dependentMetadata.symbols.pipelineRefs?.get(scopedName) || [];
      } else if (symbolType === 'variable' && varType) {
        positions = dependentMetadata.symbols.variableRefs?.get(varType)?.get(scopedName) || [];
      } else if (symbolType === 'query') {
        positions = dependentMetadata.symbols.queryRefs?.get(scopedName) || [];
      } else if (symbolType === 'mutation') {
        positions = dependentMetadata.symbols.mutationRefs?.get(scopedName) || [];
      }

      if (positions.length > 0) {
        results.push({ uri: dependentUri, positions });
      }
    }

    return results;
  }

  /**
   * Extract the alias from a scoped reference
   * @param scopedRef Scoped reference (e.g., "db::query")
   * @returns The alias part or null if not scoped
   */
  getAlias(scopedRef: string): string | null {
    const parts = scopedRef.split('::');
    return parts.length === 2 ? parts[0] : null;
  }

  /**
   * Extract the symbol name from a scoped reference
   * @param scopedRef Scoped reference (e.g., "db::query")
   * @returns The symbol name part or null if not scoped
   */
  getSymbolName(scopedRef: string): string | null {
    const parts = scopedRef.split('::');
    return parts.length === 2 ? parts[1] : null;
  }

  /**
   * Check if a reference is scoped (contains ::)
   * @param ref Reference to check
   * @returns true if scoped
   */
  isScoped(ref: string): boolean {
    return ref.includes('::');
  }
}
