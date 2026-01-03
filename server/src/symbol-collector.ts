import { ReferencePositions, RangeAbs, HandlebarsSymbols } from './types';
import { extractHandlebarsVariables, extractJqVariablesExcludingGraphQL } from './test-variable-utils';
import { Program } from 'webpipe-js';
import { walkPipelineSteps } from './ast-utils';

/**
 * Collects Handlebars content ranges using AST traversal
 * Finds handlebars name = `...` variables and |> handlebars: `...` steps
 */
function collectHandlebarsContentRangesAST(program: Program, text: string): RangeAbs[] {
  const ranges: RangeAbs[] = [];

  // 1. Variable declarations: handlebars <name> = `...`
  for (const variable of program.variables) {
    if (variable.varType === 'handlebars' || variable.varType === 'mustache') {
      // Find the backtick content
      // The AST gives us the full range. We need to find the backticks inside.
      const slice = text.slice(variable.start, variable.end);
      const backtickStart = slice.indexOf('`');
      const backtickEnd = slice.lastIndexOf('`');

      if (backtickStart !== -1 && backtickEnd !== -1 && backtickEnd > backtickStart) {
        ranges.push({
          start: variable.start + backtickStart + 1,
          end: variable.start + backtickEnd
        });
      }
    }
  }

  // 2. Inline step content: |> handlebars: `...`
  for (const step of walkPipelineSteps(program)) {
    if (step.kind === 'Regular' &&
        (step.name === 'handlebars' || step.name === 'mustache') &&
        step.configType === 'backtick') {

      // step.config contains the content *inside* the backticks (usually)
      // or we can find it in the source.
      // Assuming step.start/end covers the whole step.
      // We can use step.configStart if available, or search for backticks.

      const slice = text.slice(step.start, step.end);
      const backtickStart = slice.indexOf('`');
      const backtickEnd = slice.lastIndexOf('`');

      if (backtickStart !== -1 && backtickEnd !== -1 && backtickEnd > backtickStart) {
        ranges.push({
          start: step.start + backtickStart + 1,
          end: step.start + backtickEnd
        });
      }
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
    if (variable.varType === 'handlebars' || variable.varType === 'mustache') {
      // Calculate the position of the variable name within the declaration
      const searchStart = variable.start + variable.varType.length; // skip "handlebars" or "mustache"
      const nameIndex = text.indexOf(variable.name, searchStart);

      if (nameIndex !== -1) {
        declByName.set(variable.name, { nameStart: nameIndex, nameEnd: nameIndex + variable.name.length });
      }
    }
  }

  const contentRanges = collectHandlebarsContentRangesAST(program, text);
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
  const variableRefs = new Map<string, Map<string, Array<{ start: number; length: number }>>>();
  const pipelineRefs = new Map<string, Array<{ start: number; length: number }>>();

  const pushVar = (varType: string, varName: string, start: number, length: number) => {
    if (!variableRefs.has(varType)) {
      variableRefs.set(varType, new Map());
    }
    const byName = variableRefs.get(varType)!;
    if (!byName.has(varName)) {
      byName.set(varName, []);
    }
    byName.get(varName)!.push({ start, length });
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

  // Collect variable and pipeline references from pipeline steps
  const processPipeline = (pipeline: any) => {
    for (const step of walkPipeline(pipeline)) {
      if (step.kind === 'Regular' && step.configType === 'identifier') {
        const varName = step.config;
        const stepName = step.name;

        // Use the exact position from the AST if available, otherwise fall back to step.start
        const configPos = step.configStart ?? step.start;

        // Pipeline references: |> pipeline: Name or |> loader(...): Name
        // The step.name is just the identifier (e.g., "loader"), args are separate
        if (stepName === 'pipeline' || stepName === 'loader') {
          pushPipe(varName, configPos, varName.length);
        } else {
          // Variable references for other middleware
          pushVar(stepName, varName, configPos, varName.length);
        }
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

  // Process GraphQL query/mutation resolvers
  for (const query of program.queries) {
    processPipeline(query.pipeline);
  }
  for (const mutation of program.mutations) {
    processPipeline(mutation.pipeline);
  }

  // Process GraphQL field resolvers (e.g., resolver Team.employees)
  for (const resolver of program.resolvers) {
    processPipeline(resolver.pipeline);
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
        pushPipe(when.name, when.nameStart, when.name.length);
      } else if (when.kind === 'ExecutingVariable') {
        pushVar(when.varType, when.name, when.nameStart, when.name.length);
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
            // mock.targetStart points to the beginning of the target (e.g., "pg" in "pg.teamsQuery")
            // We need to find the position after the dot
            const dotIndex = mock.target.indexOf('.');
            if (dotIndex !== -1) {
              const nameStart = mock.targetStart + dotIndex + 1;
              pushVar(type, name, nameStart, name.length);
            }
          }
        } else {
          // Could be a pipeline reference
          if (mock.target.startsWith('pipeline ')) {
            const pipelineName = mock.target.substring('pipeline '.length);
            // mock.targetStart points to "pipeline", we need to skip past "pipeline "
            const nameStart = mock.targetStart + 'pipeline '.length;
            pushPipe(pipelineName, nameStart, pipelineName.length);
          }
        }
      }
    }
  }

  return { variableRefs, pipelineRefs };
}

/**
 * Collects all GraphQL query/mutation references from AST
 *
 * References can appear in:
 * 1. graphql middleware steps: |> graphql: `query { users { id } }`
 * 2. Test mocks: with mock query users returning `...`
 * 3. Test call assertions: and call query users with `...`
 */
export function collectGraphQLReferencesFromAST(
  program: Program,
  text: string
): {
  queryRefs: Map<string, Array<{ start: number; length: number }>>;
  mutationRefs: Map<string, Array<{ start: number; length: number }>>;
} {
  const queryRefs = new Map<string, Array<{ start: number; length: number }>>();
  const mutationRefs = new Map<string, Array<{ start: number; length: number }>>();

  const pushQuery = (name: string, start: number, length: number) => {
    if (!queryRefs.has(name)) queryRefs.set(name, []);
    queryRefs.get(name)!.push({ start, length });
  };

  const pushMutation = (name: string, start: number, length: number) => {
    if (!mutationRefs.has(name)) mutationRefs.set(name, []);
    mutationRefs.get(name)!.push({ start, length });
  };

  // Helper to extract operation names from GraphQL query strings
  const extractOperations = (
    queryString: string,
    baseOffset: number
  ): Array<{ name: string; type: 'query' | 'mutation'; start: number; length: number }> => {
    const operations: Array<any> = [];

    // Determine if it's a query or mutation and find where the keyword ends
    const typeMatch = /^\s*(query|mutation)/.exec(queryString);
    if (!typeMatch) return operations;

    const type = typeMatch[1] as 'query' | 'mutation';
    const keywordEnd = typeMatch[0].length;

    // Find the opening brace of the selection set
    // This could be: "query {" or "query($var: Type) {"
    const selectionSetStart = queryString.indexOf('{', keywordEnd);
    if (selectionSetStart === -1) return operations;

    // Extract field names from the selection set (top-level only)
    // Match: fieldName or fieldName(args)
    const selectionSetContent = queryString.substring(selectionSetStart);
    const fieldRe = /\{\s*([A-Za-z_][\w-]*)\s*[({]/g;
    let match;

    while ((match = fieldRe.exec(selectionSetContent)) !== null) {
      const name = match[1];
      const nameStart = baseOffset + selectionSetStart + match.index + match[0].indexOf(name);

      operations.push({
        name,
        type,
        start: nameStart,
        length: name.length
      });
    }

    return operations;
  };

  // Helper to walk through all pipelines (reused from collectReferencesFromAST)
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

  // 1. Collect from graphql middleware steps
  const processPipeline = (pipeline: any) => {
    for (const step of walkPipeline(pipeline)) {
      if (step.kind === 'Regular' &&
          step.name === 'graphql' &&
          step.configType === 'backtick') {

        // Find where the config string actually starts in the document
        // The step.start is the start of the entire step (including |>)
        const configStart = text.indexOf(step.config, step.start);

        if (configStart !== -1) {
          const operations = extractOperations(step.config, configStart);

          for (const op of operations) {
            if (op.type === 'query') {
              pushQuery(op.name, op.start, op.length);
            } else {
              pushMutation(op.name, op.start, op.length);
            }
          }
        }
      }
    }
  };

  // Process all pipelines
  for (const route of program.routes) {
    if (route.pipeline.kind === 'Inline') {
      processPipeline(route.pipeline.pipeline);
    }
  }
  for (const namedPipeline of program.pipelines) {
    processPipeline(namedPipeline.pipeline);
  }
  for (const query of program.queries) {
    processPipeline(query.pipeline);
  }
  for (const mutation of program.mutations) {
    processPipeline(mutation.pipeline);
  }
  for (const resolver of program.resolvers) {
    processPipeline(resolver.pipeline);
  }
  if (program.featureFlags) {
    processPipeline(program.featureFlags);
  }

  // 2. Collect from test mocks
  for (const describe of program.describes) {
    const allMocks = [...describe.mocks];
    if (describe.tests) {
      for (const test of describe.tests) {
        allMocks.push(...test.mocks);
      }
    }

    for (const mock of allMocks) {
      // Parse mock target: "query todos" or "mutation createUser"
      const match = /^(query|mutation)\s+([A-Za-z_][\w-]*)/.exec(mock.target);
      if (match) {
        const type = match[1] as 'query' | 'mutation';
        const name = match[2];
        const nameOffset = mock.start + match[1].length + 1; // +1 for space

        if (type === 'query') {
          pushQuery(name, nameOffset, name.length);
        } else {
          pushMutation(name, nameOffset, name.length);
        }
      }
    }
  }

  // 3. Collect from test call assertions
  for (const describe of program.describes) {
    if (!describe.tests) continue;

    for (const test of describe.tests) {
      for (const condition of test.conditions) {
        if (condition.isCallAssertion && condition.callTarget) {
          // Parse target: "query todos" or "mutation createUser"
          const match = /^(query|mutation)\s+([A-Za-z_][\w-]*)/.exec(condition.callTarget);
          if (match) {
            const type = match[1] as 'query' | 'mutation';
            const name = match[2];
            const nameOffset = condition.start + match[1].length + 1;

            if (type === 'query') {
              pushQuery(name, nameOffset, name.length);
            } else {
              pushMutation(name, nameOffset, name.length);
            }
          }
        }
      }
    }
  }

  return { queryRefs, mutationRefs };
}