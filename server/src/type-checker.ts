import { DiagnosticSeverity } from 'vscode-languageserver/node';
import type {
  NamedPipeline,
  Pipeline,
  PipelineRef,
  PipelineStep,
  Program,
  Route,
  TagExpr,
  Variable
} from 'webpipe-js';
import * as jqtypeModule from 'jqtype';
import * as handlebarsParser from '@handlebars/parser';
import type { AST as HandlebarsAst } from '@handlebars/parser';

export interface TypeDiagnosticPush {
  (severity: DiagnosticSeverity, start: number, end: number, message: string): void;
}

export type TypeCheckMode = 'loose' | 'strict';

export interface TypeCheckOptions {
  mode?: TypeCheckMode;
}

interface ResolvedTypeCheckOptions {
  mode: TypeCheckMode;
}

type StageShape =
  | { kind: 'unknown' }
  | { kind: 'null' }
  | { kind: 'boolean'; literal?: boolean }
  | { kind: 'number'; literal?: number }
  | { kind: 'string'; literal?: string; contentType?: string }
  | { kind: 'array'; item: StageShape }
  | { kind: 'object'; fields: Record<string, ShapeField>; additional: boolean }
  | { kind: 'union'; members: StageShape[] };

const RUNTIME_KEYS = [
  'async',
  'data',
  'originalRequest',
  'query',
  'params',
  'body',
  'headers',
  'cookies',
  'method',
  'path',
  'ip',
  'content_type'
];

interface ShapeField {
  shape: StageShape;
  optional?: boolean;
}

interface TypeContext {
  program: Program;
  pipelines: Map<string, NamedPipeline>;
  variables: Map<string, Variable>;
  asyncTasks: Map<string, PipelineTypeState>;
  resolving: Set<string>;
  options: ResolvedTypeCheckOptions;
  push: TypeDiagnosticPush;
  markPipelineMaterialized?: () => void;
}

type UnknownProducer = 'pg' | 'fetch' | 'graphql' | 'lua' | 'js' | 'route-body' | 'pipeline' | 'custom';

interface UnknownDebt {
  id: string;
  producer: UnknownProducer;
  reason: string;
  path: PathSegment[];
  start: number;
  end: number;
  clearWith: 'assert' | 'validate-or-assert' | 'typed-middleware-contract';
  latent?: boolean;
}

interface PipelineTypeState {
  shape: StageShape;
  debts: UnknownDebt[];
}

interface JqFilterSource {
  source: string;
  diagnosticStart: number;
  diagnosticEnd: number;
  preciseSpans: boolean;
}

interface HandlebarsTemplateSource {
  source: string;
  diagnosticStart: number;
  diagnosticEnd: number;
  preciseSpans: boolean;
  label?: string;
}

interface HandlebarsCheckState {
  partialStack: Set<string>;
  emitted: Set<string>;
}

interface HandlebarsScope {
  current: StageShape;
  root: StageShape;
  blockParams: Map<string, StageShape>;
}

interface HandlebarsTemplateAnalysis {
  source: HandlebarsTemplateSource;
  lineStarts: number[];
}

interface JqPathDiagnostic {
  path: PathSegment[];
  missingField?: string;
  start: number;
  end: number;
}

interface PathSegment {
  kind: 'field' | 'index';
  name?: string;
}

const unknownShape: StageShape = { kind: 'unknown' };
const stringShape: StageShape = { kind: 'string' };
const numberShape: StageShape = { kind: 'number' };
const booleanShape: StageShape = { kind: 'boolean' };
const nullShape: StageShape = { kind: 'null' };
let debtCounter = 0;

function stateOf(shape: StageShape, debts: UnknownDebt[] = []): PipelineTypeState {
  return { shape, debts };
}

function withShape(state: PipelineTypeState, shape: StageShape): PipelineTypeState {
  return { shape, debts: state.debts };
}

function resolveTypeCheckOptions(program: Program, options: TypeCheckOptions): ResolvedTypeCheckOptions {
  if (options.mode) {
    return { mode: options.mode };
  }
  return { mode: readBooleanConfig(program, 'typecheck', 'strict') ? 'strict' : 'loose' };
}

function readBooleanConfig(program: Program, name: string, key: string): boolean | undefined {
  const config = (program.configs || []).slice().reverse().find(item => item.name === name);
  const property = config?.properties.find(item => item.key === key);
  const value = property?.value;
  return value?.kind === 'Boolean' ? value.value : undefined;
}

export function checkProgramTypes(program: Program, push: TypeDiagnosticPush, options: TypeCheckOptions = {}): void {
  const resolvedOptions = resolveTypeCheckOptions(program, options);
  const ctx: TypeContext = {
    program,
    pipelines: new Map((program.pipelines || []).map(pipeline => [pipeline.name, pipeline])),
    variables: new Map((program.variables || []).map(variable => [`${variable.varType}:${variable.name}`, variable])),
    asyncTasks: new Map(),
    resolving: new Set(),
    options: resolvedOptions,
    push
  };

  for (const route of program.routes || []) {
    const output = checkPipelineRef(route.pipeline, routeInputState(route), ctx);
    pushExitDebtDiagnostics(output, ctx, 'route');
  }

  for (const query of program.queries || []) {
    const output = checkPipeline(query.pipeline, stateOf(graphqlResolverInputShape()), { ...ctx, asyncTasks: new Map(), resolving: new Set(ctx.resolving) });
    pushExitDebtDiagnostics(output, ctx, 'GraphQL query resolver');
  }
  for (const mutation of program.mutations || []) {
    const output = checkPipeline(mutation.pipeline, stateOf(graphqlResolverInputShape()), { ...ctx, asyncTasks: new Map(), resolving: new Set(ctx.resolving) });
    pushExitDebtDiagnostics(output, ctx, 'GraphQL mutation resolver');
  }
  for (const resolver of program.resolvers || []) {
    const output = checkPipeline(resolver.pipeline, stateOf(graphqlResolverInputShape()), { ...ctx, asyncTasks: new Map(), resolving: new Set(ctx.resolving) });
    pushExitDebtDiagnostics(output, ctx, 'GraphQL field resolver');
  }
}

function checkPipelineRef(ref: PipelineRef, input: PipelineTypeState, ctx: TypeContext): PipelineTypeState {
  if (ref.kind === 'Inline') {
    return checkPipeline(ref.pipeline, input, ctx);
  }

  return checkNamedPipeline(ref.name, input, ctx, ref.start, ref.end);
}

function checkNamedPipeline(name: string, input: PipelineTypeState, ctx: TypeContext, start: number, end: number): PipelineTypeState {
  const pipeline = findPipeline(ctx, name);
  if (!pipeline) {
    ctx.push(DiagnosticSeverity.Error, start, end, `Unknown pipeline '${name}'`);
    return stateOf(unknownShape);
  }
  if (ctx.resolving.has(name)) {
    return stateOf(unknownShape);
  }

  let routeDiagnosticsToCallSite = true;
  const childCtx: TypeContext = {
    ...ctx,
    asyncTasks: new Map(ctx.asyncTasks),
    resolving: new Set([...ctx.resolving, name]),
    push: (severity, diagnosticStart, diagnosticEnd, message) => {
      if (routeDiagnosticsToCallSite) {
        ctx.push(severity, start, end, `Pipeline '${name}' called here has type error: ${message}`);
        return;
      }
      ctx.push(severity, diagnosticStart, diagnosticEnd, message);
    },
    markPipelineMaterialized: () => {
      routeDiagnosticsToCallSite = false;
    }
  };
  return checkPipeline(pipeline.pipeline, input, childCtx);
}

function checkPipeline(pipeline: Pipeline, input: PipelineTypeState, ctx: TypeContext): PipelineTypeState {
  let current = input;
  const steps = pipeline.steps || [];

  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    const isLastStep = index === steps.length - 1;

    if (step.kind === 'Regular') {
      const asyncName = getTagArg(step.condition, 'async');
      if (asyncName) {
        const branchCtx = {
          ...ctx,
          asyncTasks: new Map(ctx.asyncTasks)
        };
        const output = checkRegularStep(step, current, branchCtx, false, true);
        ctx.asyncTasks.set(asyncName, output);
      } else {
        current = checkRegularStep(step, current, ctx, true, isLastStep);
        if (stepMaterializesLocalShape(step, ctx)) {
          markPipelineMaterialized(ctx);
        }
      }
      continue;
    }

    if (step.kind === 'Result') {
      current = checkResultStep(step, current, ctx);
      markPipelineMaterialized(ctx);
      continue;
    }

    if (step.kind === 'If') {
      checkPipeline(step.condition, current, { ...ctx, asyncTasks: new Map(ctx.asyncTasks) });
      const thenShape = checkPipeline(step.thenBranch, current, { ...ctx, asyncTasks: new Map(ctx.asyncTasks) });
      const elseShape = step.elseBranch
        ? checkPipeline(step.elseBranch, current, { ...ctx, asyncTasks: new Map(ctx.asyncTasks) })
        : current;
      current = {
        shape: unionShape([thenShape.shape, elseShape.shape]),
        debts: dedupeDebts([...thenShape.debts, ...elseShape.debts])
      };
      markPipelineMaterialized(ctx);
      continue;
    }

    if (step.kind === 'Dispatch') {
      const branches = step.branches.map(branch =>
        checkPipeline(branch.pipeline, current, { ...ctx, asyncTasks: new Map(ctx.asyncTasks) })
      );
      if (step.default) {
        branches.push(checkPipeline(step.default, current, { ...ctx, asyncTasks: new Map(ctx.asyncTasks) }));
      }
      current = branches.length > 0
        ? {
            shape: unionShape(branches.map(branch => branch.shape)),
            debts: dedupeDebts(branches.flatMap(branch => branch.debts))
          }
        : current;
      markPipelineMaterialized(ctx);
      continue;
    }

    if (step.kind === 'Foreach') {
      checkPipeline(step.pipeline, stateOf(unknownShape), { ...ctx, asyncTasks: new Map(ctx.asyncTasks) });
      current = current.shape.kind === 'unknown' ? stateOf(unknownShape, current.debts) : current;
      markPipelineMaterialized(ctx);
    }
  }

  return current;
}

function markPipelineMaterialized(ctx: TypeContext): void {
  ctx.markPipelineMaterialized?.();
}

function stepMaterializesLocalShape(step: Extract<PipelineStep, { kind: 'Regular' }>, ctx: TypeContext): boolean {
  switch (step.name) {
    case 'jq':
    case 'assert':
    case 'validate':
    case 'pg':
    case 'fetch':
    case 'graphql':
    case 'auth':
    case 'handlebars':
    case 'lua':
    case 'js':
    case 'join':
    case 'loader':
      return true;
    case 'pipeline':
      return step.hasConfig;
    default:
      return !step.hasConfig && !!findPipeline(ctx, step.name);
  }
}

