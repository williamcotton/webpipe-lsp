/**
 * AST Traversal Utilities
 *
 * Provides utilities for traversing and querying the WebPipe AST based on source positions.
 */

import type {
  Program,
  Config,
  ConfigProperty,
  NamedPipeline,
  Variable,
  Route,
  PipelineRef,
  Pipeline,
  PipelineStep,
  GraphQLSchema,
  QueryResolver,
  MutationResolver,
  Describe,
  It,
  Mock,
  When,
  Condition,
  LetVariable,
  DispatchBranch,
  ResultBranch,
  Tag,
} from 'webpipe-js';

/**
 * Union type representing any AST node that has source location information
 */
export type ASTNode =
  | Config
  | ConfigProperty
  | NamedPipeline
  | Variable
  | Route
  | PipelineRef
  | Pipeline
  | PipelineStep
  | GraphQLSchema
  | QueryResolver
  | MutationResolver
  | Describe
  | It
  | Mock
  | When
  | Condition
  | LetVariable
  | DispatchBranch
  | ResultBranch
  | Tag;

/**
 * Type guard to check if a value is an AST node with source location
 */
function hasSourceLocation(node: any): node is { start: number; end: number } {
  return (
    node !== null &&
    typeof node === 'object' &&
    typeof node.start === 'number' &&
    typeof node.end === 'number'
  );
}

/**
 * Check if an offset is within a node's range (inclusive)
 */
function containsOffset(node: { start: number; end: number }, offset: number): boolean {
  return offset >= node.start && offset <= node.end;
}

/**
 * Find the most specific AST node at a given offset
 * Returns null if no node is found at the offset
 */
export function findNodeAtOffset(program: Program, offset: number): ASTNode | null {
  let mostSpecific: ASTNode | null = null;
  let smallestRange = Infinity;

  const visit = (node: any): void => {
    if (!node || typeof node !== 'object') return;

    // Check if this node has source location and contains the offset
    if (hasSourceLocation(node) && containsOffset(node, offset)) {
      const range = node.end - node.start;
      if (range < smallestRange) {
        smallestRange = range;
        mostSpecific = node as ASTNode;
      }
    }

    // Recursively visit children
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item);
      }
    } else if (typeof node === 'object') {
      for (const key in node) {
        if (key !== 'start' && key !== 'end' && key !== 'lineNumber') {
          visit(node[key]);
        }
      }
    }
  };

  // Visit all top-level nodes
  visit(program.configs);
  visit(program.pipelines);
  visit(program.variables);
  visit(program.routes);
  visit(program.describes);
  visit(program.graphqlSchema);
  visit(program.queries);
  visit(program.mutations);
  visit(program.featureFlags);

  return mostSpecific;
}

/**
 * Find the hierarchy of nodes from root to the most specific node at an offset
 * Returns empty array if no node is found
 *
 * Example result: [Route, Pipeline, PipelineStep]
 */
export function findStackAtOffset(program: Program, offset: number): ASTNode[] {
  const stack: ASTNode[] = [];

  const visit = (node: any, currentStack: ASTNode[]): boolean => {
    if (!node || typeof node !== 'object') return false;

    // Check if this node has source location and contains the offset
    if (hasSourceLocation(node) && containsOffset(node, offset)) {
      const newStack = [...currentStack, node as ASTNode];

      // Check children to see if any contain the offset
      let foundInChild = false;

      if (Array.isArray(node)) {
        for (const item of node) {
          if (visit(item, newStack)) {
            foundInChild = true;
            break;
          }
        }
      } else if (typeof node === 'object') {
        for (const key in node) {
          if (key !== 'start' && key !== 'end' && key !== 'lineNumber') {
            if (visit((node as any)[key], newStack)) {
              foundInChild = true;
              break;
            }
          }
        }
      }

      // If no child contains it, this is the most specific node
      if (!foundInChild && newStack.length > stack.length) {
        stack.length = 0;
        stack.push(...newStack);
      }

      return true;
    }

    // Check array items even if parent doesn't contain offset
    if (Array.isArray(node)) {
      for (const item of node) {
        if (visit(item, currentStack)) {
          return true;
        }
      }
    }

    return false;
  };

  // Visit all top-level nodes
  visit(program.configs, []);
  visit(program.pipelines, []);
  visit(program.variables, []);
  visit(program.routes, []);
  visit(program.describes, []);
  if (program.graphqlSchema) visit(program.graphqlSchema, []);
  visit(program.queries, []);
  visit(program.mutations, []);
  if (program.featureFlags) visit(program.featureFlags, []);

  return stack;
}

