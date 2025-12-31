import { TextDocument, TextDocuments } from 'vscode-languageserver';
import { TextDocument as VTextDocument } from 'vscode-languageserver-textdocument';
import { Connection } from 'vscode-languageserver';
import { URI } from 'vscode-uri';
import * as fs from 'fs';
import { parseProgramWithDiagnostics, Program, ParseDiagnostic } from 'webpipe-js';
import { FileMetadata, ExportedSymbols, ResolvedImport, ImportGraphMetrics, SymbolTable } from './types';
import { buildSymbolTable } from './symbol-analyzer';
import { ImportResolver } from './import-resolver';

/**
 * WorkspaceManager handles multi-file caching, dependency tracking, and cross-file symbol resolution
 * Extends DocumentCache functionality to support imports and file watching
 */
export class WorkspaceManager {
  private cache = new Map<string, FileMetadata>();
  private maxCacheSize = 100;
  private maxCacheAge = 300000; // 5 minutes in ms
  private importResolver: ImportResolver;
  private invalidationQueue = new Map<string, NodeJS.Timeout>();
  private fileWatcher: any = null;

  constructor(
    private connection: Connection,
    private documents: TextDocuments<VTextDocument>,
    private workspaceRoot: string
  ) {
    this.importResolver = new ImportResolver();
  }

  /**
   * Initialize file system watching
   * Note: File watching for external changes will be implemented in a future update
   */
  async initialize(): Promise<void> {
    // File system watching can be implemented using vscode.workspace.createFileSystemWatcher
    // For now, we rely on open document change events
    console.log('WorkspaceManager initialized');
  }

  /**
   * Get file metadata (load from cache or parse)
   * This is the main entry point for accessing file data
   */
  getDocument(uri: string): FileMetadata | null {
    // Try to get from cache
    const cached = this.cache.get(uri);
    if (cached) {
      // Check if it's a stub (version === 0 means not loaded yet)
      if (cached.version === 0) {
        // This is a stub, need to load the actual file
        // Fall through to loading logic below
      } else {
        // Real cached data, return it
        cached.timestamp = Date.now();
        return cached;
      }
    }

    // Check if it's an open document
    const textDoc = this.documents.get(uri);
    if (textDoc) {
      // Parse and cache
      this.parseAndCache(uri, textDoc.getText(), textDoc.version, true);
      return this.cache.get(uri) || null;
    }

    // Try to load from file system
    try {
      const filePath = URI.parse(uri).fsPath;
      const text = fs.readFileSync(filePath, 'utf-8');
      const stats = fs.statSync(filePath);
      const version = stats.mtimeMs; // Use mtime as version for closed files

      this.parseAndCache(uri, text, version, false);
      return this.cache.get(uri) || null;
    } catch (error) {
      console.error(`Failed to load file ${uri}:`, error);
      return null;
    }
  }

  /**
   * Get metadata for a TextDocument (compatibility with DocumentCache API)
   */
  get(doc: VTextDocument): { program: Program; diagnostics: ParseDiagnostic[] } {
    const uri = doc.uri;
    const version = doc.version;
    const cached = this.cache.get(uri);

    // Cache hit - version matches
    if (cached && cached.version === version) {
      // Update timestamp for LRU
      cached.timestamp = Date.now();
      return { program: cached.program, diagnostics: cached.diagnostics };
    }

    // Cache miss or stale - parse document
    this.parseAndCache(uri, doc.getText(), version, true);
    const updated = this.cache.get(uri);
    return { program: updated!.program, diagnostics: updated!.diagnostics };
  }

  /**
   * Get just the program (compatibility with DocumentCache API)
   */
  getProgram(doc: VTextDocument): Program {
    return this.get(doc).program;
  }

