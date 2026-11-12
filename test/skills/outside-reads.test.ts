import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const skills = readdirSync('skills').flatMap((d) => readdirSync(join('skills', d)).map((f) => join('skills', d, f)));

test('no skill reads or writes outside the repo: plugin files come from `guide`, work files from `workdir`', () => {
  for (const f of skills) {
    const t = readFileSync(f, 'utf8');
    // The plugin root appears only as the CLI's own path.
    expect(t.replaceAll('"${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs"', ''), f).not.toContain('CLAUDE_PLUGIN_ROOT');
    expect(t, f).not.toMatch(/mktemp|temp dir outside/);
  }
});

test('the work folder is made by workdir and cleaned on every stop', () => {
  for (const f of ['skills/init/SKILL.md', 'skills/vet/SKILL.md', 'skills/preset/SKILL.md']) {
    const t = readFileSync(f, 'utf8');
    expect(t, f).toMatch(/(dist\/cli\.mjs" |CLI `)workdir`/);
    expect(t, f).toMatch(/workdir --clean <[a-z]+>[^\n]*(every stop|any stop|on every|at the end)|(every stop|any stop)[^\n]*workdir --clean/);
  }
});

test('init passes the rubric text inline, from guide review-rubric, not a path', () => {
  const init = readFileSync('skills/init/SKILL.md', 'utf8'), rec = readFileSync('skills/init/recommend.md', 'utf8');
  for (const n of ['init-interview', 'init-recommend', 'review-rubric']) expect(init).toContain(`dist/cli.mjs" guide ${n}\``);
  expect(rec).toMatch(/rubric text/);
  expect(rec).not.toMatch(/rubric path/);
  expect(readFileSync('skills/preset/SKILL.md', 'utf8')).toContain('dist/cli.mjs" guide preset-example`');
});
