import { URI } from 'vscode-uri';
import * as path from 'path';
import * as fs from 'fs';

/**
 * ImportResolver handles path resolution, file existence checks, and circular import detection
 */
export class ImportResolver {
  /**
   * Resolve a relative import path to an absolute file:// URI
   * @param fromUri The URI of the file containing the import statement
   * @param importPath The import path from the AST (e.g., "./common/db.wp", "../auth.wp")
   * @returns Absolute file:// URI or null if resolution fails
   */
  resolveImportPath(fromUri: string, importPath: string): string | null {
    try {
      // Normalize the import path (add .wp if missing)
      const normalizedPath = this.normalizeImportPath(importPath);

      // Parse the source URI to get the file path
      const fromFilePath = URI.parse(fromUri).fsPath;
      const fromDir = path.dirname(fromFilePath);

      // Resolve the relative path
      const resolvedPath = path.resolve(fromDir, normalizedPath);

      // Check if file exists
      if (!this.fileExists(resolvedPath)) {
        return null;
      }

      // Convert back to file:// URI
      return URI.file(resolvedPath).toString();
    } catch (error) {
      console.error(`Failed to resolve import path "${importPath}" from "${fromUri}":`, error);
      return null;
    }
  }

  /**
   * Normalize an import path by adding .wp extension if missing
   * @param importPath The raw import path
   * @returns Normalized path with .wp extension
   */
  normalizeImportPath(importPath: string): string {
    // If already has .wp extension, return as-is
    if (importPath.endsWith('.wp')) {
      return importPath;
    }

    // Add .wp extension
    return `${importPath}.wp`;
  }

  /**
   * Check if a file exists on the file system
   * @param filePath Absolute file system path
   * @returns true if file exists
   */
  private fileExists(filePath: string): boolean {
    try {
      return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
    } catch {
      return false;
    }
  }

  /**
   * Detect if adding an import would create a circular dependency
   * Uses depth-first search to detect cycles in the dependency graph
   * @param fromUri The URI of the file importing
   * @param toUri The URI of the file being imported
   * @param getDependencies Function to get dependencies for a given URI
   * @returns true if adding this import would create a cycle
   */
  detectCircularImport(
    fromUri: string,
    toUri: string,
    getDependencies: (uri: string) => string[]
  ): boolean {
    // If importing itself, that's circular
    if (fromUri === toUri) {
      return true;
    }

    // Use DFS to detect if there's a path from toUri back to fromUri
    const visited = new Set<string>();
    const stack = new Set<string>();

    const dfs = (currentUri: string): boolean => {
      if (stack.has(currentUri)) {
        // Found a cycle
        return true;
      }

      if (visited.has(currentUri)) {
        // Already explored this path
        return false;
      }

      visited.add(currentUri);
      stack.add(currentUri);

      // Get all files that currentUri imports
      const deps = getDependencies(currentUri);
      for (const depUri of deps) {
        // If we reach fromUri, we've found a cycle
        if (depUri === fromUri) {
          return true;
        }

        // Recursively check dependencies
        if (dfs(depUri)) {
          return true;
        }
      }

      stack.delete(currentUri);
      return false;
    };

    return dfs(toUri);
  }

  /**
   * Find all circular import chains in the dependency graph
   * @param getAllFiles Function to get all file URIs in the workspace
   * @param getDependencies Function to get dependencies for a given URI
   * @returns Array of circular import chains (each chain is an array of URIs)
   */
  detectAllCircularImports(
    getAllFiles: () => string[],
    getDependencies: (uri: string) => string[]
  ): string[][] {
    const cycles: string[][] = [];
    const visited = new Set<string>();
    const recursionStack: string[] = [];
    const inStack = new Set<string>();

    const dfs = (uri: string): void => {
      if (visited.has(uri)) {
        return;
      }

      visited.add(uri);
      recursionStack.push(uri);
      inStack.add(uri);

      const deps = getDependencies(uri);
      for (const depUri of deps) {
        if (!visited.has(depUri)) {
          dfs(depUri);
        } else if (inStack.has(depUri)) {
          // Found a cycle
          const cycleStart = recursionStack.indexOf(depUri);
          const cycle = recursionStack.slice(cycleStart);
          cycles.push([...cycle, depUri]); // Include the dependency to show the full cycle
        }
      }

      recursionStack.pop();
      inStack.delete(uri);
    };

    for (const uri of getAllFiles()) {
      if (!visited.has(uri)) {
        dfs(uri);
      }
    }

    return cycles;
  }

  /**
   * Get the relative path from one URI to another (for display purposes)
   * @param fromUri Source URI
   * @param toUri Target URI
   * @returns Relative path string
   */
  getRelativePath(fromUri: string, toUri: string): string {
    try {
      const fromPath = URI.parse(fromUri).fsPath;
      const toPath = URI.parse(toUri).fsPath;
      return path.relative(path.dirname(fromPath), toPath);
    } catch {
      return toUri;
    }
  }

  /**
   * Extract the filename from a URI (for display purposes)
   * @param uri File URI
   * @returns Filename without path
   */
  getFilename(uri: string): string {
    try {
      const filePath = URI.parse(uri).fsPath;
      return path.basename(filePath);
    } catch {
      return uri;
    }
  }
}
