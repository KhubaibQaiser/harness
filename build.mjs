import { build } from 'esbuild';

const common = { bundle: true, platform: 'node', format: 'esm', target: 'node22', banner: { js: '#!/usr/bin/env node' } };

await build({ ...common, entryPoints: ['src/hooks/dispatch.ts'], outfile: 'dist/hooks/dispatch.mjs' });
await build({ ...common, entryPoints: ['src/cli/index.ts'], outfile: 'dist/cli.mjs' });
