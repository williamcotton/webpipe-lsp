import { Describe, It, LetVariable } from 'webpipe-js';

/**
 * Represents a test scope context (describe or it block)
 */
export interface TestContext {
  type: 'describe' | 'it';
  name: string;
  variables: LetVariable[];
  start: number;
  end: number;
  parent?: TestContext;
}

/**
 * Find the test context (describe or it block) at the given offset
 * Uses AST traversal instead of regex-based search
 */
export function findTestContextAtOffset(
  describes: Describe[],
  offset: number
): TestContext | null {
  for (const describe of describes) {
    // Check if offset is within this describe block
    if (offset >= describe.start && offset <= describe.end) {
      const describeContext: TestContext = {
        type: 'describe',
        name: describe.name,
        variables: describe.variables,
        start: describe.start,
        end: describe.end
      };

      // Check if offset is within any it block
      for (const it of describe.tests) {
        if (offset >= it.start && offset <= it.end) {
          return {
            type: 'it',
            name: it.name,
            variables: it.variables || [],
            start: it.start,
            end: it.end,
            parent: describeContext
          };
        }
      }

      // Offset is in describe block but not in any it block
      return describeContext;
    }
  }

  return null;
}

/**
 * Resolve a variable name in the given test context
 * Looks up the scope chain (it -> describe)
 */
export function resolveVariable(
  context: TestContext | null,
  variableName: string
): LetVariable | null {
  if (!context) return null;

  // Search in current context
  const variable = context.variables.find(v => v.name === variableName);
  if (variable) return variable;

  // Search in parent context
  if (context.parent) {
    return resolveVariable(context.parent, variableName);
  }

  return null;
}

/**
 * Get all variables accessible in the given test context
 * Includes variables from parent scopes
 */
export function getVisibleVariables(context: TestContext | null): LetVariable[] {
  if (!context) return [];

  const variables = [...context.variables];

  if (context.parent) {
    variables.push(...getVisibleVariables(context.parent));
  }

  return variables;
}

/**
 * Find a variable definition by position
 */
export function findVariableAtPosition(
  describes: Describe[],
  offset: number
): LetVariable | null {
  for (const describe of describes) {
    // Check describe-level variables
    for (const variable of describe.variables) {
      if (offset >= variable.start && offset <= variable.end) {
        return variable;
      }
    }

    // Check it-level variables
    for (const it of describe.tests) {
      if (it.variables) {
        for (const variable of it.variables) {
          if (offset >= variable.start && offset <= variable.end) {
            return variable;
          }
        }
      }
    }
  }

  return null;
}

/**
 * Extract Handlebars variable usages from text
 * Returns positions and names of {{variable}} references
 */
export function extractHandlebarsVariableUsages(
  text: string,
  baseOffset: number = 0
): Array<{ name: string; start: number; end: number }> {
  const usages: Array<{ name: string; start: number; end: number }> = [];
  const regex = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

  let match;
  while ((match = regex.exec(text)) !== null) {
    const name = match[1];
    const start = baseOffset + match.index;
    const end = start + match[0].length;
    usages.push({ name, start, end });
  }

  return usages;
}

/**
 * Find a Handlebars variable usage at the given offset
 */
export function findHandlebarsVariableUsageAtOffset(
  text: string,
  offset: number
): { name: string; start: number; end: number } | null {
  const usages = extractHandlebarsVariableUsages(text, 0);

  for (const usage of usages) {
    if (offset >= usage.start && offset <= usage.end) {
      return usage;
    }
  }

  return null;
}
