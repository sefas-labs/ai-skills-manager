/**
 * Static, heuristic inspection of third-party skill content before install.
 *
 * This is NOT a guarantee of safety. It highlights things a human should look
 * at: executable code, hidden characters, instructions that try to override the
 * agent, remote-code piping, and references to credentials. The user always
 * sees the findings and confirms explicitly.
 */

export type FindingSeverity = 'high' | 'warning' | 'info';

export interface Finding {
  severity: FindingSeverity;
  code: string;
  file: string;
  line?: number;
  message: string;
  excerpt?: string;
}

const SCRIPT_FILE = /\.(sh|bash|zsh|fish|ps1|psm1|bat|cmd|py|js|mjs|cjs|ts|rb|pl|php|lua|exe|dll|so|dylib|jar|bin|app|scpt|applescript)$/i;
const TEXT_FILE = /\.(md|markdown|txt|json|ya?ml|toml|ini|cfg|csv|tsv|xml|html?|css|sh|bash|zsh|fish|ps1|psm1|bat|cmd|py|js|mjs|cjs|ts|tsx|jsx|rb|pl|php|lua|sql|r|go|rs|java|kt|swift|c|h|cpp|hpp|env|gitignore)$/i;
const MEDIA_FILE = /\.(png|jpe?g|gif|webp|ico|svg|pdf|woff2?|ttf|otf)$/i;
const FILE_WITHOUT_EXTENSION = /(^|\/)[^.]+$/;
const EXECUTABLE_GIT_MODE = '100755';

/** Zero-width spaces/joiners, bidi controls, invisible operators and the byte order mark. */
const INVISIBLE_CHARACTER_CLASS = '[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF]';
/** Unicode "tag" characters (U+E0000–U+E007F), written as surrogate pairs; used to smuggle hidden text. */
const TAG_CHARACTER = '\\uDB40[\\uDC00-\\uDC7F]';
const HIDDEN_CHARACTER = new RegExp(`${INVISIBLE_CHARACTER_CLASS}|${TAG_CHARACTER}`);
const INVISIBLE_CHARACTER_GLOBAL = new RegExp(INVISIBLE_CHARACTER_CLASS, 'g');

/** How many leading bytes to scan for a NUL byte when deciding if a file is binary. */
const BINARY_SNIFF_BYTES = 8000;
const MAX_LISTED_SCRIPTS = 5;
const MAX_EXCERPT_LENGTH = 160;

interface Rule {
  pattern: RegExp;
  severity: FindingSeverity;
  code: string;
  message: string;
  /** Only check files whose path matches. */
  onlyIn?: RegExp;
}

const RULES: Rule[] = [
  {
    pattern: /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|system)\b[^.\n]{0,30}\b(instructions?|prompts?|rules?|messages?)\b/i,
    severity: 'high',
    code: 'prompt-override',
    message: 'Text that tries to override the agent’s other instructions.',
  },
  {
    pattern: /\b(do not|don't|never)\s+(tell|inform|mention|reveal|show)\b[^.\n]{0,30}\b(user|human|developer)\b/i,
    severity: 'high',
    code: 'concealment',
    message: 'Instruction to hide actions from the user.',
  },
  {
    pattern: /(curl|wget|iwr|invoke-webrequest)\b[^\n|]{0,200}\|\s*(sudo\s+)?(sh|bash|zsh|python3?|node|iex|pwsh|powershell)\b/i,
    severity: 'high',
    code: 'remote-exec',
    message: 'Downloads remote code and pipes it into an interpreter.',
  },
  {
    pattern: /base64\s+(-d|--decode)[^\n]{0,80}\|\s*(sh|bash|python3?|node)\b/i,
    severity: 'high',
    code: 'obfuscated-exec',
    message: 'Decodes base64 and executes it.',
  },
  {
    pattern: /(~|\$HOME|%USERPROFILE%)?[/\\]\.(ssh|aws|gnupg|kube|docker)[/\\]|\.aws\/credentials|id_rsa|id_ed25519|\.netrc|\.npmrc|\.pypirc/i,
    severity: 'warning',
    code: 'credential-path',
    message: 'References a location that typically holds credentials.',
  },
  {
    pattern: /(curl|wget|fetch|requests\.(post|get)|http\.request)[^\n]{0,160}\$\{?[A-Z0-9_]*(TOKEN|SECRET|PASSWORD|API_KEY|APIKEY|PRIVATE_KEY)[A-Z0-9_]*\}?/i,
    severity: 'high',
    code: 'secret-exfiltration',
    message: 'Sends what looks like a secret environment variable over the network.',
  },
  {
    pattern: /\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\$HOME)(\s|$)/i,
    severity: 'high',
    code: 'destructive-command',
    message: 'Recursive delete of the root or home directory.',
  },
  {
    pattern: /\b(chmod\s+\+x|sudo\s|crontab\b|launchctl\s+load|systemctl\s+enable|reg\s+add)\b/i,
    severity: 'warning',
    code: 'system-change',
    message: 'Changes permissions, scheduled jobs or system services.',
  },
  {
    pattern: /<!--[\s\S]{0,2000}?-->/,
    severity: 'info',
    code: 'html-comment',
    message: 'HTML comment: invisible when rendered, but read by the agent.',
    onlyIn: /\.md$/i,
  },
  {
    pattern: /[A-Za-z0-9+/]{400,}={0,2}/,
    severity: 'warning',
    code: 'encoded-blob',
    message: 'Long encoded (base64-like) blob.',
  },
];

