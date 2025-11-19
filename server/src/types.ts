export interface RangeAbs {
  start: number;
  end: number;
}

export interface PositionInfo {
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
  variableRefs: Map<string, Array<PositionInfo>>;
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

  // Reference positions (from regex analysis, to be migrated to AST)
  variableRefs: Map<string, Array<PositionInfo>>; // "varType::varName" -> references
  pipelineRefs: Map<string, Array<PositionInfo>>; // pipelineName -> references

  // Declaration positions (from webpipe-js utilities)
  variablePositions: Map<string, PositionInfo>; // "varType::varName" -> declaration position
  pipelinePositions: Map<string, PositionInfo>; // pipelineName -> declaration position

  // Handlebars symbols
  handlebars: HandlebarsSymbols;
}