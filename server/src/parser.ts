/*
  WebPipe DSL Parser (recursive-descent)
  - Ported from the Rust nom-based parser in `webpipe-lsp/mod.rs`
  - Best-effort parsing: skips unknown lines and continues
  - Designed for LSP use (no throwing on minor errors)
*/

// ==== AST Types (mirroring Rust structures) ====

export interface Program {
  configs: Config[];
  pipelines: NamedPipeline[];
  variables: Variable[];
  routes: Route[];
  describes: Describe[];
}

export interface Config {
  name: string;
  properties: ConfigProperty[];
}

export interface ConfigProperty {
  key: string;
  value: ConfigValue;
}

export type ConfigValue =
  | { kind: 'String'; value: string }
  | { kind: 'EnvVar'; var: string; default?: string }
  | { kind: 'Boolean'; value: boolean }
  | { kind: 'Number'; value: number };

export interface NamedPipeline {
  name: string;
  pipeline: Pipeline;
}

export interface Variable {
  varType: string;
  name: string;
  value: string;
}

export interface Route {
  method: string;
  path: string;
  pipeline: PipelineRef;
}

export type PipelineRef =
  | { kind: 'Inline'; pipeline: Pipeline }
  | { kind: 'Named'; name: string };

export interface Pipeline {
  steps: PipelineStep[];
}

export type PipelineStep =
  | { kind: 'Regular'; name: string; config: string }
  | { kind: 'Result'; branches: ResultBranch[] };

export interface ResultBranch {
  branchType: ResultBranchType;
  statusCode: number;
  pipeline: Pipeline;
}

export type ResultBranchType =
  | { kind: 'Ok' }
  | { kind: 'Custom'; name: string }
  | { kind: 'Default' };

export interface Describe {
  name: string;
  mocks: Mock[];
  tests: It[];
}

export interface Mock {
  target: string;
  returnValue: string;
}

export interface It {
  name: string;
  mocks: Mock[];
  when: When;
  input?: string;
  conditions: Condition[];
}

export type When =
  | { kind: 'CallingRoute'; method: string; path: string }
  | { kind: 'ExecutingPipeline'; name: string }
  | { kind: 'ExecutingVariable'; varType: string; name: string };

export interface Condition {
  conditionType: 'Then' | 'And';
  field: string;
  jqExpr?: string;
  comparison: string;
  value: string;
}

export type DiagnosticSeverity = 'error' | 'warning' | 'info';
export interface ParseDiagnostic {
  message: string;
  start: number;
  end: number;
  severity: DiagnosticSeverity;
}

// ==== Parser Implementation ====

class Parser {
  private readonly text: string;
  private readonly len: number;
  private pos: number = 0;
  private diagnostics: ParseDiagnostic[] = [];
  private readonly pipelineRanges: Map<string, { start: number; end: number }> = new Map();
  private readonly variableRanges: Map<string, { start: number; end: number }> = new Map();

  constructor(text: string) {
    this.text = text;
    this.len = text.length;
  }

  // Diagnostics helpers
  getDiagnostics(): ParseDiagnostic[] {
    return this.diagnostics.slice();
  }

  getPipelineRanges(): Map<string, { start: number; end: number }> {
    return new Map(this.pipelineRanges);
  }

  getVariableRanges(): Map<string, { start: number; end: number }> {
    return new Map(this.variableRanges);
  }

  report(message: string, start: number, end: number, severity: DiagnosticSeverity): void {
    this.diagnostics.push({ message, start, end, severity });
  }

  findLineStart(pos: number): number {
    let i = Math.max(0, Math.min(pos, this.len));
    while (i > 0 && this.text[i - 1] !== '\n') i--;
    return i;
  }

  findLineEnd(pos: number): number {
    let i = Math.max(0, Math.min(pos, this.len));
    while (i < this.text.length && this.text[i] !== '\n') i++;
    return i;
  }

