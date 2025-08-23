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

export interface DocumentModel {
  // Raw program data from webpipe-js
  program: any;
  diagnostics: any[];
  
  // Indexed data for efficient lookup
  variablesByType: Map<string, Set<string>>;
  pipelineNames: Set<string>;
  variablePositions: Map<string, PositionInfo>; // key format: "type::name"
  pipelinePositions: Map<string, PositionInfo>; // key format: name
  
  // References (may still need some regex for complex cases)
  variableRefs: Map<string, Array<PositionInfo>>;
  pipelineRefs: Map<string, Array<PositionInfo>>;
  
  // Routes and other structures
  routes: Array<{ method: string; path: string; lineNumber: number }>;
}