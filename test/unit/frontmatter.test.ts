import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter } from '../../src/core/frontmatter';

test('parses simple scalars and body', () => {
  const r = parseFrontmatter('---\nname: pdf-tools\ndescription: Extract text from PDFs. Use for PDFs.\n---\n# Body\n');
  assert.equal(r.hasFrontmatter, true);
  assert.equal(r.error, undefined);
  assert.equal(r.data.name, 'pdf-tools');
  assert.equal(r.data.description, 'Extract text from PDFs. Use for PDFs.');
  assert.equal(r.body.trim(), '# Body');
});

test('handles quotes, booleans, numbers, comments, BOM and CRLF', () => {
  const src = '﻿---\r\nname: "quoted: name"\r\nalt: \'it\'\'s\'\r\ndisable-model-invocation: true\r\nversion: 2 # comment\r\nurl: http://x.dev/#frag\r\n---\r\nbody';
  const r = parseFrontmatter(src);
  assert.equal(r.error, undefined);
  assert.equal(r.data.name, 'quoted: name');
  assert.equal(r.data.alt, "it's");
  assert.equal(r.data['disable-model-invocation'], true);
  assert.equal(r.data.version, 2);
  assert.equal(r.data.url, 'http://x.dev/#frag');
});

test('block scalars (literal and folded)', () => {
  const r = parseFrontmatter('---\ndescription: >\n  Line one\n  line two.\n\n  Para two.\nnotes: |-\n  a\n  b\nname: x\n---\n');
  assert.equal(r.error, undefined);
  assert.equal(r.data.description, 'Line one line two.\nPara two.\n');
  assert.equal(r.data.notes, 'a\nb');
  assert.equal(r.data.name, 'x');
});

test('nested metadata map and lists', () => {
  const r = parseFrontmatter(
    '---\nname: x\nmetadata:\n  author: me\n  version: "1.0"\nallowed-tools: [Read, "Bash(git:*)"]\npaths:\n  - src/**\n  - "*.md"\n---\n',
  );
  assert.equal(r.error, undefined);
  assert.deepEqual(r.data.metadata, { author: 'me', version: '1.0' });
  assert.deepEqual(r.data['allowed-tools'], ['Read', 'Bash(git:*)']);
  assert.deepEqual(r.data.paths, ['src/**', '*.md']);
});

test('no frontmatter', () => {
  const r = parseFrontmatter('# Just markdown');
  assert.equal(r.hasFrontmatter, false);
  assert.deepEqual(r.data, {});
});

test('unclosed frontmatter is an error', () => {
  const r = parseFrontmatter('---\nname: x\n# body');
  assert.match(r.error ?? '', /not closed/);
});

test('garbage line is an error, not a guess', () => {
  const r = parseFrontmatter('---\nname x\n---\n');
  assert.ok(r.error);
});

test('tab indentation is rejected', () => {
  const r = parseFrontmatter('---\nmetadata:\n\tauthor: me\n---\n');
  assert.ok(r.error);
});

test('digit-only values that would lose precision stay strings (e.g. SHAs)', () => {
  const r = parseFrontmatter('---\na: 0000000000000000000000000000000000000000\nb: 1234567890123456789012345678901234567890\nc: 42\nd: 3.5\ne: 007\n---\n');
  assert.equal(r.data['a'], '0000000000000000000000000000000000000000');
  assert.equal(r.data['b'], '1234567890123456789012345678901234567890');
  assert.equal(r.data['c'], 42);
  assert.equal(r.data['d'], 3.5);
  assert.equal(r.data['e'], '007');
});

test('multi-line plain and quoted scalars (indented continuation lines) are folded like YAML', () => {
  const r = parseFrontmatter(
    '---\nname: tao\ndescription: Performs deep Root Cause Analysis on\n  image-evidence-driven experiments.\n\n  Second paragraph.\nnext: "quoted that\n  continues here"\nsingle: \'one\n  two\'\n---\nBody\n',
  );
  assert.equal(r.error, undefined);
  assert.equal(r.data['description'], 'Performs deep Root Cause Analysis on image-evidence-driven experiments.\nSecond paragraph.');
  assert.equal(r.data['next'], 'quoted that continues here');
  assert.equal(r.data['single'], 'one two');
  assert.equal(r.data['name'], 'tao');
  // Like YAML: a continuation line can't hold another "key: value".
  assert.ok(parseFrontmatter('---\ndescription: Foo\n  name: bar\n---\n').error);
});

test('a plain scalar can start on the line after "key:" (as Vercel skills do)', () => {
  const r = parseFrontmatter('---\nname: x\ndescription:\n  React composition patterns that scale.\n  Use when refactoring.\nmetadata:\n  a: b\n---\n');
  assert.equal(r.error, undefined);
  assert.equal(r.data['description'], 'React composition patterns that scale. Use when refactoring.');
  assert.deepEqual(r.data['metadata'], { a: 'b' });
});
