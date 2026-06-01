import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { TextDocument } from 'vscode-languageserver-textdocument';

import { DocumentValidator } from './validation';
import { WorkspaceManager } from './workspace-manager';

function collectDiagnosticMessages(source: string): string[] {
  const uri = 'file:///test.wp';
  const doc = TextDocument.create(uri, 'webpipe', 1, source);
  const documents = new Map<string, TextDocument>([[uri, doc]]);
  const workspace = new WorkspaceManager(
    { log() {}, error() {} },
    { get: (documentUri: string) => documents.get(documentUri) },
    '/'
  );
  const validator = new DocumentValidator(workspace);

  return validator.collectDiagnostics(doc).map(diagnostic => diagnostic.message);
}

test('algraf aliases are recognized as built-in middleware steps', () => {
  const messages = collectDiagnosticMessages(`
GET /svg/ag
  |> jq: \`{ rows: [] }\`
  |> ag({"type":"svg"}): \`Chart(data: input) {}\`

GET /svg/algraf
  |> jq: \`{ rows: [] }\`
  |> algraf({"type":"svg"}): \`Chart(data: input) {}\`
`);

  assert.equal(messages.some(message => message.includes("Unknown step 'ag'")), false);
  assert.equal(messages.some(message => message.includes("Unknown step 'algraf'")), false);
});

test('ag variable declarations are recognized as built-in middleware variables', () => {
  const messages = collectDiagnosticMessages(`
ag weatherChart = \`Chart(data: input) {}\`

GET /svg/ag-variable
  |> jq: \`{ rows: [] }\`
  |> ag: weatherChart
`);

  assert.equal(messages.some(message => message.includes("Unknown variable type 'ag'")), false);
  assert.equal(messages.some(message => message.includes('Unknown ag variable')), false);
});
