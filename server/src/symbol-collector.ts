import { VariablesByType, DeclarationPositions, ReferencePositions, RangeAbs, HandlebarsSymbols } from './types';
import { createDocumentModel } from './document-model';

export function collectVariablesAndPipelines(text: string): VariablesByType {
  const documentModel = createDocumentModel(text);
  return {
    variablesByType: documentModel.variablesByType,
    pipelineNames: documentModel.pipelineNames
  };
}

export function collectDeclarationPositions(text: string): DeclarationPositions {
  const documentModel = createDocumentModel(text);
  return {
    variablePositions: documentModel.variablePositions,
    pipelinePositions: documentModel.pipelinePositions
  };
}

export function collectReferencePositions(text: string): ReferencePositions {
  const variableRefs = new Map<string, Array<{ start: number; length: number }>>();
  const pipelineRefs = new Map<string, Array<{ start: number; length: number }>>();

  const pushVar = (key: string, start: number, length: number) => {
    if (!variableRefs.has(key)) variableRefs.set(key, []);
    variableRefs.get(key)!.push({ start, length });
  };
  
  const pushPipe = (name: string, start: number, length: number) => {
    if (!pipelineRefs.has(name)) pipelineRefs.set(name, []);
    pipelineRefs.get(name)!.push({ start, length });
  };

  // |> pipeline: <name>
  const pipeRefRe = /(^|\n)(\s*\|>\s*pipeline\s*:\s*)([A-Za-z_][\w-]*)/g;
  for (let m; (m = pipeRefRe.exec(text)); ) {
    const name = m[3];
    const prefixLen = (m[1] ? m[1].length : 0) + m[2].length;
    const start = m.index + prefixLen;
    pushPipe(name, start, name.length);
  }

  // when executing pipeline <name>
  const whenPipeRe = /(^|\n)(\s*when\s+executing\s+pipeline\s+)([A-Za-z_][\w-]*)/g;
  for (let m; (m = whenPipeRe.exec(text)); ) {
    const name = m[3];
    const prefixLen = (m[1] ? m[1].length : 0) + m[2].length;
    const start = m.index + prefixLen;
    pushPipe(name, start, name.length);
  }

  // with/and mock pipeline <name> returning `...`
  const mockPipeRe = /(^|\n)(\s*(?:with|and)\s+mock\s+pipeline\s+)([A-Za-z_][\w-]*)\s+returning\s+`/g;
  for (let m; (m = mockPipeRe.exec(text)); ) {
    const name = m[3];
    const prefixLen = (m[1] ? m[1].length : 0) + m[2].length;
    const start = m.index + prefixLen;
    pushPipe(name, start, name.length);
  }

  // |> <step>: <var>
  const stepVarRe = /(^|\n)(\s*\|>\s*([A-Za-z_][\w-]*)\s*:\s*)([A-Za-z_][\w-]*)/g;
  for (let m; (m = stepVarRe.exec(text)); ) {
    const stepType = m[3];
    if (stepType === 'pipeline') continue;
    const varName = m[4];
    const key = `${stepType}::${varName}`;
    const prefixLen = (m[1] ? m[1].length : 0) + m[2].length;
    const start = m.index + prefixLen;
    pushVar(key, start, varName.length);
  }

  // when executing variable <type> <name>
  const whenVarRe = /(^|\n)(\s*when\s+executing\s+variable\s+([A-Za-z_][\w-]*)\s+)([A-Za-z_][\w-]*)/g;
  for (let m; (m = whenVarRe.exec(text)); ) {
    const varType = m[3];
    const varName = m[4];
    const key = `${varType}::${varName}`;
    const prefixLen = (m[1] ? m[1].length : 0) + m[2].length;
    const start = m.index + prefixLen;
    pushVar(key, start, varName.length);
  }

  // with/and mock <type>.<name> returning `...`
  const mockVarRe = /(^|\n)(\s*(?:with|and)\s+mock\s+([A-Za-z_][\w-]*)\.)([A-Za-z_][\w-]*)\s+returning\s+`/g;
  for (let m; (m = mockVarRe.exec(text)); ) {
    const varType = m[3];
    const varName = m[4];
    const key = `${varType}::${varName}`;
    const prefixLen = (m[1] ? m[1].length : 0) + m[2].length;
    const start = m.index + prefixLen;
    pushVar(key, start, varName.length);
  }

  return { variableRefs, pipelineRefs };
}

