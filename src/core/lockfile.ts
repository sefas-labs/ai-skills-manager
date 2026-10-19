import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathKey } from './paths';
import type { LockEntry } from './types';

interface LockFileShape {
  version: 1;
  entries: Record<string, LockEntry>;
}

/**
 * Records where each skill installed by this extension came from (repo, ref,
 * commit, subpath, tree SHA). Stored in the extension's global storage, never
 * inside the skill, so installed content stays byte-for-byte what the author
 * published.
 */
export class LockStore {
  private data: LockFileShape = { version: 1, entries: {} };
  private loaded = false;
  /** Saves run one after another: concurrent installs/removals must not race on the file. */
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly file: string, private readonly platform: NodeJS.Platform = process.platform) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as LockFileShape;
      if (parsed && parsed.version === 1 && parsed.entries && typeof parsed.entries === 'object') this.data = parsed;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Corrupt lock: keep a copy and start fresh rather than crash.
        await fs.copyFile(this.file, `${this.file}.corrupt-${Date.now()}`).catch(() => undefined);
      }
      this.data = { version: 1, entries: {} };
    }
    this.loaded = true;
  }

  get(dir: string): LockEntry | undefined {
    return this.data.entries[pathKey(dir, this.platform)];
  }

  all(): LockEntry[] {
    return Object.values(this.data.entries);
  }

  async set(entry: LockEntry): Promise<void> {
    if (!this.loaded) await this.load();
    this.data.entries[pathKey(entry.dir, this.platform)] = entry;
    await this.save();
  }

  async remove(dir: string): Promise<void> {
    if (!this.loaded) await this.load();
    delete this.data.entries[pathKey(dir, this.platform)];
    await this.save();
  }

  private save(): Promise<void> {
    const run = async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      await fs.rename(tmp, this.file);
    };
    this.saving = this.saving.then(run, run);
    return this.saving;
  }
}
