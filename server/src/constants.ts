export const VALID_HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

export const KNOWN_MIDDLEWARE = new Set([
  'jq', 'pg', 'fetch', 'handlebars', 'lua', 'auth', 'cache', 'log', 'debug', 'validate'
]);

export const KNOWN_STEPS = new Set([
  'jq', 'pg', 'fetch', 'handlebars', 'lua', 'auth', 'cache', 'log', 'debug', 'validate', 'result', 'pipeline'
]);

export const VALID_AUTH_FLOWS = new Set(['optional', 'required', 'login', 'register', 'logout']);

export const REGEX_PATTERNS = {
  VAR_DECL: /(^|\n)\s*([A-Za-z_][\w-]*)\s+([A-Za-z_][\w-]*)\s*=\s*`[\s\S]*?`/g,
  PIPE_DECL: /(^|\n)\s*pipeline\s+([A-Za-z_][\w-]*)\s*=/g,
  ROUTE_DECL: /(^|\n)\s*([A-Z]+)\s+(\/[\S]*)/g,
  STEP_REF: /(^|\n)\s*\|>\s*([A-Za-z_][\w-]*)\s*:\s*([^\s\n`"].*?)(?=\n|$)/g,
  PIPE_REF: /(^|\n)\s*\|>\s*pipeline:\s*([A-Za-z_][\w-]*)/g,
  IDENTIFIER: /^[A-Za-z_][\w-]*$/,
  WORD_CHAR: /[A-Za-z0-9_-]/,
  SINGLE_IDENTIFIER: /^(?<id>[A-Za-z_][\w-]*)$/
} as const;