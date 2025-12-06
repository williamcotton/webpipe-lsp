import { ReferencePositions, RangeAbs, HandlebarsSymbols } from './types';
import { extractHandlebarsVariables, extractJqVariablesExcludingGraphQL } from './test-variable-utils';
import { Program } from 'webpipe-js';

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

/**
 * Collects Handlebars partial symbols using AST-based variable declarations
 */
export function collectHandlebarsSymbols(text: string, program: Program): HandlebarsSymbols {
  const declByName = new Map<string, { nameStart: number; nameEnd: number }>();

  // Use AST to find handlebars variable declarations
  for (const variable of program.variables) {
    if (variable.varType === 'handlebars') {
      // Calculate the position of the variable name within the declaration
      // Format: "handlebars <name> = `...`"
      // The name starts after "handlebars "
      const nameStart = variable.start + 'handlebars '.length;
      declByName.set(variable.name, { nameStart, nameEnd: nameStart + variable.name.length });
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

/**
 * Collects all references to test let variables (both {{varName}} and $varName)
 * Returns a map of varName -> array of reference positions
 *
 * Note: Multiple variables with the same name can exist in different scopes.
 * Scope matching is done later using positional checks against describe/test block ranges.
 * GraphQL contexts (graphql: `...`) are excluded when searching for $varName.
 */
export function collectTestLetVariableReferences(
  text: string,
  program: Program
): Map<string, Array<{ start: number; length: number }>> {
  const refs = new Map<string, Array<{ start: number; length: number }>>();

  const addRef = (varName: string, start: number, length: number) => {
    if (!refs.has(varName)) refs.set(varName, []);
    refs.get(varName)!.push({ start, length });
  };

  // Process each describe block
  for (const describe of program.describes) {
    // Use AST's built-in positions
    const describeText = text.substring(describe.start, describe.end);

    // Collect describe-level let variables
    const describeVars = new Set<string>();
    if (describe.variables) {
      for (const variable of describe.variables) {
        describeVars.add(variable.name);
      }
    }

    // Search for describe-level variable references within the entire describe block
    for (const varName of describeVars) {
      // Handlebars {{varName}}
      const handlebarsVars = extractHandlebarsVariables(describeText, describe.start);
      for (const v of handlebarsVars) {
        if (v.name === varName) {
          addRef(varName, v.start, v.end - v.start);
        }
      }

      // JQ $varName (excluding GraphQL contexts)
      const jqVars = extractJqVariablesExcludingGraphQL(describeText, describe.start);
      for (const v of jqVars) {
        if (v.name === varName) {
          addRef(varName, v.start, v.end - v.start);
        }
      }
    }

    // Process each test block for test-level variables
    if (describe.tests) {
      for (const test of describe.tests) {
        // Use AST's built-in positions
        const testText = text.substring(test.start, test.end);

        // Collect test-level let variables (these override describe-level)
        if (test.variables) {
          for (const variable of test.variables) {
            // Search only within this test's scope
            // Handlebars {{varName}}
            const handlebarsVars = extractHandlebarsVariables(testText, test.start);
            for (const v of handlebarsVars) {
              if (v.name === variable.name) {
                addRef(variable.name, v.start, v.end - v.start);
              }
            }

            // JQ $varName (excluding GraphQL contexts)
            const jqVars = extractJqVariablesExcludingGraphQL(testText, test.start);
            for (const v of jqVars) {
              if (v.name === variable.name) {
                addRef(variable.name, v.start, v.end - v.start);
              }
            }
          }
        }
      }
    }
  }

  return refs;
}

/**
 * Filters references to only include those that are in scope for a given test let variable.
 * Uses AST's built-in position data - no regex needed!
 *
 * Scope rules:
 * - Describe-level variables: references anywhere in the describe block (excluding tests that shadow it)
 * - Test-level variables: references only within that specific test block
 */
export function filterReferencesInScope(
  varDecl: { name: string; describeName: string; testName?: string; start: number },
  allReferences: Array<{ start: number; length: number }>,
  program: Program
): Array<{ start: number; length: number }> {
  // Find the describe block this variable belongs to
  const describe = program.describes.find(d => d.name === varDecl.describeName);
  if (!describe) return [];

  // If this is a test-level variable, only include references within that test
  if (varDecl.testName) {
    const test = describe.tests?.find(t => t.name === varDecl.testName);
    if (!test) return [];

    // Filter to references within the test block using AST positions
    return allReferences.filter(ref =>
      ref.start >= test.start && ref.start < test.end
    );
  }

  // This is a describe-level variable
  // Include references anywhere in the describe block, EXCEPT within tests that shadow this variable
  const shadowingTestRanges: Array<{ start: number; end: number }> = [];

  if (describe.tests) {
    for (const test of describe.tests) {
      // Check if this test has a variable with the same name (shadowing)
      if (test.variables?.some(variable => variable.name === varDecl.name)) {
        // Use AST's built-in positions
        shadowingTestRanges.push({ start: test.start, end: test.end });
      }
    }
  }

  // Filter to references within describe block but outside shadowing test blocks
  return allReferences.filter(ref => {
    // Must be within describe block (using AST positions)
    if (ref.start < describe.start || ref.start >= describe.end) {
      return false;
    }

    // Must not be within a shadowing test block
    for (const shadowRange of shadowingTestRanges) {
      if (ref.start >= shadowRange.start && ref.start < shadowRange.end) {
        return false;
      }
    }

    return true;
  });
}

/**
 * AST-based reference collection (replacement for regex-based collectReferencePositions)
 * Uses the parsed AST to find all variable and pipeline references
 */
export function collectReferencesFromAST(program: Program): ReferencePositions {
  const variableRefs = new Map<string, Array<{ start: number; length: number }>>();
  const pipelineRefs = new Map<string, Array<{ start: number; length: number }>>();

  const pushVar = (varType: string, varName: string, start: number, length: number) => {
    const key = `${varType}::${varName}`;
    if (!variableRefs.has(key)) variableRefs.set(key, []);
    variableRefs.get(key)!.push({ start, length });
  };

  const pushPipe = (name: string, start: number, length: number) => {
    if (!pipelineRefs.has(name)) pipelineRefs.set(name, []);
    pipelineRefs.get(name)!.push({ start, length });
  };

  // Helper to walk through all pipelines
  function* walkPipeline(pipeline: any): any {
    if (!pipeline || !pipeline.steps) return;
    for (const step of pipeline.steps) {
      yield step;
      // Recurse into nested pipelines
      if (step.kind === 'If') {
        yield* walkPipeline(step.condition);
        yield* walkPipeline(step.thenBranch);
        if (step.elseBranch) yield* walkPipeline(step.elseBranch);
      } else if (step.kind === 'Dispatch') {
        for (const branch of step.branches) yield* walkPipeline(branch.pipeline);
        if (step.default) yield* walkPipeline(step.default);
      } else if (step.kind === 'Foreach') {
        yield* walkPipeline(step.pipeline);
      } else if (step.kind === 'Result') {
        for (const branch of step.branches) yield* walkPipeline(branch.pipeline);
      }
    }
  }

  // Collect variable references from pipeline steps
  const processPipeline = (pipeline: any) => {
    for (const step of walkPipeline(pipeline)) {
      if (step.kind === 'Regular' && step.configType === 'identifier') {
        const varName = step.config;
        const stepName = step.name;

        // Calculate name offset within the step
        // This is approximate - we know the step starts at step.start
        // For now, use the start of the step as the reference position
        // TODO: The parser should ideally provide separate position for the config value
        pushVar(stepName, varName, step.start, varName.length);
      }
    }
  };

  // Process routes
  for (const route of program.routes) {
    if (route.pipeline.kind === 'Named') {
      // Named pipeline reference
      pushPipe(route.pipeline.name, route.pipeline.start, route.pipeline.name.length);
    } else if (route.pipeline.kind === 'Inline') {
      // Inline pipeline
      processPipeline(route.pipeline.pipeline);
    }
  }

  // Process named pipelines
  for (const namedPipeline of program.pipelines) {
    processPipeline(namedPipeline.pipeline);
  }

  // Process GraphQL resolvers
  for (const query of program.queries) {
    processPipeline(query.pipeline);
  }
  for (const mutation of program.mutations) {
    processPipeline(mutation.pipeline);
  }

  // Process feature flags
  if (program.featureFlags) {
    processPipeline(program.featureFlags);
  }

  // Process test describe blocks
  for (const describe of program.describes) {
    for (const test of describe.tests) {
      // Check when clauses
      const when = test.when;
      if (when.kind === 'ExecutingPipeline') {
        pushPipe(when.name, when.start, when.name.length);
      } else if (when.kind === 'ExecutingVariable') {
        pushVar(when.varType, when.name, when.start, when.name.length);
      }

      // Check mocks (both describe-level and test-level)
      const allMocks = [...describe.mocks, ...test.mocks];
      for (const mock of allMocks) {
        // Parse mock target
        if (mock.target.includes('.')) {
          const [type, name] = mock.target.split('.');
          if (type === 'query' || type === 'mutation') {
            // GraphQL mock - not a variable reference
            continue;
          } else {
            // Variable mock: type.name
            pushVar(type, name, mock.start, name.length);
          }
        } else {
          // Could be a pipeline reference
          if (mock.target.startsWith('pipeline ')) {
            const pipelineName = mock.target.substring('pipeline '.length);
            pushPipe(pipelineName, mock.start, pipelineName.length);
          }
        }
      }
    }
  }

  return { variableRefs, pipelineRefs };
}