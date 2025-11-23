/*
Language: WebPipe
Description: Syntax highlighting for WebPipe language files
Author: WebPipe Language Team
*/

export default function(hljs) {
  return {
    name: 'WebPipe',
    case_insensitive: false,
    contains: [
      // Comments
      hljs.HASH_COMMENT_MODE,

      // HTTP Methods
      {
        scope: 'keyword',
        match: '\\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\\b'
      },

      // Config / pipeline keywords
      {
        scope: 'keyword',
        match: '\\b(config|pipeline)\\b'
      },

      // ────────────────────────────────────────────────
      //  NEW: middleware keyword in *variable assignment*
      //       e.g.  pg pageQuery = `…` or mustache template = """…"""
      // ────────────────────────────────────────────────
      {
        scope: 'keyword',
        match: '^\\s*[a-zA-Z_][a-zA-Z0-9_]*(?=\\s+[a-zA-Z_][a-zA-Z0-9_]*\\s*=)'
      },

      // Mustache embedded content with triple quotes
      {
        begin: '\\bmustache\\s+[a-zA-Z_][a-zA-Z0-9_]*\\s*=\\s*\\"\\"\\"\\"',
        end: '\\"\\"\\"\\"',
        subLanguage: 'xml',
        contains: [
          {
            scope: 'variable',
            match: '\\{\\{[^}]+\\}\\}'
          }
        ]
      },

      // Pipeline operator
      {
        scope: 'operator',
        match: '\\|>'
      },

      // Tags: @tag, @!negated, @flag(args)
      {
        scope: 'meta',
        match: '@!?[a-zA-Z_][a-zA-Z0-9_-]*(\\((\\s*[a-zA-Z0-9_-]+\\s*)(,\\s*[a-zA-Z0-9_-]+\\s*)*\\))?'
      },

      // Middleware functions in pipelines (word before colon)
      {
        scope: 'keyword',
        match: '\\b[a-zA-Z_][a-zA-Z0-9_]*(?=\\s*:)'
      },

      // Route paths
      {
        scope: 'string',
        match: '/[^\\s]*',
        contains: [
          {
            scope: 'variable',
            match: ':[a-zA-Z_][a-zA-Z0-9_]*'
          }
        ]
      },

      // Lua embedded content
      {
        begin: '\\blua:\\s*`',
        end: '`',
        subLanguage: 'lua',
        contains: [
          {
            scope: 'variable',
            match: 'request\\.[a-zA-Z_][a-zA-Z0-9_]*'
          }
        ]
      },

      // JQ embedded content
      {
        begin: '\\bjq:\\s*`',
        end: '`',
        subLanguage: 'json',
        contains: [
          {
            scope: 'variable',
            match: '\\.[a-zA-Z_][a-zA-Z0-9_]*'
          }
        ]
      },

      // JQ filter between `output` and the assertion condition in tests
      {
        begin: '\\b(then|and)\\s+output\\s*`',
        end: '`',
        contains: [
          { scope: 'string', begin: '"', end: '"' },
          { scope: 'variable', match: '\\.[a-zA-Z_][a-zA-Z0-9_]*|\\.[0-9]+' },
          { scope: 'variable', match: '\\$[a-zA-Z_][a-zA-Z0-9_]*' },
          { scope: 'number', match: '\\b[0-9]+(?:\\.[0-9]+)?\\b' },
          { scope: 'literal', match: '\\b(null|true|false)\\b' },
          { scope: 'keyword', match: '\\b(map|select|keys|values|length|tostring|tonumber|type|now|empty|error|debug|reverse|sort|group_by|unique|flatten|min|max|add|any|all|range|floor|ceil|round|sqrt|test|match|capture|split|join|ltrimstr|rtrimstr|startswith|endswith|inside|contains|index|rindex|tojson|fromjson)\\b' },
          { scope: 'operator', match: '\\||\\+|\\-|\\*|/|==|!=|<|>|<=|>=|and|or|not|\\?' },
          { scope: 'punctuation', match: '[\\[\\]\\{\\}\\(\\),\\.:]'
          }
        ]
      },

      // SQL embedded content
      {
        begin: '\\bpg:\\s*`',
        end: '`',
        subLanguage: 'sql'
      },

      // Triple double-quote strings
      {
        scope: 'string',
        begin: '\\"\\"\\"\\"',
        end: '\\"\\"\\"\\"',
        contains: [
          {
            scope: 'variable',
            match: '\\.[a-zA-Z_][a-zA-Z0-9_]*'
          }
        ]
      },

      // Generic back‑tick strings
      {
        scope: 'string',
        begin: '`',
        end: '`',
        contains: [
          {
            scope: 'variable',
            match: '\\.[a-zA-Z_][a-zA-Z0-9_]*'
          },
          hljs.QUOTE_STRING_MODE
        ]
      },

      // Regular quoted strings
      hljs.QUOTE_STRING_MODE,

      // Numbers
      hljs.C_NUMBER_MODE,

      // Environment variables
      {
        scope: 'variable',
        match: '\\$[a-zA-Z_][a-zA-Z0-9_]*'
      },

      // Boolean literals
      {
        scope: 'literal',
        match: '\\b(true|false)\\b'
      },

      // BDD test keywords with quoted strings
      {
        begin: '\\b(describe|it)\\s+',
        beginScope: 'keyword',
        end: '$',
        contains: [
          {
            scope: 'string',
            match: '"[^"]*"'
          }
        ]
      },

      // Other BDD keywords
      {
        scope: 'keyword',
        match: '\\b(with|when|then|and|executing|calling|input|output|equals|contains|matches|in|status|mock|returning)\\b'
      }
    ]
  };
}
