import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { DiagnosticSeverity } from 'vscode-languageserver/node';
import { parseProgram } from 'webpipe-js';

import { checkProgramTypes } from './type-checker';
import type { TypeCheckOptions } from './type-checker';

interface TypeDiagnostic {
  severity: DiagnosticSeverity;
  start: number;
  end: number;
  message: string;
}

function collectTypeDiagnosticDetails(source: string, options?: TypeCheckOptions): TypeDiagnostic[] {
  const diagnostics: TypeDiagnostic[] = [];

  checkProgramTypes(parseProgram(source), (severity: DiagnosticSeverity, start: number, end: number, message: string) => {
    diagnostics.push({ severity, start, end, message });
  }, options);

  return diagnostics;
}

function collectTypeDiagnostics(source: string, options?: TypeCheckOptions): string[] {
  return collectTypeDiagnosticDetails(source, options).map(diagnostic => diagnostic.message);
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

test('result error branches do not open known input shapes to arbitrary fields', () => {
  const source = `
GET /signal/:city
  |> jq: \`{ city: .params.city }\`
  |> fetch("https://example.test/" + (.city | tostring))
  |> result
    networkError(200):
      |> jq: \`{ city: .cityNonExistant, source: "offline" }\`
`;
  const diagnostic = collectTypeDiagnosticDetails(source)
    .find(item => item.message.includes('cityNonExistant'));

  assert.ok(diagnostic);
  assert.equal(source.slice(diagnostic.start, diagnostic.end), '.cityNonExistant');
});

test('GraphQL loader target pipelines are type checked', () => {
  const messages = collectTypeDiagnostics(`
graphqlSchema = \`
  type Team { id: ID!, name: String! }
  type Launch { ownerId: ID!, owner: Team }
  type Query { launches: [Launch!]! }
\`

pipeline TeamByIdLoader =
  |> jq: \`
    reduce (.keys // [])[] as $key (
      {};
      .[$key] = ($teamsNonExistant[] // null)
    )
  \`

resolver Launch.owner =
  |> loader(.parent.ownerId): TeamByIdLoader
`);

  assert.equal(
    messages.some(message => message.includes('$teamsNonExistant')),
    true
  );
});

test('GraphQL loader target pipelines are checked with loader data shape', () => {
  const messages = collectTypeDiagnostics(`
graphqlSchema = \`
  type Team { id: ID!, name: String! }
  type Launch { ownerId: ID!, owner: Team }
  type Query { launches: [Launch!]! }
\`

pipeline seedTeams =
  |> jq: \`{ teams: [{ id: 1, name: "Platform" }] }\`

pipeline TeamByIdLoader =
  |> seedTeams
  |> jq: \`{ keys: .keysNonExistant, teams: .teams }\`

resolver Launch.owner =
  |> loader(.parent.ownerId): TeamByIdLoader
`);

  assert.equal(
    messages.some(message => message.includes('keysNonExistant')),
    true
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

test('middleware arguments are checked against the current pipeline shape', () => {
  const source = `
GET /gql/user/:id/todos
  |> jq: \`{ targetNumber: (.params.id | tonumber) }\`
  |> graphql({ userId: .targetId }): \`
    query($userId: ID!) {
      user(id: $userId) { name email }
    }
  \`
  |> jq: \`.\`
`;
  const diagnostic = collectTypeDiagnosticDetails(source)
    .find(item => item.message.includes('.targetId may be missing') && item.message.includes('graphql arguments'));

  assert.ok(diagnostic);
  assert.equal(source.slice(diagnostic.start, diagnostic.end), '.targetId');
});

test('middleware arguments accept fields produced by previous stages', () => {
  const messages = collectTypeDiagnostics(`
GET /gql/user/:id/todos
  |> jq: \`{ targetId: (.params.id | tonumber) }\`
  |> graphql({ userId: .targetId }): \`
    query($userId: ID!) {
      user(id: $userId) { name email }
    }
  \`
  |> jq: \`.\`
`);

  assert.equal(
    messages.some(message => message.includes('.targetId may be missing')),
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

test('handlebars diagnostics point at missing inline template properties', () => {
  const source = `
GET /hello/:world
  |> jq: \`{ world: .params.world }\`
  |> handlebars: \`<p>hello, {{wrld}}</p>\`
`;
  const diagnostic = collectTypeDiagnosticDetails(source)
    .find(item => item.message.includes('Handlebars type check') && item.message.includes('wrld'));

  assert.ok(diagnostic);
  assert.equal(source.slice(diagnostic.start, diagnostic.end), 'wrld');
});

test('handlebars variable diagnostics point at the template use site', () => {
  const source = `
handlebars greeting = \`<p>hello, {{name}}</p>\`

GET /hello
  |> jq: \`{ world: "Ada" }\`
  |> handlebars: greeting
`;
  const diagnostic = collectTypeDiagnosticDetails(source)
    .find(item => item.message.includes("Handlebars template 'greeting' used here has type error"));

  assert.ok(diagnostic);
  assert.equal(source.slice(diagnostic.start, diagnostic.end), 'greeting');
});

test('handlebars partial diagnostics use each item context', () => {
  const messages = collectTypeDiagnostics(`
handlebars todoItem = \`<li>{{title}}</li>\`

GET /todos
  |> jq: \`{ todos: [{ title: "Ship it" }] }\`
  |> handlebars: \`<ul>{{#each todos}}{{> todoItem}}{{/each}}</ul>\`
`);

  assert.equal(
    messages.some(message => message.includes('Handlebars') && message.includes('title')),
    false
  );
});

test('handlebars parser handles block params and helper arguments', () => {
  const messages = collectTypeDiagnostics(`
GET /todos
  |> jq: \`{ todos: [{ title: "Ship it", created_at: "today" }] }\`
  |> handlebars: \`
    {{#each todos as |todo|}}
      {{formatDate todo.created_at}}
      {{todo.title}}
    {{/each}}
  \`
`);

  assert.equal(
    messages.some(message => message.includes('Handlebars') && (message.includes('todo') || message.includes('formatDate'))),
    false
  );
});

test('named pipeline handlebars diagnostics stay on the definition after local shape materializes', () => {
  const source = `
pipeline renderGreeting =
  |> jq: \`{ name: "Ada" }\`
  |> handlebars: \`<p>hello, {{nam}}</p>\`

GET /hello
  |> renderGreeting
`;
  const diagnostics = collectTypeDiagnosticDetails(source);
  const diagnostic = diagnostics.find(item => item.message.includes('Handlebars type check') && item.message.includes('nam'));

  assert.ok(diagnostic);
  assert.equal(
    diagnostics.some(item => item.message.includes("Pipeline 'renderGreeting' called here") && item.message.includes('nam')),
    false
  );
  assert.equal(source.slice(diagnostic.start, diagnostic.end), 'nam');
});

test('named pipeline handlebars input diagnostics point at the invalid call site', () => {
  const source = `
pipeline renderGreeting =
  |> handlebars: \`<p>hello, {{name}}</p>\`

GET /hello
  |> jq: \`{ world: "Ada" }\`
  |> renderGreeting
`;
  const diagnostic = collectTypeDiagnosticDetails(source)
    .find(item => item.message.includes("Pipeline 'renderGreeting' called here has type error") && item.message.includes('name'));

  assert.ok(diagnostic);
  assert.equal(diagnostic.start, source.lastIndexOf('renderGreeting'));
});

test('strict mode flags pg rows consumed without assert', () => {
  const messages = collectTypeDiagnostics(`
GET /teams
  |> jq: \`{ sqlParams: [] }\`
  |> pg: \`SELECT * FROM teams\`
  |> jq: \`{ names: .data.rows | map(.name) }\`
`, { mode: 'strict' });

  assert.equal(
    messages.some(message => message.includes('Strict type error') && message.includes('unasserted pg result')),
    true
  );
});

test('loose mode still allows pg rows without assert', () => {
  const messages = collectTypeDiagnostics(`
GET /teams
  |> jq: \`{ sqlParams: [] }\`
  |> pg: \`SELECT * FROM teams\`
  |> jq: \`{ names: .data.rows | map(.name) }\`
`);

  assert.equal(
    messages.some(message => message.includes('Strict type error')),
    false
  );
});

test('strict mode accepts pg rows after assert and jqtype checks asserted fields', () => {
  const messages = collectTypeDiagnostics(`
assert TeamsPageState = \`{
  data: {
    rows: [{ id: string, name: string }],
    rowCount: number
  }
}\`

GET /teams
  |> jq: \`{ sqlParams: [] }\`
  |> pg: \`SELECT * FROM teams\`
  |> assert: TeamsPageState
  |> jq: \`{ names: .data.rows | map(.namei) }\`
`, { mode: 'strict' });

  assert.equal(
    messages.some(message => message.includes('Strict type error')),
    false
  );
  assert.equal(
    messages.some(message => message.includes('property "namei" is not present')),
    true
  );
});

test('strict mode allows known pg rowCount without asserting row fields', () => {
  const messages = collectTypeDiagnostics(`
GET /teams/count
  |> jq: \`{ sqlParams: [] }\`
  |> pg: \`SELECT * FROM teams\`
  |> jq: \`{ count: .data.rowCount }\`
`, { mode: 'strict' });

  assert.equal(
    messages.some(message => message.includes('Strict type error')),
    false
  );
});

test('strict mode flags route exit with unasserted fetch response', () => {
  const messages = collectTypeDiagnostics(`
GET /proxy
  |> jq: \`{ fetchUrl: "https://example.com", fetchMethod: "GET" }\`
  |> fetch: \`_\`
`, { mode: 'strict' });

  assert.equal(
    messages.some(message => message.includes('route returns') && message.includes('unasserted fetch response')),
    true
  );
});

test('strict mode accepts fetch async join after assert', () => {
  const messages = collectTypeDiagnostics(`
assert JoinedState = \`{
  async: {
    user: {
      data: {
        response: {
          id: string,
          login: string
        }
      }
    }
  }
}\`

GET /dashboard/:id
  |> jq: \`{ fetchUrl: "https://example.com/users/" + .params.id, fetchMethod: "GET" }\`
  |> fetch: \`_\` @async(user)
  |> join: \`user\`
  |> assert: JoinedState
  |> jq: \`{ login: .async.user.data.response.login }\`
`, { mode: 'strict' });

  assert.equal(
    messages.some(message => message.includes('Strict type error')),
    false
  );
});

test('strict mode flags lua output consumed without assert', () => {
  const messages = collectTypeDiagnostics(`
GET /lua
  |> lua: \`return { message = "hi" }\`
  |> jq: \`{ message: .message }\`
`, { mode: 'strict' });

  assert.equal(
    messages.some(message => message.includes('Strict type error') && message.includes('unasserted lua output')),
    true
  );
});

test('strict mode flags raw pg output without assert', () => {
  const messages = collectTypeDiagnostics(`
GET /raw
  |> jq: \`{ sqlParams: [] }\`
  |> pg: \`!raw SELECT '{}'::json\`
  |> jq: \`{ id: .id }\`
`, { mode: 'strict' });

  assert.equal(
    messages.some(message => message.includes('Strict type error') && message.includes('unasserted pg result')),
    true
  );
});

test('strict mode accepts lua output after assert', () => {
  const messages = collectTypeDiagnostics(`
GET /lua
  |> lua: \`return { message = "hi" }\`
  |> assert: \`{ message: string }\`
  |> jq: \`{ message: .message }\`
`, { mode: 'strict' });

  assert.equal(
    messages.some(message => message.includes('Strict type error')),
    false
  );
});

test('strict mode flags request body reads without validate or assert', () => {
  const messages = collectTypeDiagnostics(`
POST /login
  |> jq: \`{ login: .body.login }\`
`, { mode: 'strict' });

  assert.equal(
    messages.some(message => message.includes('unvalidated request body')),
    true
  );
});

test('strict mode accepts request body reads after validate', () => {
  const messages = collectTypeDiagnostics(`
POST /login
  |> validate: \`{
    login: string(3..50),
    password: string(6..100)
  }\`
  |> jq: \`{ login: .body.login }\`
`, { mode: 'strict' });

  assert.equal(
    messages.some(message => message.includes('Strict type error')),
    false
  );
});

test('strict mode propagates debt through named pipelines and lets caller assert it', () => {
  const messages = collectTypeDiagnostics(`
assert TeamsPageState = \`{
  data: {
    rows: [{ id: string, name: string }],
    rowCount: number
  }
}\`

pipeline getTeams =
  |> jq: \`{ sqlParams: [] }\`
  |> pg: \`SELECT * FROM teams\`

GET /teams
  |> pipeline: getTeams
  |> assert: TeamsPageState
  |> jq: \`{ names: .data.rows | map(.name) }\`
`, { mode: 'strict' });

  assert.equal(
    messages.some(message => message.includes('Strict type error')),
    false
  );
});

test('named pipeline diagnostics point at the invalid call site', () => {
  const source = `
pipeline teamsOutput =
  |> jq: \`{
    names: .data.rows | map(.name),
    count: .data.rowCount
  }\`

GET /teams
  |> jq: \`{ data: { rows: [{ name: "Ada" }], rowCount: 1 } }\`
  |> teamsOutput

POST /login
  |> validate: \`{
    login: string(3..50),
    password: string(6..100)
  }\`
  |> jq: \`{ login: .body.login }\`
  |> teamsOutput
`;
  const diagnostics = collectTypeDiagnosticDetails(source);
  const diagnostic = diagnostics.find(item => item.message.includes("Pipeline 'teamsOutput' called here has type error"));

  assert.ok(diagnostic);
  assert.equal(diagnostic.start, source.lastIndexOf('teamsOutput'));
  assert.equal(
    diagnostic.message.includes('property "data" is not present') || diagnostic.message.includes('.data.rows may be missing'),
    true
  );
});

test('named pipeline diagnostics stay on the definition after local shape materializes', () => {
  const source = `
pipeline teamsOutput =
  |> jq: \`{
    names: .data.rows | map(.name),
    count: .data.rowCount
  }\`

pipeline getTeams =
  |> jq: \`{ sqlParams: [] }\`
  |> pg: \`SELECT id, name FROM teams\`
  |> assert: \`{
    data: {
      rows: [{ id: string | number, name: string }],
      rowCount: number
    }
  }\`
  |> jq: \`{
    teams: .datum.rows,
    teamCount: .data.rowCount
  }\`

GET /strict/teams-ok
  |> getTeams
  |> teamsOutput
`;
  const diagnostics = collectTypeDiagnosticDetails(source);
  const diagnostic = diagnostics.find(item => item.message.includes('datum'));

  assert.ok(diagnostic);
  assert.equal(
    diagnostics.some(item => item.message.includes("Pipeline 'getTeams' called here") && item.message.includes('datum')),
    false
  );
  assert.equal(source.slice(diagnostic.start, diagnostic.end).includes('datum'), true);
});

test('config typecheck strict enables strict mode', () => {
  const messages = collectTypeDiagnostics(`
config typecheck {
  strict: true
}

GET /teams
  |> jq: \`{ sqlParams: [] }\`
  |> pg: \`SELECT * FROM teams\`
  |> jq: \`{ names: .data.rows | map(.name) }\`
`);

  assert.equal(
    messages.some(message => message.includes('Strict type error')),
    true
  );
});

test('assert contract accepts array whose item type is a union of compatible objects', () => {
  const messages = collectTypeDiagnostics(`
GET /
  |> jq: \`{ tasks: [{id: 1, title: "Learn WebPipe"}, {id: 2, title: "Build HTMX App"}] }\`
  |> assert: \`{ tasks: [{ id: number, title: string }] }\`
`);

  assert.equal(
    messages.some(message => message.includes('Assert contract expects')),
    false
  );
});
