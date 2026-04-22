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
import { KNOWN_MIDDLEWARE, KNOWN_STEPS } from './constants';

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
      // Prefer the deeper child when parent and child share the same span.
      if (range <= smallestRange) {
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
  visit(program.resolvers);
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
  visit(program.resolvers, []);
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

  // Walk GraphQL query/mutation resolvers
  for (const query of program.queries) {
    yield* walkPipeline(query.pipeline);
  }
  for (const mutation of program.mutations) {
    yield* walkPipeline(mutation.pipeline);
  }

  // Walk GraphQL field resolvers (e.g., resolver Team.employees)
  for (const resolver of program.resolvers) {
    yield* walkPipeline(resolver.pipeline);
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
    const variableRef = getVariableReferenceFromStep(step);
    if (variableRef) {
      yield {
        step,
        varName: variableRef.varName,
        offset: variableRef.offset,
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

  // Pipeline steps that reference other pipelines (|> pipeline: Name or |> loader(...): Name)
  for (const step of walkPipelineSteps(program)) {
    const pipelineRef = getPipelineReferenceFromStep(step);
    if (pipelineRef) {
      yield {
        name: pipelineRef.name,
        offset: pipelineRef.offset,
      };
    }
  }

  // Test when clauses that execute pipelines
  for (const describe of program.describes) {
    for (const test of describe.tests) {
      if (test.when.kind === 'ExecutingPipeline') {
        yield {
          name: test.when.name,
          offset: test.when.nameStart,
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

export function regularStepHasConfig(step: PipelineStep): boolean {
  if (step.kind !== 'Regular') return false;
  const stepAny = step as any;
  if (typeof stepAny.hasConfig === 'boolean') {
    return stepAny.hasConfig;
  }
  return step.configStart !== undefined || step.configEnd !== undefined || step.config !== '';
}

export function isImplicitPipelineCallStep(step: PipelineStep): boolean {
  return step.kind === 'Regular' &&
    !regularStepHasConfig(step) &&
    !KNOWN_STEPS.has(step.name) &&
    !KNOWN_MIDDLEWARE.has(step.name);
}

export function getPipelineReferenceFromStep(
  step: PipelineStep
): { name: string; offset: number; length: number; shorthand: boolean } | null {
  if (step.kind !== 'Regular') return null;

  if ((step.name === 'pipeline' || step.name === 'loader') && step.configType === 'identifier') {
    return {
      name: step.config,
      offset: step.configStart ?? step.start,
      length: step.config.length,
      shorthand: false,
    };
  }

  if (isImplicitPipelineCallStep(step)) {
    return {
      name: step.name,
      offset: step.nameStart ?? step.start,
      length: step.name.length,
      shorthand: true,
    };
  }

  return null;
}

export function getVariableReferenceFromStep(
  step: PipelineStep
): { varType: string; varName: string; offset: number; length: number } | null {
  if (step.kind !== 'Regular' || step.configType !== 'identifier') return null;
  if (getPipelineReferenceFromStep(step)) return null;

  return {
    varType: step.name,
    varName: step.config,
    offset: step.configStart ?? step.start,
    length: step.config.length,
  };
}
