// Bundles the extension host code and the dashboard webview with esbuild.
//   node scripts/build.mjs               development build (sourcemaps)
//   node scripts/build.mjs --production  minified, no sourcemaps
//   node scripts/build.mjs --watch
import * as esbuild from 'esbuild';
import { rmSync } from 'node:fs';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  minify: production,
  sourcemap: production ? false : 'linked',
  logLevel: 'info',
  legalComments: 'none',
};

const configs = [
  {
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode'],
  },
  {
    ...common,
    entryPoints: ['src/webview/main.ts'],
    outfile: 'dist/webview.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
  },
];

// Start clean so stale sourcemaps never end up in a package.
rmSync('dist', { recursive: true, force: true });

if (watch) {
  for (const c of configs) {
    const ctx = await esbuild.context(c);
    await ctx.watch();
  }
  console.log('[build] watching…');
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}