function checkRegularStep(step: Extract<PipelineStep, { kind: 'Regular' }>, input: PipelineTypeState, ctx: TypeContext, allowAsync: boolean, isLastStep: boolean): PipelineTypeState {
  if (allowAsync && getTagArg(step.condition, 'async')) {
    return input;
  }

  checkStepArgAccesses(step, input, ctx);

  switch (step.name) {
    case 'jq':
      return checkJqStep(step, input, ctx, isLastStep);
    case 'assert':
      return checkAssertStep(step, input, ctx);
    case 'validate':
      return checkValidateStep(step, input, ctx);
    case 'pg':
      return applyDataMiddlewareState(input, pgResultShape(step.config), step, ctx);
    case 'fetch':
      return applyDataMiddlewareState(input, fetchResultShape(), step, ctx);
    case 'graphql':
      return applyDataMiddlewareState(input, graphqlResultShape(), step, ctx);
    case 'auth':
      return withShape(input, applyAuthShape(input.shape, step));
    case 'handlebars':
      return checkHandlebarsStep(step, input, ctx);
    case 'lua':
      return transformUnknownState(input, step, 'lua');
    case 'js':
      return transformUnknownState(input, step, 'js');
    case 'join':
      return applyJoinShape(input, step, ctx);
    case 'loader':
      return checkLoaderStep(step, ctx);
    case 'pipeline':
      if (!step.hasConfig) {
        return input;
      }
      return mergePipelineCallResult(
        input,
        checkNamedPipeline(step.config.trim(), applyPipelineArgs(step, input, ctx), ctx, step.configStart ?? step.nameStart, step.configEnd ?? step.nameEnd)
      );
    default:
      if (!step.hasConfig && findPipeline(ctx, step.name)) {
        return mergePipelineCallResult(
          input,
          checkNamedPipeline(step.name, applyPipelineArgs(step, input, ctx), ctx, step.nameStart, step.nameEnd)
        );
      }
      return input;
  }
}

// Pipeline calls aren't a registered middleware, so at runtime the executor
// falls back to `StateBehavior::Merge` (see executor/step.rs apply_result_to_state).
// That means the inner pipeline's output is *shallow-merged* on top of the
// caller's state at the call site, not used as a full replacement. Mirror that
// here so the caller's fields (route runtime keys, inline-arg fields, etc.)
// survive across pipeline-call boundaries.
function mergePipelineCallResult(caller: PipelineTypeState, inner: PipelineTypeState): PipelineTypeState {
  return {
    shape: mergeObjectShapes(caller.shape, inner.shape),
    debts: inner.debts
  };
}

function checkLoaderStep(step: Extract<PipelineStep, { kind: 'Regular' }>, ctx: TypeContext): PipelineTypeState {
  if (!step.hasConfig) {
    return stateOf(unknownShape);
  }

  checkNamedPipeline(
    step.config.trim(),
    stateOf(graphqlLoaderInputShape()),
    ctx,
    step.configStart ?? step.nameStart,
    step.configEnd ?? step.nameEnd
  );

  return stateOf(unknownShape);
}

function checkJqStep(step: Extract<PipelineStep, { kind: 'Regular' }>, input: PipelineTypeState, ctx: TypeContext, isLastStep: boolean): PipelineTypeState {
  const filter = resolveJqFilterSource(step, ctx);
  if (!filter) {
    return applyTransformState(input, unknownShape, isLastStep);
  }

  const pathDiagnostics: JqPathDiagnostic[] = [];
  const rootAccesses = scanRootFieldAccesses(filter.source);
  const strictRootAccesses = scanRootFieldAccesses(filter.source, 1);
  for (const access of rootAccesses) {
    const problem = validatePath(input.shape, access.path);
    if (problem) {
      const missingField = missingFieldFromProblem(problem);
      pathDiagnostics.push({
        path: access.path,
        missingField,
        start: filter.preciseSpans ? filter.diagnosticStart + access.start : filter.diagnosticStart,
        end: filter.preciseSpans ? filter.diagnosticStart + access.end : filter.diagnosticEnd
      });
    }
  }
  pushStrictDebtAccessDiagnostics(strictRootAccesses, input, ctx, filter);

  try {
    const jqtype = jqtypeModule as any;
    const checker = new jqtype.JqTypeChecker();
    const inputShape = jqtype.InputShape.fromJsonSchema(toJsonSchema(input.shape));
    const options = createAnalyzeOptions(jqtype);
    const report = checker.analyzeFilter(filter.source, inputShape, options);

    const jqtypeMissingProperties = pushJqtypeDiagnostics(report, filter, ctx);
    pushPipelinePathDiagnostics(pathDiagnostics, jqtypeMissingProperties, input.shape, ctx);

    const outputSchemaValue = jqtype.AnalyzeReport?.toJsonSchemaValue
      ? jqtype.AnalyzeReport.toJsonSchemaValue(report)
      : undefined;

    if (outputSchemaValue) {
      return applyTransformState(input, fromJsonSchema(outputSchemaValue.schema ?? outputSchemaValue), isLastStep);
    }

    return applyTransformState(input, report?.output ? fromJqtypeOutput(report.output, jqtype) : unknownShape, isLastStep);
  } catch (err) {
    ctx.push(
      DiagnosticSeverity.Warning,
      filter.diagnosticStart,
      filter.diagnosticEnd,
      `Could not type-check jq filter with jqtype: ${err instanceof Error ? err.message : String(err)}`
    );
    return applyTransformState(input, unknownShape, isLastStep);
  }
}

function resolveJqFilterSource(step: Extract<PipelineStep, { kind: 'Regular' }>, ctx: TypeContext): JqFilterSource | undefined {
  const configStart = step.configStart ?? step.nameStart;
  const configEnd = step.configEnd ?? step.nameEnd;

  if (step.configType !== 'identifier') {
    const quoted = step.configType === 'backtick' || step.configType === 'quoted';
    return {
      source: step.config,
      diagnosticStart: quoted ? configStart + 1 : configStart,
      diagnosticEnd: quoted ? Math.max(configStart + 1, configEnd - 1) : configEnd,
      preciseSpans: true
    };
  }

  const variable = findVariable(ctx, 'jq', step.config);
  if (!variable) {
    return undefined;
  }

  return {
    source: variable.value,
    diagnosticStart: configStart,
    diagnosticEnd: configEnd,
    preciseSpans: false
  };
}

function pushJqtypeDiagnostics(report: any, filter: JqFilterSource, ctx: TypeContext): Set<string> {
  const missingProperties = new Set<string>();
  const diagnostics = Array.isArray(report?.diagnostics)
    ? report.diagnostics
    : Array.isArray(report?.errors)
      ? report.errors
      : [];
  const seenDiagnostics = new Set<string>();

  for (const diagnostic of diagnostics) {
    const span = diagnostic.span || diagnostic.range || diagnostic.location;
    const start = filter.preciseSpans && typeof span?.start === 'number'
      ? filter.diagnosticStart + span.start
      : filter.diagnosticStart;
    const end = filter.preciseSpans && typeof span?.end === 'number'
      ? filter.diagnosticStart + span.end
      : filter.diagnosticEnd;
    const severity = String(diagnostic.severity || '').toLowerCase() === 'error'
      ? DiagnosticSeverity.Error
      : DiagnosticSeverity.Warning;
    const message = diagnostic.message || diagnostic.reason || String(diagnostic);
    const missingProperty = missingPropertyFromJqtypeMessage(message);
    if (missingProperty) {
      // Suppress when the specific access reported by jqtype is the right-hand
      // operand of `//`. jqtype is unaware that `.a // .b` falls back when
      // `.a` is null/absent, so a missing `.b` is a deliberate fallback rather
      // than a bug. The LSP already filters such accesses from its own
      // path diagnostics via isNullAlternativeOperand; mirror that here.
      // NOTE: As of jqtype 0.6.0, span positions can be wrong for properties
      // that appear more than once in the filter source (it returns the first
      // textual occurrence). This suppression only fires when jqtype reports
      // an accurate span. See jqtype-rhs-span-spec.md.
      const spanStart = typeof span?.start === 'number' ? span.start : undefined;
      if (spanStart !== undefined && isFallbackAccessAt(filter.source, missingProperty, spanStart)) {
        continue;
      }
      missingProperties.add(missingProperty);
    }
    const dedupeKey = `${severity}:${start}:${end}:${message}`;
    if (seenDiagnostics.has(dedupeKey)) {
      continue;
    }
    seenDiagnostics.add(dedupeKey);
    ctx.push(severity, start, end, `jq type check: ${message}`);
  }
  return missingProperties;
}

function isFallbackAccessAt(filter: string, propertyName: string, spanStart: number): boolean {
  // Find the `.<propertyName>` access at or near spanStart.
  // jqtype span positions may point at the property name (after the dot) or
  // at the dot itself; tolerate both by scanning a small window.
  const searchStart = Math.max(0, spanStart - 1);
  const searchEnd = Math.min(filter.length, spanStart + propertyName.length + 1);
  const slice = filter.slice(searchStart, searchEnd);
  const idx = slice.indexOf(`.${propertyName}`);
  if (idx === -1) return false;
  const dotIndex = searchStart + idx;
  // Ensure this is a fresh access (not part of `.foo.<propertyName>`).
  if (dotIndex > 0 && /[\w.]/.test(filter[dotIndex - 1])) return false;
  let k = dotIndex - 1;
  while (k >= 0 && (filter[k] === ' ' || filter[k] === '\t' || filter[k] === '\n')) k--;
  return k >= 1 && filter[k] === '/' && filter[k - 1] === '/';
}

function pushPipelinePathDiagnostics(pathDiagnostics: JqPathDiagnostic[], jqtypeMissingProperties: Set<string>, input: StageShape, ctx: TypeContext, stageLabel = 'this jq stage'): void {
  for (const diagnostic of pathDiagnostics) {
    if (diagnostic.missingField && jqtypeMissingProperties.has(diagnostic.missingField)) {
      continue;
    }
    ctx.push(
      DiagnosticSeverity.Error,
      diagnostic.start,
      diagnostic.end,
      `Type error: ${pathToJq(diagnostic.path)} may be missing before ${stageLabel}. Previous stage output: ${renderShape(input)}.${hintForMissingPath(diagnostic.path)}`
    );
  }
}

function missingFieldFromProblem(problem: string): string | undefined {
  return /^missing field (.+)$/.exec(problem)?.[1];
}

function missingPropertyFromJqtypeMessage(message: string): string | undefined {
  return /^property "([^"]+)" is not present on /.exec(message)?.[1];
}

