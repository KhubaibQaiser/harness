import { realpathSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultExec, type Exec } from '../../src/core/exec.js';
import { countViolations, resolveBin } from '../../src/rules/count.js';
import { LINT_RULES } from '../../src/rules/table.js';
import type { Proposal } from '../../src/rules/propose.js';

const byId = (ids: string[]) => LINT_RULES.filter((r) => ids.includes(r.id));
const proposal = (): Proposal => ({
  configText: 'export default [];\n',
  rules: byId(['max-depth', 'react/no-array-index-key', 'react-hooks/set-state-in-effect']),
  missing: [],
  skipped: [],
  ts: { noUncheckedIndexedAccess: true },
  noLint: [],
});
const report = (ids: string[]) => JSON.stringify([{ filePath: 'a.ts', messages: ids.map((ruleId) => ({ ruleId })) }]);
const state = (root: string) => join(root, '.harness', 'state');
let root: string;
/** A fake package under root/node_modules whose bin is the given JS, declared the way the real ones are. */
function fakePkg(at: string, name: string, bin: string, js: string) {
  const dir = join(at, 'node_modules', name);
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', bin: { [name === 'typescript' ? 'tsc' : name]: bin } }));
  writeFileSync(join(dir, bin), js);
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'count-'));
  writeFileSync(join(root, 'eslint.config.mjs'), 'export default [];\n');
  writeFileSync(join(root, 'tsconfig.json'), '{}');
  fakePkg(root, 'eslint', 'bin/eslint.js', '');
  fakePkg(root, 'typescript', 'bin/tsc', '');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const leftovers = () => (existsSync(state(root)) ? readdirSync(state(root)) : []);

const tscOut = (n: number) => Array.from({ length: n }, (_, i) => `a.ts(${i},1): error TS2322: x`).join('\n');
const fake = (o: { eslint?: ReturnType<Exec>[]; tsc?: (args: string[]) => ReturnType<Exec> }): { exec: Exec; calls: string[][]; cmds: string[] } => {
  const calls: string[][] = [];
  const cmds: string[] = [];
  const queue = [...(o.eslint ?? [])];
  const exec: Exec = (cmd, [bin = '', ...args]) => {
    cmds.push(cmd);
    calls.push([bin, ...args]);
    if (bin.endsWith('eslint.js')) return queue.shift() ?? { status: 0, stdout: '[]' };
    return o.tsc ? o.tsc(args) : { status: 0, stdout: '' };
  };
  return { exec, calls, cmds };
};

