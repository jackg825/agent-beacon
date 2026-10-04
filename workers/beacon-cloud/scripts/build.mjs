import { build } from 'esbuild';
await build({ entryPoints: ['src/index.ts'], outfile: 'dist/worker.mjs', bundle: true,
  format: 'esm', target: 'es2022', platform: 'browser', sourcemap: false });
