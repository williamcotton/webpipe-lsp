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
  
  return { word, start, end };
}

export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function createMarkdownCodeBlock(language: string | undefined, content: string): string {
  const lang = language || '';
  return '```' + lang + '\n' + content + '\n```';
}