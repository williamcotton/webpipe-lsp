import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  extractJqVariables,
  extractJqVariablesExcludingGraphQL,
} from './test-variable-utils';

test('extractJqVariables ignores dollar signs inside quoted strings', () => {
  const refs = extractJqVariables(
    '{ "query": "query($g:String){books(genre:$g){id}}", "variables": { "genre": "x" } }',
    0
  );

  assert.deepEqual(refs, []);
});

test('extractJqVariables still finds real jq variables outside strings', () => {
  const refs = extractJqVariables('{ genre: $g, literal: "query($g)" }', 12);

  assert.deepEqual(refs, [
    {
      name: 'g',
      start: 21,
      end: 23,
    },
  ]);
});

test('extractJqVariablesExcludingGraphQL ignores GraphQL operation variables', () => {
  const refs = extractJqVariablesExcludingGraphQL(
    '|> graphql: `query($id: ID!) { user(id: $id) { id } }`',
    0
  );

  assert.deepEqual(refs, []);
});
