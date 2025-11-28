/**
 * Middleware documentation for hover support
 * Generated from documentation in webpipe-lsp/middleware/*.md
 */
import { createMarkdownCodeBlock } from './utils';

export interface MiddlewareDoc {
  name: string;
  description: string;
  inputs?: string[];
  outputs?: string[];
  behavior?: string[];
  errors?: string[];
  notes?: string[];
  examples: string[];
}

export const middlewareDocs: Record<string, MiddlewareDoc> = {
  pg: {
    name: 'pg',
    description: 'Execute SQL against Postgres.',
    inputs: [
      '`sqlParams`: array of parameters bound in order',
      'optional `resultName`: capture under `.data.<name>`'
    ],
    behavior: [
      'SELECT/RETURNING → `.data = { rows: [...], rowCount: N }`',
      'Non-SELECT → `.data = { rows: [], rowCount: <affected> }`'
    ],
    errors: [
      '`{ type: "sqlError", message, sqlstate?, severity?, query }`'
    ],
    examples: [
      'GET /teams/:id\n  |> jq: `{ sqlParams: [.params.id], resultName: "team" }`\n  |> pg: `SELECT * FROM teams WHERE id = $1`'
    ]
  },

  fetch: {
    name: 'fetch',
    description: 'Perform HTTP requests.',
    inputs: [
      '`fetchUrl` (overrides inline URL)',
      '`fetchMethod` (default GET)',
      '`fetchHeaders` (object)',
      '`fetchBody` (JSON for POST/PUT)',
      '`fetchTimeout` (seconds)',
      '`resultName` (to place under `.data.<name>`)'
    ],
    behavior: [
      'Respects `_metadata.cache` set by `cache` middleware',
      'Cache key from `keyTemplate` or an automatic hash of method/url/headers/body'
    ],
    errors: [
      '`{ type: "httpError", status, statusText, url, method, responseBody? }`',
      '`{ type: "networkError", message, url, method }`',
      '`{ type: "timeoutError", timeoutSeconds, url, method }`'
    ],
    examples: [
      'GET /zen\n  |> jq: `{ fetchUrl: "https://api.github.com/zen", resultName: "api" }`\n  |> fetch: `_`\n  |> jq: `{ zen: .data.api.response }`'
    ]
  },

  auth: {
    name: 'auth',
    description: 'Authentication middleware with multiple flows.',
    inputs: [
      'Flow: `login` - validates credentials, creates session, sets cookie (`setCookies`), attaches `.user`',
      'Flow: `register` - creates user, attaches `.user`',
      'Flow: `logout` - clears session, returns `setCookies` with expired cookie',
      'Flow: `required` - ensures valid session and attaches `.user` or emits `authError`',
      'Flow: `optional` - attaches `.user` if valid session, otherwise passes through',
      'Flow: `type:<role>` - requires `.user.type == role` else `authError`'
    ],
    behavior: [
      'Cookie name and flags from auth config (`cookieName`, `HttpOnly`, `Secure`, `SameSite`, `Path`, `Max-Age`)'
    ],
    errors: [
      '`{ type: "authError", message }`'
    ],
    examples: [
      'GET /protected\n  |> auth: `required`',
      'GET /admin\n  |> auth: `type:admin`'
    ]
  },

  cache: {
    name: 'cache',
    description: 'Sets cache metadata used by other middleware (e.g., `fetch`).',
    inputs: [
      '`enabled: true|false`',
      '`ttl: <seconds>`',
      '`keyTemplate: <template-with-{path} placeholders>`'
    ],
    examples: [
      'GET /users/:id\n  |> cache: `\n    ttl: 30\n    enabled: true\n    keyTemplate: user-{params.id}\n  `'
    ]
  },

  validate: {
    name: 'validate',
    description: 'Validates fields in the current JSON.',
    errors: [
      '`{ type: "validationError", field, message, rule? }`'
    ],
    examples: [
      'POST /register\n  |> validate: `{\n    login: string(3..50),\n    email: email,\n    password: string(8..100)\n  }`'
    ]
  },

  jq: {
    name: 'jq',
    description: 'Transform JSON using jq expressions.',
    behavior: [
      'Input is serialized to JSON and fed to jq',
      'Result must be valid JSON (string, number, object, array, true/false/null)'
    ],
    examples: [
      'GET /users/:id\n  |> jq: `{ sqlParams: [.params.id] }`\n  |> pg: `SELECT * FROM users WHERE id = $1`\n  |> jq: `{ user: .data.rows[0] }`'
    ]
  },

  handlebars: {
    name: 'handlebars',
    description: 'Render strings using Handlebars templates.',
    behavior: [
      'Supports inline partials via `{{#*inline "name"}}...{{/inline}}`',
      'Can use partials defined in `handlebars` variable blocks',
      'Partials are referenced with `{{> partialName}}`'
    ],
    errors: [
      '`{ type: "MiddlewareExecutionError", message }`'
    ],
    examples: [
      'handlebars userCard = `\n  <div class="user-card">\n    <h3>{{name}}</h3>\n    <p>{{email}}</p>\n  </div>\n`\n\nGET /profile\n  |> jq: `{ name: "Alice", email: "alice@example.com" }`\n  |> handlebars: `\n    <div class="profile">\n      {{> userCard}}\n      <p>Welcome back!</p>\n    </div>\n  `',
      'handlebars layout = `\n  <!DOCTYPE html>\n  <html>\n    <head><title>{{title}}</title></head>\n    <body>{{> content}}</body>\n  </html>\n`\n\handlebars content = `\n  <main>\n    <h1>{{heading}}</h1>\n    <p>{{message}}</p>\n  </main>\n`\n\nGET /page\n  |> jq: `{ title: "My Page", heading: "Welcome", message: "Hello World" }`\n  |> handlebars: `{{> layout}}`'
    ]
  },

  log: {
    name: 'log',
    description: 'Adds logging metadata and prints a JSON log line.',
    inputs: [
      '`level`',
      '`includeBody`',
      '`includeHeaders`',
      '`enabled`'
    ],
    examples: [
      'GET /api/data\n  |> log: `level: debug, includeBody: false, includeHeaders: true`'
    ]
  },

  lua: {
    name: 'lua',
    description: 'Run Lua scripts with access to `request` JSON and helpers.',
    inputs: [
      'Globals: `request` (current JSON)',
      'Globals: `executeSql(sql) -> (result, err)`',
      'Globals: `getEnv(name) -> string|nil`',
      'Globals: `requireScript(name)` (loads `scripts/<name>.lua` and returns its value)'
    ],
    notes: ['Security: dangerous Lua stdlib functions are removed'],
    examples: [
      'GET /teams/:id\n  |> lua: `\n    local id = request.params.id\n    local result, err = executeSql("SELECT * FROM teams WHERE id = " .. id)\n    if err then return { errors = { { type = "sqlError", message = err } } } end\n    return result\n  `'
    ]
  },

  debug: {
    name: 'debug',
    description: 'Prints a label and the current pipeline value to stdout. No changes to the value.',
    examples: [
      'GET /api/test\n  |> debug: "Current pipeline value"'
    ]
  },

  pipeline: {
    name: 'pipeline',
    description: 'Reference a named pipeline or define a pipeline.',
    behavior: [
      'When used in routes: `|> pipeline: name` - executes the named pipeline',
      'When used in declarations: `pipeline name = ...` - defines a reusable pipeline'
    ],
    examples: [
      'pipeline getUserData =\n  |> jq: `{ sqlParams: [.params.id] }`\n  |> pg: `SELECT * FROM users WHERE id = $1`\n\nGET /users/:id\n  |> pipeline: getUserData',
      'GET /users/:id\n  |> jq: `{ sqlParams: [.params.id] }`\n  |> pg: `SELECT * FROM users WHERE id = $1`\n  |> pipeline: formatResponse'
    ]
  },

  result: {
    name: 'result',
    description: 'Handle different execution outcomes with conditional branching.',
    behavior: [
      'Branches execution based on success/failure outcomes',
      '`ok(status)` - handles successful execution',
      '`default(status)` - fallback handler',
      'Custom branches for specific error types'
    ],
    examples: [
      'GET /users/:id\n  |> jq: `{ sqlParams: [.params.id] }`\n  |> pg: `SELECT * FROM users WHERE id = $1`\n  |> result\n    ok(200):\n      |> jq: `.data.rows[0]`\n    default(404):\n      |> jq: `{ error: "User not found" }`'
    ]
  },

  join: {
    name: 'join',
    description: 'Wait for async tasks to complete and merge their results.',
    inputs: [
      'Comma-separated list of async task names to wait for',
      'Can be plain identifiers: `task1,task2,task3`',
      'Or JSON array: `["task1","task2","task3"]`'
    ],
    behavior: [
      'Blocks until all specified async tasks complete',
      'Results are merged into `.async.<taskName>` in the context',
      'Each async result contains the full middleware output',
      'Tasks are identified by the `@async(name)` tag on their step'
    ],
    examples: [
      'GET /dashboard\n  |> fetch: `https://api.example.com/users` @async(users)\n  |> fetch: `https://api.example.com/posts` @async(posts)\n  |> join: `users,posts`\n  |> jq: `{\n    users: .async.users.data.response,\n    posts: .async.posts.data.response\n  }`'
    ]
  },

  graphql: {
    name: 'graphql',
    description: 'Execute GraphQL queries and mutations using defined resolvers.',
    inputs: [
      'GraphQL query/mutation string (inline or variable reference)',
      '`graphqlParams`: object of variables to pass to the query'
    ],
    behavior: [
      'Parses and executes GraphQL operations against defined `query` and `mutation` resolvers',
      'Results are placed in `.data` with the GraphQL response structure',
      'Can reference GraphQL variables: `|> graphql: myQueryVar`',
      'Works with `@async(name)` for parallel execution'
    ],
    errors: [
      '`{ type: "graphqlError", message, path?, locations? }`'
    ],
    examples: [
      'POST /graphql\n  |> jq: `{ graphqlParams: .variables }`\n  |> graphql: `.query`',
      'GET /test-graphql\n  |> graphql: `query { users { id name } }`',
      'graphql myQuery = `query { currentTime }`\n\nGET /time\n  |> graphql: myQuery'
    ]
  },

  rateLimit: {
    name: 'rateLimit',
    description: 'Rate limiting middleware using sliding window counters.',
    inputs: [
      '`keyTemplate` (required): Template for the rate limit key with interpolation, e.g. `ip-{ip}-route-{method}-{path}`, `user-{user.id}`',
      '`limit` (required): Maximum requests allowed per window',
      '`window` (required): Time window duration, e.g. `60s`, `1m`, `5m`, `1h`',
      '`burst` (optional): Extra burst capacity above the limit',
      '`scope` (optional): Semantic hint (`route`, `global`, `custom`)',
      '`enabled` (optional): If `false`, rate limiting is skipped (default: `true`)'
    ],
    behavior: [
      'Tracks request counts per key using sliding window',
      'Adds `_metadata.rateLimit` with `remaining`, `limit`, `resetAfter`, `key`',
      'Supports nested path interpolation: `{user.id}`, `{params.name}`',
      '`{ip}` is available from connection or `X-Forwarded-For`/`X-Real-IP` headers'
    ],
    errors: [
      '`{ type: "rate_limit_exceeded", message, status: 429 }`'
    ],
    notes: [
      'Client IP extracted from: 1) `X-Forwarded-For` header (first IP), 2) `X-Real-IP` header, 3) TCP connection'
    ],
    examples: [
      'GET /api/search\n  |> rateLimit: `\n    keyTemplate: ip-{ip}-route-{method}-{path}\n    limit: 20\n    window: 10s\n  `',
      'GET /api/users\n  |> rateLimit: `\n    keyTemplate: user-{user.id}-route-{method}-{path}\n    limit: 100\n    window: 60s\n    burst: 10\n  `'
    ]
  }
};