function fromJqtypeOutput(output: any, jqtype: any): StageShape {
  if (output?.item && jqtype.typeToJsonSchema) {
    return fromJsonSchema(jqtype.typeToJsonSchema(output.item));
  }
  if (typeof output?.toCompactString === 'function') {
    return unknownShape;
  }
  return unknownShape;
}

function createAnalyzeOptions(jqtype: any): any {
  const options = jqtype.AnalyzeOptions.default();
  if (jqtype.jsonSchemaToType) {
    options.externalVars = {
      ...(options.externalVars || {}),
      context: jqtype.jsonSchemaToType(toJsonSchema(unknownShape))
    };
  }
  return options;
}

function inferJqOutputShape(source: string, input: StageShape): StageShape {
  try {
    const jqtype = jqtypeModule as any;
    const checker = new jqtype.JqTypeChecker();
    const inputShape = jqtype.InputShape.fromJsonSchema(toJsonSchema(input));
    const report = checker.analyzeFilter(source, inputShape, createAnalyzeOptions(jqtype));
    const outputSchemaValue = jqtype.AnalyzeReport?.toJsonSchemaValue
      ? jqtype.AnalyzeReport.toJsonSchemaValue(report)
      : undefined;

    if (outputSchemaValue) {
      return fromJsonSchema(outputSchemaValue.schema ?? outputSchemaValue);
    }

    return report?.output ? fromJqtypeOutput(report.output, jqtype) : unknownShape;
  } catch {
    return unknownShape;
  }
}

function checkAssertStep(step: Extract<PipelineStep, { kind: 'Regular' }>, input: PipelineTypeState, ctx: TypeContext): PipelineTypeState {
  const contract = resolveAssertContract(step, ctx);
  if (!contract) {
    return input;
  }

  const parsed = parseShapeSchema(contract.source);
  if (!parsed.ok) {
    ctx.push(DiagnosticSeverity.Error, contract.start, contract.end, `Invalid assert contract: ${parsed.error}`);
    return input;
  }

  const issue = findRequiredFieldMismatch(input.shape, parsed.shape);
  if (issue) {
    const useStart = step.configStart ?? step.nameStart;
    const useEnd = step.configEnd ?? step.nameEnd;
    const contractLabel = step.configType === 'identifier' ? ` '${step.config.trim()}'` : '';
    ctx.push(
      DiagnosticSeverity.Warning,
      useStart,
      useEnd,
      `Assert contract${contractLabel} expects ${issue}, but previous stage output is ${renderShape(input.shape)}.`
    );
  }

  return {
    shape: mergeObjectShapes(input.shape, parsed.shape),
    debts: clearDebtsWithAssert(input.debts, parsed.shape)
  };
}

function checkValidateStep(step: Extract<PipelineStep, { kind: 'Regular' }>, input: PipelineTypeState, ctx: TypeContext): PipelineTypeState {
  const parsed = parseShapeSchema(step.config, true);
  if (!parsed.ok) {
    ctx.push(
      DiagnosticSeverity.Warning,
      step.configStart ?? step.nameStart,
      step.configEnd ?? step.nameEnd,
      `Could not infer validate schema: ${parsed.error}`
    );
    return input;
  }

  const object = asObjectShape(input.shape);
  object.fields.body = { shape: parsed.shape };
  return {
    shape: object,
    debts: clearRouteBodyDebts(input.debts, parsed.shape)
  };
}

function checkHandlebarsStep(step: Extract<PipelineStep, { kind: 'Regular' }>, input: PipelineTypeState, ctx: TypeContext): PipelineTypeState {
  pushStepDebtDiagnostics(input, step, ctx, 'handlebars renders');

  const template = resolveHandlebarsTemplateSource(step, ctx);
  if (template) {
    checkHandlebarsTemplate(
      template,
      handlebarsRenderInputShape(input.shape),
      ctx,
      { partialStack: new Set(), emitted: new Set() }
    );
  }

  return stateOf({ kind: 'string', contentType: 'text/html' });
}

function resolveHandlebarsTemplateSource(step: Extract<PipelineStep, { kind: 'Regular' }>, ctx: TypeContext): HandlebarsTemplateSource | undefined {
  const configStart = step.configStart ?? step.nameStart;
  const configEnd = step.configEnd ?? step.nameEnd;

  if (step.configType !== 'identifier') {
    const quoted = step.configType === 'backtick' || step.configType === 'quoted';
    return {
      source: step.config,
      diagnosticStart: quoted ? configStart + 1 : configStart,
      diagnosticEnd: quoted ? Math.max(configStart + 1, configEnd - 1) : configEnd,
      preciseSpans: true
    };
  }

  const variable = findHandlebarsVariable(ctx, step.config);
  if (!variable) {
    return undefined;
  }

  return {
    source: variable.value,
    diagnosticStart: configStart,
    diagnosticEnd: configEnd,
    preciseSpans: false,
    label: `Handlebars template '${step.config.trim()}' used here`
  };
}

function checkHandlebarsTemplate(source: HandlebarsTemplateSource, input: StageShape, ctx: TypeContext, state: HandlebarsCheckState): void {
  let program: HandlebarsAst.Program;
  try {
    program = handlebarsParser.parse(source.source);
  } catch {
    return;
  }

  const analysis = {
    source,
    lineStarts: lineStartsFor(source.source)
  };
  checkHandlebarsProgram(
    program,
    analysis,
    {
      current: input,
      root: input,
      blockParams: new Map()
    },
    ctx,
    state
  );
}

function checkHandlebarsProgram(program: HandlebarsAst.Program, analysis: HandlebarsTemplateAnalysis, scope: HandlebarsScope, ctx: TypeContext, state: HandlebarsCheckState): void {
  for (const statement of program.body || []) {
    checkHandlebarsStatement(statement, analysis, scope, ctx, state);
  }
}

function checkHandlebarsStatement(statement: HandlebarsAst.Statement, analysis: HandlebarsTemplateAnalysis, scope: HandlebarsScope, ctx: TypeContext, state: HandlebarsCheckState): void {
  switch (statement.type) {
    case 'ContentStatement':
    case 'CommentStatement':
      return;
    case 'MustacheStatement':
    case 'Decorator':
      checkHandlebarsMustache(statement as HandlebarsAst.MustacheStatement, analysis, scope, ctx, state);
      return;
    case 'BlockStatement':
    case 'DecoratorBlock':
      checkHandlebarsBlockStatement(statement as HandlebarsAst.BlockStatement, analysis, scope, ctx, state);
      return;
    case 'PartialStatement':
      checkHandlebarsPartialStatement(statement as HandlebarsAst.PartialStatement, analysis, scope, ctx, state);
      return;
    case 'PartialBlockStatement': {
      const partial = statement as HandlebarsAst.PartialBlockStatement;
      checkHandlebarsPartialStatement(partial, analysis, scope, ctx, state);
      checkHandlebarsProgram(partial.program, analysis, scope, ctx, state);
      return;
    }
  }
}

function checkHandlebarsMustache(node: HandlebarsAst.MustacheStatement, analysis: HandlebarsTemplateAnalysis, scope: HandlebarsScope, ctx: TypeContext, state: HandlebarsCheckState): void {
  const hasHelperArgs = (node.params?.length || 0) > 0 || (node.hash?.pairs?.length || 0) > 0;
  if (!hasHelperArgs && isHandlebarsPathExpression(node.path)) {
    checkHandlebarsPathExpression(node.path, analysis, scope, ctx, state);
    return;
  }

  if (isHandlebarsSubExpression(node.path)) {
    checkHandlebarsSubExpression(node.path, analysis, scope, ctx, state);
  }
  checkHandlebarsExpressions(node.params || [], node.hash, analysis, scope, ctx, state);
}

function checkHandlebarsBlockStatement(node: HandlebarsAst.BlockStatement, analysis: HandlebarsTemplateAnalysis, scope: HandlebarsScope, ctx: TypeContext, state: HandlebarsCheckState): void {
  const blockName = handlebarsPathName(node.path);

  if (statementIsDecoratorBlock(node) && blockName === 'inline') {
    checkHandlebarsExpressions(node.params || [], node.hash, analysis, scope, ctx, state);
    checkHandlebarsProgram(node.program, analysis, scope, ctx, state);
    return;
  }

  if (blockName === 'each') {
    const itemShape = checkHandlebarsBlockContext(node, analysis, scope, ctx, state, eachItemShape);
    const childScope = withHandlebarsBlockParams({ ...scope, current: itemShape }, node.program, itemShape, numberShape);
    checkHandlebarsProgram(node.program, analysis, childScope, ctx, state);
    if (node.inverse) {
      checkHandlebarsProgram(node.inverse, analysis, scope, ctx, state);
    }
    return;
  }

  if (blockName === 'with') {
    const childShape = checkHandlebarsBlockContext(node, analysis, scope, ctx, state, shape => shape ?? unknownShape);
    const childScope = withHandlebarsBlockParams({ ...scope, current: childShape }, node.program, childShape);
    checkHandlebarsProgram(node.program, analysis, childScope, ctx, state);
    if (node.inverse) {
      checkHandlebarsProgram(node.inverse, analysis, scope, ctx, state);
    }
    return;
  }

  if (blockName === 'if' || blockName === 'unless') {
    checkHandlebarsExpressions(node.params || [], node.hash, analysis, scope, ctx, state);
    checkHandlebarsProgram(node.program, analysis, scope, ctx, state);
    if (node.inverse) {
      checkHandlebarsProgram(node.inverse, analysis, scope, ctx, state);
    }
    return;
  }

  const hasHelperArgs = (node.params?.length || 0) > 0 || (node.hash?.pairs?.length || 0) > 0;
  if (hasHelperArgs) {
    checkHandlebarsExpressions(node.params || [], node.hash, analysis, scope, ctx, state);
    checkHandlebarsProgram(node.program, analysis, scope, ctx, state);
  } else {
    checkHandlebarsPathExpression(node.path, analysis, scope, ctx, state);
    const childShape = shapeAtHandlebarsPath(node.path, scope) ?? unknownShape;
    checkHandlebarsProgram(node.program, analysis, { ...scope, current: childShape }, ctx, state);
  }
  if (node.inverse) {
    checkHandlebarsProgram(node.inverse, analysis, scope, ctx, state);
  }
}

function checkHandlebarsBlockContext(
  node: HandlebarsAst.BlockStatement,
  analysis: HandlebarsTemplateAnalysis,
  scope: HandlebarsScope,
  ctx: TypeContext,
  state: HandlebarsCheckState,
  mapShape: (shape: StageShape | undefined) => StageShape
): StageShape {
  const param = node.params?.[0];
  if (!param) {
    return unknownShape;
  }
  checkHandlebarsExpression(param, analysis, scope, ctx, state);
  return mapShape(expressionShape(param, scope));
}

