// Bundles the browser code (chat + moderator console) into client/public.
import * as esbuild from 'esbuild';

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