function isProbablyBinary(bytes: Uint8Array): boolean {
  const bytesToCheck = Math.min(bytes.length, BINARY_SNIFF_BYTES);
  for (let index = 0; index < bytesToCheck; index++) {
    if (bytes[index] === 0) return true;
  }
  return false;
}

/** Findings from the file list alone (used in the preview, before downloading everything). */
export function inspectFileList(files: Array<{ path: string; size?: number; mode?: string }>): Finding[] {
  const scripts = files.filter((file) => SCRIPT_FILE.test(file.path) || file.mode === EXECUTABLE_GIT_MODE);
  if (!scripts.length) return [];
  const listed = scripts.slice(0, MAX_LISTED_SCRIPTS).map((script) => script.path).join(', ');
  const remaining = scripts.length - MAX_LISTED_SCRIPTS;
  return [
    {
      severity: 'warning',
      code: 'contains-code',
      file: remaining > 0 ? `${listed} (+${remaining} more)` : listed,
      message: `Contains ${scripts.length} script/executable file(s). The agent may run them later when it uses this skill. They are installed without execute permission and never run by this extension.`,
    },
  ];
}

function shouldReadAsText(file: string): boolean {
  return TEXT_FILE.test(file) || FILE_WITHOUT_EXTENSION.test(file);
}

function lineNumberAt(text: string, offset: number): number {
  return text.slice(0, offset).split('\n').length;
}

export function inspectContent(file: string, bytes: Uint8Array): Finding[] {
  if (isProbablyBinary(bytes)) {
    if (MEDIA_FILE.test(file)) return [];
    return [{ severity: 'warning', code: 'binary', file, message: 'Binary file that cannot be reviewed as text.' }];
  }
  if (!shouldReadAsText(file)) return [];

  const findings: Finding[] = [];
  const text = Buffer.from(bytes).toString('utf8');
  const lines = text.split('\n');
  const lineWithHiddenCharacters = lines.findIndex((line) => HIDDEN_CHARACTER.test(line));
  if (lineWithHiddenCharacters !== -1) {
    findings.push({
      severity: 'high',
      code: 'hidden-unicode',
      file,
      line: lineWithHiddenCharacters + 1,
      message: 'Invisible or bidirectional Unicode characters (can hide instructions from reviewers).',
      excerpt: showInvisibleCharacters(lines[lineWithHiddenCharacters]),
    });
  }
  for (const rule of RULES) {
    if (rule.onlyIn && !rule.onlyIn.test(file)) continue;
    const match = rule.pattern.exec(text);
    if (!match) continue;
    findings.push({ severity: rule.severity, code: rule.code, file, line: lineNumberAt(text, match.index), message: rule.message, excerpt: truncate(match[0]) });
  }
  return findings;
}

function truncate(text: string, maxLength = MAX_EXCERPT_LENGTH): string {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  return singleLine.length > maxLength ? singleLine.slice(0, maxLength) + '…' : singleLine;
}

/** Replaces each invisible character with a visible `<U+XXXX>` marker. */
function showInvisibleCharacters(text: string): string {
  const codePointLabel = (character: string) => `<U+${character.charCodeAt(0).toString(16).toUpperCase()}>`;
  return truncate(text.replace(INVISIBLE_CHARACTER_GLOBAL, codePointLabel));
}

export function worstSeverity(findings: Finding[]): FindingSeverity | undefined {
  if (findings.some((finding) => finding.severity === 'high')) return 'high';
  if (findings.some((finding) => finding.severity === 'warning')) return 'warning';
  if (findings.length) return 'info';
  return undefined;
}
