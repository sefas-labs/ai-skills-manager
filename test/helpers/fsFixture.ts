import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export async function tempDir(prefix = 'skills-test-'): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

export function skillMd(name: string, description = `Does ${name} things. Use when testing.`, extra = ''): string {
  return `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n\nInstructions.\n`;
}

export async function writeSkill(root: string, dirName: string, content = skillMd(dirName), files: Record<string, string> = {}): Promise<string> {
  const dir = path.join(root, dirName);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), content);
  for (const [rel, c] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), c);
  }
  return dir;
}
