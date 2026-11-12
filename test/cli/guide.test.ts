import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import { run } from '../../src/cli/index.js';

const cli = (root: string, ...argv: string[]) => {
  const lines: string[] = [];
  const code = run(argv, { root, env: {}, out: (l) => lines.push(l) });
  return { code, out: lines.join('\n') };
};
const read = (p: string) => readFileSync(p, 'utf8');

test('guide prints each bundled doc as it is on disk', () => {
  for (const [name, file] of [['init-skill', 'skills/init/SKILL.md'], ['init-interview', 'skills/init/interview.md'], ['init-recommend', 'skills/init/recommend.md'], ['review-rubric', 'templates/skills/review-rubric/SKILL.md'], ['preset-interview', 'skills/preset/interview.md']]) {
    const r = cli('/', 'guide', name);
    expect(r.code, name).toBe(0);
    expect(r.out, name).toBe(read(file));
  }
});

test('guide preset-example prints the yaml, then each file of its folder under its path', () => {
  const r = cli('/', 'guide', 'preset-example');
  expect(r.code).toBe(0);
  expect(r.out.startsWith('## khubaib-frontend.yaml\n')).toBe(true);
  expect(r.out).toContain(read('catalog/presets/khubaib-frontend.yaml'));
  expect(r.out).toContain('## khubaib-frontend/templates/core.md\n');
  expect(r.out).toContain(read('catalog/presets/khubaib-frontend/templates/core.md'));
  expect(r.out).toMatch(/## khubaib-frontend\/items\/[^\n]+\.yaml\n/);
});

test('guide with an unknown or missing name is a usage error that lists the names', () => {
  for (const argv of [['guide', 'nope'], ['guide'], ['guide', 'init-interview', 'x']]) {
    const r = cli('/', ...argv);
    expect(r.code).toBe(2);
    for (const n of ['init-skill', 'init-interview', 'init-recommend', 'review-rubric', 'preset-interview', 'preset-example']) expect(r.out).toContain(n);
  }
});

const repo = () => realpathSync(mkdtempSync(join(tmpdir(), 'harness-wd-')));

test('workdir makes a fresh folder under .harness/tmp, git-ignored, and prints its path', () => {
  const root = repo();
  const a = cli(root, 'workdir'), b = cli(root, 'workdir');
  expect(a.code).toBe(0);
  expect(dirname(a.out)).toBe(join(root, '.harness', 'tmp'));
  expect(existsSync(a.out)).toBe(true);
  expect(b.out).not.toBe(a.out);
  expect(read(join(root, '.harness/tmp/.gitignore'))).toBe('*\n');
  writeFileSync(join(root, '.harness/tmp/.gitignore'), 'mine\n');
  cli(root, 'workdir');
  expect(read(join(root, '.harness/tmp/.gitignore'))).toBe('mine\n'); // only written when missing
});

test('workdir --clean removes that folder and nothing else', () => {
  const root = repo();
  const a = cli(root, 'workdir').out, b = cli(root, 'workdir').out;
  writeFileSync(join(a, 'answers.json'), '{}');
  expect(cli(root, 'workdir', '--clean', a).code).toBe(0);
  expect(existsSync(a)).toBe(false);
  expect(existsSync(b)).toBe(true);
});

test('workdir --clean refuses any path not directly under .harness/tmp', () => {
  const root = repo();
  const a = cli(root, 'workdir').out;
  mkdirSync(join(a, 'sub'));
  for (const p of [join(root, '.harness/tmp'), join(root, '.harness'), root, join(a, 'sub'), join(root, '.harness/tmp/.gitignore'), join(a, '..', '..', 'config.yaml'), '/tmp', join(root, 'src')]) {
    const r = cli(root, 'workdir', '--clean', p);
    expect(r.code, p).toBe(2);
  }
  expect(existsSync(join(a, 'sub'))).toBe(true);
  expect(existsSync(join(root, '.harness/tmp/.gitignore'))).toBe(true);
  expect(cli(root, 'workdir', '--clean').code).toBe(2);
});

test('workdir refuses a symlinked .harness/tmp', () => {
  const root = repo();
  const away = repo();
  mkdirSync(join(root, '.harness'));
  symlinkSync(away, join(root, '.harness/tmp'));
  mkdirSync(join(away, 'x'));
  expect(cli(root, 'workdir').code).toBe(2);
  expect(cli(root, 'workdir', '--clean', join(root, '.harness/tmp/x')).code).toBe(2);
  expect(existsSync(join(away, 'x'))).toBe(true);
});
