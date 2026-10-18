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

const FENCE = /^---\s*$/;

export function parseFrontmatter(source: string): FrontmatterResult {
  const text = source.replace(/^﻿/, '');
  const lines = text.split(/\r?\n/);
  if (lines.length === 0 || !FENCE.test(lines[0])) {
    return { data: {}, body: text, hasFrontmatter: false };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (FENCE.test(lines[i]) || /^\.\.\.\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return { data: {}, body: text, hasFrontmatter: true, error: 'Frontmatter is not closed with "---".' };
  }
  const body = lines.slice(end + 1).join('\n');
  try {
    const data = parseYamlSubset(lines.slice(1, end));
    return { data, body, hasFrontmatter: true };
  } catch (e) {
    return { data: {}, body, hasFrontmatter: true, error: (e as Error).message };
  }
}

function indentOf(line: string): number {
  const m = /^( *)/.exec(line);
  return m ? m[1].length : 0;
}

function isBlank(line: string): boolean {
  return /^\s*(#.*)?$/.test(line);
}

function stripComment(value: string): string {
  // Remove " # comment" outside quotes.
  let inS = false;
  let inD = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === '#' && !inS && !inD && (i === 0 || /\s/.test(value[i - 1]))) {
      return value.slice(0, i).trimEnd();
    }
  }
  return value;
}

export function parseScalar(raw: string): unknown {
  const v = stripComment(raw.trim());
  if (v === '') return '';
  if (v.startsWith('"')) {
    if (!v.endsWith('"') || v.length < 2) throw new Error(`Unterminated double-quoted string: ${v}`);
    return JSON.parse(v.replace(/\\'/g, "'"));
  }
  if (v.startsWith("'")) {
    if (!v.endsWith("'") || v.length < 2) throw new Error(`Unterminated single-quoted string: ${v}`);
    return v.slice(1, -1).replace(/''/g, "'");
  }
  if (v.startsWith('[')) {
    if (!v.endsWith(']')) throw new Error(`Unterminated flow list: ${v}`);
    const inner = v.slice(1, -1).trim();
    if (inner === '') return [];
    return splitFlow(inner).map((s) => parseScalar(s));
  }
  if (v.startsWith('{')) {
    if (!v.endsWith('}')) throw new Error(`Unterminated flow map: ${v}`);
    const out: Record<string, unknown> = {};
    const inner = v.slice(1, -1).trim();
    if (inner === '') return out;
    for (const part of splitFlow(inner)) {
      const idx = part.indexOf(':');
      if (idx === -1) throw new Error(`Invalid flow map entry: ${part}`);
      out[unquoteKey(part.slice(0, idx).trim())] = parseScalar(part.slice(idx + 1));
    }
    return out;
  }
  if (/^(true|True|TRUE)$/.test(v)) return true;
  if (/^(false|False|FALSE)$/.test(v)) return false;
  if (/^(null|Null|NULL|~)$/.test(v)) return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) {
    // Only when lossless: keeps SHAs, zero-padded ids and huge numbers as text.
    const n = Number(v);
    if (String(n) === v) return n;
  }
  return v;
}

function splitFlow(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inS = false;
  let inD = false;
  let cur = '';
  for (const c of s) {
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (!inS && !inD && (c === '[' || c === '{')) depth++;
    else if (!inS && !inD && (c === ']' || c === '}')) depth--;
    if (c === ',' && depth === 0 && !inS && !inD) {
      parts.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  if (cur.trim() !== '') parts.push(cur.trim());
  return parts;
}

function unquoteKey(k: string): string {
  if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) return k.slice(1, -1);
  return k;
}

const KEY_LINE = /^( *)("[^"]+"|'[^']+'|[^\s:#][^:]*?)\s*:(?:\s+(.*)|\s*)$/;

function parseYamlSubset(lines: string[]): Record<string, unknown> {
  const [map] = parseMap(lines, 0, 0);
  return map;
}

/** Parses a block map starting at `start` whose keys are at exactly `indent`. */
function parseMap(lines: string[], start: number, indent: number): [Record<string, unknown>, number] {
  const out: Record<string, unknown> = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    if (/^ *\t/.test(line)) {
      throw new Error(`Tabs are not allowed for indentation (line ${i + 1}).`);
    }
    const ind = indentOf(line);
    if (ind < indent) break;
    if (ind > indent) throw new Error(`Unexpected indentation at frontmatter line ${i + 1}.`);
    const m = KEY_LINE.exec(line);
    if (!m) throw new Error(`Cannot parse frontmatter line ${i + 1}: "${line.trim()}"`);
    const key = unquoteKey(m[2].trim());
    const rest = (m[3] ?? '').trim();
    i++;
    if (rest === '' || rest.startsWith('#')) {
      // Nested map, block list, or empty value.
      let j = i;
      while (j < lines.length && isBlank(lines[j])) j++;
      if (j < lines.length && indentOf(lines[j]) > indent) {
        const childIndent = indentOf(lines[j]);
        if (/^\s*- /.test(lines[j]) || /^\s*-$/.test(lines[j])) {
          const [list, next] = parseList(lines, j, childIndent);
          out[key] = list;
          i = next;
        } else {
          const [child, next] = parseMap(lines, j, childIndent);
          out[key] = child;
          i = next;
        }
      } else if (j < lines.length && indentOf(lines[j]) === indent && /^\s*- /.test(lines[j])) {
        // YAML allows lists at the same indent as the parent key.
        const [list, next] = parseList(lines, j, indent);
        out[key] = list;
        i = next;
      } else {
        out[key] = null;
      }
    } else if (/^[|>][+-]?\d*$/.test(stripComment(rest))) {
      const style = rest[0];
      const chomp = rest.includes('-') ? 'strip' : rest.includes('+') ? 'keep' : 'clip';
      const block: string[] = [];
      let blockIndent = -1;
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim() === '') {
          block.push('');
          i++;
          continue;
        }
        const li = indentOf(l);
        if (li <= indent) break;
        if (blockIndent === -1) blockIndent = li;
        if (li < blockIndent) break;
        block.push(l.slice(blockIndent));
        i++;
      }
      let value: string;
      if (style === '|') {
        value = block.join('\n');
      } else {
        // Folded: join non-empty consecutive lines with spaces, keep blank lines as newlines.
        value = block
          .join('\n')
          .split(/\n{2,}/)
          .map((p) => p.replace(/\n/g, ' '))
          .join('\n');
      }
      if (chomp === 'strip') value = value.replace(/\n+$/, '');
      else if (chomp === 'clip') value = value.replace(/\n+$/, '') + '\n';
      out[key] = value;
    } else {
      out[key] = parseScalar(rest);
    }
  }
  return [out, i];
}

function parseList(lines: string[], start: number, indent: number): [unknown[], number] {
  const out: unknown[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const ind = indentOf(line);
    if (ind < indent) break;
    if (ind > indent || !/^\s*-(\s|$)/.test(line)) break;
    const item = line.slice(ind + 1).trim();
    if (KEY_LINE.test(' '.repeat(indent + 2) + item) && !item.startsWith('"') && !item.startsWith("'")) {
      // "- key: value" list of maps (first key inline).
      const synthetic = [' '.repeat(indent + 2) + item];
      let j = i + 1;
      while (j < lines.length && (isBlank(lines[j]) || indentOf(lines[j]) > indent)) {
        synthetic.push(lines[j]);
        j++;
      }
      const [m] = parseMap(synthetic, 0, indent + 2);
      out.push(m);
      i = j;
    } else {
      out.push(parseScalar(item));
      i++;
    }
  }
  return [out, i];
}
