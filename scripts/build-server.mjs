// Bundles the server into dist/server.js. esbuild doesn't type-check, so a small type
// mismatch can never block a deploy; run `npm run typecheck` during development instead.
import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['server/index.ts'],
  outfile: 'dist/server.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external', // node_modules stay as normal imports
  sourcemap: true,
  logLevel: 'info',
});
