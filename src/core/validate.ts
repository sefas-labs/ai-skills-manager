import { SKILL_NAME_RE } from './paths';
import type { Issue } from './types';

/**
 * Validation against the Agent Skills spec (https://agentskills.io/specification)
 * plus provider-specific notes that were verified in each provider's docs.
 */
export function validateSkill(input: {
  dirName: string;
  frontmatter: Record<string, unknown>;
  hasFrontmatter: boolean;
  parseError?: string;
  lineCount: number;
}): Issue[] {
  const issues: Issue[] = [];
  const fm = input.frontmatter;

  if (input.parseError) {
    issues.push({ severity: 'error', code: 'frontmatter-invalid', message: `Frontmatter could not be parsed: ${input.parseError}` });
    return issues;
  }
  if (!input.hasFrontmatter) {
    issues.push({
      severity: 'error',
      code: 'frontmatter-missing',
      message: 'SKILL.md has no YAML frontmatter. Cursor and Codex require `name` and `description`.',
    });
    return issues;
  }

  const name = fm['name'];
  if (name === undefined || name === null || name === '') {
    issues.push({
      severity: 'warning',
      code: 'name-missing',
      message: '`name` is missing. The spec requires it; Claude Code falls back to the folder name, Cursor and Codex may not load the skill.',
    });
  } else if (typeof name !== 'string') {
    issues.push({ severity: 'error', code: 'name-type', message: '`name` must be a string.' });
  } else {
    if (name.length > 64) issues.push({ severity: 'warning', code: 'name-length', message: '`name` exceeds 64 characters.' });
    if (!SKILL_NAME_RE.test(name)) {
      issues.push({
        severity: 'warning',
        code: 'name-format',
        message: '`name` should only use lowercase letters, numbers and single hyphens (no leading/trailing hyphen).',
      });
    }
    if (name !== input.dirName) {
      issues.push({
        severity: 'warning',
        code: 'name-mismatch',
        message: `\`name\` ("${name}") does not match the folder name ("${input.dirName}"). The spec and Cursor require them to match.`,
      });
    }
  }

  const desc = fm['description'];
  if (desc === undefined || desc === null || (typeof desc === 'string' && desc.trim() === '')) {
    issues.push({
      severity: 'error',
      code: 'description-missing',
      message: '`description` is missing. Agents use it to decide when to load the skill; Cursor and Codex require it.',
    });
  } else if (typeof desc !== 'string') {
    issues.push({ severity: 'error', code: 'description-type', message: '`description` must be a string.' });
  } else if (desc.length > 1024) {
    issues.push({ severity: 'warning', code: 'description-length', message: `\`description\` is ${desc.length} characters (spec max: 1024).` });
  }

  const compat = fm['compatibility'];
  if (typeof compat === 'string' && compat.length > 500) {
    issues.push({ severity: 'warning', code: 'compatibility-length', message: '`compatibility` exceeds 500 characters.' });
  }

  const meta = fm['metadata'];
  if (meta !== undefined && meta !== null && (typeof meta !== 'object' || Array.isArray(meta))) {
    issues.push({ severity: 'warning', code: 'metadata-type', message: '`metadata` should be a key/value map.' });
  }

  if (input.lineCount > 500) {
    issues.push({
      severity: 'info',
      code: 'long-skill',
      message: `SKILL.md has ${input.lineCount} lines. The spec recommends under 500 and moving detail into referenced files.`,
    });
  }
  return issues;
}
