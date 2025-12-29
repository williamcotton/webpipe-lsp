import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  DocumentFormattingParams,
  TextEdit,
  Range,
} from 'vscode-languageserver/node';
import { prettyPrint } from 'webpipe-js';
import { DocumentCache } from './document-cache';

/**
 * Formatting provider for .wp documents.
 * Uses prettyPrint from webpipe-js to format entire documents.
 */
export class FormattingProvider {
  constructor(private cache: DocumentCache) {}

  /**
   * Format an entire document
   */
  onFormatting(
    params: DocumentFormattingParams,
    doc: TextDocument
  ): TextEdit[] {
    try {
      const program = this.cache.getProgram(doc);

      // Use prettyPrint to format the entire program
      const formattedText = prettyPrint(program);

      // Create a text edit that replaces the entire document
      const fullRange = Range.create(
        doc.positionAt(0),
        doc.positionAt(doc.getText().length)
      );

      return [TextEdit.replace(fullRange, formattedText)];
    } catch (error) {
      // If formatting fails, return no edits (leave document as-is)
      console.error('Formatting error:', error);
      return [];
    }
  }
}
