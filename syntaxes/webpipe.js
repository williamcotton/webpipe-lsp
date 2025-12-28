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
        match: '\\b(GET|POST|PUT|DELETE|HEAD|OPTIONS)\\b'
      },

      // Config / pipeline / featureFlags keywords
      {
        scope: 'keyword',
        match: '\\b(config|pipeline|featureFlags)\\b'
      },

      // Control flow keywords (if/else/dispatch/foreach)
      {
        scope: 'keyword',
        match: '\\b(if|then|else|dispatch|case|default|foreach|end)\\b'
      },

      // Boolean operators for tag expressions in dispatch
      {
        scope: 'keyword',
        match: '\\b(and|or)\\b'
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

      // Tags: @tag, @!negated, @flag(args), @guard(`jq expr`)
      // Note: Args can be identifiers or backtick-quoted strings (for @guard JQ expressions)
      {
        scope: 'meta',
        begin: '@!?[a-zA-Z_][a-zA-Z0-9_-]*\\(',
        end: '\\)',
        contains: [
          {
            scope: 'string',
            begin: '`',
            end: '`',
            contains: [
              // Include JQ syntax highlighting for guard expressions
              { scope: 'variable', match: '\\.[a-zA-Z_][a-zA-Z0-9_]*' },
              { scope: 'keyword', match: '\\b(and|or|not)\\b' },
              { scope: 'operator', match: '==|!=|<|>|<=|>=' }
            ]
          },
          {
            scope: 'literal',
            match: '[a-zA-Z0-9_-]+'
          }
        ]
      },
      // Tags without arguments
      {
        scope: 'meta',
        match: '@!?[a-zA-Z_][a-zA-Z0-9_-]*'
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

      // JS embedded content
      {
        begin: '\\bjs:\\s*`',
        end: '`',
        subLanguage: 'javascript',
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

      // when calling HTTP method and route
      {
        match: '\\b(when|and)\\s+(calling)\\s+(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\\s+([^\\s]+)',
        captures: {
          1: { scope: 'keyword' },
          2: { scope: 'keyword' },
          3: { scope: 'keyword' },
          4: { scope: 'string' }
        }
      },

      // with/and with input/body/cookies/headers
      {
        begin: '\\b(with|and)(?:\\s+(with))?\\s+(body|input|cookies|headers)\\s*`',
        beginScope: {
          1: 'keyword',
          2: 'keyword',
          3: 'keyword'
        },
        end: '`',
        contains: [
          { scope: 'string', begin: '"', end: '"' },
          { scope: 'variable', match: '\\.[a-zA-Z_][a-zA-Z0-9_]*|\\.[0-9]+' },
          { scope: 'variable', match: '\\$[a-zA-Z_][a-zA-Z0-9_]*' },
          { scope: 'number', match: '\\b[0-9]+(?:\\.[0-9]+)?\\b' },
          { scope: 'literal', match: '\\b(null|true|false)\\b' },
          { scope: 'keyword', match: '\\b(map|select|keys|values|length|tostring|tonumber|type)\\b' }
        ]
      },

      // with/and with mock returning
      {
        begin: '\\b(with|and)(?:\\s+(with))?\\s+(mock)\\s+([a-zA-Z_][a-zA-Z0-9_.-]*)\\s+(returning)\\s*`',
        beginScope: {
          1: 'keyword',
          2: 'keyword',
          3: 'keyword',
          4: 'variable',
          5: 'keyword'
        },
        end: '`',
        contains: [
          { scope: 'string', begin: '"', end: '"' },
          { scope: 'variable', match: '\\.[a-zA-Z_][a-zA-Z0-9_]*|\\.[0-9]+' },
          { scope: 'variable', match: '\\$[a-zA-Z_][a-zA-Z0-9_]*' },
          { scope: 'number', match: '\\b[0-9]+(?:\\.[0-9]+)?\\b' },
          { scope: 'literal', match: '\\b(null|true|false)\\b' }
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

      // Let variable declarations in tests
      {
        match: '^\\s*(let)\\s+([a-zA-Z_][a-zA-Z0-9_-]*)\\s*(=)',
        captures: {
          1: { scope: 'keyword' },
          2: { scope: 'variable' },
          3: { scope: 'operator' }
        }
      },

      // Handlebars template variables
      {
        scope: 'variable',
        match: '\\{\\{[a-zA-Z_][a-zA-Z0-9_-]*\\}\\}',
        contains: []
      },

      // Selector syntax highlighting
      {
        begin: '\\b(then|and)\\s+(selector)\\s+',
        beginScope: {
          1: 'keyword',
          2: 'keyword'
        },
        end: '$',
        contains: [
          {
            scope: 'string',
            match: '"[^"]*"'
          },
          {
            scope: 'keyword',
            match: '\\b(exists|does|not|exist|text|count|attribute|equals|contains|matches|is|greater|than|less)\\b'
          }
        ]
      },

      // Other BDD keywords
      {
        scope: 'keyword',
        match: '\\b(let|with|when|then|and|executing|calling|input|output|equals|contains|matches|in|status|mock|returning|selector|exists|attribute|text|count)\\b'
      }
    ]
  };
}