function checkHandlebarsPartialStatement(node: HandlebarsAst.PartialStatement | HandlebarsAst.PartialBlockStatement, analysis: HandlebarsTemplateAnalysis, scope: HandlebarsScope, ctx: TypeContext, state: HandlebarsCheckState): void {
  const partialName = handlebarsPartialName(node.name);
  if (!partialName || partialName === '@partial-block') {
    checkHandlebarsExpressions(node.params || [], node.hash, analysis, scope, ctx, state);
    return;
  }

  let partialInput = scope.current;
  const contextParam = node.params?.[0];
  if (contextParam) {
    checkHandlebarsExpression(contextParam, analysis, scope, ctx, state);
    partialInput = expressionShape(contextParam, scope) ?? unknownShape;
  }

  checkHandlebarsExpressions((node.params || []).slice(1), node.hash, analysis, scope, ctx, state);
  partialInput = mergeHandlebarsHashIntoShape(partialInput, node.hash, scope);

  if (state.partialStack.has(partialName)) {
    return;
  }
  const partial = findHandlebarsVariable(ctx, partialName);
  if (!partial) {
    return;
  }

  const nameRange = handlebarsNodeRange(analysis, node.name);
  state.partialStack.add(partialName);
  checkHandlebarsTemplate(
    {
      source: partial.value,
      diagnosticStart: nameRange.start,
      diagnosticEnd: nameRange.end,
      preciseSpans: false,
      label: `Handlebars partial '${partialName}' used here`
    },
    partialInput,
    ctx,
    state
  );
  state.partialStack.delete(partialName);
}

function checkHandlebarsExpressions(expressions: HandlebarsAst.Expression[], hash: HandlebarsAst.Hash | undefined, analysis: HandlebarsTemplateAnalysis, scope: HandlebarsScope, ctx: TypeContext, state: HandlebarsCheckState): void {
  for (const expression of expressions) {
    checkHandlebarsExpression(expression, analysis, scope, ctx, state);
  }
  for (const pair of hash?.pairs || []) {
    checkHandlebarsExpression(pair.value, analysis, scope, ctx, state);
  }
}

function checkHandlebarsExpression(expression: HandlebarsAst.Expression, analysis: HandlebarsTemplateAnalysis, scope: HandlebarsScope, ctx: TypeContext, state: HandlebarsCheckState): void {
  if (isHandlebarsPathExpression(expression)) {
    checkHandlebarsPathExpression(expression, analysis, scope, ctx, state);
  } else if (isHandlebarsSubExpression(expression)) {
    checkHandlebarsSubExpression(expression, analysis, scope, ctx, state);
  }
}

function checkHandlebarsSubExpression(expression: HandlebarsAst.SubExpression, analysis: HandlebarsTemplateAnalysis, scope: HandlebarsScope, ctx: TypeContext, state: HandlebarsCheckState): void {
  if (isHandlebarsSubExpression(expression.path)) {
    checkHandlebarsSubExpression(expression.path, analysis, scope, ctx, state);
  }
  checkHandlebarsExpressions(expression.params || [], expression.hash, analysis, scope, ctx, state);
}

function checkHandlebarsPathExpression(path: HandlebarsAst.PathExpression, analysis: HandlebarsTemplateAnalysis, scope: HandlebarsScope, ctx: TypeContext, state: HandlebarsCheckState): void {
  const resolved = resolveHandlebarsPath(path, scope);
  if (!resolved || resolved.path.length === 0) return;
  pushHandlebarsPathDiagnostic(analysis, path, resolved.path, resolved.base, scope.root, ctx, state, path.original || pathToHandlebars(resolved.path));
}

function withHandlebarsBlockParams(scope: HandlebarsScope, program: HandlebarsAst.Program, firstShape: StageShape, secondShape?: StageShape): HandlebarsScope {
  const blockParams = [...scope.blockParams];
  const names = program.blockParams || [];
  if (names[0]) blockParams.push([names[0], firstShape]);
  if (names[1] && secondShape) blockParams.push([names[1], secondShape]);
  return {
    ...scope,
    blockParams: new Map(blockParams)
  };
}

function handlebarsRenderInputShape(input: StageShape): StageShape {
  if (input.kind === 'union') {
    return unionShape(input.members.map(handlebarsRenderInputShape));
  }

  const context = handlebarsContextShape();
  if (input.kind === 'object') {
    return mergeObjectShapes(input, objectShape({
      context: { shape: context }
    }));
  }
  return objectShape({
    data: { shape: input },
    context: { shape: context }
  });
}

function handlebarsContextShape(): StageShape {
  return objectShape({
    flags: { shape: recordShape(booleanShape) },
    conditions: { shape: recordShape(booleanShape) },
    request: { shape: unknownShape, optional: true },
    env: { shape: stringShape, optional: true },
    cache: { shape: unknownShape, optional: true },
    log: { shape: unknownShape, optional: true },
    rate_limit: { shape: unknownShape, optional: true }
  }, true);
}

function checkResultStep(step: Extract<PipelineStep, { kind: 'Result' }>, input: PipelineTypeState, ctx: TypeContext): PipelineTypeState {
  const branches = step.branches.map(branch => {
    const body = checkPipeline({ ...branch.pipeline }, withShape(input, resultBranchInputShape(input.shape, branch.branchType)), { ...ctx, asyncTasks: new Map(ctx.asyncTasks) });
    return {
      shape: objectShape({
      status: { shape: { kind: 'number', literal: branch.statusCode } },
      body: { shape: body.shape }
      }),
      debts: body.debts
    };
  });
  return branches.length > 0
    ? {
        shape: unionShape(branches.map(branch => branch.shape)),
        debts: dedupeDebts(branches.flatMap(branch => branch.debts))
      }
    : input;
}

function resolveAssertContract(step: Extract<PipelineStep, { kind: 'Regular' }>, ctx: TypeContext): { source: string; start: number; end: number } | undefined {
  if (step.configType === 'identifier') {
    const variable = findVariable(ctx, 'assert', step.config.trim());
    if (!variable) {
      ctx.push(
        DiagnosticSeverity.Error,
        step.configStart ?? step.nameStart,
        step.configEnd ?? step.nameEnd,
        `Unknown assert contract '${step.config.trim()}'`
      );
      return undefined;
    }
    return { source: variable.value, start: variable.start, end: variable.end };
  }

  return {
    source: step.config,
    start: step.configStart ?? step.nameStart,
    end: step.configEnd ?? step.nameEnd
  };
}

function findPipeline(ctx: TypeContext, ref: string): NamedPipeline | undefined {
  const trimmed = ref.trim();
  return ctx.pipelines.get(trimmed) || ctx.pipelines.get(trimmed.split('::').pop() || trimmed);
}

function applyPipelineArgs(step: Extract<PipelineStep, { kind: 'Regular' }>, input: PipelineTypeState, ctx: TypeContext): PipelineTypeState {
  if (!step.args.length) {
    return input;
  }

  const argShape = inferJqOutputShape(step.args[0], input.shape);
  if (input.shape.kind === 'object' && argShape.kind === 'object') {
    return withShape(input, mergeObjectShapes(input.shape, argShape));
  }
  return stateOf(argShape);
}

function applyDataMiddlewareShape(input: StageShape, result: StageShape, step: Extract<PipelineStep, { kind: 'Regular' }>, ctx: TypeContext): StageShape {
  if (step.name === 'pg' && step.config.trim().startsWith('!raw')) {
    return unknownShape;
  }

  const targetName = getResultTargetName(step, ctx, input);
  if (targetName) {
    return mergeObjectShapes(input, objectShape({
      data: {
        shape: objectShape({
          [targetName]: { shape: result }
        })
      }
    }));
  }

  return mergeObjectShapes(input, objectShape({
    data: { shape: result }
  }));
}

function applyDataMiddlewareState(input: PipelineTypeState, result: StageShape, step: Extract<PipelineStep, { kind: 'Regular' }>, ctx: TypeContext): PipelineTypeState {
  const targetName = getResultTargetName(step, ctx, input.shape);

  if (step.name === 'pg' && step.config.trim().startsWith('!raw')) {
    if (targetName) {
      const shape = mergeObjectShapes(input.shape, objectShape({
        data: {
          shape: objectShape({
            [targetName]: { shape: unknownShape }
          })
        }
      }));
      return {
        shape,
        debts: addDebts(input.debts, [
          makeDebt(step, 'pg', 'raw pg result', [...dataOutputPath(targetName)], 'assert')
        ])
      };
    }

    return {
      shape: unknownShape,
      debts: addDebts(input.debts, [
        makeDebt(step, 'pg', 'raw pg result', [], 'assert')
      ])
    };
  }

  const shape = applyDataMiddlewareShape(input.shape, result, step, ctx);
  const basePath = dataOutputPath(targetName);
  const debts: UnknownDebt[] = [];

  if (step.name === 'pg') {
    debts.push(makeDebt(step, 'pg', 'pg row data', [...basePath, fieldSegment('rows'), indexSegment()], 'assert'));
  } else if (step.name === 'fetch') {
    debts.push(makeDebt(step, 'fetch', 'fetch response body', [...basePath, fieldSegment('response')], 'assert'));
  } else if (step.name === 'graphql') {
    debts.push(makeDebt(step, 'graphql', 'graphql data payload', [...basePath, fieldSegment('data')], 'assert'));
  }

  return {
    shape,
    debts: addDebts(input.debts, debts)
  };
}

function getResultTargetName(step: Extract<PipelineStep, { kind: 'Regular' }>, ctx: TypeContext, input: StageShape): string | undefined {
  const tagResult = getTagArg(step.condition, 'result');
  if (tagResult) return tagResult;

  const stateResultName = getLiteralStringProp(input, 'resultName');
  if (stateResultName) return stateResultName;

  if (step.configType === 'identifier') {
    const variable = findVariable(ctx, step.name, step.config.trim());
    if (variable) return variable.name;
  }

  return undefined;
}

