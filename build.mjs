import { chmodSync } from 'node:fs';
import { build } from 'esbuild';

const common = { bundle: true, platform: 'node', format: 'esm', target: 'node22', banner: { js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module';\nconst require = __cr(import.meta.url);" } };

await build({ ...common, entryPoints: ['src/hooks/dispatch.ts'], outfile: 'dist/hooks/dispatch.mjs' });
await build({ ...common, entryPoints: ['src/cli/index.ts'], outfile: 'dist/cli.mjs' });
for (const f of ['dist/cli.mjs', 'dist/hooks/dispatch.mjs']) chmodSync(f, 0o755);