  /**
   * Get symbol table (compatibility with DocumentCache API)
   */
  getSymbols(doc: VTextDocument): SymbolTable {
    const uri = doc.uri;
    const version = doc.version;
    const cached = this.cache.get(uri);

    // Ensure we have cached data for this version
    if (!cached || cached.version !== version) {
      // Trigger parse and symbol table build
      this.get(doc);
      const updated = this.cache.get(uri);
      return updated!.symbols;
    }

    // Update timestamp for LRU
    cached.timestamp = Date.now();
    return cached.symbols;
  }

  /**
   * Get document text from cache (compatibility with DocumentCache API)
   */
  getText(doc: VTextDocument): string {
    const cached = this.cache.get(doc.uri);
    if (cached && cached.version === doc.version) {
      return cached.text;
    }
    // Fallback to document
    return doc.getText();
  }

  /**
   * Parse a file and cache it with import resolution and dependency tracking
   */
  private parseAndCache(uri: string, text: string, version: number, isOpen: boolean): void {
    // Check if already cached with same version
    const cached = this.cache.get(uri);
    if (cached && cached.version === version && cached.text === text) {
      return; // No need to re-parse
    }

    // Parse the document
    const { program, diagnostics } = parseProgramWithDiagnostics(text);

    // Resolve imports (but don't load them yet - lazy loading)
    const imports = this.resolveImports(uri, program);

    // Create preliminary metadata (needed for merging GraphQL)
    const preliminaryMetadata: FileMetadata = {
      version,
      text,
      program,
      diagnostics,
      symbols: this.getEmptySymbolTable(), // Will be replaced
      timestamp: Date.now(),
      imports,
      exportedSymbols: { variables: new Map(), pipelines: new Set(), queries: new Set(), mutations: new Set() }, // Will be replaced
      dependents: cached?.dependents || new Set(),
      isOpen
    };

    // Temporarily cache for import resolution in mergeGraphQLFromImports
    this.cache.set(uri, preliminaryMetadata);

    // Merge GraphQL from imports
    const mergedProgram = this.mergeGraphQLFromImports(uri) || program;

    // Build symbol table from merged program (includes imported GraphQL resolvers)
    const symbols = buildSymbolTable(mergedProgram, text);

    // Extract exported symbols
    const exportedSymbols = this.extractExportedSymbols(program);

    // Create metadata
    const metadata: FileMetadata = {
      version,
      text,
      program,
      diagnostics,
      symbols,
      timestamp: Date.now(),
      imports,
      exportedSymbols,
      dependents: cached?.dependents || new Set(),
      isOpen
    };

    // Store in cache
    this.cache.set(uri, metadata);

    // Update dependency graph
    this.updateDependencyGraph(uri, imports);

    // Cleanup if cache is too large
    this.cleanup();
  }

  /**
   * Extract exported symbols from a program
   */
  private extractExportedSymbols(program: Program): ExportedSymbols {
    const variables = new Map<string, Set<string>>();
    const pipelines = new Set<string>();
    const queries = new Set<string>();
    const mutations = new Set<string>();

    // Extract pipelines
    for (const pipeline of program.pipelines || []) {
      pipelines.add(pipeline.name);
    }

    // Extract variables (grouped by type)
    for (const variable of program.variables || []) {
      if (!variables.has(variable.varType)) {
        variables.set(variable.varType, new Set());
      }
      variables.get(variable.varType)!.add(variable.name);
    }

    // Extract queries
    for (const query of program.queries || []) {
      queries.add(query.name);
    }

    // Extract mutations
    for (const mutation of program.mutations || []) {
      mutations.add(mutation.name);
    }

    return { variables, pipelines, queries, mutations };
  }

