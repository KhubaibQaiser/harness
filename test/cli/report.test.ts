import { chmodSync, existsSync, mkdirSync, writeFileSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { exportKnown, openCommand, report } from '../../src/cli/report.js';
import { encodeProjectDir } from '../../src/report/locate.js';
import { exportProblems } from '../../src/report/export.js';
import { assistant, prompt, writeSession } from '../fixtures/transcripts/make.js';

const base = mkdtempSync(join(tmpdir(), 'harness-report-'));
afterAll(() => {
  try { chmodSync(join(base, 'ro', '.harness'), 0o700); } catch { /* absent */ }
  rmSync(base, { recursive: true, force: true });
});
const NOW = Date.parse('2026-11-05T12:00:00Z');
const SECRET = 'SECRET-PROMPT-TEXT-xyzzy';

/** A temp repo and home; `n` sessions started inside the repo. */
let k = 0;
function world(n: number) {
  const dir = join(base, `w${++k}`), root = join(dir, 'repo'), home = join(dir, 'home');
  mkdirSync(root, { recursive: true });
  const proj = join(home, '.claude', 'projects', encodeProjectDir(realpathSync(root)));
  mkdirSync(proj, { recursive: true });
  for (let i = 0; i < n; i++) writeSession(proj, `s${i}`, [prompt(SECRET, { cwd: realpathSync(root) }), assistant()]);
  return { root, home };
}
const go = async (w: { root: string; home: string }, args: string[], extra: Record<string, unknown> = {}) => {
  const lines: string[] = [];
  const code = await report(args, { root: w.root, env: {}, out: (s) => lines.push(s), home: w.home, git: () => ({ status: 1, stdout: '' }), now: () => NOW, ...extra });
  return { code, lines, text: lines.join('\n') };
};
const htmlPath = (w: { root: string }) => join(w.root, '.harness/reports/2026-11-05.html');

describe('harness report', () => {
  it('writes the html and the self-ignoring folder, and prints counts only', async () => {
    const w = world(2);
    const r = await go(w, []);
    expect(r.code).toBe(0);
    expect(existsSync(htmlPath(w))).toBe(true);
    expect(readFileSync(join(w.root, '.harness/reports/.gitignore'), 'utf8')).toBe('*');
    expect(r.lines.length).toBeLessThanOrEqual(8);
    expect(r.text).not.toContain(SECRET);
    expect(r.text).not.toContain(w.home);
    expect(r.lines.at(-1)).toContain('.harness/reports/2026-11-05.html');
    expect(r.text).toMatch(/2 scanned/);
    expect(r.text).toMatch(/sideRecords/); // the windows notes counts
    expect(readFileSync(htmlPath(w), 'utf8')).toContain('<!doctype html>');
  });
  it('writes no folder .gitignore when the root one already ignores the folder', async () => {
    const w = world(0);
    writeFileSync(join(w.root, '.gitignore'), 'dist/\n.harness/reports/\n');
    expect((await go(w, [])).code).toBe(0);
    expect(existsSync(htmlPath(w))).toBe(true);
    expect(existsSync(join(w.root, '.harness/reports/.gitignore'))).toBe(false);
  });
  it.each([
    ['a negated line', 'dist/\n.harness/reports/\n!.harness/reports/\n'],
    ['a different spelling', '/.harness/reports\n'],
    ['a trailing space', '.harness/reports/ \n'],
    ['only a nested .gitignore', 'dist/\n'],
  ])('still writes the folder .gitignore for %s', async (_n, root_gi) => {
    const w = world(0);
    writeFileSync(join(w.root, '.gitignore'), root_gi);
    mkdirSync(join(w.root, '.harness'), { recursive: true });
    writeFileSync(join(w.root, '.harness/.gitignore'), 'reports/\n');
    expect((await go(w, [])).code).toBe(0);
    expect(readFileSync(join(w.root, '.harness/reports/.gitignore'), 'utf8')).toBe('*');
  });
  it('rejects bad arguments with exit 2', async () => {
    const w = world(0);
    for (const a of [['--days', '0'], ['--days', 'x'], ['--days'], ['--bogus']]) {
      const r = await go(w, a);
      expect(r.code, a.join(' ')).toBe(2);
      expect(r.text).toContain('harness report [--days N] [--open] [--export]');
    }
  });
  it('refuses inside Claude Code', async () => {
    const w = world(1);
    const r = await go(w, [], { env: { CLAUDECODE: '1' } });
    expect(r.code).toBe(1);
    expect(r.text).toContain('Run harness report in your own terminal for now.');
    expect(existsSync(htmlPath(w))).toBe(false);
  });
  it('with no sessions exits 0 and says to start Claude Code inside the repo', async () => {
    const r = await go(world(0), []);
    expect(r.code).toBe(0);
    expect(r.text).toContain('Start Claude Code inside the repo');
  });
  it('--export writes a clean counts-only json', async () => {
    const w = world(2);
    const r = await go(w, ['--export']);
    expect(r.code).toBe(0);
    const j = JSON.parse(readFileSync(join(w.root, '.harness/reports/2026-11-05-export.json'), 'utf8'));
    expect(exportProblems(j, exportKnown())).toEqual([]);
    expect(JSON.stringify(j)).not.toContain(SECRET);
  });
  it('refuses to write when the export has a problem, and lists kinds not values', async () => {
    const w = world(1);
    const r = await go(w, ['--export'], { buildExport: () => ({ schema: 1, harness: 'leak /Users/x/private' }) });
    expect(r.code).toBe(1);
    expect(r.text).toContain('string not on the allowlist');
    expect(r.text).not.toContain('/Users/x/private');
    expect(existsSync(join(w.root, '.harness/reports'))).toBe(false);
  });
  it('--open calls the seam with the html path', async () => {
    const w = world(1);
    const open = vi.fn();
    await go(w, ['--open'], { open });
    expect(open).toHaveBeenCalledWith(htmlPath(w));
  });
  it('does not open without --open', async () => {
    const open = vi.fn();
    await go(world(1), [], { open });
    expect(open).not.toHaveBeenCalled();
  });
  // chmod can't make a folder read-only on Windows, and root ignores it.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('exits 1 when .harness is read-only', async () => {
    const w = world(1);
    mkdirSync(join(w.root, '.harness'), { recursive: true });
    chmodSync(join(w.root, '.harness'), 0o500);
    const r = await go(w, []);
    chmodSync(join(w.root, '.harness'), 0o700);
    expect(r.code).toBe(1);
    expect(r.text).toContain('Could not write');
  });
  it('ignores sessions started outside the repo', async () => {
    const w = world(0);
    const proj = join(w.home, '.claude', 'projects', encodeProjectDir(realpathSync(w.root)));
    writeSession(proj, 'out', [prompt('x', { cwd: '/elsewhere' }), assistant()]);
    const r = await go(w, []);
    expect(r.text).toContain('Start Claude Code inside the repo');
  });
  it('stays within 8 lines with every optional line present, and prints the rules line', async () => {
    const r = await go(world(0), ['--export']);
    expect(r.lines.length).toBeLessThanOrEqual(8);
    expect(r.text).toContain('Rules enforced');
    expect(r.lines.at(-1)).toContain('.harness/reports/2026-11-05.html');
  });
  it('prints the real rules-enforced line', async () => {
    const r = await go(world(0), []);
    expect(r.text).toContain('Rules enforced: 1 of 11 rules enforced deterministically, 2 partly');
    expect(r.text).not.toContain('not computed');
  });
  it('renders the evals section only when eval results exist', async () => {
    const none = world(0);
    await go(none, []);
    expect(readFileSync(htmlPath(none), 'utf8')).not.toContain('id="evals"');
    const w = world(0);
    const dir = join(w.root, '.harness/reports/evals/2026-11-04-claude-x-skills');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'result.json'), JSON.stringify({ threshold: 1, cases: [{ name: 'case-one', arms: { with: [{ score: 1 }] } }] }));
    await go(w, []);
    const html = readFileSync(htmlPath(w), 'utf8');
    expect(html).toContain('id="evals"');
    expect(html).toContain('case-one');
  });
  it('rejects a huge --days', async () => {
    expect((await go(world(0), ['--days', '99999999'])).code).toBe(2);
  });
  it('turns a failure while collecting into one calm line and exit 1', async () => {
    const r = await go(world(1), [], { now: () => Number.NaN });
    expect(r.code).toBe(1);
    expect(r.lines).toHaveLength(1);
    expect(r.text).toContain('Could not build the report');
  });
  it('passes the path as one argv element, and never through cmd', () => {
    const p = 'C:\\a & b\\x^y.html';
    expect(openCommand('win32', p)).toEqual(['explorer.exe', [p]]);
    expect(openCommand('darwin', p)).toEqual(['open', [p]]);
    expect(openCommand('linux', p)).toEqual(['xdg-open', [p]]);
  });
});
