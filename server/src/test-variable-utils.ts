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
 * Find the test context at a given offset in the text
 * Returns the test, describe, and available variables at that location
 */
export function findTestContextAtOffset(
  text: string,
  offset: number,
  describes: Describe[]
): TestContext | null {
  for (const describe of describes) {
    if (!describe.tests) continue;

    // Find the describe block in the text
    const describeRe = new RegExp(`\\bdescribe\\s+"${escapeRegex(describe.name || '')}"`, 'g');
    const describeMatch = describeRe.exec(text);
    if (!describeMatch) continue;

    const describeStart = describeMatch.index;

    for (const test of describe.tests) {
      if (!test.name) continue;

      // Find this specific test in the text after the describe block
      const itRe = new RegExp(`\\bit\\s+"${escapeRegex(test.name)}"`, 'g');
      itRe.lastIndex = describeStart;
      const itMatch = itRe.exec(text);
      if (!itMatch) continue;

      const testStart = itMatch.index;

      // Find the end of this test (next test or end of describe)
      const nextTestRe = /\n\s*it\s+"/g;
      nextTestRe.lastIndex = testStart + 1;
      const nextTestMatch = nextTestRe.exec(text);
      const testEnd = nextTestMatch ? nextTestMatch.index : text.length;

      // Check if our offset is within this test
      if (offset >= testStart && offset <= testEnd) {
        // Collect available variables
        const definedVariables = new Set<string>();

        // Add describe-level variables
        if (describe.variables) {
          for (const [name] of describe.variables) {
            definedVariables.add(name);
          }
        }

        // Add test-level variables (override describe-level)
        if (test.variables) {
          for (const [name] of test.variables) {
            definedVariables.add(name);
          }
        }

        return {
          describe,
          test,
          testStart,
          testEnd,
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
    for (const [name, value, format] of context.test.variables) {
      if (name === varName) {
        return { value, format, source: 'test' };
      }
    }
  }

  // Then check describe-level variables
  if (context.describe.variables) {
    for (const [name, value, format] of context.describe.variables) {
      if (name === varName) {
        return { value, format, source: 'describe' };
      }
    }
  }

  return null;
}

/**
 * Find the text range of a describe block
 */
export function findDescribeBlockRange(
  text: string,
  describe: Describe
): { start: number; end: number } | null {
  const describeRe = new RegExp(`\\bdescribe\\s+"${escapeRegex(describe.name || '')}"`, 'g');
  const describeMatch = describeRe.exec(text);
  if (!describeMatch) return null;

  const describeStart = describeMatch.index;

  // Find the end of this describe block (next describe or end of file)
  const nextDescribeRe = /\n\s*describe\s+"/g;
  nextDescribeRe.lastIndex = describeStart + 1;
  const nextDescribeMatch = nextDescribeRe.exec(text);
  const describeEnd = nextDescribeMatch ? nextDescribeMatch.index : text.length;

  return { start: describeStart, end: describeEnd };
}

/**
 * Find the text range of a test block within a describe
 */
export function findTestBlockRange(
  text: string,
  describeStart: number,
  test: Describe['tests'][0]
): { start: number; end: number } | null {
  if (!test.name) return null;

  const itRe = new RegExp(`\\bit\\s+"${escapeRegex(test.name)}"`, 'g');
  itRe.lastIndex = describeStart;
  const itMatch = itRe.exec(text);
  if (!itMatch) return null;

  const testStart = itMatch.index;

  // Find the end of this test (next test or end of describe)
  const nextTestRe = /\n\s*it\s+"/g;
  nextTestRe.lastIndex = testStart + 1;
  const nextTestMatch = nextTestRe.exec(text);
  const testEnd = nextTestMatch ? nextTestMatch.index : text.length;

  return { start: testStart, end: testEnd };
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