function collectHandlebarsContentRanges(text: string): RangeAbs[] {
  const ranges: RangeAbs[] = [];
  
  // Variable declarations: handlebars <name> = `...`
  const varRe = /(^|\n)\s*handlebars\s+([A-Za-z_][\w-]*)\s*=\s*`([\s\S]*?)`/g;
  for (let m; (m = varRe.exec(text)); ) {
    const whole = m[0];
    const content = m[3];
    const backtickRel = whole.indexOf('`');
    if (backtickRel >= 0) {
      const contentStart = m.index + backtickRel + 1;
      ranges.push({ start: contentStart, end: contentStart + content.length });
    }
  }
  
  // Inline step content: |> handlebars: `...`
  const stepRe = /(^|\n)\s*\|>\s*handlebars\s*:\s*`([\s\S]*?)`/g;
  for (let m; (m = stepRe.exec(text)); ) {
    const whole = m[0];
    const content = m[2];
    const backtickRel = whole.indexOf('`');
    if (backtickRel >= 0) {
      const contentStart = m.index + backtickRel + 1;
      ranges.push({ start: contentStart, end: contentStart + content.length });
    }
  }
  
  return ranges;
}

export function collectHandlebarsSymbols(text: string): HandlebarsSymbols {
  const declByName = new Map<string, { nameStart: number; nameEnd: number }>();
  const { variablePositions } = collectDeclarationPositions(text);
  
  for (const [key, pos] of variablePositions.entries()) {
    if (key.startsWith('handlebars::')) {
      const name = key.slice('handlebars::'.length);
      declByName.set(name, { nameStart: pos.start, nameEnd: pos.start + pos.length });
    }
  }

  const contentRanges = collectHandlebarsContentRanges(text);
  const usagesByName = new Map<string, Array<{ start: number; end: number }>>();
  const inlineDefsByContent: Array<{
    range: RangeAbs;
    inlineByName: Map<string, { start: number; end: number }>;
    inlineBlockByName: Map<string, { start: number; end: number }>;
  }> = [];

  // Patterns for usages and inline definitions
  const includeRe = /\{\{>\s*([A-Za-z_][\w./-]*|@partial-block)/g;
  const blockIncludeRe = /\{\{#>\s*([A-Za-z_][\w./-]*|@partial-block)/g;
  const inlineDefRe = /\{\{#\*inline\s+"([^"]+)"\s*\}\}/g;
  const inlineCloseRe = /\{\{\/inline\s*\}\}/g;

  for (const range of contentRanges) {
    const slice = text.slice(range.start, range.end);
    const inlineByName = new Map<string, { start: number; end: number }>();
    const inlineBlockByName = new Map<string, { start: number; end: number }>();

    // Inline definitions within this content
    for (let m; (m = inlineDefRe.exec(slice)); ) {
      const name = m[1];
      const nameStart = range.start + m.index + m[0].indexOf(name);
      inlineByName.set(name, { start: nameStart, end: nameStart + name.length });
      
      const blockStartAbs = range.start + m.index;
      inlineCloseRe.lastIndex = m.index + m[0].length;
      const close = inlineCloseRe.exec(slice);
      if (close) {
        const blockEndAbs = range.start + close.index + close[0].length;
        inlineBlockByName.set(name, { start: blockStartAbs, end: blockEndAbs });
      }
    }

    // Usages: simple includes
    for (let m; (m = includeRe.exec(slice)); ) {
      const name = m[1];
      if (name === '@partial-block') continue;
      const nameStart = range.start + m.index + m[0].indexOf(name);
      if (!usagesByName.has(name)) usagesByName.set(name, []);
      usagesByName.get(name)!.push({ start: nameStart, end: nameStart + name.length });
    }
    
    // Usages: block includes
    for (let m; (m = blockIncludeRe.exec(slice)); ) {
      const name = m[1];
      if (name === '@partial-block') continue;
      const nameStart = range.start + m.index + m[0].indexOf(name);
      if (!usagesByName.has(name)) usagesByName.set(name, []);
      usagesByName.get(name)!.push({ start: nameStart, end: nameStart + name.length });
    }

    inlineDefsByContent.push({ range, inlineByName, inlineBlockByName });
  }

  return { declByName, contentRanges, usagesByName, inlineDefsByContent };
}