function applyAuthShape(input: StageShape, step: Extract<PipelineStep, { kind: 'Regular' }>): StageShape {
  const flow = step.config.trim().replace(/^["']|["']$/g, '');
  const userShape = authUserShape(flow);

  if (flow === 'logout') {
    return mergeObjectShapes(input, objectShape({
      setCookies: { shape: arrayShape(stringShape), optional: true }
    }));
  }

  return mergeObjectShapes(input, objectShape({
    user: { shape: userShape, optional: flow === 'optional' }
  }));
}

function applyJoinShape(input: PipelineTypeState, step: Extract<PipelineStep, { kind: 'Regular' }>, ctx: TypeContext): PipelineTypeState {
  const targets = step.parsedJoinTargets && step.parsedJoinTargets.length > 0
    ? step.parsedJoinTargets
    : step.config.split(',').map(target => target.trim()).filter(Boolean);

  const asyncFields: Record<string, ShapeField> = {};
  const joinedDebts: UnknownDebt[] = [];
  for (const target of targets) {
    const task = ctx.asyncTasks.get(target) || stateOf(unknownShape);
    asyncFields[target] = { shape: task.shape };
    joinedDebts.push(...prefixDebts(task.debts, [fieldSegment('async'), fieldSegment(target)]));
  }

  return {
    shape: mergeObjectShapes(input.shape, objectShape({
    async: { shape: objectShape(asyncFields, true) }
    })),
    debts: addDebts(input.debts, joinedDebts)
  };
}

function routeInputState(route: Route): PipelineTypeState {
  const shape = routeInputShape(route);
  const debts = ['POST', 'PUT', 'PATCH'].includes(route.method)
    ? [
        makeDebtFromParts({
          producer: 'route-body',
          reason: 'request body',
          path: [fieldSegment('body')],
          start: route.start,
          end: route.start + route.method.length,
          clearWith: 'validate-or-assert',
          latent: true
        })
      ]
    : [];
  return stateOf(shape, debts);
}

function routeInputShape(route: Route): StageShape {
  const params: Record<string, ShapeField> = {};
  for (const part of route.path.split('/')) {
    if (part.startsWith(':') && part.length > 1) {
      params[part.slice(1)] = { shape: unionShape([stringShape, numberShape]) };
    }
  }

  const queryValue = unionShape([stringShape, numberShape, arrayShape(unionShape([stringShape, numberShape]))]);
  const body = ['POST', 'PUT', 'PATCH'].includes(route.method) ? unknownShape : objectShape({}, true);

  return objectShape({
    method: { shape: { kind: 'string', literal: route.method } },
    path: { shape: stringShape },
    params: { shape: objectShape(params, false) },
    query: { shape: recordShape(queryValue) },
    headers: { shape: recordShape(stringShape) },
    cookies: { shape: recordShape(stringShape) },
    body: { shape: body },
    content_type: { shape: stringShape, optional: true },
    originalRequest: {
      shape: objectShape({
        method: { shape: { kind: 'string', literal: route.method } },
        params: { shape: objectShape(params, false) },
        query: { shape: recordShape(queryValue) }
      }, true)
    }
  }, false);
}

function graphqlResolverInputShape(): StageShape {
  return objectShape({
    parent: { shape: unknownShape, optional: true },
    args: { shape: recordShape(unknownShape) },
    context: {
      shape: objectShape({
        user: { shape: authUserShape(), optional: true }
      }, true)
    }
  }, true);
}

function graphqlLoaderInputShape(): StageShape {
  return objectShape({
    keys: { shape: arrayShape(unknownShape) },
    args: { shape: recordShape(unknownShape) },
    context: {
      shape: objectShape({
        user: { shape: authUserShape(), optional: true }
      }, true)
    }
  }, false);
}

function authUserShape(flow = 'required'): StageShape {
  return objectShape({
    id: { shape: unionShape([stringShape, numberShape]) },
    login: { shape: stringShape, optional: flow !== 'login' },
    email: { shape: stringShape, optional: true },
    type: { shape: stringShape, optional: true }
  });
}

function pgResultShape(config: string): StageShape {
  if (config.trim().startsWith('!raw')) {
    return unknownShape;
  }
  return objectShape({
    rows: { shape: arrayShape(recordShape(unknownShape)) },
    rowCount: { shape: numberShape }
  });
}

function fetchResultShape(): StageShape {
  return objectShape({
    response: { shape: unknownShape },
    status: { shape: numberShape },
    headers: { shape: recordShape(stringShape) }
  });
}

function graphqlResultShape(): StageShape {
  return objectShape({
    data: { shape: recordShape(unknownShape), optional: true },
    errors: { shape: arrayShape(recordShape(unknownShape)), optional: true }
  }, true);
}

function errorEnvelopeShape(errorType: string): StageShape {
  return objectShape({
    errors: {
      shape: arrayShape(objectShape({
        type: { shape: { kind: 'string', literal: errorType } },
        message: { shape: stringShape },
        field: { shape: stringShape, optional: true },
        context: { shape: stringShape, optional: true },
        rule: { shape: stringShape, optional: true },
        code: { shape: stringShape, optional: true },
        sqlstate: { shape: stringShape, optional: true },
        severity: { shape: stringShape, optional: true },
        query: { shape: stringShape, optional: true },
        status: { shape: numberShape, optional: true },
        url: { shape: stringShape, optional: true }
      }, true))
    }
  }, false);
}

function resultBranchInputShape(input: StageShape, branchType: { kind: string; name?: string }): StageShape {
  if (branchType.kind === 'Ok') {
    return narrowToOkShape(input);
  }
  if (branchType.kind === 'Custom' && branchType.name) {
    const narrowed = narrowToErrorShape(input, branchType.name);
    return mergeErrorEnvelopeShape(narrowed, branchType.name);
  }
  return input;
}

function mergeErrorEnvelopeShape(input: StageShape, errorType: string): StageShape {
  const envelope = errorEnvelopeShape(errorType);
  if (input.kind === 'unknown') {
    return mergeObjectShapes(recordShape(unknownShape), envelope);
  }
  if (input.kind === 'union') {
    return unionShape(input.members.map(member => mergeErrorEnvelopeShape(member, errorType)));
  }
  return mergeObjectShapes(input, envelope);
}

function narrowToOkShape(input: StageShape): StageShape {
  if (input.kind === 'union') {
    const okMembers = input.members.filter(member => !memberLooksLikeError(member));
    if (okMembers.length > 0 && okMembers.length < input.members.length) {
      const stripped = okMembers.map(stripErrorsField);
      return stripped.length === 1 ? stripped[0] : unionShape(stripped);
    }
  }
  return stripErrorsField(input);
}

function narrowToErrorShape(input: StageShape, name: string): StageShape {
  if (input.kind !== 'union') return input;
  const matching = input.members.filter(member => memberCouldHaveErrorType(member, name));
  if (matching.length === 0 || matching.length === input.members.length) return input;
  return matching.length === 1 ? matching[0] : unionShape(matching);
}

function memberLooksLikeError(shape: StageShape): boolean {
  if (shape.kind !== 'object') return false;
  const errors = shape.fields.errors;
  return !!errors && !errors.optional && errors.shape.kind === 'array';
}

function memberCouldHaveErrorType(shape: StageShape, name: string): boolean {
  if (shape.kind !== 'object') return false;
  const errors = shape.fields.errors;
  if (!errors || errors.shape.kind !== 'array') return false;
  const item = errors.shape.item;
  if (item.kind === 'object') {
    const typeField = item.fields.type;
    if (typeField && typeField.shape.kind === 'string' && typeField.shape.literal !== undefined) {
      return typeField.shape.literal === name;
    }
  }
  return true;
}

function stripErrorsField(shape: StageShape): StageShape {
  if (shape.kind !== 'object' || !shape.fields.errors) return shape;
  const fields: Record<string, ShapeField> = {};
  for (const [key, value] of Object.entries(shape.fields)) {
    if (key !== 'errors') fields[key] = value;
  }
  return objectShape(fields, shape.additional);
}

function objectShape(fields: Record<string, ShapeField>, additional = false): StageShape {
  return { kind: 'object', fields, additional };
}

function recordShape(value: StageShape): StageShape {
  return { kind: 'object', fields: {}, additional: true };
}

function arrayShape(item: StageShape): StageShape {
  return { kind: 'array', item };
}

function unionShape(members: StageShape[]): StageShape {
  const flat = members.flatMap(member => member.kind === 'union' ? member.members : [member]);
  const rendered = new Set<string>();
  const unique: StageShape[] = [];
  for (const member of flat) {
    // Use a full, untruncated identity for dedup. renderShape elides large
    // objects with "+N more fields" for display, which makes structurally
    // distinct shapes look identical and incorrectly collapses unions.
    const key = shapeIdentity(member);
    if (!rendered.has(key)) {
      rendered.add(key);
      unique.push(member);
    }
  }
  return unique.length === 1 ? unique[0] : { kind: 'union', members: unique };
}

function shapeIdentity(shape: StageShape): string {
  switch (shape.kind) {
    case 'unknown':
      return 'unknown';
    case 'null':
      return 'null';
    case 'boolean':
      return shape.literal === undefined ? 'boolean' : `bool:${shape.literal}`;
    case 'number':
      return shape.literal === undefined ? 'number' : `num:${shape.literal}`;
    case 'string':
      return shape.literal === undefined ? 'string' : `str:${JSON.stringify(shape.literal)}`;
    case 'array':
      return `array(${shapeIdentity(shape.item)})`;
    case 'union':
      return `union(${shape.members.map(shapeIdentity).sort().join('|')})`;
    case 'object': {
      const entries = Object.entries(shape.fields).sort((a, b) => a[0].localeCompare(b[0]));
      const fields = entries.map(([k, f]) => `${k}${f.optional ? '?' : ''}:${shapeIdentity(f.shape)}`);
      return `obj{${fields.join(',')}${shape.additional ? ',...' : ''}}`;
    }
  }
}

function mergeObjectShapes(left: StageShape, right: StageShape): StageShape {
  if (left.kind === 'unknown') return right;
  if (right.kind === 'unknown') return left;
  // Distribute merges over unions so that a helper pipeline returning
  // `{ a } | { b }` still merges with the caller's surrounding state per
  // backpack semantics (object outputs merge, even when they vary by branch).
  if (left.kind === 'union') {
    return unionShape(left.members.map(member => mergeObjectShapes(member, right)));
  }
  if (right.kind === 'union') {
    return unionShape(right.members.map(member => mergeObjectShapes(left, member)));
  }
  if (left.kind !== 'object' || right.kind !== 'object') return right;

  const merged: Record<string, ShapeField> = { ...left.fields };
  for (const [key, field] of Object.entries(right.fields)) {
    const existing = merged[key];
    merged[key] = existing
      ? { shape: mergeObjectShapes(existing.shape, field.shape), optional: existing.optional && field.optional }
      : field;
  }
  return objectShape(merged, left.additional || right.additional);
}

function applyTransformShape(input: StageShape, output: StageShape, isLastStep: boolean): StageShape {
  if (isLastStep) {
    return output;
  }
  return restoreRuntimeKeys(input, output);
}

function applyTransformState(input: PipelineTypeState, output: StageShape, isLastStep: boolean): PipelineTypeState {
  const shape = applyTransformShape(input.shape, output, isLastStep);
  if (isLastStep) {
    return stateOf(shape);
  }
  return {
    shape,
    debts: preserveRestoredRuntimeKeyDebts(input, output)
  };
}

function preserveRestoredRuntimeKeyDebts(input: PipelineTypeState, output: StageShape): UnknownDebt[] {
  if (input.shape.kind !== 'object' || output.kind !== 'object') {
    return [];
  }
  return input.debts.filter(debt => {
    const first = debt.path.find(segment => segment.kind === 'field')?.name;
    return !!first && RUNTIME_KEYS.includes(first) && !output.fields[first];
  });
}

function restoreRuntimeKeys(input: StageShape, output: StageShape): StageShape {
  if (output.kind === 'union') {
    return unionShape(output.members.map(member => restoreRuntimeKeys(input, member)));
  }
  if (input.kind !== 'object' || output.kind !== 'object') {
    return output;
  }

  const fields: Record<string, ShapeField> = { ...output.fields };
  for (const key of RUNTIME_KEYS) {
    if (!fields[key] && input.fields[key]) {
      fields[key] = input.fields[key];
    }
  }

  return objectShape(fields, output.additional);
}

function asObjectShape(shape: StageShape): Extract<StageShape, { kind: 'object' }> {
  if (shape.kind === 'object') {
    return { ...shape, fields: { ...shape.fields } };
  }
  return objectShape({}, true) as Extract<StageShape, { kind: 'object' }>;
}

function getLiteralStringProp(shape: StageShape, field: string): string | undefined {
  if (shape.kind !== 'object') return undefined;
  const prop = shape.fields[field]?.shape;
  return prop?.kind === 'string' ? prop.literal : undefined;
}

function fieldSegment(name: string): PathSegment {
  return { kind: 'field', name };
}

function indexSegment(): PathSegment {
  return { kind: 'index' };
}

function dataOutputPath(targetName: string | undefined): PathSegment[] {
  return targetName
    ? [fieldSegment('data'), fieldSegment(targetName)]
    : [fieldSegment('data')];
}

function makeDebt(step: Extract<PipelineStep, { kind: 'Regular' }>, producer: UnknownProducer, reason: string, path: PathSegment[], clearWith: UnknownDebt['clearWith']): UnknownDebt {
  return makeDebtFromParts({
    producer,
    reason,
    path,
    start: step.nameStart,
    end: step.nameEnd,
    clearWith
  });
}

function makeDebtFromParts(parts: Omit<UnknownDebt, 'id'>): UnknownDebt {
  return {
    id: `${parts.producer}:${parts.start}:${parts.end}:${debtCounter++}`,
    ...parts
  };
}

function addDebts(existing: UnknownDebt[], incoming: UnknownDebt[]): UnknownDebt[] {
  return dedupeDebts([...existing, ...incoming]);
}

function dedupeDebts(debts: UnknownDebt[]): UnknownDebt[] {
  const seen = new Set<string>();
  const result: UnknownDebt[] = [];
  for (const debt of debts) {
    const key = `${debt.producer}:${renderDebtPath(debt.path)}:${debt.start}:${debt.end}:${debt.latent ? 'latent' : 'active'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(debt);
  }
  return result;
}

function prefixDebts(debts: UnknownDebt[], prefix: PathSegment[]): UnknownDebt[] {
  return debts.map(debt => ({
    ...debt,
    id: `${debt.id}@${renderDebtPath(prefix)}`,
    path: [...prefix, ...debt.path]
  }));
}

function clearDebtsWithAssert(debts: UnknownDebt[], asserted: StageShape): UnknownDebt[] {
  return debts.filter(debt => {
    if (debt.path.length === 0) {
      return asserted.kind === 'unknown';
    }
    return !contractCoversPath(asserted, debt.path);
  });
}

function clearRouteBodyDebts(debts: UnknownDebt[], bodyShape: StageShape): UnknownDebt[] {
  const asserted = objectShape({ body: { shape: bodyShape } });
  return debts.filter(debt => {
    if (debt.producer !== 'route-body') return true;
    return !contractCoversPath(asserted, debt.path);
  });
}

function contractCoversPath(shape: StageShape, path: PathSegment[]): boolean {
  if (path.length === 0) {
    return shape.kind !== 'unknown';
  }
  if (shape.kind === 'union') {
    return shape.members.some(member => contractCoversPath(member, path));
  }
  const [head, ...tail] = path;
  if (head.kind === 'index') {
    return shape.kind === 'array' && contractCoversPath(shape.item, tail);
  }
  if (shape.kind !== 'object') {
    return false;
  }
  const field = shape.fields[head.name!];
  if (!field || field.optional) {
    return false;
  }
  return contractCoversPath(field.shape, tail);
}

function transformUnknownState(input: PipelineTypeState, step: Extract<PipelineStep, { kind: 'Regular' }>, producer: 'lua' | 'js'): PipelineTypeState {
  return {
    shape: unknownShape,
    debts: addDebts(input.debts, [
      makeDebt(step, producer, `${producer} output`, [], 'assert')
    ])
  };
}

function checkStepArgAccesses(step: Extract<PipelineStep, { kind: 'Regular' }>, input: PipelineTypeState, ctx: TypeContext): void {
  const argSpans = step.argSpans;
  for (let index = 0; index < (step.args || []).length; index++) {
    const arg = step.args[index];
    const span = argSpans?.[index];
    checkJqSourceAccesses(arg, input, ctx, {
      source: arg,
      diagnosticStart: span?.start ?? step.nameStart,
      diagnosticEnd: span?.end ?? step.nameEnd,
      preciseSpans: !!span
    }, `${step.name} arguments`);
  }
}

function checkJqSourceAccesses(source: string, input: PipelineTypeState, ctx: TypeContext, span: JqFilterSource, stageLabel: string): void {
  const accesses = scanRootFieldAccesses(source, 1);
  const pathDiagnostics: JqPathDiagnostic[] = [];
  for (const access of accesses) {
    const problem = validatePath(input.shape, access.path);
    if (problem) {
      pathDiagnostics.push({
        path: access.path,
        missingField: missingFieldFromProblem(problem),
        start: span.preciseSpans ? span.diagnosticStart + access.start : span.diagnosticStart,
        end: span.preciseSpans ? span.diagnosticStart + access.end : span.diagnosticEnd
      });
    }
  }
  pushPipelinePathDiagnostics(pathDiagnostics, new Set(), input.shape, ctx, stageLabel);
  pushStrictDebtAccessDiagnostics(accesses, input, ctx, span);
}

function pushStrictDebtAccessDiagnostics(
  accesses: Array<{ path: PathSegment[]; start: number; end: number }>,
  input: PipelineTypeState,
  ctx: TypeContext,
  filter: JqFilterSource
): void {
  if (ctx.options.mode !== 'strict') return;
  const emitted = new Set<string>();
  for (const access of accesses) {
    const debt = input.debts.find(item => pathTouchesDebt(access.path, item.path));
    if (!debt) continue;
    const key = `${renderDebtPath(access.path)}:${debt.id}`;
    if (emitted.has(key)) continue;
    emitted.add(key);
    ctx.push(
      DiagnosticSeverity.Error,
      filter.preciseSpans ? filter.diagnosticStart + access.start : filter.diagnosticStart,
      filter.preciseSpans ? filter.diagnosticStart + access.end : filter.diagnosticEnd,
      strictConsumerMessage(access.path, debt)
    );
  }
}

function pushStepDebtDiagnostics(input: PipelineTypeState, step: Extract<PipelineStep, { kind: 'Regular' }>, ctx: TypeContext, action: string): void {
  if (ctx.options.mode !== 'strict') return;
  for (const debt of input.debts.filter(debt => !debt.latent)) {
    ctx.push(
      DiagnosticSeverity.Error,
      step.nameStart,
      step.nameEnd,
      `Strict type error: ${action} ${describeDebt(debt)}. ${clearDebtHint(debt)}`
    );
  }
}

function pushExitDebtDiagnostics(state: PipelineTypeState, ctx: TypeContext, owner: string): void {
  if (ctx.options.mode !== 'strict') return;
  for (const debt of state.debts.filter(debt => !debt.latent)) {
    ctx.push(
      DiagnosticSeverity.Error,
      debt.start,
      debt.end,
      `Strict type error: ${owner} returns ${describeDebt(debt)}. ${clearDebtHint(debt)}`
    );
  }
}

function pathTouchesDebt(accessPath: PathSegment[], debtPath: PathSegment[]): boolean {
  if (debtPath.length === 0) {
    return true;
  }
  return isPathPrefix(accessPath, debtPath) || isPathPrefix(debtPath, accessPath);
}

function isPathPrefix(prefix: PathSegment[], full: PathSegment[]): boolean {
  if (prefix.length > full.length) return false;
  return prefix.every((segment, index) => segmentsCompatible(segment, full[index]));
}

function segmentsCompatible(left: PathSegment, right: PathSegment): boolean {
  if (left.kind === 'index' || right.kind === 'index') {
    return left.kind === right.kind;
  }
  return left.name === right.name;
}

function strictConsumerMessage(accessPath: PathSegment[], debt: UnknownDebt): string {
  return `Strict type error: ${pathToJq(accessPath)} reads ${describeDebt(debt)}. ${clearDebtHint(debt)}`;
}

function describeDebt(debt: UnknownDebt): string {
  const path = renderDebtPath(debt.path);
  switch (debt.producer) {
    case 'pg':
      return `${path} from an unasserted pg result`;
    case 'fetch':
      return `${path} from an unasserted fetch response`;
    case 'graphql':
      return `${path} from an unasserted graphql result`;
    case 'lua':
      return `${path} from unasserted lua output`;
    case 'js':
      return `${path} from unasserted js output`;
    case 'route-body':
      return `${path} from an unvalidated request body`;
    default:
      return `${path} from ${debt.reason}`;
  }
}

function clearDebtHint(debt: UnknownDebt): string {
  return debt.clearWith === 'validate-or-assert'
    ? 'Add validate or assert before consuming it.'
    : 'Add an assert contract before consuming or returning it.';
}

function renderDebtPath(path: PathSegment[]): string {
  if (path.length === 0) return '$';
  let out = '';
  for (const segment of path) {
    out += segment.kind === 'field' ? `.${segment.name}` : '[]';
  }
  return out;
}

function pushHandlebarsPathDiagnostic(
  analysis: HandlebarsTemplateAnalysis,
  node: HandlebarsAst.Node,
  path: PathSegment[],
  currentInput: StageShape,
  rootInput: StageShape,
  ctx: TypeContext,
  state: HandlebarsCheckState,
  displayPath: string
): void {
  if (path.length === 0) return;
  const problem = validateHandlebarsPath(currentInput, path);
  if (!problem) return;

  const { start, end } = handlebarsNodeRange(analysis, node);
  const key = `${start}:${end}:${displayPath}:${problem}:${analysis.source.label || ''}`;
  if (state.emitted.has(key)) return;
  state.emitted.add(key);

  const detail = handlebarsProblemMessage(problem, displayPath, rootInput);
  const message = analysis.source.label
    ? `${analysis.source.label} has type error: ${detail}`
    : `Handlebars type check: ${detail}`;
  ctx.push(DiagnosticSeverity.Error, start, end, message);
}

function resolveHandlebarsPath(path: HandlebarsAst.PathExpression, scope: HandlebarsScope): { base: StageShape; path: PathSegment[] } | undefined {
  if (path.data || path.depth > 0) return undefined;
  const parts = handlebarsPathParts(path);
  if (!parts) return undefined;
  if (parts.length === 0) return { base: scope.current, path: [] };

  const blockParamShape = scope.blockParams.get(parts[0]);
  if (blockParamShape) {
    return {
      base: blockParamShape,
      path: parts.slice(1).map(fieldSegment)
    };
  }

  return {
    base: scope.current,
    path: parts.map(fieldSegment)
  };
}

function shapeAtHandlebarsPath(path: HandlebarsAst.PathExpression, scope: HandlebarsScope): StageShape | undefined {
  const resolved = resolveHandlebarsPath(path, scope);
  return resolved ? shapeAtPath(resolved.base, resolved.path) : undefined;
}

function expressionShape(expression: HandlebarsAst.Expression, scope: HandlebarsScope): StageShape | undefined {
  if (isHandlebarsPathExpression(expression)) {
    return shapeAtHandlebarsPath(expression, scope);
  }
  switch (expression.type) {
    case 'StringLiteral':
      return { kind: 'string', literal: (expression as HandlebarsAst.StringLiteral).value };
    case 'NumberLiteral':
      return { kind: 'number', literal: (expression as HandlebarsAst.NumberLiteral).value };
    case 'BooleanLiteral':
      return { kind: 'boolean', literal: (expression as HandlebarsAst.BooleanLiteral).value };
    case 'NullLiteral':
      return nullShape;
    case 'UndefinedLiteral':
      return unknownShape;
    default:
      return unknownShape;
  }
}

function mergeHandlebarsHashIntoShape(shape: StageShape, hash: HandlebarsAst.Hash | undefined, scope: HandlebarsScope): StageShape {
  const pairs = hash?.pairs || [];
  if (pairs.length === 0) return shape;

  const fields: Record<string, ShapeField> = {};
  for (const pair of pairs) {
    fields[pair.key] = { shape: expressionShape(pair.value, scope) ?? unknownShape };
  }
  return mergeObjectShapes(shape, objectShape(fields));
}

function handlebarsPathParts(path: HandlebarsAst.PathExpression): string[] | undefined {
  if ((path as any).this || path.original === 'this' || path.original === '.') return [];
  const parts = path.parts || [];
  if (parts.some(part => typeof part !== 'string')) return undefined;
  return parts as string[];
}

function handlebarsPathName(path: HandlebarsAst.PathExpression): string | undefined {
  const parts = handlebarsPathParts(path);
  return parts?.[0];
}

function handlebarsPartialName(name: HandlebarsAst.PathExpression | HandlebarsAst.SubExpression): string | undefined {
  if (!isHandlebarsPathExpression(name) || name.data || name.depth > 0) return undefined;
  return name.original || handlebarsPathParts(name)?.join('/');
}

function isHandlebarsPathExpression(node: HandlebarsAst.Expression | HandlebarsAst.SubExpression | HandlebarsAst.PathExpression | HandlebarsAst.Literal): node is HandlebarsAst.PathExpression {
  return node?.type === 'PathExpression';
}

function isHandlebarsSubExpression(node: HandlebarsAst.Expression | HandlebarsAst.SubExpression | HandlebarsAst.PathExpression | HandlebarsAst.Literal): node is HandlebarsAst.SubExpression {
  return node?.type === 'SubExpression';
}

function statementIsDecoratorBlock(node: HandlebarsAst.BlockStatement): boolean {
  return (node as any).type === 'DecoratorBlock';
}

function lineStartsFor(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '\n') {
      starts.push(index + 1);
    }
  }
  return starts;
}

function handlebarsNodeRange(analysis: HandlebarsTemplateAnalysis, node: HandlebarsAst.Node): { start: number; end: number } {
  if (!analysis.source.preciseSpans || !node.loc) {
    return { start: analysis.source.diagnosticStart, end: analysis.source.diagnosticEnd };
  }
  return {
    start: analysis.source.diagnosticStart + handlebarsPositionOffset(analysis.lineStarts, node.loc.start),
    end: analysis.source.diagnosticStart + handlebarsPositionOffset(analysis.lineStarts, node.loc.end)
  };
}

function handlebarsPositionOffset(lineStarts: number[], position: HandlebarsAst.Position): number {
  return (lineStarts[Math.max(0, position.line - 1)] ?? 0) + position.column;
}

function validateHandlebarsPath(shape: StageShape, path: PathSegment[]): string | undefined {
  if (shape.kind === 'union') {
    const failures = shape.members.map(member => validateHandlebarsPath(member, path));
    return failures.some(failure => !failure) ? undefined : failures.find(Boolean);
  }
  return validatePath(shape, path);
}

function handlebarsProblemMessage(problem: string, displayPath: string, input: StageShape): string {
  const missing = missingFieldFromProblem(problem);
  if (missing) {
    return `property "${missing}" is not present for {{${displayPath}}}. Previous stage output: ${renderShape(input)}.`;
  }
  return `{{${displayPath}}} is invalid: ${problem}. Previous stage output: ${renderShape(input)}.`;
}

function pathToHandlebars(path: PathSegment[]): string {
  if (path.length === 0) return 'this';
  return path.map(segment => segment.kind === 'field' ? segment.name : '[0]').join('.');
}

function shapeAtPath(shape: StageShape | undefined, path: PathSegment[]): StageShape | undefined {
  if (!shape) return undefined;
  if (path.length === 0 || shape.kind === 'unknown') return shape;
  if (shape.kind === 'union') {
    const members = shape.members.map(member => shapeAtPath(member, path)).filter((member): member is StageShape => !!member);
    return members.length > 0 ? unionShape(members) : undefined;
  }

  const [head, ...tail] = path;
  if (head.kind === 'index') {
    return shape.kind === 'array' ? shapeAtPath(shape.item, tail) : undefined;
  }
  if (shape.kind !== 'object') {
    return undefined;
  }

  const field = shape.fields[head.name!];
  if (field) {
    return shapeAtPath(field.shape, tail);
  }
  return shape.additional ? unknownShape : undefined;
}

function eachItemShape(shape: StageShape | undefined): StageShape {
  if (!shape || shape.kind === 'unknown') return unknownShape;
  if (shape.kind === 'array') return shape.item;
  if (shape.kind === 'object') return unknownShape;
  if (shape.kind === 'union') return unionShape(shape.members.map(eachItemShape));
  return unknownShape;
}

function findHandlebarsVariable(ctx: TypeContext, ref: string): Variable | undefined {
  return findVariable(ctx, 'handlebars', ref) || findVariable(ctx, 'mustache', ref);
}

function findVariable(ctx: TypeContext, type: string, ref: string): Variable | undefined {
  const trimmed = ref.trim();
  return ctx.variables.get(`${type}:${trimmed}`) || ctx.variables.get(`${type}:${trimmed.split('::').pop() || trimmed}`);
}

function renderShape(shape: StageShape): string {
  switch (shape.kind) {
    case 'unknown':
      return 'unknown';
    case 'null':
      return 'null';
    case 'boolean':
      return shape.literal === undefined ? 'boolean' : String(shape.literal);
    case 'number':
      return shape.literal === undefined ? 'number' : String(shape.literal);
    case 'string':
      return shape.literal === undefined ? 'string' : JSON.stringify(shape.literal);
    case 'array':
      return `${renderShape(shape.item)}[]`;
    case 'union':
      return shape.members.map(renderShape).join(' | ');
    case 'object': {
      const allEntries = Object.entries(shape.fields);
      const cap = 8;
      const shown = allEntries.slice(0, cap);
      const hidden = allEntries.length - shown.length;
      const fields = shown.map(([key, field]) => `${key}${field.optional ? '?' : ''}: ${renderShape(field.shape)}`);
      const parts: string[] = [...fields];
      if (hidden > 0) {
        parts.push(`+${hidden} more field${hidden === 1 ? '' : 's'}`);
      }
      if (shape.additional) {
        parts.push('...');
      }
      return parts.length === 0 ? '{}' : `{ ${parts.join(', ')} }`;
    }
  }
}

function hintForMissingPath(path: PathSegment[]): string {
  const first = path.find(segment => segment.kind === 'field')?.name;
  if (first === 'data') {
    return ' Hint: did you mean to put this jq after pg/fetch/graphql or add an assert contract?';
  }
  return '';
}

function toJsonSchema(shape: StageShape): any {
  switch (shape.kind) {
    case 'unknown':
      return {};
    case 'null':
      return { type: 'null' };
    case 'boolean':
      return shape.literal === undefined ? { type: 'boolean' } : { const: shape.literal };
    case 'number':
      return shape.literal === undefined ? { type: 'number' } : { const: shape.literal };
    case 'string':
      return shape.literal === undefined ? { type: 'string' } : { const: shape.literal };
    case 'array':
      return { type: 'array', items: toJsonSchema(shape.item) };
    case 'union':
      return { anyOf: shape.members.map(toJsonSchema) };
    case 'object': {
      const properties: Record<string, any> = {};
      const required: string[] = [];
      for (const [key, field] of Object.entries(shape.fields)) {
        properties[key] = toJsonSchema(field.shape);
        if (!field.optional) required.push(key);
      }
      return {
        type: 'object',
        properties,
        required,
        additionalProperties: shape.additional
      };
    }
  }
}

function fromJsonSchema(schema: any): StageShape {
  if (!schema || typeof schema !== 'object') return unknownShape;
  if ('const' in schema) {
    const value = schema.const;
    if (value === null) return nullShape;
    if (typeof value === 'boolean') return { kind: 'boolean', literal: value };
    if (typeof value === 'number') return { kind: 'number', literal: value };
    if (typeof value === 'string') return { kind: 'string', literal: value };
    return unknownShape;
  }
  if (Array.isArray(schema.anyOf)) return unionShape(schema.anyOf.map(fromJsonSchema));
  if (Array.isArray(schema.oneOf)) return unionShape(schema.oneOf.map(fromJsonSchema));

  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case 'null':
      return nullShape;
    case 'boolean':
      return booleanShape;
    case 'integer':
    case 'number':
      return numberShape;
    case 'string':
      return stringShape;
    case 'array':
      return arrayShape(fromJsonSchema(schema.items));
    case 'object': {
      const required = new Set<string>(schema.required || []);
      const fields: Record<string, ShapeField> = {};
      for (const [key, value] of Object.entries(schema.properties || {})) {
        fields[key] = { shape: fromJsonSchema(value), optional: !required.has(key) };
      }
      return objectShape(fields, schema.additionalProperties !== false);
    }
    default:
      return unknownShape;
  }
}

function validatePath(shape: StageShape, path: PathSegment[]): string | undefined {
  let current = shape;
  for (const segment of path) {
    if (current.kind === 'unknown') return undefined;
    if (current.kind === 'union') {
      const failures = current.members.map(member => validatePath(member, [segment]));
      if (failures.some(Boolean)) return failures.find(Boolean);
      current = unknownShape;
      continue;
    }
    if (segment.kind === 'index') {
      if (current.kind !== 'array') {
        return `expected array before ${pathToJq(path)}`;
      }
      current = current.item;
      continue;
    }
    if (current.kind !== 'object') {
      return `expected object before .${segment.name}`;
    }
    const field = current.fields[segment.name!];
    if (!field) {
      return current.additional ? undefined : `missing field ${segment.name}`;
    }
    current = field.shape;
  }
  return undefined;
}

function findRequiredFieldMismatch(actual: StageShape, expected: StageShape, path = '$'): string | undefined {
  if (actual.kind === 'unknown' || expected.kind === 'unknown') return undefined;
  if (actual.kind === 'union') {
    // assert is a runtime check that fires on whatever member actually arrives.
    // If at least one union member satisfies the contract, the assert can
    // succeed at runtime — only warn when NO member matches.
    const memberIssues = actual.members.map(member => findRequiredFieldMismatch(member, expected, path));
    if (memberIssues.some(issue => issue === undefined)) return undefined;
    return memberIssues.find(Boolean);
  }
  if (expected.kind === 'union') {
    return expected.members.every(member => findRequiredFieldMismatch(actual, member, path))
      ? findRequiredFieldMismatch(actual, expected.members[0], path)
      : undefined;
  }
  if (expected.kind === 'object') {
    if (actual.kind !== 'object') return `${path} to be an object`;
    for (const [key, field] of Object.entries(expected.fields)) {
      if (field.optional) continue;
      const actualField = actual.fields[key];
      const childPath = path === '$' ? `$.${key}` : `${path}.${key}`;
      if (!actualField) {
        if (actual.additional) continue;
        return childPath;
      }
      const nested = findRequiredFieldMismatch(actualField.shape, field.shape, childPath);
      if (nested) return nested;
    }
  }
  if (expected.kind === 'array') {
    if (actual.kind !== 'array') return `${path} to be an array`;
    return findRequiredFieldMismatch(actual.item, expected.item, `${path}[]`);
  }
  return undefined;
}

function scanRootFieldAccesses(filter: string, minFieldCount = 2): Array<{ path: PathSegment[]; start: number; end: number }> {
  const accesses: Array<{ path: PathSegment[]; start: number; end: number }> = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < filter.length; i++) {
    const ch = filter[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch !== '.' || !isIdentStart(filter[i + 1]) || !isRootDot(filter, i)) {
      continue;
    }

    const start = i;
    const path: PathSegment[] = [];
    let j = i;
    while (j < filter.length) {
      if (filter[j] === '.' && isIdentStart(filter[j + 1])) {
        j++;
        const nameStart = j;
        while (j < filter.length && isIdentContinue(filter[j])) j++;
        path.push({ kind: 'field', name: filter.slice(nameStart, j) });
        continue;
      }
      if (filter[j] === '[') {
        const close = filter.indexOf(']', j + 1);
        if (close === -1) break;
        const inside = filter.slice(j + 1, close).trim();
        if (/^\d+$/.test(inside)) {
          path.push({ kind: 'index' });
          j = close + 1;
          continue;
        }
      }
      break;
    }

    const fieldCount = path.filter(segment => segment.kind === 'field').length;
    if (fieldCount >= minFieldCount && !isNullAlternativeOperand(filter, start, j)) {
      accesses.push({ path, start, end: j });
    }
    i = Math.max(i, j - 1);
  }

  return accesses;
}

function isRootDot(filter: string, dotIndex: number): boolean {
  if (dotIndex === 0) return true;
  const prev = filter[dotIndex - 1];
  return !prev || !/[A-Za-z0-9_$\]\)]/.test(prev);
}

function isNullAlternativeOperand(filter: string, start: number, end: number): boolean {
  let after = end;
  while (/\s/.test(filter[after] || '')) after++;
  if (filter.slice(after, after + 2) === '//') {
    return true;
  }

  let before = start - 1;
  while (before >= 0 && /\s/.test(filter[before])) before--;
  return before >= 1 && filter.slice(before - 1, before + 1) === '//';
}

function pathToJq(path: PathSegment[]): string {
  let out = '';
  for (const segment of path) {
    out += segment.kind === 'field' ? `.${segment.name}` : '[0]';
  }
  return out;
}

function getTagArg(expr: TagExpr | undefined, name: string): string | undefined {
  if (!expr) return undefined;
  if (expr.kind === 'Tag') {
    return expr.tag.name === name ? expr.tag.args[0] : undefined;
  }
  return getTagArg(expr.left, name) || getTagArg(expr.right, name);
}

function isIdentStart(ch: string | undefined): boolean {
  return !!ch && /[A-Za-z_]/.test(ch);
}

function isIdentContinue(ch: string | undefined): boolean {
  return !!ch && /[A-Za-z0-9_-]/.test(ch);
}

type SchemaParseResult = { ok: true; shape: StageShape } | { ok: false; error: string };

function parseShapeSchema(source: string, allowBareObject = false): SchemaParseResult {
  try {
    return { ok: true, shape: new ShapeSchemaParser(source).parse() };
  } catch (err) {
    if (allowBareObject && looksLikeBareObjectSchema(source)) {
      try {
        return { ok: true, shape: new ShapeSchemaParser(`{${source}}`).parse() };
      } catch {
        // Report the original parser error below; it usually points closer to the real issue.
      }
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function looksLikeBareObjectSchema(source: string): boolean {
  const trimmed = source.trim();
  return trimmed.length > 0 && !trimmed.startsWith('{') && !trimmed.startsWith('[') && trimmed.includes(':');
}

class ShapeSchemaParser {
  private pos = 0;

  constructor(private readonly source: string) {}

  parse(): StageShape {
    const shape = this.parseUnion();
    this.skipWs();
    if (!this.eof()) {
      throw new Error(`unexpected token '${this.peek()}'`);
    }
    return shape;
  }

  private parseUnion(): StageShape {
    const members = [this.parsePrimary()];
    while (true) {
      this.skipWs();
      if (!this.eat('|')) break;
      members.push(this.parsePrimary());
    }
    return members.length === 1 ? members[0] : unionShape(members);
  }

  private parsePrimary(): StageShape {
    this.skipWs();
    const ch = this.peek();
    if (ch === '{') return this.parseObject();
    if (ch === '[') return this.parseArray();
    if (ch === '"') return { kind: 'string', literal: this.parseString() };
    if (ch === '-' || /\d/.test(ch || '')) return { kind: 'number', literal: this.parseNumber() };
    if (isIdentStart(ch)) return this.parseNamedType();
    throw new Error(`unexpected token '${ch || 'end of schema'}'`);
  }

  private parseObject(): StageShape {
    this.expect('{');
    const fields: Record<string, ShapeField> = {};
    let additional = false;

    while (true) {
      this.skipWsAndCommas();
      if (this.eat('}')) break;
      if (this.source.slice(this.pos, this.pos + 3) === '...') {
        this.pos += 3;
        additional = true;
        this.skipWsAndCommas();
        if (this.eat('}')) break;
        continue;
      }

      const key = this.peek() === '"' ? this.parseString() : this.parseIdentifier();
      this.skipWs();
      const optional = this.eat('?');
      this.skipWs();
      this.expect(':');
      fields[key] = { shape: this.parseUnion(), optional };
      this.skipWsAndCommas();
      if (this.eat('}')) break;
    }

    return objectShape(fields, additional);
  }

  private parseArray(): StageShape {
    this.expect('[');
    this.skipWs();
    if (this.eat(']')) return arrayShape(unknownShape);
    const item = this.parseUnion();
    this.skipWsAndCommas();
    this.expect(']');
    return arrayShape(item);
  }

  private parseNamedType(): StageShape {
    const ident = this.parseIdentifier();
    switch (ident) {
      case 'unknown':
      case 'any':
        return unknownShape;
      case 'null':
        return nullShape;
      case 'bool':
      case 'boolean':
        return booleanShape;
      case 'number':
        return numberShape;
      case 'email':
      case 'string':
        this.parseOptionalRange();
        return stringShape;
      case 'true':
        return { kind: 'boolean', literal: true };
      case 'false':
        return { kind: 'boolean', literal: false };
      default:
        throw new Error(`unknown schema type '${ident}'`);
    }
  }

  private parseOptionalRange(): void {
    this.skipWs();
    if (!this.eat('(')) return;
    while (!this.eof() && this.peek() !== ')') this.pos++;
    this.expect(')');
  }

  private parseIdentifier(): string {
    this.skipWs();
    if (!isIdentStart(this.peek())) throw new Error(`expected identifier, got '${this.peek() || 'end of schema'}'`);
    const start = this.pos++;
    while (isIdentContinue(this.peek())) this.pos++;
    return this.source.slice(start, this.pos);
  }

  private parseNumber(): number {
    const start = this.pos;
    if (this.peek() === '-') this.pos++;
    while (/\d/.test(this.peek() || '')) this.pos++;
    if (this.peek() === '.') {
      this.pos++;
      while (/\d/.test(this.peek() || '')) this.pos++;
    }
    const value = Number(this.source.slice(start, this.pos));
    if (!Number.isFinite(value)) throw new Error('invalid number literal');
    return value;
  }

  private parseString(): string {
    this.expect('"');
    let out = '';
    let escaped = false;
    while (!this.eof()) {
      const ch = this.source[this.pos++];
      if (escaped) {
        out += ch === 'n' ? '\n' : ch === 'r' ? '\r' : ch === 't' ? '\t' : ch;
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        return out;
      } else {
        out += ch;
      }
    }
    throw new Error('unterminated string literal');
  }

  private skipWsAndCommas(): void {
    while (true) {
      this.skipWs();
      if (!this.eat(',')) break;
    }
  }

  private skipWs(): void {
    while (/\s/.test(this.peek() || '')) this.pos++;
  }

  private expect(ch: string): void {
    this.skipWs();
    if (!this.eat(ch)) throw new Error(`expected '${ch}', got '${this.peek() || 'end of schema'}'`);
  }

  private eat(ch: string): boolean {
    if (this.source[this.pos] === ch) {
      this.pos++;
      return true;
    }
    return false;
  }

  private peek(): string | undefined {
    return this.source[this.pos];
  }

  private eof(): boolean {
    return this.pos >= this.source.length;
  }
}
