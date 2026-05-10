import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { DiagnosticSeverity } from 'vscode-languageserver/node';
import { parseProgram } from 'webpipe-js';

import { checkProgramTypes } from './type-checker';

interface TypeDiagnostic {
  severity: DiagnosticSeverity;
  start: number;
  end: number;
  message: string;
}

function collectTypeDiagnosticDetails(source: string): TypeDiagnostic[] {
  const diagnostics: TypeDiagnostic[] = [];

  checkProgramTypes(parseProgram(source), (severity: DiagnosticSeverity, start: number, end: number, message: string) => {
    diagnostics.push({ severity, start, end, message });
  });

  return diagnostics;
}

function collectTypeDiagnostics(source: string): string[] {
  return collectTypeDiagnosticDetails(source).map(diagnostic => diagnostic.message);
}

test('non-terminal jq transforms preserve route context for later stages', () => {
  const messages = collectTypeDiagnostics(`
GET /weather/:city
  |> jq: \`{
    fetchUrl: "https://api.open-meteo.com/v1/forecast?current_weather=true",
    fetchMethod: "GET"
  }\`
  |> fetch: \`_\` @async(openmeteo)
  |> jq: \`{
    fetchUrl: "https://goweather.herokuapp.com/weather/" + .params.city,
    fetchMethod: "GET"
  }\`
`);

  assert.equal(
    messages.some(message => message.includes('.params.city may be missing')),
    false
  );
});

test('jq variable references are analyzed as filters, not jq calls', () => {
  const messages = collectTypeDiagnostics(`
jq weatherData = \`{
  "hourly": {
    "time": ["2026-01-09T00:00"],
    "temperature_2m": [-4.2]
  }
}\`

GET /svg/weather
  |> jq: weatherData
  |> jq: \`
    .hourly as $h |
    [$h.time, $h.temperature_2m] | transpose | map({time: .[0], temp: .[1]})
  \`
`);

  assert.equal(
    messages.some(message => message.includes('unsupported builtin or call `weatherData`')),
    false
  );
});

test('result error branches expose the matching error envelope', () => {
  const messages = collectTypeDiagnostics(`
GET /test-sql-error
  |> jq: \`{ sqlParams: [] }\`
  |> pg: \`SELECT * FROM nonexistent_table\`
  |> result
    sqlError(500):
      |> jq: \`{
        sqlstate: .errors[0].sqlstate,
        message: .errors[0].message,
        query: .errors[0].query
      }\`
`);

  assert.equal(
    messages.some(message => message.includes('.errors[0]')),
    false
  );
});

test('$context references are treated as jq external variables', () => {
  const messages = collectTypeDiagnostics(`
GET /test-context-ratelimit
  |> rateLimit: \`keyTemplate: context-test, limit: 100, window: 1m\`
  |> jq: \`{
    allowed: $context.rate_limit.allowed,
    flag_count: ($context.flags | length)
  }\`
`);

  assert.equal(
    messages.some(message => message.includes('$context') || message.includes('.rate_limit')),
    false
  );
});

test('pipeline shorthand arguments refine the called pipeline input', () => {
  const messages = collectTypeDiagnostics(`
pipeline getSugarParams =
  |> jq: \`{ test: .params[0] }\`

GET /pipeline-sugar/params/:id
  |> getSugarParams({ params: [.params.id] })
`);

  assert.equal(
    messages.some(message => message.includes('array index may be applied to non-array input')),
    false
  );
});

test('explicit resultName takes precedence over variable auto-naming', () => {
  const messages = collectTypeDiagnostics(`
pg getUserInfo = \`SELECT 1 as id, 'Test User' as name\`

GET /precedence/test
  |> jq: \`{ resultName: "explicitName" }\`
  |> pg: getUserInfo
  |> jq: \`{ hasExplicit: (.data.explicitName != null) }\`
`);

  assert.equal(
    messages.some(message => message.includes('.data.explicitName may be missing')),
    false
  );
});

test('root access diagnostics start at the dot inside quoted jq content', () => {
  const source = `
GET /type-checking/span-error
  |> jq: \`{ data: { rows: [] } }\`
  |> jq: \`{ value: .data[0].rows }\`
`;
  const diagnostic = collectTypeDiagnosticDetails(source)
    .find(item => item.message.startsWith('Type error: .data[0].rows may be missing'));

  assert.ok(diagnostic);
  assert.equal(diagnostic.start, source.indexOf('.data[0].rows'));
});

test('assert contracts refine backpack state without dropping route params', () => {
  const messages = collectTypeDiagnostics(`
assert WeatherResponse = \`{
  async: {
    openmeteo: {
      data: {
        response: {
          current_weather: {
            temperature: number
          }
        }
      }
    }
  }
}\`

GET /weather/:city
  |> jq: \`{ fetchUrl: "https://example.com", fetchMethod: "GET" }\`
  |> assert: WeatherResponse
  |> jq: \`{ city: .params.city, temperature: .async.openmeteo.data.response.current_weather.temperature }\`
`);

  assert.equal(
    messages.some(message => message.includes('property "params" is not present') || message.includes('.params.city may be missing')),
    false
  );
});

test('jqtype missing-property diagnostics suppress duplicate pipeline missing-field errors', () => {
  const messages = collectTypeDiagnostics(`
GET /hello/:world
  |> jq: \`{ world: .params.wrld }\`
  |> handlebars: \`<p>hello, {{world}}</p>\`
`);

  assert.equal(
    messages.filter(message => message.includes('wrld')).length,
    1
  );
  assert.equal(
    messages.some(message => message.includes('Type error: .params.wrld may be missing')),
    false
  );
  assert.equal(
    messages.some(message => message.includes('property "wrld" is not present')),
    true
  );
});
