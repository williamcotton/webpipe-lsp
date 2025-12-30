import { REGEX_PATTERNS } from './constants';
import { WordInfo } from './types';

export function getWordAt(text: string, offset: number): WordInfo | null {
  const isWordChar = (ch: string) => REGEX_PATTERNS.WORD_CHAR.test(ch);
  let start = offset;
  let end = offset;

  while (start > 0 && isWordChar(text[start - 1])) start--;
  while (end < text.length && isWordChar(text[end])) end++;

  if (start === end) return null;

  const word = text.slice(start, end);
  if (!REGEX_PATTERNS.IDENTIFIER.test(word)) return null;

  // Check for scoped reference (alias::symbol)
  // If we have "::" right before the word, include the alias part
  if (start >= 2 && text.slice(start - 2, start) === '::') {
    let aliasStart = start - 2;
    while (aliasStart > 0 && isWordChar(text[aliasStart - 1])) aliasStart--;
    const alias = text.slice(aliasStart, start - 2);
    if (REGEX_PATTERNS.IDENTIFIER.test(alias)) {
      return { word: alias + '::' + word, start: aliasStart, end };
    }
  }

  // If we have "::" right after the word, include the symbol part
  if (end + 2 <= text.length && text.slice(end, end + 2) === '::') {
    let symbolEnd = end + 2;
    while (symbolEnd < text.length && isWordChar(text[symbolEnd])) symbolEnd++;
    const symbol = text.slice(end + 2, symbolEnd);
    if (REGEX_PATTERNS.IDENTIFIER.test(symbol)) {
      return { word: word + '::' + symbol, start, end: symbolEnd };
    }
  }

  return { word, start, end };
}

export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function createMarkdownCodeBlock(language: string | undefined, content: string): string {
  const lang = language || '';
  return '```' + lang + '\n' + content + '\n```';
}