  /**
   * Resolve import paths without loading the files (lazy loading)
   */
  private resolveImports(fromUri: string, program: Program): ResolvedImport[] {
    const resolvedImports: ResolvedImport[] = [];

    for (const imp of program.imports || []) {
      const resolvedUri = this.importResolver.resolveImportPath(fromUri, imp.path);

      if (resolvedUri === null) {
        // Resolution failed
        resolvedImports.push({
          alias: imp.alias,
          uri: '',
          path: imp.path,
          resolved: false,
          error: `File not found: ${imp.path}`,
          loaded: false
        });
      } else {
        // Check for circular import
        const isCircular = this.importResolver.detectCircularImport(
          fromUri,
          resolvedUri,
          (uri) => {
            const meta = this.cache.get(uri);
            return meta?.imports?.filter(i => i.resolved).map(i => i.uri) || [];
          }
        );

        if (isCircular) {
          resolvedImports.push({
            alias: imp.alias,
            uri: resolvedUri,
            path: imp.path,
            resolved: false,
            error: `Circular import detected`,
            loaded: false
          });
        } else {
          resolvedImports.push({
            alias: imp.alias,
            uri: resolvedUri,
            path: imp.path,
            resolved: true,
            loaded: false // Not loaded yet (lazy)
          });
        }
      }
    }

    return resolvedImports;
  }

  /**
   * Get all configs for a file including imported configs
   * Imported configs come first, then main file configs (so main can override)
   */
  getAllConfigs(uri: string): any[] {
    const metadata = this.cache.get(uri);
    if (!metadata) {
      return [];
    }

    const allConfigs: any[] = [];

    // Collect configs from imports first
    for (const imp of metadata.imports) {
      if (imp.resolved && imp.uri) {
        // Ensure imported file is loaded
        this.ensureImportLoaded(imp.uri);
        const importedMeta = this.cache.get(imp.uri);
        if (importedMeta && importedMeta.program && importedMeta.program.configs) {
          allConfigs.push(...importedMeta.program.configs);
        }
      }
    }

    // Add main file configs (so they can override imported ones)
    if (metadata.program && metadata.program.configs) {
      allConfigs.push(...metadata.program.configs);
    }

    return allConfigs;
  }

  /**
   * Merge GraphQL schemas, routes, and pipelines from imported modules
   * Returns a new program with merged GraphQL schema, queries, mutations, resolvers, routes, and pipelines
   */
  mergeGraphQLFromImports(uri: string): Program | null {
    const metadata = this.cache.get(uri);
    if (!metadata || !metadata.program) {
      return null;
    }

    // Clone the program
    const mergedProgram = { ...metadata.program };
    const schemaParts: string[] = [];

    // Add main program's schema if it exists
    if (metadata.program.graphqlSchema) {
      schemaParts.push(metadata.program.graphqlSchema.sdl);
    }

    // Clone arrays to avoid mutating the original
    mergedProgram.queries = [...(metadata.program.queries || [])];
    mergedProgram.mutations = [...(metadata.program.mutations || [])];
    mergedProgram.resolvers = [...(metadata.program.resolvers || [])];
    mergedProgram.routes = [...(metadata.program.routes || [])];
    mergedProgram.pipelines = [...(metadata.program.pipelines || [])];
    mergedProgram.describes = [...(metadata.program.describes || [])];

    // Collect from imports
    for (const imp of metadata.imports) {
      if (imp.resolved && imp.uri) {
        // Ensure imported file is loaded
        this.ensureImportLoaded(imp.uri);
        const importedMeta = this.cache.get(imp.uri);

        if (importedMeta && importedMeta.program) {
          // Merge GraphQL schema
          if (importedMeta.program.graphqlSchema) {
            schemaParts.push(importedMeta.program.graphqlSchema.sdl);
          }

          // Merge query resolvers
          if (importedMeta.program.queries) {
            mergedProgram.queries.push(...importedMeta.program.queries);
          }

          // Merge mutation resolvers
          if (importedMeta.program.mutations) {
            mergedProgram.mutations.push(...importedMeta.program.mutations);
          }

          // Merge type resolvers
          if (importedMeta.program.resolvers) {
            mergedProgram.resolvers.push(...importedMeta.program.resolvers);
          }

          // Merge routes from imports
          if (importedMeta.program.routes) {
            mergedProgram.routes.push(...importedMeta.program.routes);
          }

          // Merge pipelines from imports
          if (importedMeta.program.pipelines) {
            mergedProgram.pipelines.push(...importedMeta.program.pipelines);
          }

          // Merge test describes from imports
          if (importedMeta.program.describes) {
            mergedProgram.describes.push(...importedMeta.program.describes);
          }
        }
      }
    }

    // Combine all schema parts into a single schema
    if (schemaParts.length > 0) {
      mergedProgram.graphqlSchema = {
        sdl: schemaParts.join('\n\n')
      };
    }

    return mergedProgram;
  }