export function getMiddlewareDoc(middlewareName: string): MiddlewareDoc | null {
  return middlewareDocs[middlewareName] || null;
}

export function formatMiddlewareHover(doc: MiddlewareDoc): string {
  const sections: string[] = [];

  // Title and description
  sections.push(`### ${doc.name} Middleware\n`);
  sections.push(doc.description);

  // Inputs
  if (doc.inputs && doc.inputs.length > 0) {
    sections.push('\n**Inputs:**');
    sections.push(doc.inputs.map(input => `- ${input}`).join('\n'));
  }

  // Behavior
  if (doc.behavior && doc.behavior.length > 0) {
    sections.push('\n**Behavior:**');
    sections.push(doc.behavior.map(behavior => `- ${behavior}`).join('\n'));
  }

  // Errors
  if (doc.errors && doc.errors.length > 0) {
    sections.push('\n**Errors:**');
    sections.push(doc.errors.map(error => `- ${error}`).join('\n'));
  }

  // Notes
  if (doc.notes && doc.notes.length > 0) {
    sections.push('\n**Notes:**');
    sections.push(doc.notes.map(note => `- ${note}`).join('\n'));
  }

  // Examples
  if (doc.examples && doc.examples.length > 0) {
    sections.push('\n**Examples:**');
    for (const example of doc.examples) {
      sections.push(createMarkdownCodeBlock('webpipe', example));
    }
  }

  return sections.join('\n');
}