import { parseProgramWithDiagnostics, getVariableRanges, getPipelineRanges } from 'webpipe-js';
import { DocumentModel, PositionInfo } from './types';

export function createDocumentModel(text: string): DocumentModel {
  // Single call to parse the program
  const { program, diagnostics } = parseProgramWithDiagnostics(text);
  
  // Get position ranges from webpipe-js
  const variableRanges = getVariableRanges(text);
  const pipelineRanges = getPipelineRanges(text);
  
  // Build indexed data structures
  const variablesByType = new Map<string, Set<string>>();
  const variablePositions = new Map<string, PositionInfo>();
  
  // Convert variable ranges to our format
  for (const [key, range] of variableRanges.entries()) {
    const [varType, varName] = key.split('::');
    if (!variablesByType.has(varType)) {
      variablesByType.set(varType, new Set());
    }
    variablesByType.get(varType)!.add(varName);
    
    // For position, we need to find the name position within the range
    // The range covers the entire declaration, but we want just the name position
    const namePos = findVariableNamePosition(text, range, varName);
    variablePositions.set(key, namePos);
  }
  
  // Build pipeline data
  const pipelineNames = new Set<string>();
  const pipelinePositions = new Map<string, PositionInfo>();
  
  for (const [name, range] of pipelineRanges.entries()) {
    pipelineNames.add(name);
    // Find the name position within the pipeline declaration
    const namePos = findPipelineNamePosition(text, range, name);
    pipelinePositions.set(name, namePos);
  }
  
  // Extract routes from program data
  const routes = (program.routes || []).map((route: any) => ({
    method: route.method,
    path: route.path,
    lineNumber: route.lineNumber || 0
  }));
  
  // TODO: Collect references - may still need some targeted regex for this
  // For now, start with empty maps
  const variableRefs = new Map<string, Array<PositionInfo>>();
  const pipelineRefs = new Map<string, Array<PositionInfo>>();
  
  return {
    program,
    diagnostics,
    variablesByType,
    pipelineNames,
    variablePositions,
    pipelinePositions,
    variableRefs,
    pipelineRefs,
    routes
  };
}

function findVariableNamePosition(text: string, range: { start: number; end: number }, varName: string): PositionInfo {
  // Look for the variable name within the declaration range
  const declarationText = text.slice(range.start, range.end);
  const nameIndex = declarationText.lastIndexOf(varName);
  if (nameIndex >= 0) {
    return {
      start: range.start + nameIndex,
      length: varName.length
    };
  }
  // Fallback to the start of the range
  return {
    start: range.start,
    length: varName.length
  };
}

function findPipelineNamePosition(text: string, range: { start: number; end: number }, pipelineName: string): PositionInfo {
  // Look for the pipeline name within the declaration range
  const declarationText = text.slice(range.start, range.end);
  const nameIndex = declarationText.indexOf(pipelineName);
  if (nameIndex >= 0) {
    return {
      start: range.start + nameIndex,
      length: pipelineName.length
    };
  }
  // Fallback to the start of the range
  return {
    start: range.start,
    length: pipelineName.length
  };
}