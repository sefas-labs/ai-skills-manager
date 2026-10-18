// Runs `node --test` on an explicit file list. Glob arguments to `node --test`
// only work on Node 21+, and on Node 20 a quoted glob silently runs nothing.
//   node scripts/run-tests.mjs <dir> <suffix>
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const [dir, suffix] = process.argv.slice(2);
if (!dir || !suffix) {
  console.error('usage: node scripts/run-tests.mjs <dir> <suffix>');
  process.exit(2);
}

const files = [];
const walk = (d) => {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith(suffix)) files.push(p);
  }
};
walk(dir);
files.sort();
if (files.length === 0) {
  console.error(`No ${suffix} files under ${dir}`);
  process.exit(1);
}
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
