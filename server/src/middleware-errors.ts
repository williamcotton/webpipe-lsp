export interface MiddlewareErrorSpec {
  branchable: readonly string[];
  fatal?: readonly string[];
}

export const middlewareErrorRegistry: Record<string, MiddlewareErrorSpec> = {
  assert: {
    branchable: ['assertionError', 'assertError']
  },
  ag: {
    branchable: ['agError']
  },
  algraf: {
    branchable: ['algrafError']
  },
  auth: {
    branchable: ['authError'],
    fatal: ['database_error', 'config_error']
  },
  fetch: {
    branchable: ['httpError', 'networkError', 'timeoutError', 'fetchError']
  },
  gg: {
    branchable: ['ggError']
  },
  graphql: {
    branchable: ['graphqlError'],
    fatal: ['config_error']
  },
  handlebars: {
    branchable: ['handlebarsError']
  },
  jq: {
    branchable: ['jqError']
  },
  js: {
    branchable: ['jsError']
  },
  lua: {
    branchable: ['luaError']
  },
  pg: {
    branchable: ['sqlError', 'pgError'],
    fatal: ['database_error']
  },
  stdin: {
    branchable: ['stdinError']
  },
  validate: {
    branchable: ['validationError']
  }
};

export function getMiddlewareBranchableErrors(name: string): readonly string[] | undefined {
  return middlewareErrorRegistry[name]?.branchable;
}
