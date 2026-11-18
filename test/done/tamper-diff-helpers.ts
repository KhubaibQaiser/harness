import { rmSync } from 'node:fs';
import { afterEach } from 'vitest';
import { contractHash, type Contract } from '../../src/done/contract.js';
import { defaultExec, type Exec } from '../../src/core/exec.js';
import { diffTamper } from '../../src/done/tamper-diff.js';
import { repoWith, type Files } from '../review/repo.js';

export const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
export const run = (base: Files, head: Files, o: Parameters<typeof diffTamper>[4] = {}, exec: Exec = defaultExec) => {
  const r = repoWith(base, head);
  dirs.push(r.root);
  return diffTamper(r.root, exec, r.base, r.head, o);
};
export const findings = (base: Files, head: Files, o?: Parameters<typeof diffTamper>[4]) => run(base, head, o).findings;
export const T = (body: string) => `test('a', () => {\n${body}\n});\n`;
export const contract = (id: string): Contract => {
  const c = { id, title: 't', base: 'a'.repeat(40), approved_by: 'person', approved_at: '2026-11-14T00:00:00Z', criteria: [] } as unknown as Contract;
  return { ...c, sha256: contractHash(c) } as Contract;
};
export const own = (id: string) => { const c = contract(id); return { text: JSON.stringify(c, null, 2) + '\n', own: { id, sha256: contractHash(c) } }; };
// Round 4
export const src = { 'src/a.ts': 'a' }, src2 = { 'src/a.ts': 'b' };
