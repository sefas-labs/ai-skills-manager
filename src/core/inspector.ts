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

const SCRIPT_EXT = /\.(sh|bash|zsh|fish|ps1|psm1|bat|cmd|py|js|mjs|cjs|ts|rb|pl|php|lua|exe|dll|so|dylib|jar|bin|app|scpt|applescript)$/i;
const TEXT_EXT = /\.(md|markdown|txt|json|ya?ml|toml|ini|cfg|csv|tsv|xml|html?|css|sh|bash|zsh|fish|ps1|psm1|bat|cmd|py|js|mjs|cjs|ts|tsx|jsx|rb|pl|php|lua|sql|r|go|rs|java|kt|swift|c|h|cpp|hpp|env|gitignore)$/i;

// Zero-width, bidi controls and Unicode "tag" characters (used to smuggle invisible instructions).
const HIDDEN_CHARS = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]|\uDB40[\uDC00-\uDC7F]/;

interface Rule {
  re: RegExp;
  severity: FindingSeverity;
  code: string;
  message: string;
  onlyIn?: RegExp;
}

const RULES: Rule[] = [
  {
    re: /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|system)\b[^.\n]{0,30}\b(instructions?|prompts?|rules?|messages?)\b/i,
    severity: 'high',
    code: 'prompt-override',
    message: 'Text that tries to override the agent’s other instructions.',
  },
  {
    re: /\b(do not|don't|never)\s+(tell|inform|mention|reveal|show)\b[^.\n]{0,30}\b(user|human|developer)\b/i,
    severity: 'high',
    code: 'concealment',
    message: 'Instruction to hide actions from the user.',
  },
  {
    re: /(curl|wget|iwr|invoke-webrequest)\b[^\n|]{0,200}\|\s*(sudo\s+)?(sh|bash|zsh|python3?|node|iex|pwsh|powershell)\b/i,
    severity: 'high',
    code: 'remote-exec',
    message: 'Downloads remote code and pipes it into an interpreter.',
  },
  {
    re: /base64\s+(-d|--decode)[^\n]{0,80}\|\s*(sh|bash|python3?|node)\b/i,
    severity: 'high',
    code: 'obfuscated-exec',
    message: 'Decodes base64 and executes it.',
  },
  {
    re: /(~|\$HOME|%USERPROFILE%)?[/\\]\.(ssh|aws|gnupg|kube|docker)[/\\]|\.aws\/credentials|id_rsa|id_ed25519|\.netrc|\.npmrc|\.pypirc/i,
    severity: 'warning',
    code: 'credential-path',
    message: 'References a location that typically holds credentials.',
  },
  {
    re: /(curl|wget|fetch|requests\.(post|get)|http\.request)[^\n]{0,160}\$\{?[A-Z0-9_]*(TOKEN|SECRET|PASSWORD|API_KEY|APIKEY|PRIVATE_KEY)[A-Z0-9_]*\}?/i,
    severity: 'high',
    code: 'secret-exfiltration',
    message: 'Sends what looks like a secret environment variable over the network.',
  },
  {
    re: /\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\$HOME)(\s|$)/i,
    severity: 'high',
    code: 'destructive-command',
    message: 'Recursive delete of the root or home directory.',
  },
  {
    re: /\b(chmod\s+\+x|sudo\s|crontab\b|launchctl\s+load|systemctl\s+enable|reg\s+add)\b/i,
    severity: 'warning',
    code: 'system-change',
    message: 'Changes permissions, scheduled jobs or system services.',
  },
  {
    re: /<!--[\s\S]{0,2000}?-->/,
    severity: 'info',
    code: 'html-comment',
    message: 'HTML comment: invisible when rendered, but read by the agent.',
    onlyIn: /\.md$/i,
  },
  {
    re: /[A-Za-z0-9+/]{400,}={0,2}/,
    severity: 'warning',
    code: 'encoded-blob',
    message: 'Long encoded (base64-like) blob.',
  },
];

function isProbablyBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Findings from the file list alone (used in the preview, before downloading everything). */
export function inspectFileList(files: Array<{ path: string; size?: number; mode?: string }>): Finding[] {
  const out: Finding[] = [];
  const scripts = files.filter((f) => SCRIPT_EXT.test(f.path) || f.mode === '100755');
  if (scripts.length) {
    out.push({
      severity: 'warning',
      code: 'contains-code',
      file: scripts.slice(0, 5).map((s) => s.path).join(', ') + (scripts.length > 5 ? ` (+${scripts.length - 5} more)` : ''),
      message: `Contains ${scripts.length} script/executable file(s). The agent may run them later when it uses this skill. They are installed without execute permission and never run by this extension.`,
    });
  }
  return out;
}

export function inspectContent(file: string, buf: Uint8Array): Finding[] {
  const out: Finding[] = [];
  if (isProbablyBinary(buf)) {
    if (!/\.(png|jpe?g|gif|webp|ico|svg|pdf|woff2?|ttf|otf)$/i.test(file)) {
      out.push({ severity: 'warning', code: 'binary', file, message: 'Binary file that cannot be reviewed as text.' });
    }
    return out;
  }
  if (!TEXT_EXT.test(file) && !/(^|\/)[^.]+$/.test(file)) return out;
  const text = Buffer.from(buf).toString('utf8');
  const lines = text.split('\n');
  const seen = new Set<string>();
  lines.forEach((line, idx) => {
    if (HIDDEN_CHARS.test(line) && !seen.has('hidden-unicode')) {
      seen.add('hidden-unicode');
      out.push({
        severity: 'high',
        code: 'hidden-unicode',
        file,
        line: idx + 1,
        message: 'Invisible or bidirectional Unicode characters (can hide instructions from reviewers).',
        excerpt: visualize(line),
      });
    }
  });
  for (const rule of RULES) {
    if (rule.onlyIn && !rule.onlyIn.test(file)) continue;
    const m = rule.re.exec(text);
    if (!m) continue;
    const line = text.slice(0, m.index).split('\n').length;
    out.push({ severity: rule.severity, code: rule.code, file, line, message: rule.message, excerpt: truncate(m[0]) });
  }
  return out;
}

function truncate(s: string, n = 160): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n) + '…' : one;
}

function visualize(s: string): string {
  return truncate(s.replace(/[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g, (c) => `<U+${c.charCodeAt(0).toString(16).toUpperCase()}>`));
}

export function worstSeverity(findings: Finding[]): FindingSeverity | undefined {
  if (findings.some((f) => f.severity === 'high')) return 'high';
  if (findings.some((f) => f.severity === 'warning')) return 'warning';
  if (findings.length) return 'info';
  return undefined;
}
