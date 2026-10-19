/**
 * Minimal, dependency-free parser for SKILL.md YAML frontmatter.
 *
 * It supports the subset that skills use in practice: scalars (plain, single
 * and double quoted), booleans/numbers, block scalars (| and >), one level of
 * nested maps (e.g. `metadata:`), block lists (`- a`) and flow lists (`[a, b]`).
 * Anything it can't understand is reported as an error instead of guessed.
 */

export interface FrontmatterResult {
  data: Record<string, unknown>;
  body: string;
  hasFrontmatter: boolean;
  error?: string;
}

const BYTE_ORDER_MARK = /^﻿/;
const OPENING_FENCE = /^---\s*$/;
const CLOSING_FENCE = /^(---|\.\.\.)\s*$/;
const LEADING_SPACES = /^( *)/;
const BLANK_OR_COMMENT_LINE = /^\s*(#.*)?$/;
const TAB_INDENTATION = /^ *\t/;
const WHITESPACE = /\s/;
/** `key:` or `key: value`; the key may be quoted. */
const KEY_LINE = /^( *)("[^"]+"|'[^']+'|[^\s:#][^:]*?)\s*:(?:\s+(.*)|\s*)$/;
const LIST_ITEM_LINE = /^\s*-(\s|$)/;
const KEY_VALUE_SEPARATOR = /:\s/;
/** A line that YAML would read as a list item, complex key or value marker. */
const STRUCTURAL_LINE_START = /^[-?:]\s/;
/** `|` or `>`, optionally followed by a chomping indicator (+/-) and an indentation digit. */
const BLOCK_SCALAR_HEADER = /^[|>][+-]?\d*$/;
const TRAILING_NEWLINES = /\n+$/;
const PARAGRAPH_BREAK = /\n{2,}/;

const TRUE_VALUE = /^(true|True|TRUE)$/;
const FALSE_VALUE = /^(false|False|FALSE)$/;
const NULL_VALUE = /^(null|Null|NULL|~)$/;
const DECIMAL_NUMBER = /^-?\d+(\.\d+)?$/;
const ESCAPED_SINGLE_QUOTE = /\\'/g;
const DOUBLED_SINGLE_QUOTE = /''/g;

type ParsedMap = Record<string, unknown>;
/** A parsed value and the index of the first line after it. */
type Parsed<T> = [T, number];

export function parseFrontmatter(source: string): FrontmatterResult {
  const text = source.replace(BYTE_ORDER_MARK, '');
  const lines = text.split(/\r?\n/);
  if (lines.length === 0 || !OPENING_FENCE.test(lines[0])) {
    return { data: {}, body: text, hasFrontmatter: false };
  }
  const closingLine = lines.findIndex((line, index) => index > 0 && CLOSING_FENCE.test(line));
  if (closingLine === -1) {
    return { data: {}, body: text, hasFrontmatter: true, error: 'Frontmatter is not closed with "---".' };
  }
  const body = lines.slice(closingLine + 1).join('\n');
  try {
    const [data] = parseMap(lines.slice(1, closingLine), 0, 0);
    return { data, body, hasFrontmatter: true };
  } catch (error) {
    return { data: {}, body, hasFrontmatter: true, error: (error as Error).message };
  }
}

function indentOf(line: string): number {
  return LEADING_SPACES.exec(line)?.[1].length ?? 0;
}

function isBlank(line: string): boolean {
  return BLANK_OR_COMMENT_LINE.test(line);
}

function isListItem(line: string): boolean {
  return LIST_ITEM_LINE.test(line);
}

/** Tracks whether we are inside '…' or "…" while scanning a value character by character. */
class QuoteTracker {
  private inSingle = false;
  private inDouble = false;

  update(character: string): void {
    if (character === "'" && !this.inDouble) this.inSingle = !this.inSingle;
    else if (character === '"' && !this.inSingle) this.inDouble = !this.inDouble;
  }

  get outside(): boolean {
    return !this.inSingle && !this.inDouble;
  }
}

/** Removes a trailing ` # comment` that is not inside quotes. */
function stripComment(value: string): string {
  const quotes = new QuoteTracker();
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    quotes.update(character);
    const startsComment = character === '#' && quotes.outside && (index === 0 || WHITESPACE.test(value[index - 1]));
    if (startsComment) return value.slice(0, index).trimEnd();
  }
  return value;
}

export function parseScalar(raw: string): unknown {
  const value = stripComment(raw.trim());
  if (value === '') return '';
  if (value.startsWith('"')) return parseDoubleQuoted(value);
  if (value.startsWith("'")) return parseSingleQuoted(value);
  if (value.startsWith('[')) return parseFlowList(value);
  if (value.startsWith('{')) return parseFlowMap(value);
  if (TRUE_VALUE.test(value)) return true;
  if (FALSE_VALUE.test(value)) return false;
  if (NULL_VALUE.test(value)) return null;
  if (DECIMAL_NUMBER.test(value)) {
    // Only when lossless: keeps SHAs, zero-padded ids and huge numbers as text.
    const number = Number(value);
    if (String(number) === value) return number;
  }
  return value;
}

