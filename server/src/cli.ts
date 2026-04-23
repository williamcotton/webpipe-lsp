#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';
import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { DocumentValidator } from './validation';
import { DocumentLookup, LoggerLike, WorkspaceManager } from './workspace-manager';

interface CliOptions {
  command: 'check';
  filePath: string;
  json: boolean;
  workspaceRoot: string;
}

class StaticDocumentStore implements DocumentLookup {
  private readonly docs = new Map<string, TextDocument>();

  set(doc: TextDocument): void {
    this.docs.set(doc.uri, doc);
  }

  get(uri: string): TextDocument | undefined {
    return this.docs.get(uri);
  }
}

const silentLogger: LoggerLike = {
  log: () => {},
  error: () => {}
};

function usage(): string {
  return [
    'Usage:',
    '  webpipe-lsp check <file.wp> [--json] [--workspace-root <dir>]',
    '  webpipe-lsp <file.wp> [--json] [--workspace-root <dir>]',
    '',
    'Options:',
    '  --json                 Print machine-readable diagnostics JSON',
    '  --workspace-root DIR   Override workspace root (defaults to cwd)',
    '  -h, --help             Show this help',
  ].join('\n');
}

function parseArgs(argv: string[]): CliOptions {
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
    console.log(usage());
    process.exit(0);
  }

  let command: 'check' = 'check';
  let filePath: string | undefined;
  let json = false;
  let workspaceRoot = process.cwd();

  let index = 0;
  if (argv[0] === 'check') {
    index = 1;
  }

  while (index < argv.length) {
    const arg = argv[index];

    if (arg === '--json') {
      json = true;
      index += 1;
      continue;
    }

    if (arg === '--workspace-root') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('Missing value for --workspace-root');
      }
      workspaceRoot = value;
      index += 2;
      continue;
    }

    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    }

    if (!filePath) {
      filePath = arg;
      index += 1;
      continue;
    }

    throw new Error(`Unexpected argument: ${arg}`);
  }

  if (!filePath) {
    throw new Error('Missing .wp file path');
  }

  return {
    command,
    filePath,
    json,
    workspaceRoot
  };
}

function severityName(severity: DiagnosticSeverity | undefined): string {
  switch (severity) {
    case DiagnosticSeverity.Error:
      return 'error';
    case DiagnosticSeverity.Warning:
      return 'warning';
    case DiagnosticSeverity.Information:
      return 'information';
    case DiagnosticSeverity.Hint:
      return 'hint';
    default:
      return 'information';
  }
}

function summarizeDiagnostics(diagnostics: Diagnostic[]): Record<string, number> {
  return diagnostics.reduce<Record<string, number>>((counts, diagnostic) => {
    const key = severityName(diagnostic.severity);
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, { error: 0, warning: 0, information: 0, hint: 0 });
}

function toPrintablePath(filePath: string): string {
  const relative = path.relative(process.cwd(), filePath);
  if (!relative || relative.startsWith('..')) {
    return filePath;
  }
  return relative;
}

function formatHuman(filePath: string, diagnostics: Diagnostic[]): string {
  const lines: string[] = [];
  const displayPath = toPrintablePath(filePath);

  if (diagnostics.length === 0) {
    return `No diagnostics for ${displayPath}`;
  }

  const sorted = diagnostics.slice().sort((left, right) => {
    if (left.range.start.line !== right.range.start.line) {
      return left.range.start.line - right.range.start.line;
    }
    if (left.range.start.character !== right.range.start.character) {
      return left.range.start.character - right.range.start.character;
    }
    return severityName(left.severity).localeCompare(severityName(right.severity));
  });

  for (const diagnostic of sorted) {
    const line = diagnostic.range.start.line + 1;
    const column = diagnostic.range.start.character + 1;
    lines.push(
      `${displayPath}:${line}:${column}: ${severityName(diagnostic.severity)}: ${diagnostic.message}`
    );
  }

  const counts = summarizeDiagnostics(diagnostics);
  lines.push('');
  lines.push(
    `Summary: ${counts.error} error(s), ${counts.warning} warning(s), ${counts.information} info message(s), ${counts.hint} hint(s)`
  );

  return lines.join('\n');
}

function formatJson(filePath: string, diagnostics: Diagnostic[]): string {
  const payload = {
    file: filePath,
    counts: summarizeDiagnostics(diagnostics),
    diagnostics: diagnostics.map((diagnostic) => ({
      severity: severityName(diagnostic.severity),
      message: diagnostic.message,
      source: diagnostic.source ?? 'webpipe-lsp',
      start: {
        line: diagnostic.range.start.line + 1,
        column: diagnostic.range.start.character + 1
      },
      end: {
        line: diagnostic.range.end.line + 1,
        column: diagnostic.range.end.character + 1
      }
    }))
  };

  return JSON.stringify(payload, null, 2);
}

async function checkFile(options: CliOptions): Promise<number> {
  const absoluteFilePath = path.resolve(options.filePath);
  const absoluteWorkspaceRoot = path.resolve(options.workspaceRoot);

  if (!fs.existsSync(absoluteFilePath)) {
    throw new Error(`File not found: ${absoluteFilePath}`);
  }

  const text = fs.readFileSync(absoluteFilePath, 'utf8');
  const uri = URI.file(absoluteFilePath).toString();
  const doc = TextDocument.create(uri, 'webpipe', 1, text);

  const documents = new StaticDocumentStore();
  documents.set(doc);

  const workspace = new WorkspaceManager(
    silentLogger,
    documents,
    URI.file(absoluteWorkspaceRoot).toString()
  );
  const validator = new DocumentValidator(workspace);
  const diagnostics = validator.collectDiagnostics(doc);

  if (options.json) {
    console.log(formatJson(absoluteFilePath, diagnostics));
  } else {
    console.log(formatHuman(absoluteFilePath, diagnostics));
  }

  return diagnostics.some((diagnostic) => diagnostic.severity === DiagnosticSeverity.Error) ? 1 : 0;
}

async function main(): Promise<void> {
  let options: CliOptions;

  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    console.error('');
    console.error(usage());
    process.exit(2);
    return;
  }

  try {
    const exitCode = await checkFile(options);
    process.exit(exitCode);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) {
      console.error(JSON.stringify({ error: message }, null, 2));
    } else {
      console.error(`webpipe-lsp: ${message}`);
    }
    process.exit(2);
  }
}

void main();