/**
 * Find all pipeline steps in the program
 */
export function* walkPipelineSteps(program: Program): Generator<PipelineStep> {
  function* walkPipeline(pipeline: Pipeline): Generator<PipelineStep> {
    for (const step of pipeline.steps) {
      yield step;

      // Recurse into nested pipelines
      if (step.kind === 'If') {
        yield* walkPipeline(step.condition);
        yield* walkPipeline(step.thenBranch);
        if (step.elseBranch) {
          yield* walkPipeline(step.elseBranch);
        }
      } else if (step.kind === 'Dispatch') {
        for (const branch of step.branches) {
          yield* walkPipeline(branch.pipeline);
        }
        if (step.default) {
          yield* walkPipeline(step.default);
        }
      } else if (step.kind === 'Foreach') {
        yield* walkPipeline(step.pipeline);
      } else if (step.kind === 'Result') {
        for (const branch of step.branches) {
          yield* walkPipeline(branch.pipeline);
        }
      }
    }
  }

  // Walk routes
  for (const route of program.routes) {
    if (route.pipeline.kind === 'Inline') {
      yield* walkPipeline(route.pipeline.pipeline);
    }
  }

  // Walk named pipelines
  for (const namedPipeline of program.pipelines) {
    yield* walkPipeline(namedPipeline.pipeline);
  }

  // Walk GraphQL resolvers
  for (const query of program.queries) {
    yield* walkPipeline(query.pipeline);
  }
  for (const mutation of program.mutations) {
    yield* walkPipeline(mutation.pipeline);
  }

  // Walk feature flags
  if (program.featureFlags) {
    yield* walkPipeline(program.featureFlags);
  }

  // Walk test describe blocks
  for (const describe of program.describes) {
    for (const test of describe.tests) {
      // Tests can execute pipelines/variables, but don't contain inline pipelines
      // No pipeline steps to walk here
    }
  }
}

/**
 * Find all variable references in pipeline steps
 */
export function* walkVariableReferences(program: Program): Generator<{ step: PipelineStep; varName: string; offset: number }> {
  for (const step of walkPipelineSteps(program)) {
    if (step.kind === 'Regular' && step.configType === 'identifier') {
      yield {
        step,
        varName: step.config,
        offset: step.start,
      };
    }
  }
}

/**
 * Find all pipeline references in the program
 */
export function* walkPipelineReferences(program: Program): Generator<{ name: string; offset: number }> {
  // Routes with named pipeline references
  for (const route of program.routes) {
    if (route.pipeline.kind === 'Named') {
      yield {
        name: route.pipeline.name,
        offset: route.pipeline.start,
      };
    }
  }

  // Pipeline steps that reference other pipelines
  for (const step of walkPipelineSteps(program)) {
    if (step.kind === 'Regular' && step.name === 'pipeline' && step.configType === 'identifier') {
      yield {
        name: step.config,
        offset: step.start,
      };
    }
  }

  // Test when clauses that execute pipelines
  for (const describe of program.describes) {
    for (const test of describe.tests) {
      if (test.when.kind === 'ExecutingPipeline') {
        yield {
          name: test.when.name,
          offset: test.when.start,
        };
      }
    }
  }

  // Mock pipeline references
  for (const describe of program.describes) {
    for (const test of describe.tests) {
      for (const mock of [...describe.mocks, ...test.mocks]) {
        if (mock.target.startsWith('pipeline ')) {
          const name = mock.target.substring('pipeline '.length);
          yield {
            name,
            offset: mock.start,
          };
        }
      }
    }
  }
}