function parseDoubleQuoted(value: string): string {
  if (value.length < 2 || !value.endsWith('"')) throw new Error(`Unterminated double-quoted string: ${value}`);
  return JSON.parse(value.replace(ESCAPED_SINGLE_QUOTE, "'"));
}

function parseSingleQuoted(value: string): string {
  if (value.length < 2 || !value.endsWith("'")) throw new Error(`Unterminated single-quoted string: ${value}`);
  return value.slice(1, -1).replace(DOUBLED_SINGLE_QUOTE, "'");
}

function parseFlowList(value: string): unknown[] {
  if (!value.endsWith(']')) throw new Error(`Unterminated flow list: ${value}`);
  const inner = value.slice(1, -1).trim();
  if (inner === '') return [];
  return splitFlowItems(inner).map((item) => parseScalar(item));
}

function parseFlowMap(value: string): ParsedMap {
  if (!value.endsWith('}')) throw new Error(`Unterminated flow map: ${value}`);
  const map: ParsedMap = {};
  const inner = value.slice(1, -1).trim();
  if (inner === '') return map;
  for (const entry of splitFlowItems(inner)) {
    const colon = entry.indexOf(':');
    if (colon === -1) throw new Error(`Invalid flow map entry: ${entry}`);
    map[unquoteKey(entry.slice(0, colon).trim())] = parseScalar(entry.slice(colon + 1));
  }
  return map;
}