describe('countViolations', () => {
  it('counts eslint messages per proposed rule', async () => {
    const f = fake({ eslint: [{ status: 1, stdout: report(['max-depth', 'max-depth', 'react/no-array-index-key', 'other/x']) }] });
    const c = await countViolations(root, proposal(), f.exec);
    expect(c.eslint.byRule).toEqual({ 'max-depth': 2, 'react/no-array-index-key': 1 });
    expect(new Set(f.cmds)).toEqual(new Set([process.execPath]));
    expect(f.calls[0]!.slice(1, 3)).toEqual(['--config', join(state(root), 'rules-preview.mjs')]);
    expect(leftovers()).toEqual([]);
  });

  it('drops a rule named in a config error and retries', async () => {
    const err = { status: 2, stdout: '', stderr: "Definition for rule 'react-hooks/set-state-in-effect' not found." };
    const f = fake({ eslint: [err, { status: 0, stdout: report(['max-depth']) }] });
    const c = await countViolations(root, proposal(), f.exec);
    expect(c.eslint.dropped).toEqual([{ rule: 'react-hooks/set-state-in-effect', plugin: 'eslint-plugin-react-hooks' }]);
    expect(c.eslint.byRule).toEqual({ 'max-depth': 1 });
    expect(f.calls.filter((x) => x[0]!.endsWith('eslint.js'))).toHaveLength(2);
  });

  it('reports a timeout as error with empty byRule', async () => {
    const f = fake({ eslint: [{ status: 1, stdout: '', timedOut: true }], tsc: () => ({ status: 1, stdout: '', timedOut: true }) });
    const c = await countViolations(root, proposal(), f.exec);
    expect(c.eslint.error).toMatch(/timed out/);
    expect(c.eslint.byRule).toEqual({});
    expect(c.ts).toEqual({ byOption: { noUncheckedIndexedAccess: null }, baseline: null });
    expect(leftovers()).toEqual([]);
  });

  it('gives error, not a crash, for malformed json', async () => {
    const f = fake({ eslint: [{ status: 1, stdout: '{not json' }] });
    const c = await countViolations(root, proposal(), f.exec);
    expect(c.eslint.error).toBe('eslint output was not valid JSON');
  });

  it('gives the ts delta over the baseline', async () => {
    const f = fake({ tsc: (a) => ({ status: 2, stdout: tscOut(a.some((x) => x.includes('tsconfig.noUnchecked')) ? 10 : 3) }) });
    const c = await countViolations(root, proposal(), f.exec);
    expect(c.ts).toEqual({ byOption: { noUncheckedIndexedAccess: 7 }, baseline: 3 });
    expect(leftovers()).toEqual([]);
  });

  it('cleans up preview files when exec throws', async () => {
    mkdirSync(state(root), { recursive: true });
    const exec: Exec = () => {
      throw new Error('boom');
    };
    const c = await countViolations(root, proposal(), exec);
    expect(c.eslint.error).toBeTruthy();
    expect(leftovers()).toEqual([]);
  });

  it('reports unknown, never 0, when tsc did not run', async () => {
    const f = fake({ tsc: () => ({ status: 1, stdout: '', stderr: 'spawn ENOENT' }) });
    expect((await countViolations(root, proposal(), f.exec)).ts).toEqual({ byOption: { noUncheckedIndexedAccess: null }, baseline: null });
    const g = fake({ tsc: (a) => (a.some((x) => x.includes('tsconfig.noUnchecked')) ? { status: 1, stdout: '' } : { status: 0, stdout: '' }) });
    expect((await countViolations(root, proposal(), g.exec)).ts).toEqual({ byOption: { noUncheckedIndexedAccess: null }, baseline: 0 });
    const m = fake({ tsc: () => ({ status: 127, stdout: '', missing: true }) });
    expect((await countViolations(root, proposal(), m.exec)).ts.baseline).toBeNull();
  });

  it('counts jsx-a11y style set messages and ignores the preview files', async () => {
    const p = { ...proposal(), rules: byId(['jsx-a11y', 'max-depth']) };
    const f = fake({ eslint: [{ status: 1, stdout: report(['jsx-a11y/alt-text', 'jsx-a11y/alt-text', 'max-depth']) }] });
    const c = await countViolations(root, p, f.exec);
    expect(c.eslint.byRule).toEqual({ 'jsx-a11y/alt-text': 2, 'max-depth': 1 });
    expect(f.calls[0]).toContain('--ignore-pattern');
  });

  it('removes tsbuildinfo files tsc leaves behind', async () => {
    const f = fake({
      tsc: () => {
        mkdirSync(state(root), { recursive: true });
        writeFileSync(join(state(root), 'tsconfig.noUncheckedIndexedAccess.tsbuildinfo'), '{}');
        return { status: 0, stdout: '' };
      },
    });
    await countViolations(root, proposal(), f.exec);
    expect(leftovers()).toEqual([]);
  });

  it('generates a preview that loads: repo config first, dropped rule filtered out', async () => {
    const keep = join(root, 'kept');
    mkdirSync(keep);
    let runs = 0;
    const p = proposal();
    p.configText = "export default [{ files: ['**'], rules: { 'max-depth': 'error', 'react-hooks/set-state-in-effect': 'error' } }];\n";
    writeFileSync(join(root, 'eslint.config.mjs'), "export default [{ rules: { 'no-var': 'error' } }];\n");
    const err = { status: 2, stdout: '', stderr: "Definition for rule 'react-hooks/set-state-in-effect' not found." };
    const exec: Exec = (_cmd, args) => {
      if (!args[0]!.endsWith('eslint.js')) return { status: 0, stdout: '' };
      for (const f of ['rules-preview.mjs', 'rules-preview.proposal.mjs']) copyFileSync(join(state(root), f), join(keep, f));
      return runs++ === 0 ? err : { status: 0, stdout: '[]' };
    };
    const c = await countViolations(root, p, exec);
    expect(c.eslint.dropped.map((d) => d.rule)).toEqual(['react-hooks/set-state-in-effect']);
    const cfg = ((await import(pathToFileURL(join(keep, 'rules-preview.mjs')).href)) as { default: { rules: Record<string, string> }[] }).default;
    expect(cfg[0]!.rules).toEqual({ 'no-var': 'error' });
    expect(cfg[1]!.rules).toEqual({ 'max-depth': 'error' });
  });

  it('reports eslint and tsc as unknown when they cannot be resolved', async () => {
    rmSync(join(root, 'node_modules'), { recursive: true });
    let called = false;
    const exec: Exec = () => ((called = true), { status: 0, stdout: '' });
    const c = await countViolations(root, proposal(), exec);
    expect(c.eslint).toEqual({ byRule: {}, dropped: [], error: 'eslint is not installed' });
    expect(c.ts).toEqual({ byOption: { noUncheckedIndexedAccess: null }, baseline: null });
    expect(called).toBe(false);
  });

  it('runs the resolved bin files through node for real', async () => {
    const json = report(['max-depth', 'max-depth']);
    fakePkg(root, 'eslint', 'bin/eslint.js', `process.stdout.write(${JSON.stringify(json)}); process.exit(1);`);
    const ts = "const n = process.argv.includes('-p') && process.argv[process.argv.indexOf('-p') + 1].includes('noUnchecked') ? 5 : 2; for (let i = 0; i < n; i++) console.log('a.ts: error TS1: x'); process.exit(2);";
    fakePkg(root, 'typescript', 'bin/tsc', ts);
    const c = await countViolations(root, proposal(), defaultExec);
    expect(c.eslint.byRule).toEqual({ 'max-depth': 2 });
    expect(c.ts).toEqual({ byOption: { noUncheckedIndexedAccess: 3 }, baseline: 2 });
  });

  it('times out a hung bin through node and reports unknown', async () => {
    fakePkg(root, 'eslint', 'bin/eslint.js', 'setTimeout(() => {}, 10000);');
    fakePkg(root, 'typescript', 'bin/tsc', 'setTimeout(() => {}, 10000);');
    const c = await countViolations(root, proposal(), defaultExec, 300);
    expect(c.eslint.error).toBe('eslint timed out');
    expect(c.ts.baseline).toBeNull();
  });

  it('resolves a string-form bin', () => {
    const dir = join(root, 'node_modules', 'strbin');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'strbin', bin: 'cli.js' }));
    writeFileSync(join(dir, 'cli.js'), '');
    expect(resolveBin(root, 'strbin', 'strbin')).toBe(realpathSync(join(dir, 'cli.js')));
  });

  it('ignores a tool found only outside the repo node_modules', async () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'count-parent-')));
    const sub = join(parent, 'repo');
    mkdirSync(sub);
    writeFileSync(join(sub, 'tsconfig.json'), '{}');
    fakePkg(parent, 'eslint', 'bin/eslint.js', '');
    fakePkg(parent, 'typescript', 'bin/tsc', '');
    try {
      expect(resolveBin(sub, 'eslint', 'eslint')).toBeNull();
      const f = fake({});
      const c = await countViolations(sub, proposal(), f.exec);
      expect(c.eslint.error).toBe('eslint is not installed');
      expect(c.ts.baseline).toBeNull();
      expect(f.calls).toEqual([]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
