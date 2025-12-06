import { Describe } from 'webpipe-js';

/**
 * Shared utilities for working with test let variables
 */

export interface TestContext {
  describe: Describe;
  test: Describe['tests'][0];
  testStart: number;
  testEnd: number;
  definedVariables: Set<string>;
}

/**
 * Helper to escape regex special characters
 */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Helper to extract Handlebars variable references from a string
 */
export function extractHandlebarsVariables(
  str: string,
  baseOffset: number
): Array<{ name: string; start: number; end: number }> {
  const regex = /\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g;
  const variables: Array<{ name: string; start: number; end: number }> = [];
  let match;

  while ((match = regex.exec(str)) !== null) {
    variables.push({
      name: match[1],
      start: baseOffset + match.index,
      end: baseOffset + match.index + match[0].length
    });
  }

  return variables;
}

/**
 * Helper to extract JQ variable references from a string
 * Matches $variableName in JQ expressions
 */
export function extractJqVariables(
  str: string,
  baseOffset: number
): Array<{ name: string; start: number; end: number }> {
  const regex = /\$([a-zA-Z_][a-zA-Z0-9_]*)/g;
  const variables: Array<{ name: string; start: number; end: number }> = [];
  let match;

  while ((match = regex.exec(str)) !== null) {
    variables.push({
      name: match[1],
      start: baseOffset + match.index,
      end: baseOffset + match.index + match[0].length
    });
  }

  return variables;
}

/**
 * Finds which describe block contains the given offset.
 * Returns the describe AST node and its text range.
 *
 * Uses the AST's built-in start/end positions - no regex needed!
 */
export function findDescribeAtOffset(
  text: string,
  offset: number,
  describes: Describe[]
): { describe: Describe; start: number; end: number } | null {
  // Find the describe that contains this offset
  // If multiple match (nested describes), take the smallest (most specific)
  let bestMatch: { describe: Describe; start: number; end: number } | null = null;
  let smallestSize = Infinity;

  for (const describe of describes) {
    if (offset >= describe.start && offset < describe.end) {
      const size = describe.end - describe.start;
      if (size < smallestSize) {
        bestMatch = { describe, start: describe.start, end: describe.end };
        smallestSize = size;
      }
    }
  }

  return bestMatch;
}

/**
 * Find the test context at a given offset in the text
 * Returns the test, describe, and available variables at that location
 *
 * Uses the AST's built-in start/end positions - no regex needed!
 */
export function findTestContextAtOffset(
  text: string,
  offset: number,
  describes: Describe[]
): TestContext | null {
  for (const describe of describes) {
    if (!describe.tests) continue;

    // Check if offset is within this describe block
    if (offset < describe.start || offset >= describe.end) continue;

    for (const test of describe.tests) {
      // Check if our offset is within this test using AST positions
      if (offset >= test.start && offset < test.end) {
        // Collect available variables
        const definedVariables = new Set<string>();

        // Add describe-level variables
        if (describe.variables) {
          for (const variable of describe.variables) {
            definedVariables.add(variable.name);
          }
        }

        // Add test-level variables (override describe-level)
        if (test.variables) {
          for (const variable of test.variables) {
            definedVariables.add(variable.name);
          }
        }

        return {
          describe,
          test,
          testStart: test.start,
          testEnd: test.end,
          definedVariables
        };
      }
    }
  }

  return null;
}

/**
 * Get the value of a let variable from a test context
 * Returns the value, format, and whether it's from the test or describe level
 */
export function getLetVariableValue(
  varName: string,
  context: TestContext
): { value: string; format: 'quoted' | 'backtick' | 'bare'; source: 'test' | 'describe' } | null {
  // Check test-level variables first (they override describe-level)
  if (context.test.variables) {
    for (const variable of context.test.variables) {
      if (variable.name === varName) {
        return { value: variable.value, format: variable.format, source: 'test' };
      }
    }
  }

  // Then check describe-level variables
  if (context.describe.variables) {
    for (const variable of context.describe.variables) {
      if (variable.name === varName) {
        return { value: variable.value, format: variable.format, source: 'describe' };
      }
    }
  }

  return null;
}

/**
 * @deprecated Use describe.start and describe.end from the AST directly
 *
 * Find the text range of a describe block.
 * This function is kept for backward compatibility but is no longer needed
 * since the AST now includes position information.
 */
export function findDescribeBlockRange(
  text: string,
  describe: Describe
): { start: number; end: number } | null {
  // Just return the AST's built-in positions
  return { start: describe.start, end: describe.end };
}

/**
 * @deprecated Use test.start and test.end from the AST directly
 *
 * Find the text range of a test block within a describe.
 * This function is kept for backward compatibility but is no longer needed
 * since the AST now includes position information.
 */
export function findTestBlockRange(
  text: string,
  describeStart: number,
  test: Describe['tests'][0]
): { start: number; end: number } | null {
  // Just return the AST's built-in positions
  return { start: test.start, end: test.end };
}

/**
 * Extract JQ variables from text, excluding GraphQL contexts
 * GraphQL contexts are identified by `graphql:` backtick blocks
 */
export function extractJqVariablesExcludingGraphQL(
  str: string,
  baseOffset: number
): Array<{ name: string; start: number; end: number }> {
  // First, find all graphql: backtick blocks to exclude (positions relative to str)
  const graphqlRanges: Array<{ start: number; end: number }> = [];
  const graphqlRe = /\|>\s*graphql\s*:\s*`([\s\S]*?)`/g;
  let match;

  while ((match = graphqlRe.exec(str)) !== null) {
    // The range of the backtick content (excluding the backticks themselves)
    const contentStart = match.index + match[0].indexOf('`') + 1;
    const contentEnd = contentStart + match[1].length;
    graphqlRanges.push({ start: contentStart, end: contentEnd });
  }

  // Extract all JQ variables (positions relative to str, starting at 0)
  const jqVars = extractJqVariables(str, 0);
  const filtered: Array<{ name: string; start: number; end: number }> = [];

  for (const v of jqVars) {
    const varStart = v.start;  // Already relative to str
    const varEnd = v.end;

    // Check if this variable is within any GraphQL range
    const inGraphQL = graphqlRanges.some(
      range => varStart >= range.start && varEnd <= range.end
    );

    if (!inGraphQL) {
      // Add baseOffset to convert to absolute positions
      filtered.push({
        name: v.name,
        start: v.start + baseOffset,
        end: v.end + baseOffset
      });
    }
  }

  return filtered;
}
