import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

// Each test file gets its own temp folder (inside the run folder from global-tmp.ts), removed when the file ends,
// so whatever the file or its spawns create with tmpdir() is cleaned up even though the tests never delete it.
const own = mkdtempSync(join(tmpdir(), 'file-'));
process.env.TMPDIR = process.env.TMP = process.env.TEMP = own;
afterAll(() => rmSync(own, { recursive: true, force: true, maxRetries: 3 }));
