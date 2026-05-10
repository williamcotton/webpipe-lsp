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

  const childCtx: TypeContext = {
    ...ctx,
    asyncTasks: new Map(ctx.asyncTasks),
    resolving: new Set([...ctx.resolving, name])
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
      }
      continue;
    }

    if (step.kind === 'Result') {
      current = checkResultStep(step, current, ctx);
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
      continue;
    }

    if (step.kind === 'Foreach') {
      checkPipeline(step.pipeline, stateOf(unknownShape), { ...ctx, asyncTasks: new Map(ctx.asyncTasks) });
      current = current.shape.kind === 'unknown' ? stateOf(unknownShape, current.debts) : current;
    }
  }

  return current;
}

function checkRegularStep(step: Extract<PipelineStep, { kind: 'Regular' }>, input: PipelineTypeState, ctx: TypeContext, allowAsync: boolean, isLastStep: boolean): PipelineTypeState {
  if (allowAsync && getTagArg(step.condition, 'async')) {
    return input;
  }

  checkStepArgDebtAccesses(step, input, ctx);

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
      pushStepDebtDiagnostics(input, step, ctx, 'handlebars renders');
      return stateOf({ kind: 'string', contentType: 'text/html' });
    case 'lua':
      return transformUnknownState(input, step, 'lua');
    case 'js':
      return transformUnknownState(input, step, 'js');
    case 'join':
      return applyJoinShape(input, step, ctx);
    case 'pipeline':
      if (!step.hasConfig) {
        return input;
      }
      return checkNamedPipeline(step.config.trim(), applyPipelineArgs(step, input, ctx), ctx, step.configStart ?? step.nameStart, step.configEnd ?? step.nameEnd);
    default:
      if (!step.hasConfig && findPipeline(ctx, step.name)) {
        return checkNamedPipeline(step.name, applyPipelineArgs(step, input, ctx), ctx, step.nameStart, step.nameEnd);
      }
      return input;
  }
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
      missingProperties.add(missingProperty);
    }
    ctx.push(severity, start, end, `jq type check: ${message}`);
  }
  return missingProperties;
}

function pushPipelinePathDiagnostics(pathDiagnostics: JqPathDiagnostic[], jqtypeMissingProperties: Set<string>, input: StageShape, ctx: TypeContext): void {
  for (const diagnostic of pathDiagnostics) {
    if (diagnostic.missingField && jqtypeMissingProperties.has(diagnostic.missingField)) {
      continue;
    }
    ctx.push(
      DiagnosticSeverity.Error,
      diagnostic.start,
      diagnostic.end,
      `Type error: ${pathToJq(diagnostic.path)} may be missing before this jq stage. Previous stage output: ${renderShape(input)}.${hintForMissingPath(diagnostic.path)}`
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
    ctx.push(
      DiagnosticSeverity.Warning,
      contract.start,
      contract.end,
      `Assert contract expects ${issue}, but previous stage output is ${renderShape(input.shape)}.`
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

  checkJqSourceDebtAccesses(step.args[0], input, ctx, {
    source: step.args[0],
    diagnosticStart: step.nameStart,
    diagnosticEnd: step.nameEnd,
    preciseSpans: false
  });

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
  }, true);
}

function resultBranchInputShape(input: StageShape, branchType: { kind: string; name?: string }): StageShape {
  if (branchType.kind !== 'Custom' || !branchType.name) {
    return input;
  }
  return mergeObjectShapes(input, errorEnvelopeShape(branchType.name));
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
    const key = renderShape(member);
    if (!rendered.has(key)) {
      rendered.add(key);
      unique.push(member);
    }
  }
  return unique.length === 1 ? unique[0] : { kind: 'union', members: unique };
}

function mergeObjectShapes(left: StageShape, right: StageShape): StageShape {
  if (left.kind === 'unknown') return right;
  if (right.kind === 'unknown') return left;
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

function checkStepArgDebtAccesses(step: Extract<PipelineStep, { kind: 'Regular' }>, input: PipelineTypeState, ctx: TypeContext): void {
  for (const arg of step.args || []) {
    checkJqSourceDebtAccesses(arg, input, ctx, {
      source: arg,
      diagnosticStart: step.nameStart,
      diagnosticEnd: step.nameEnd,
      preciseSpans: false
    });
  }
}

function checkJqSourceDebtAccesses(source: string, input: PipelineTypeState, ctx: TypeContext, span: JqFilterSource): void {
  const accesses = scanRootFieldAccesses(source, 1);
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
      const fields = Object.entries(shape.fields)
        .slice(0, 8)
        .map(([key, field]) => `${key}${field.optional ? '?' : ''}: ${renderShape(field.shape)}`);
      const suffix = shape.additional ? (fields.length > 0 ? ', ...' : '...') : '';
      return `{ ${fields.join(', ')}${suffix} }`;
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
