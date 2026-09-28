// Bundles the browser code (chat + moderator console) into client/public,
// and copies the two display fonts used by dark mode (served from our own site, no third parties).
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import * as esbuild from 'esbuild';

const FONTS = [
  ['@fontsource/bungee/files/bungee-latin-400-normal.woff2', 'bungee-400.woff2'],
  ['@fontsource/silkscreen/files/silkscreen-latin-400-normal.woff2', 'silkscreen-400.woff2'],
  ['@fontsource/silkscreen/files/silkscreen-latin-700-normal.woff2', 'silkscreen-700.woff2'],
];
mkdirSync('client/public/fonts', { recursive: true });
for (const [from, to] of FONTS) {
  const src = `node_modules/${from}`;
  if (existsSync(src)) copyFileSync(src, `client/public/fonts/${to}`);
  else console.warn(`font not found (falls back to system fonts): ${src}`);
}

const options = {
  entryPoints: { app: 'client/src/app.ts', mod: 'client/src/mod.ts' },
  outdir: 'client/public',
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: process.env.NODE_ENV === 'production',
  sourcemap: true,
  logLevel: 'info',
};

if (process.argv.includes('--watch')) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