  /**
   * Update dependency graph (bidirectional)
   */
  private updateDependencyGraph(fromUri: string, imports: ResolvedImport[]): void {
    // Add fromUri to the dependents set of each imported file
    for (const imp of imports) {
      if (imp.resolved && imp.uri) {
        // Get or create metadata for the imported file
        let targetMetadata = this.cache.get(imp.uri);

        if (!targetMetadata) {
          // Create stub metadata for lazy loading
          targetMetadata = {
            version: 0,
            text: '',
            program: { configs: [], imports: [], pipelines: [], variables: [], routes: [], describes: [], comments: [] },
            diagnostics: [],
            symbols: this.getEmptySymbolTable(),
            timestamp: Date.now(),
            imports: [],
            exportedSymbols: { variables: new Map(), pipelines: new Set(), queries: new Set(), mutations: new Set() },
            dependents: new Set(),
            isOpen: false
          };
          this.cache.set(imp.uri, targetMetadata);
        }

        // Add fromUri to dependents
        targetMetadata.dependents.add(fromUri);
      }
    }
  }

  /**
   * Ensure an imported file is loaded
   */
  ensureImportLoaded(uri: string): void {
    const meta = this.cache.get(uri);
    if (meta && meta.version === 0) {
      // This is a stub - load the actual file
      this.getDocument(uri);
    }
  }

  /**
   * Invalidate a file and queue dependent re-validation
   */
  invalidate(uri: string): void {
    const meta = this.cache.get(uri);
    if (!meta) {
      return;
    }

    // Clear this file's cache immediately
    this.cache.delete(uri);

    // Queue dependent re-validations with debounce
    for (const dependentUri of meta.dependents) {
      if (this.invalidationQueue.has(dependentUri)) {
        clearTimeout(this.invalidationQueue.get(dependentUri));
      }

      this.invalidationQueue.set(dependentUri, setTimeout(() => {
        this.revalidateDependent(dependentUri);
        this.invalidationQueue.delete(dependentUri);
      }, 500)); // 500ms debounce
    }
  }

  /**
   * Re-validate a dependent file
   */
  private revalidateDependent(uri: string): void {
    // Re-parse the dependent file to trigger validation
    const textDoc = this.documents.get(uri);
    if (textDoc) {
      // Will trigger validation through the normal flow
      this.parseAndCache(uri, textDoc.getText(), textDoc.version, true);
    }
  }

  /**
   * Reload a file from the file system
   */
  private async reloadFromFileSystem(uri: string): Promise<void> {
    try {
      const filePath = URI.parse(uri).fsPath;
      const text = await fs.promises.readFile(filePath, 'utf-8');
      const stats = await fs.promises.stat(filePath);
      const version = stats.mtimeMs; // Use mtime as version

      this.parseAndCache(uri, text, version, false);
    } catch (error) {
      console.error(`Failed to reload file ${uri}:`, error);
    }
  }

  /**
   * Handle file deletion
   */
  private handleFileDeleted(uri: string): void {
    // Remove from cache
    this.cache.delete(uri);

    // TODO: Show diagnostics for files that import the deleted file
  }

  /**
   * Get all file metadata (for cross-file reference searching)
   */
  getAllFileMetadata(): Map<string, FileMetadata> {
    return this.cache;
  }