/** Splits `a, [b, c], "d, e"` at top-level commas only. */
function splitFlowItems(text: string): string[] {
  const items: string[] = [];
  const quotes = new QuoteTracker();
  let nesting = 0;
  let current = '';
  for (const character of text) {
    quotes.update(character);
    if (quotes.outside && (character === '[' || character === '{')) nesting++;
    else if (quotes.outside && (character === ']' || character === '}')) nesting--;
    const isTopLevelComma = character === ',' && nesting === 0 && quotes.outside;
    if (isTopLevelComma) {
      items.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  if (current.trim() !== '') items.push(current.trim());
  return items;
}

function unquoteKey(key: string): string {
  const isDoubleQuoted = key.startsWith('"') && key.endsWith('"');
  const isSingleQuoted = key.startsWith("'") && key.endsWith("'");
  return isDoubleQuoted || isSingleQuoted ? key.slice(1, -1) : key;
}

/** YAML folding: blank lines become newlines, other line breaks a single space. */
function foldLines(parts: string[]): string {
  return parts.reduce((folded, part) => {
    if (part === '') return folded + '\n';
    const startsNewLine = folded === '' || folded.endsWith('\n');
    return startsNewLine ? folded + part : `${folded} ${part}`;
  }, '');
}

/** Index of the first line at or after `start` that is not blank. */
function nextContentLine(lines: string[], start: number): number {
  let index = start;
  while (index < lines.length && isBlank(lines[index])) index++;
  return index;
}

/** Index after the last line that is blank or indented deeper than `indent`. */
function endOfIndentedBlock(lines: string[], start: number, indent: number): number {
  let index = start;
  while (index < lines.length && (isBlank(lines[index]) || indentOf(lines[index]) > indent)) index++;
  return index;
}

/** Parses a block map starting at `start` whose keys are at exactly `indent`. */
function parseMap(lines: string[], start: number, indent: number): Parsed<ParsedMap> {
  const map: ParsedMap = {};
  let lineIndex = start;
  while (lineIndex < lines.length) {
    const line = lines[lineIndex];
    if (isBlank(line)) {
      lineIndex++;
      continue;
    }
    if (TAB_INDENTATION.test(line)) throw new Error(`Tabs are not allowed for indentation (line ${lineIndex + 1}).`);
    const lineIndent = indentOf(line);
    if (lineIndent < indent) break;
    if (lineIndent > indent) throw new Error(`Unexpected indentation at frontmatter line ${lineIndex + 1}.`);
    const keyLine = KEY_LINE.exec(line);
    if (!keyLine) throw new Error(`Cannot parse frontmatter line ${lineIndex + 1}: "${line.trim()}"`);

    const key = unquoteKey(keyLine[2].trim());
    const inlineValue = (keyLine[3] ?? '').trim();
    const valueStart = lineIndex + 1;
    let value: unknown;
    if (inlineValue === '' || inlineValue.startsWith('#')) {
      [value, lineIndex] = parseValueBelowKey(lines, valueStart, indent);
    } else if (BLOCK_SCALAR_HEADER.test(stripComment(inlineValue))) {
      [value, lineIndex] = parseBlockScalar(lines, valueStart, indent, inlineValue);
    } else {
      [value, lineIndex] = parseInlineValue(lines, valueStart, indent, inlineValue);
    }
    map[key] = value;
  }
  return [map, lineIndex];
}

/** `key:` with nothing after it: a nested map, a list, a scalar on the next lines, or null. */
function parseValueBelowKey(lines: string[], start: number, keyIndent: number): Parsed<unknown> {
  const firstLine = nextContentLine(lines, start);
  if (firstLine >= lines.length) return [null, start];
  const childLine = lines[firstLine];
  const childIndent = indentOf(childLine);

  if (childIndent > keyIndent) {
    const isStructured = isListItem(childLine) || KEY_LINE.test(childLine);
    if (!isStructured && !KEY_VALUE_SEPARATOR.test(stripComment(childLine))) {
      return parseIndentedPlainScalar(lines, firstLine, keyIndent);
    }
    if (isListItem(childLine)) return parseList(lines, firstLine, childIndent);
    return parseMap(lines, firstLine, childIndent);
  }
  // YAML allows a list at the same indent as its parent key.
  const isSameIndentList = childIndent === keyIndent && /^\s*- /.test(childLine);
  if (isSameIndentList) return parseList(lines, firstLine, keyIndent);
  return [null, start];
}

/** `key:` followed by an indented plain scalar on the next lines, folded like YAML. */
function parseIndentedPlainScalar(lines: string[], start: number, keyIndent: number): Parsed<string> {
  const end = endOfIndentedBlock(lines, start, keyIndent);
  const parts = lines.slice(start, end).map((line) => stripComment(line.trim()));
  while (parts.length && parts[parts.length - 1] === '') parts.pop();
  return [foldLines(parts), end];
}

/** `key: |` (literal) or `key: >` (folded), with optional `-` (strip) or `+` (keep) chomping. */
function parseBlockScalar(lines: string[], start: number, keyIndent: number, header: string): Parsed<string> {
  const isLiteral = header[0] === '|';
  const stripsTrailingNewlines = header.includes('-');
  const keepsTrailingNewlines = header.includes('+');
  const blockLines: string[] = [];
  let blockIndent = -1;
  let lineIndex = start;
  while (lineIndex < lines.length) {
    const line = lines[lineIndex];
    if (line.trim() === '') {
      blockLines.push('');
      lineIndex++;
      continue;
    }
    const lineIndent = indentOf(line);
    if (lineIndent <= keyIndent) break;
    if (blockIndent === -1) blockIndent = lineIndent;
    if (lineIndent < blockIndent) break;
    blockLines.push(line.slice(blockIndent));
    lineIndex++;
  }

  const joined = blockLines.join('\n');
  let value = isLiteral ? joined : foldParagraphs(joined);
  if (stripsTrailingNewlines) value = value.replace(TRAILING_NEWLINES, '');
  else if (!keepsTrailingNewlines) value = value.replace(TRAILING_NEWLINES, '') + '\n';
  return [value, lineIndex];
}

/** Folded style: lines of a paragraph join with spaces, blank lines separate paragraphs. */
function foldParagraphs(text: string): string {
  return text
    .split(PARAGRAPH_BREAK)
    .map((paragraph) => paragraph.replace(/\n/g, ' '))
    .join('\n');
}

/** `key: value`, where plain or quoted values may continue on more-indented lines. */
function parseInlineValue(lines: string[], start: number, keyIndent: number, inlineValue: string): Parsed<unknown> {
  let end = endOfIndentedBlock(lines, start, keyIndent);
  while (end > start && isBlank(lines[end - 1])) end--;
  const continuation = lines.slice(start, end).map((line) => line.trim());
  if (continuation.length === 0) return [parseScalar(inlineValue), start];

  const quote = inlineValue[0] === '"' || inlineValue[0] === "'" ? inlineValue[0] : '';
  const looksStructured = (line: string) => KEY_VALUE_SEPARATOR.test(stripComment(line)) || STRUCTURAL_LINE_START.test(line);
  if (!quote && continuation.some(looksStructured)) throw new Error(`Unexpected indentation at frontmatter line ${start + 1}.`);

  const parts = quote ? [inlineValue, ...continuation] : [stripComment(inlineValue), ...continuation.map(stripComment)];
  const folded = foldLines(parts);
  return [quote ? parseScalar(folded) : folded, end];
}

function parseList(lines: string[], start: number, indent: number): Parsed<unknown[]> {
  const items: unknown[] = [];
  let lineIndex = start;
  while (lineIndex < lines.length) {
    const line = lines[lineIndex];
    if (isBlank(line)) {
      lineIndex++;
      continue;
    }
    const lineIndent = indentOf(line);
    if (lineIndent !== indent || !isListItem(line)) break;
    const item = line.slice(lineIndent + 1).trim();
    const itemIndent = ' '.repeat(indent + 2);
    const isQuoted = item.startsWith('"') || item.startsWith("'");
    const startsAMap = KEY_LINE.test(itemIndent + item) && !isQuoted;
    if (startsAMap) {
      // "- key: value": a map whose first key is on the dash line.
      const end = endOfIndentedBlock(lines, lineIndex + 1, indent);
      const mapLines = [itemIndent + item, ...lines.slice(lineIndex + 1, end)];
      const [map] = parseMap(mapLines, 0, indent + 2);
      items.push(map);
      lineIndex = end;
    } else {
      items.push(parseScalar(item));
      lineIndex++;
    }
  }
  return [items, lineIndex];
}
