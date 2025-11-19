import { TextDocument } from 'vscode-languageserver-textdocument';
import { parseProgramWithDiagnostics, Program, ParseDiagnostic } from 'webpipe-js';
import { SymbolTable } from './types';
import { buildSymbolTable } from './symbol-analyzer';

interface CachedDocument {
  version: number;
  text: string;
  program: Program;
  diagnostics: ParseDiagnostic[];
  symbols: SymbolTable;
  timestamp: number;
}

/**
 * Caches parsed AST for documents to avoid repeated parsing.
 * Invalidates cache when document version changes.
 */
export class DocumentCache {
  private cache = new Map<string, CachedDocument>();
  private maxCacheSize = 100;
  private maxCacheAge = 300000; // 5 minutes in ms

  /**
   * Get cached parse result or parse and cache if not available/stale
   */
  get(doc: TextDocument): { program: Program; diagnostics: ParseDiagnostic[] } {
    const uri = doc.uri;
    const version = doc.version;
    const cached = this.cache.get(uri);

    // Cache hit - version matches
    if (cached && cached.version === version) {
      // Update timestamp for LRU
      cached.timestamp = Date.now();
      return { program: cached.program, diagnostics: cached.diagnostics };
    }

    // Cache miss or stale - parse document and build symbol table
    const text = doc.getText();
    const { program, diagnostics } = parseProgramWithDiagnostics(text);
    const symbols = buildSymbolTable(program, text);

    // Store in cache
    this.cache.set(uri, {
      version,
      text,
      program,
      diagnostics,
      symbols,
      timestamp: Date.now()
    });

    // Cleanup if cache is too large
    this.cleanup();

    return { program, diagnostics };
  }

  /**
   * Get just the program (for providers that don't need diagnostics)
   */
  getProgram(doc: TextDocument): Program {
    return this.get(doc).program;
  }

  /**
   * Get the pre-computed symbol table for a document.
   * This is the primary API for language providers (hover, definition, references).
   * The symbol table is computed once per document version and cached.
   */
  getSymbols(doc: TextDocument): SymbolTable {
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
   * Get document text from cache (avoids repeated getText() calls)
   */
  getText(doc: TextDocument): string {
    const cached = this.cache.get(doc.uri);
    if (cached && cached.version === doc.version) {
      return cached.text;
    }
    // Fallback to document
    return doc.getText();
  }

  /**
   * Invalidate cache entry for a specific document
   */
  invalidate(uri: string): void {
    this.cache.delete(uri);
  }

  /**
   * Clear entire cache
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Remove old entries when cache grows too large
   */
  private cleanup(): void {
    if (this.cache.size <= this.maxCacheSize) {
      return;
    }

    const now = Date.now();
    const entries = Array.from(this.cache.entries());

    // Remove entries older than maxCacheAge first
    for (const [uri, cached] of entries) {
      if (now - cached.timestamp > this.maxCacheAge) {
        this.cache.delete(uri);
      }
    }

    // If still too large, remove oldest entries
    if (this.cache.size > this.maxCacheSize) {
      entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
      const toRemove = this.cache.size - this.maxCacheSize;
      for (let i = 0; i < toRemove; i++) {
        this.cache.delete(entries[i][0]);
      }
    }
  }

  /**
   * Get cache statistics for debugging
   */
  getStats(): { size: number; maxSize: number; entries: Array<{ uri: string; version: number; age: number }> } {
    const now = Date.now();
    return {
      size: this.cache.size,
      maxSize: this.maxCacheSize,
      entries: Array.from(this.cache.entries()).map(([uri, cached]) => ({
        uri,
        version: cached.version,
        age: now - cached.timestamp
      }))
    };
  }
}