  // Entry point
  parseProgram(): Program {
    this.skipSpaces();

    const configs: Config[] = [];
    const pipelines: NamedPipeline[] = [];
    const variables: Variable[] = [];
    const routes: Route[] = [];
    const describes: Describe[] = [];

    while (!this.eof()) {
      this.skipSpaces();
      if (this.eof()) break;

      const start = this.pos;

      const cfg = this.tryParse(() => this.parseConfig());
      if (cfg) {
        configs.push(cfg);
        continue;
      }

      const namedPipe = this.tryParse(() => this.parseNamedPipeline());
      if (namedPipe) {
        pipelines.push(namedPipe);
        continue;
      }

      const variable = this.tryParse(() => this.parseVariable());
      if (variable) {
        variables.push(variable);
        continue;
      }

      const route = this.tryParse(() => this.parseRoute());
      if (route) {
        routes.push(route);
        continue;
      }

      const describe = this.tryParse(() => this.parseDescribe());
      if (describe) {
        describes.push(describe);
        continue;
      }

      // Fallback: report and skip to end of line to avoid infinite loop
      if (this.pos === start) {
        const lineStart = this.findLineStart(this.pos);
        const lineEnd = this.findLineEnd(this.pos);
        this.report('Unrecognized or unsupported syntax', lineStart, lineEnd, 'warning');
        this.skipToEol();
        this.consumeWhile((c) => c === '\n');
      }
    }
    // Simple unmatched backtick detection
    const backtickCount = (this.text.match(/`/g) || []).length;
    if (backtickCount % 2 === 1) {
      const idx = this.text.lastIndexOf('`');
      const start = Math.max(0, idx);
      this.report('Unclosed backtick-delimited string', start, start + 1, 'warning');
    }

    return { configs, pipelines, variables, routes, describes };
  }

  // ---- Helpers ----
  private eof(): boolean { return this.pos >= this.len; }
  private peek(): string { return this.text[this.pos] ?? '\0'; }
  private cur(): string { return this.text[this.pos] ?? '\0'; }
  private ahead(n: number): string { return this.text[this.pos + n] ?? '\0'; }

  private tryParse<T>(fn: () => T): T | null {
    const save = this.pos;
    try {
      const value = fn();
      return value;
    } catch (_e) {
      this.pos = save;
      return null;
    }
  }

  private skipSpaces(): void {
    this.consumeWhile((ch) => ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n');
  }

  private skipInlineSpaces(): void {
    this.consumeWhile((ch) => ch === ' ' || ch === '\t' || ch === '\r');
  }

  private consumeWhile(pred: (ch: string) => boolean): string {
    const start = this.pos;
    while (!this.eof() && pred(this.text[this.pos])) this.pos++;
    return this.text.slice(start, this.pos);
  }

  private match(str: string): boolean {
    if (this.text.startsWith(str, this.pos)) {
      this.pos += str.length;
      return true;
    }
    return false;
  }

  private expect(str: string): void {
    if (!this.match(str)) throw new ParseFailure(`expected '${str}'`, this.pos);
  }

  private skipToEol(): void {
    while (!this.eof() && this.cur() !== '\n') this.pos++;
  }

  private isIdentStart(ch: string): boolean {
    return /[A-Za-z_]/.test(ch);
  }

  private isIdentCont(ch: string): boolean {
    return /[A-Za-z0-9_\-]/.test(ch);
  }

  private parseIdentifier(): string {
    if (!this.isIdentStart(this.cur())) throw new ParseFailure('identifier', this.pos);
    const start = this.pos;
    this.pos++;
    while (!this.eof() && this.isIdentCont(this.cur())) this.pos++;
    return this.text.slice(start, this.pos);
  }

  private parseNumber(): number {
    const start = this.pos;
    const digits = this.consumeWhile((c) => /[0-9]/.test(c));
    if (digits.length === 0) throw new ParseFailure('number', this.pos);
    return parseInt(this.text.slice(start, this.pos), 10);
  }

  private parseQuotedString(): string {
    this.expect('"');
    const start = this.pos;
    while (!this.eof()) {
      const ch = this.cur();
      if (ch === '"') break;
      // allow any char including newlines until closing quote on same line
      this.pos++;
    }
    const content = this.text.slice(start, this.pos);
    this.expect('"');
    return content;
  }

  private parseBacktickString(): string {
    this.expect('`');
    const start = this.pos;
    while (!this.eof()) {
      const ch = this.cur();
      if (ch === '`') break;
      this.pos++;
    }
    const content = this.text.slice(start, this.pos);
    this.expect('`');
    return content;
  }

  private parseMethod(): string {
    const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
    for (const m of methods) {
      if (this.text.startsWith(m, this.pos)) {
        this.pos += m.length;
        return m;
      }
    }
    throw new ParseFailure('method', this.pos);
  }

  // Step configuration: backticks, quotes, or bare identifier
  private parseStepConfig(): string {
    const bt = this.tryParse(() => this.parseBacktickString());
    if (bt !== null) return bt;
    const dq = this.tryParse(() => this.parseQuotedString());
    if (dq !== null) return dq;
    const id = this.tryParse(() => this.parseIdentifier());
    if (id !== null) return id;
    throw new ParseFailure('step-config', this.pos);
  }

  // ---- Config parsing ----
  private parseConfigValue(): ConfigValue {
    // Env with default: $VAR || "default"
    const envWithDefault = this.tryParse(() => {
      this.expect('$');
      const variable = this.parseIdentifier();
      this.skipInlineSpaces();
      this.expect('||');
      this.skipInlineSpaces();
      const def = this.parseQuotedString();
      return { kind: 'EnvVar', var: variable, default: def } as ConfigValue;
    });
    if (envWithDefault) return envWithDefault;

    // Env without default: $VAR
    const envNoDefault = this.tryParse(() => {
      this.expect('$');
      const variable = this.parseIdentifier();
      return { kind: 'EnvVar', var: variable } as ConfigValue;
    });
    if (envNoDefault) return envNoDefault;

    const str = this.tryParse(() => this.parseQuotedString());
    if (str !== null) return { kind: 'String', value: str };

    const bool = this.tryParse(() => {
      if (this.match('true')) return true;
      if (this.match('false')) return false;
      throw new ParseFailure('bool', this.pos);
    });
    if (bool !== null) return { kind: 'Boolean', value: bool };

    const num = this.tryParse(() => this.parseNumber());
    if (num !== null) return { kind: 'Number', value: num };

    throw new ParseFailure('config-value', this.pos);
  }

  private parseConfigProperty(): ConfigProperty {
    this.skipSpaces();
    const key = this.parseIdentifier();
    this.skipInlineSpaces();
    this.expect(':');
    this.skipInlineSpaces();
    const value = this.parseConfigValue();
    return { key, value };
  }

  private parseConfig(): Config {
    this.expect('config');
    this.skipInlineSpaces();
    const name = this.parseIdentifier();
    this.skipInlineSpaces();
    this.expect('{');
    this.skipSpaces();
    const properties: ConfigProperty[] = [];
    while (true) {
      const prop = this.tryParse(() => this.parseConfigProperty());
      if (!prop) break;
      properties.push(prop);
      this.skipSpaces();
    }
    this.skipSpaces();
    this.expect('}');
    this.skipSpaces();
    return { name, properties };
  }

  // ---- Pipeline parsing ----
  private parsePipelineStep(): PipelineStep {
    // result step first
    const result = this.tryParse(() => this.parseResultStep());
    if (result) return result;
    return this.parseRegularStep();
  }

  private parseRegularStep(): PipelineStep {
    this.skipSpaces();
    this.expect('|>');
    this.skipInlineSpaces();
    const name = this.parseIdentifier();
    this.expect(':');
    this.skipInlineSpaces();
    const config = this.parseStepConfig();
    this.skipSpaces();
    return { kind: 'Regular', name, config };
  }

  private parseResultStep(): PipelineStep {
    this.skipSpaces();
    this.expect('|>');
    this.skipInlineSpaces();
    this.expect('result');
    this.skipSpaces();
    const branches: ResultBranch[] = [];
    while (true) {
      const br = this.tryParse(() => this.parseResultBranch());
      if (!br) break;
      branches.push(br);
    }
    return { kind: 'Result', branches };
  }

  private parseResultBranch(): ResultBranch {
    this.skipSpaces();
    const branchIdent = this.parseIdentifier();
    let branchType: ResultBranchType;
    if (branchIdent === 'ok') branchType = { kind: 'Ok' };
    else if (branchIdent === 'default') branchType = { kind: 'Default' };
    else branchType = { kind: 'Custom', name: branchIdent };
    this.expect('(');
    const statusCode = this.parseNumber();
    if (statusCode < 100 || statusCode > 599) {
      this.report(`Invalid HTTP status code: ${statusCode}`,
        this.pos - String(statusCode).length,
        this.pos,
        'error');
    }
    this.expect(')');
    this.expect(':');
    this.skipSpaces();
    const pipeline = this.parsePipeline();
    return { branchType, statusCode, pipeline };
  }

  private parsePipeline(): Pipeline {
    const steps: PipelineStep[] = [];
    while (true) {
      const save = this.pos;
      this.skipSpaces();
      if (!this.text.startsWith('|>', this.pos)) {
        this.pos = save;
        break;
      }
      const step = this.parsePipelineStep();
      steps.push(step);
    }
    return { steps };
  }

  private parseNamedPipeline(): NamedPipeline {
    const start = this.pos; // start at 'pipeline'
    this.expect('pipeline');
    this.skipInlineSpaces();
    const name = this.parseIdentifier();
    this.skipInlineSpaces();
    this.expect('=');
    this.skipInlineSpaces();
    const beforePipeline = this.pos;
    const pipeline = this.parsePipeline();
    const end = this.pos; // parsePipeline stops before trailing spaces/comments
    // Record exact range from 'pipeline' through last step
    this.pipelineRanges.set(name, { start, end });
    this.skipSpaces();
    return { name, pipeline };
  }

  private parsePipelineRef(): PipelineRef {
    // Prefer inline pipeline (sequence of steps)
    const inline = this.tryParse(() => this.parsePipeline());
    if (inline && inline.steps.length > 0) return { kind: 'Inline', pipeline: inline };

    // Named pipeline reference: |> pipeline: name
    const named = this.tryParse(() => {
      this.skipSpaces();
      this.expect('|>');
      this.skipInlineSpaces();
      this.expect('pipeline:');
      this.skipInlineSpaces();
      const name = this.parseIdentifier();
      return { kind: 'Named', name } as PipelineRef;
    });
    if (named) return named;
    throw new Error('pipeline-ref');
  }

  // ---- Variable parsing ----
  private parseVariable(): Variable {
    const start = this.pos; // beginning of var type
    const varType = this.parseIdentifier();
    this.skipInlineSpaces();
    const name = this.parseIdentifier();
    this.skipInlineSpaces();
    this.expect('=');
    this.skipInlineSpaces();
    const value = this.parseBacktickString();
    const end = this.pos; // position after closing backtick
    this.variableRanges.set(`${varType}::${name}`, { start, end });
    this.skipSpaces();
    return { varType, name, value };
  }

  // ---- Route parsing ----
  private parseRoute(): Route {
    const method = this.parseMethod();
    this.skipInlineSpaces();
    const path = this.consumeWhile((c) => c !== ' ' && c !== '\n');
    this.skipSpaces();
    const pipeline = this.parsePipelineRef();
    this.skipSpaces();
    return { method, path, pipeline };
  }

  // ---- Test parsing ----
  private parseWhen(): When {
    const calling = this.tryParse(() => {
      this.expect('calling');
      this.skipInlineSpaces();
      const method = this.parseMethod();
      this.skipInlineSpaces();
      const path = this.consumeWhile((c) => c !== '\n');
      return { kind: 'CallingRoute', method, path } as When;
    });
    if (calling) return calling;

    const executingPipeline = this.tryParse(() => {
      this.expect('executing');
      this.skipInlineSpaces();
      this.expect('pipeline');
      this.skipInlineSpaces();
      const name = this.parseIdentifier();
      return { kind: 'ExecutingPipeline', name } as When;
    });
    if (executingPipeline) return executingPipeline;

    const executingVariable = this.tryParse(() => {
      this.expect('executing');
      this.skipInlineSpaces();
      this.expect('variable');
      this.skipInlineSpaces();
      const varType = this.parseIdentifier();
      this.skipInlineSpaces();
      const name = this.parseIdentifier();
      return { kind: 'ExecutingVariable', varType, name } as When;
    });
    if (executingVariable) return executingVariable;

    throw new ParseFailure('when', this.pos);
  }

  private parseCondition(): Condition {
    this.skipSpaces();
    const ct = (() => {
      if (this.match('then')) return 'Then' as const;
      if (this.match('and')) return 'And' as const;
      throw new Error('condition-type');
    })();
    this.skipInlineSpaces();
    const field = this.consumeWhile((c) => c !== ' ' && c !== '\n' && c !== '`');
    this.skipInlineSpaces();
    const jqExpr = this.tryParse(() => this.parseBacktickString());
    this.skipInlineSpaces();
    const comparison = this.consumeWhile((c) => c !== ' ' && c !== '\n');
    this.skipInlineSpaces();
    const value = (() => {
      const v1 = this.tryParse(() => this.parseBacktickString());
      if (v1 !== null) return v1;
      const v2 = this.tryParse(() => this.parseQuotedString());
      if (v2 !== null) return v2;
      return this.consumeWhile((c) => c !== '\n');
    })();
    return { conditionType: ct, field, jqExpr: jqExpr ?? undefined, comparison, value };
  }

  private parseMockHead(prefixWord: 'with' | 'and'): Mock {
    this.skipSpaces();
    this.expect(prefixWord);
    this.skipInlineSpaces();
    this.expect('mock');
    this.skipInlineSpaces();
    const target = this.consumeWhile((c) => c !== ' ' && c !== '\n');
    this.skipInlineSpaces();
    this.expect('returning');
    this.skipInlineSpaces();
    const returnValue = this.parseBacktickString();
    this.skipSpaces();
    return { target, returnValue };
  }

  private parseMock(): Mock {
    return this.parseMockHead('with');
  }
  private parseAndMock(): Mock {
    return this.parseMockHead('and');
  }

  private parseIt(): It {
    this.skipSpaces();
    this.expect('it');
    this.skipInlineSpaces();
    this.expect('"');
    const name = this.consumeWhile((c) => c !== '"');
    this.expect('"');
    this.skipSpaces();

    const mocks: Mock[] = [];
    while (true) {
      const m = this.tryParse(() => this.parseMock());
      if (!m) break;
      mocks.push(m);
    }

    this.expect('when');
    this.skipInlineSpaces();
    const when = this.parseWhen();
    this.skipSpaces();

    const input = this.tryParse(() => {
      this.expect('with');
      this.skipInlineSpaces();
      this.expect('input');
      this.skipInlineSpaces();
      const v = this.parseBacktickString();
      this.skipSpaces();
      return v;
    }) ?? undefined;

    const extraMocks: Mock[] = [];
    while (true) {
      const m = this.tryParse(() => this.parseAndMock());
      if (!m) break;
      extraMocks.push(m);
      this.skipSpaces();
    }

    const conditions: Condition[] = [];
    while (true) {
      const c = this.tryParse(() => this.parseCondition());
      if (!c) break;
      conditions.push(c);
    }

    return { name, mocks: [...mocks, ...extraMocks], when, input, conditions };
  }

  private parseDescribe(): Describe {
    this.skipSpaces();
    this.expect('describe');
    this.skipInlineSpaces();
    this.expect('"');
    const name = this.consumeWhile((c) => c !== '"');
    this.expect('"');
    this.skipSpaces();

    const mocks: Mock[] = [];
    while (true) {
      const m = this.tryParse(() => this.parseMock());
      if (!m) break;
      mocks.push(m);
      this.skipSpaces();
    }

    const tests: It[] = [];
    while (true) {
      const it = this.tryParse(() => this.parseIt());
      if (!it) break;
      tests.push(it);
    }

    return { name, mocks, tests };
  }
}

// Public API
export function parseProgram(text: string): Program {
  const parser = new Parser(text);
  return parser.parseProgram();
}

export function parseProgramWithDiagnostics(text: string): { program: Program; diagnostics: ParseDiagnostic[] } {
  const parser = new Parser(text);
  const program = parser.parseProgram();
  return { program, diagnostics: parser.getDiagnostics() };
}

// Helper APIs to fetch ranges without changing existing parse outputs
export function getPipelineRanges(text: string): Map<string, { start: number; end: number }> {
  const parser = new Parser(text);
  parser.parseProgram();
  return parser.getPipelineRanges();
}

export function getVariableRanges(text: string): Map<string, { start: number; end: number }> {
  const parser = new Parser(text);
  parser.parseProgram();
  return parser.getVariableRanges();
}

class ParseFailure extends Error {
  constructor(message: string, public at: number) {
    super(message);
  }
}

