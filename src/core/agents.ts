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
  exists?: (fullPath: string) => Promise<boolean>;
}

interface Probe {
  binaries?: string[];
  homeFiles?: string[];
  extensions?: string[];
  apps?: Partial<Record<NodeJS.Platform, string[]>>;
}

// Checked on this machine on 2026-10-18: `claude` + ~/.claude.json + anthropic.claude-code;
// /Applications/Cursor.app; ~/.codex/{config.toml,auth.json}; VS Code 1.140 bundles
// GitHub.copilot-chat and Copilot writes ~/.copilot/.
const PROBES: Record<string, Probe> = {
  'claude-code': { binaries: ['claude'], homeFiles: ['.claude.json'], extensions: ['anthropic.claude-code'] },
  cursor: {
    binaries: ['cursor'],
    apps: {
      darwin: ['/Applications/Cursor.app', '~/Applications/Cursor.app'],
      win32: ['%LOCALAPPDATA%/Programs/cursor/Cursor.exe'],
    },
  },
  codex: { binaries: ['codex'], homeFiles: ['.codex/config.toml', '.codex/auth.json'], extensions: ['openai.chatgpt'] },
  copilot: { binaries: ['copilot'], homeFiles: ['.copilot'], extensions: ['github.copilot', 'github.copilot-chat'] },
};

const WINDOWS_EXECUTABLE_SUFFIXES = ['.exe', '.cmd', '.bat', ''];
const UNIX_EXECUTABLE_SUFFIXES = [''];
const HOME_PREFIX = /^~(?=\/|$)/;
const LOCAL_APP_DATA_PLACEHOLDER = /%LOCALAPPDATA%/g;
const EDITOR_EVIDENCE = 'built into this editor';

const pathExists = (fullPath: string) => fs.access(fullPath).then(() => true, () => false);

async function firstExisting(candidates: string[], exists: (fullPath: string) => Promise<boolean>): Promise<string | undefined> {
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  return undefined;
}

export async function detectAgents(agentIds: string[], input: DetectionInput): Promise<Record<string, AgentDetection>> {
  const exists = input.exists ?? pathExists;
  const installedExtensions = new Set(input.extensionIds.map((id) => id.toLowerCase()));
  const executableSuffixes = input.platform === 'win32' ? WINDOWS_EXECUTABLE_SUFFIXES : UNIX_EXECUTABLE_SUFFIXES;
  const localAppData = process.env.LOCALAPPDATA ?? path.join(input.homeDir, 'AppData/Local');
  const expandAppPath = (appPath: string) => appPath.replace(HOME_PREFIX, input.homeDir).replace(LOCAL_APP_DATA_PLACEHOLDER, localAppData);
  const displayPath = (fullPath: string) => (fullPath.startsWith(input.homeDir) ? '~' + fullPath.slice(input.homeDir.length) : fullPath);

  const isOnPath = async (binary: string) => {
    for (const dir of input.pathDirs) {
      const candidates = executableSuffixes.map((suffix) => path.join(dir, binary + suffix));
      if (await firstExisting(candidates, exists)) return true;
    }
    return false;
  };

  const detections: Record<string, AgentDetection> = {};
  for (const agentId of agentIds) {
    const probe = PROBES[agentId];
    const evidence: string[] = [];
    if (input.hostAgent === agentId) evidence.push(EDITOR_EVIDENCE);
    if (probe) {
      for (const extension of probe.extensions ?? []) {
        if (installedExtensions.has(extension)) evidence.push(`extension ${extension}`);
      }
      for (const binary of probe.binaries ?? []) {
        if (await isOnPath(binary)) evidence.push(`\`${binary}\` on PATH`);
      }
      for (const homeFile of probe.homeFiles ?? []) {
        if (await exists(path.join(input.homeDir, homeFile))) evidence.push(`~/${homeFile}`);
      }
      for (const app of probe.apps?.[input.platform] ?? []) {
        const appPath = expandAppPath(app);
        if (await exists(appPath)) evidence.push(displayPath(appPath));
      }
    }
    detections[agentId] = { installed: evidence.length > 0, evidence };
  }
  return detections;
}

/** The agent native to the editor, from vscode.env.appName. */
export function hostAgentFor(appName: string): string | undefined {
  if (/cursor/i.test(appName)) return 'cursor';
  if (/visual studio code|vscodium|code - oss/i.test(appName)) return 'copilot';
  return undefined;
}
