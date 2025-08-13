/**
 * Configuration documentation for hover support
 * Generated from analysis of Rust middleware files
 */
import { createMarkdownCodeBlock } from './utils';

export interface ConfigDoc {
  name: string;
  description: string;
  options: ConfigOption[];
  examples: string[];
}

export interface ConfigOption {
  name: string;
  type: string;
  description: string;
  default?: string;
  required?: boolean;
}

export const configDocs: Record<string, ConfigDoc> = {
  cache: {
    name: 'cache',
    description: 'Cache configuration settings used by other middleware (e.g., fetch).',
    options: [
      {
        name: 'enabled',
        type: 'boolean',
        description: 'Whether caching is enabled',
        default: 'true',
        required: false
      },
      {
        name: 'defaultTtl',
        type: 'number',
        description: 'Default time to live in seconds for cache entries',
        default: '60',
        required: false
      },
      {
        name: 'maxCacheSize',
        type: 'number',
        description: 'Maximum cache size in bytes',
        default: '10485760',
        required: false
      }
    ],
    examples: [
      'config cache {\n  enabled: true\n  defaultTtl: 300\n  maxCacheSize: 52428800\n}'
    ]
  },

  pg: {
    name: 'pg',
    description: 'PostgreSQL database connection configuration.',
    options: [
      {
        name: 'host',
        type: 'string',
        description: 'Database host address',
        default: 'localhost',
        required: false
      },
      {
        name: 'port',
        type: 'number',
        description: 'Database port number',
        default: '5432',
        required: false
      },
      {
        name: 'database',
        type: 'string',
        description: 'Database name',
        default: 'postgres',
        required: false
      },
      {
        name: 'user',
        type: 'string',
        description: 'Database username',
        default: 'postgres',
        required: false
      },
      {
        name: 'password',
        type: 'string',
        description: 'Database password',
        default: 'postgres',
        required: false
      },
      {
        name: 'maxPoolSize',
        type: 'number',
        description: 'Maximum number of connections in the pool',
        default: '20',
        required: false
      },
      {
        name: 'initialPoolSize',
        type: 'number',
        description: 'Initial number of connections in the pool',
        default: '5',
        required: false
      }
    ],
    examples: [
      'config pg {\n  host: "localhost"\n  port: 5432\n  database: "myapp"\n  user: "myuser"\n  password: $DB_PASSWORD\n  maxPoolSize: 50\n  initialPoolSize: 10\n}'
    ]
  },

  auth: {
    name: 'auth',
    description: 'Authentication configuration for sessions and cookies.',
    options: [
      {
        name: 'sessionTtl',
        type: 'number',
        description: 'Session time to live in seconds',
        default: '604800',
        required: false
      },
      {
        name: 'cookieName',
        type: 'string',
        description: 'Name of the session cookie',
        default: 'wp_session',
        required: false
      },
      {
        name: 'cookieSecure',
        type: 'boolean',
        description: 'Whether to set Secure flag on cookies',
        default: 'false',
        required: false
      },
      {
        name: 'cookieHttpOnly',
        type: 'boolean',
        description: 'Whether to set HttpOnly flag on cookies',
        default: 'true',
        required: false
      },
      {
        name: 'cookieSameSite',
        type: 'string',
        description: 'SameSite cookie attribute (Lax, Strict, None)',
        default: 'Lax',
        required: false
      },
      {
        name: 'cookiePath',
        type: 'string',
        description: 'Path attribute for cookies',
        default: '/',
        required: false
      }
    ],
    examples: [
      'config auth {\n  sessionTtl: 86400\n  cookieName: "my_session"\n  cookieSecure: true\n  cookieHttpOnly: true\n  cookieSameSite: "Strict"\n  cookiePath: "/app"\n}'
    ]
  },

  log: {
    name: 'log',
    description: 'Logging configuration for request/response logging.',
    options: [
      {
        name: 'enabled',
        type: 'boolean',
        description: 'Whether logging is enabled',
        default: 'true',
        required: false
      },
      {
        name: 'format',
        type: 'string',
        description: 'Log output format',
        default: 'json',
        required: false
      },
      {
        name: 'level',
        type: 'string',
        description: 'Log level (debug, info, warn, error)',
        default: 'debug',
        required: false
      },
      {
        name: 'includeBody',
        type: 'boolean',
        description: 'Whether to include response body in logs',
        default: 'false',
        required: false
      },
      {
        name: 'includeHeaders',
        type: 'boolean',
        description: 'Whether to include request headers in logs',
        default: 'true',
        required: false
      },
      {
        name: 'maxBodySize',
        type: 'number',
        description: 'Maximum body size to include in logs',
        default: '1024',
        required: false
      },
      {
        name: 'timestamp',
        type: 'boolean',
        description: 'Whether to include timestamps in logs',
        default: 'true',
        required: false
      }
    ],
    examples: [
      'config log {\n  enabled: true\n  format: "json"\n  level: "debug"\n  includeBody: true\n  includeHeaders: false\n  maxBodySize: 2048\n  timestamp: true\n}'
    ]
  }
};

export function getConfigDoc(configName: string): ConfigDoc | null {
  return configDocs[configName] || null;
}

export function formatConfigHover(doc: ConfigDoc): string {
  const sections: string[] = [];

  // Title and description
  sections.push(`### config ${doc.name}\n`);
  sections.push(doc.description);

  // Configuration options
  if (doc.options && doc.options.length > 0) {
    sections.push('\n**Configuration Options:**');
    for (const option of doc.options) {
      let optionLine = `- **${option.name}**: \`${option.type}\``;
      if (option.required) {
        optionLine += ' *(required)*';
      } else if (option.default) {
        optionLine += ` *(default: ${option.default})*`;
      }
      optionLine += ` - ${option.description}`;
      sections.push(optionLine);
    }
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