  /**
   * Get import graph metrics for debugging
   */
  getImportGraph(): ImportGraphMetrics {
    const files = this.cache.size;
    const totalImports = Array.from(this.cache.values())
      .reduce((sum, m) => sum + m.imports.length, 0);

    // Calculate max depth with BFS
    const maxDepth = this.calculateMaxImportDepth();

    // Detect circular imports
    const circularImports = this.importResolver.detectAllCircularImports(
      () => Array.from(this.cache.keys()),
      (uri) => {
        const meta = this.cache.get(uri);
        return meta?.imports?.filter(i => i.resolved).map(i => i.uri) || [];
      }
    );

    return { files, totalImports, maxDepth, circularImports };
  }

  /**
   * Calculate maximum import depth using BFS
   */
  private calculateMaxImportDepth(): number {
    let maxDepth = 0;

    for (const uri of this.cache.keys()) {
      const depth = this.getImportDepth(uri);
      maxDepth = Math.max(maxDepth, depth);
    }

    return maxDepth;
  }

  /**
   * Get import depth for a specific file
   */
  private getImportDepth(uri: string): number {
    const visited = new Set<string>();
    const queue: Array<{ uri: string; depth: number }> = [{ uri, depth: 0 }];
    let maxDepth = 0;

    while (queue.length > 0) {
      const { uri: currentUri, depth } = queue.shift()!;

      if (visited.has(currentUri)) {
        continue;
      }

      visited.add(currentUri);
      maxDepth = Math.max(maxDepth, depth);

      const meta = this.cache.get(currentUri);
      if (meta) {
        for (const imp of meta.imports) {
          if (imp.resolved && imp.uri) {
            queue.push({ uri: imp.uri, depth: depth + 1 });
          }
        }
      }
    }

    return maxDepth;
  }

  /**
   * Cleanup old entries when cache grows too large
   */
  private cleanup(): void {
    if (this.cache.size <= this.maxCacheSize) {
      return;
    }

    const now = Date.now();
    const entries = Array.from(this.cache.entries());

    // Remove entries older than maxCacheAge first (but keep open files)
    for (const [uri, cached] of entries) {
      if (!cached.isOpen && now - cached.timestamp > this.maxCacheAge) {
        this.cache.delete(uri);
      }
    }

    // If still too large, remove oldest closed files
    if (this.cache.size > this.maxCacheSize) {
      const closedEntries = entries.filter(([_, cached]) => !cached.isOpen);
      closedEntries.sort((a, b) => a[1].timestamp - b[1].timestamp);
      const toRemove = this.cache.size - this.maxCacheSize;
      for (let i = 0; i < toRemove && i < closedEntries.length; i++) {
        this.cache.delete(closedEntries[i][0]);
      }
    }
  }

  /**
   * Clear entire cache
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics for debugging
   */
  getStats(): { size: number; maxSize: number; entries: Array<{ uri: string; version: number; age: number; isOpen: boolean }> } {
    const now = Date.now();
    return {
      size: this.cache.size,
      maxSize: this.maxCacheSize,
      entries: Array.from(this.cache.entries()).map(([uri, cached]) => ({
        uri,
        version: cached.version,
        age: now - cached.timestamp,
        isOpen: cached.isOpen
      }))
    };
  }

  /**
   * Helper to create an empty symbol table
   */
  private getEmptySymbolTable(): SymbolTable {
    return {
      variables: new Map(),
      pipelines: new Set(),
      variableRefs: new Map(),
      pipelineRefs: new Map(),
      testLetVariableRefs: new Map(),
      variablePositions: new Map(),
      pipelinePositions: new Map(),
      testLetVariablePositions: [],
      queryPositions: new Map(),
      mutationPositions: new Map(),
      queryRefs: new Map(),
      mutationRefs: new Map(),
      handlebars: {
        declByName: new Map(),
        contentRanges: [],
        usagesByName: new Map(),
        inlineDefsByContent: []
      }
    };
  }
}
