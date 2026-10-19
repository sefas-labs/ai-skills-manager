import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Which agents are installed on this machine, from cheap file-system
 * evidence only: nothing is executed. Each hit is reported so the UI can say
 * *why* an agent counts as detected. A miss is "not detected", not "absent"
 * (e.g. a CLI installed through a version manager the editor's PATH lacks).
 */
export interface AgentDetection {
  installed: boolean;
  evidence: string[];
}

export interface DetectionInput {
  homeDir: string;
  platform: NodeJS.Platform;
  /** Directories of the PATH the extension host sees. */
  pathDirs: string[];
  /** Ids of extensions installed in the host editor (any case). */
  extensionIds: string[];
  /** Agent built into the editor we run in ('cursor' in Cursor, 'copilot' in VS Code). */
  hostAgent?: string;
  /** Overridable for tests. */
  exists?: (p: string) => Promise<boolean>;
}

interface Probe {
  bins?: string[];
  homeFiles?: string[];
  extensions?: string[];
  apps?: Partial<Record<NodeJS.Platform, string[]>>;
}

// Checked on this machine on 2026-10-18: `claude` + ~/.claude.json + anthropic.claude-code;
// /Applications/Cursor.app; ~/.codex/{config.toml,auth.json}; VS Code 1.140 bundles
// GitHub.copilot-chat and Copilot writes ~/.copilot/.
const PROBES: Record<string, Probe> = {
  'claude-code': { bins: ['claude'], homeFiles: ['.claude.json'], extensions: ['anthropic.claude-code'] },
  cursor: {
    bins: ['cursor'],
    apps: {
      darwin: ['/Applications/Cursor.app', '~/Applications/Cursor.app'],
      win32: ['%LOCALAPPDATA%/Programs/cursor/Cursor.exe'],
    },
  },
  codex: { bins: ['codex'], homeFiles: ['.codex/config.toml', '.codex/auth.json'], extensions: ['openai.chatgpt'] },
  copilot: { bins: ['copilot'], homeFiles: ['.copilot'], extensions: ['github.copilot', 'github.copilot-chat'] },
};

const defaultExists = (p: string) => fs.access(p).then(() => true, () => false);

export async function detectAgents(ids: string[], input: DetectionInput): Promise<Record<string, AgentDetection>> {
  const exists = input.exists ?? defaultExists;
  const exts = new Set(input.extensionIds.map((e) => e.toLowerCase()));
  const exeSuffixes = input.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const expand = (p: string) =>
    p.replace(/^~(?=\/|$)/, input.homeDir).replace(/%LOCALAPPDATA%/g, process.env.LOCALAPPDATA ?? path.join(input.homeDir, 'AppData/Local'));

  const out: Record<string, AgentDetection> = {};
  for (const id of ids) {
    const probe = PROBES[id];
    const evidence: string[] = [];
    if (input.hostAgent === id) evidence.push('built into this editor');
    if (probe) {
      for (const e of probe.extensions ?? []) if (exts.has(e)) evidence.push(`extension ${e}`);
      for (const bin of probe.bins ?? []) {
        for (const dir of input.pathDirs) {
          const hit = await firstExisting(exeSuffixes.map((s) => path.join(dir, bin + s)), exists);
          if (hit) {
            evidence.push(`\`${bin}\` on PATH`);
            break;
          }
        }
      }
      for (const f of probe.homeFiles ?? []) if (await exists(path.join(input.homeDir, f))) evidence.push(`~/${f}`);
      for (const app of probe.apps?.[input.platform] ?? []) {
        const p = expand(app);
        if (await exists(p)) evidence.push(p.startsWith(input.homeDir) ? '~' + p.slice(input.homeDir.length) : p);
      }
    }
    out[id] = { installed: evidence.length > 0, evidence };
  }
  return out;
}

async function firstExisting(paths: string[], exists: (p: string) => Promise<boolean>): Promise<string | undefined> {
  for (const p of paths) if (await exists(p)) return p;
  return undefined;
}

/** The agent native to the editor, from vscode.env.appName. */
export function hostAgentFor(appName: string): string | undefined {
  if (/cursor/i.test(appName)) return 'cursor';
  if (/visual studio code|vscodium|code - oss/i.test(appName)) return 'copilot';
  return undefined;
}
