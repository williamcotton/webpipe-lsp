export interface RangeAbs {
  start: number;
  end: number;
}

export interface PositionInfo {
  start: number;
  length: number;
}

export interface TestLetVariablePosition {
  name: string;
  describeName: string;
  testName?: string;
  start: number;
  length: number;
}

export interface VariablesByType {
  variablesByType: Map<string, Set<string>>;
  pipelineNames: Set<string>;
}

export interface DeclarationPositions {
  variablePositions: Map<string, PositionInfo>;
  pipelinePositions: Map<string, PositionInfo>;
}

export interface ReferencePositions {
  variableRefs: Map<string, Map<string, Array<PositionInfo>>>; // varType -> varName -> references
  pipelineRefs: Map<string, Array<PositionInfo>>;
}

export interface HandlebarsSymbols {
  declByName: Map<string, { nameStart: number; nameEnd: number }>;
  contentRanges: RangeAbs[];
  usagesByName: Map<string, Array<{ start: number; end: number }>>;
  inlineDefsByContent: Array<{
    range: RangeAbs;
    inlineByName: Map<string, { start: number; end: number }>;
    inlineBlockByName: Map<string, { start: number; end: number }>;
  }>;
}

export interface WordInfo {
  word: string;
  start: number;
  end: number;
}

/**
 * Centralized symbol table derived from AST
 * Contains all symbol information needed by language providers
 */
export interface SymbolTable {
  // Variable and pipeline declarations (from AST)
  variables: Map<string, Set<string>>; // varType -> Set of varNames
  pipelines: Set<string>; // pipeline names

  // Reference positions (AST-based)
  variableRefs: Map<string, Map<string, Array<PositionInfo>>>; // varType -> varName -> references
  pipelineRefs: Map<string, Array<PositionInfo>>; // pipelineName -> references
  testLetVariableRefs: Map<string, Array<PositionInfo>>; // test let varName -> references

  // Declaration positions (from webpipe-js utilities)
  variablePositions: Map<string, Map<string, PositionInfo>>; // varType -> varName -> declaration position
  pipelinePositions: Map<string, PositionInfo>; // pipelineName -> declaration position
  testLetVariablePositions: TestLetVariablePosition[]; // test let variables with scope information

  // GraphQL resolver positions
  queryPositions: Map<string, PositionInfo>; // queryName -> declaration position
  mutationPositions: Map<string, PositionInfo>; // mutationName -> declaration position

  // GraphQL resolver references (for future find-all-references)
  queryRefs: Map<string, Array<PositionInfo>>; // queryName -> references
  mutationRefs: Map<string, Array<PositionInfo>>; // mutationName -> references

  // Handlebars symbols
  handlebars: HandlebarsSymbols;
}

/**
 * Multi-file import support types
 */

/**
 * Exported symbols from a file (for cross-file resolution)
 */
export interface ExportedSymbols {
  variables: Map<string, Set<string>>; // varType → varNames
  pipelines: Set<string>; // pipeline names
  queries: Set<string>; // query resolver names
  mutations: Set<string>; // mutation resolver names
}

/**
 * Resolved import with URI and metadata
 */
export interface ResolvedImport {
  alias: string; // The import alias (e.g., "db" from "import './db.wp' as db")
  uri: string; // Absolute file:// URI
  path: string; // Original import path from AST
  resolved: boolean; // Whether path resolution succeeded
  error?: string; // Resolution error message if failed
  loaded: boolean; // Whether the imported file has been loaded (lazy loading)
}

/**
 * File metadata with multi-file support
 */
export interface FileMetadata {
  version: number; // TextDocument.version or mtime hash for closed files
  text: string; // File content
  program: any; // Parsed AST (Program from webpipe-js)
  diagnostics: any[]; // Parse diagnostics
  symbols: SymbolTable; // Symbol table
  timestamp: number; // Last update timestamp for LRU cache

  // Multi-file extensions
  imports: ResolvedImport[]; // Resolved imports
  exportedSymbols: ExportedSymbols; // Symbols exported by this file
  dependents: Set<string>; // URIs of files that import this file
  isOpen: boolean; // Whether file is open in VS Code
}

/**
 * Symbol resolution result (cross-file)
 */
export interface SymbolResolutionResult {
  uri: string; // URI of file containing the symbol
  symbol: PositionInfo; // Position of the symbol
  type: 'pipeline' | 'variable' | 'query' | 'mutation'; // Symbol type
}

/**
 * Import graph metrics (for debugging/monitoring)
 */
export interface ImportGraphMetrics {
  files: number; // Total files in workspace
  totalImports: number; // Total import statements
  maxDepth: number; // Maximum import chain depth
  circularImports: string[][]; // Circular import chains
}