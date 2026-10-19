import { SKILL_NAME_RE } from './paths';
import type { Issue } from './types';

/** Limits from the Agent Skills spec (https://agentskills.io/specification). */
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_COMPATIBILITY_LENGTH = 500;
const RECOMMENDED_MAX_LINES = 500;

export interface SkillToValidate {
  dirName: string;
  frontmatter: Record<string, unknown>;
  hasFrontmatter: boolean;
  parseError?: string;
  lineCount: number;
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || value === '' || (typeof value === 'string' && value.trim() === '');
}

function isKeyValueMap(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nameIssues(name: unknown, dirName: string): Issue[] {
  if (isBlank(name)) {
    return [
      {
        severity: 'warning',
        code: 'name-missing',
        message: '`name` is missing. The spec requires it; Claude Code falls back to the folder name, Cursor and Codex may not load the skill.',
      },
    ];
  }
  if (typeof name !== 'string') return [{ severity: 'error', code: 'name-type', message: '`name` must be a string.' }];

  const issues: Issue[] = [];
  if (name.length > MAX_NAME_LENGTH) {
    issues.push({ severity: 'warning', code: 'name-length', message: `\`name\` exceeds ${MAX_NAME_LENGTH} characters.` });
  }
  if (!SKILL_NAME_RE.test(name)) {
    issues.push({
      severity: 'warning',
      code: 'name-format',
      message: '`name` should only use lowercase letters, numbers and single hyphens (no leading/trailing hyphen).',
    });
  }
  if (name !== dirName) {
    issues.push({
      severity: 'warning',
      code: 'name-mismatch',
      message: `\`name\` ("${name}") does not match the folder name ("${dirName}"). The spec and Cursor require them to match.`,
    });
  }
  return issues;
}

function descriptionIssues(description: unknown): Issue[] {
  if (isBlank(description)) {
    return [
      {
        severity: 'error',
        code: 'description-missing',
        message: '`description` is missing. Agents use it to decide when to load the skill; Cursor and Codex require it.',
      },
    ];
  }
  if (typeof description !== 'string') return [{ severity: 'error', code: 'description-type', message: '`description` must be a string.' }];
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return [
      {
        severity: 'warning',
        code: 'description-length',
        message: `\`description\` is ${description.length} characters (spec max: ${MAX_DESCRIPTION_LENGTH}).`,
      },
    ];
  }
  return [];
}

/**
 * Validation against the Agent Skills spec (https://agentskills.io/specification)
 * plus provider-specific notes that were verified in each provider's docs.
 */
export function validateSkill(skill: SkillToValidate): Issue[] {
  if (skill.parseError) {
    return [{ severity: 'error', code: 'frontmatter-invalid', message: `Frontmatter could not be parsed: ${skill.parseError}` }];
  }
  if (!skill.hasFrontmatter) {
    return [
      {
        severity: 'error',
        code: 'frontmatter-missing',
        message: 'SKILL.md has no YAML frontmatter. Cursor and Codex require `name` and `description`.',
      },
    ];
  }

  const frontmatter = skill.frontmatter;
  const issues: Issue[] = [...nameIssues(frontmatter['name'], skill.dirName), ...descriptionIssues(frontmatter['description'])];

  const compatibility = frontmatter['compatibility'];
  if (typeof compatibility === 'string' && compatibility.length > MAX_COMPATIBILITY_LENGTH) {
    issues.push({ severity: 'warning', code: 'compatibility-length', message: `\`compatibility\` exceeds ${MAX_COMPATIBILITY_LENGTH} characters.` });
  }

  const metadata = frontmatter['metadata'];
  const hasMetadata = metadata !== undefined && metadata !== null;
  if (hasMetadata && !isKeyValueMap(metadata)) {
    issues.push({ severity: 'warning', code: 'metadata-type', message: '`metadata` should be a key/value map.' });
  }

  if (skill.lineCount > RECOMMENDED_MAX_LINES) {
    issues.push({
      severity: 'info',
      code: 'long-skill',
      message: `SKILL.md has ${skill.lineCount} lines. The spec recommends under ${RECOMMENDED_MAX_LINES} and moving detail into referenced files.`,
    });
  }
  return issues;
}
