import * as realFs from 'node:fs';
import type { FsLike } from '../../src/install/apply.js';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { parse as parseYaml, parseDocument } from 'yaml';
import { update } from '../../src/cli/update.js';
import { uninstall } from '../../src/cli/uninstall.js';
import { readManifest } from '../../src/install/apply.js';
import { decision, syncNow, writeDecision } from '../core/decisions-helpers.js';
import { execFileSync } from 'node:child_process';
import { pkgDir, templatesDir, REPO, fake, newDist, commitAll, installed, up, betaInstall, settingsBlocks, OWN_IDS, aiInstalled } from './update-helpers.js';

test('beta repo update inside Claude Code without AI flags refreshes files only', async () => {
  const root = await installed();
  const fresh = settingsBlocks(root);
  const beta = betaInstall(root, {});
  let out = '';
  const code = await update(['--yes'], { env: { CLAUDECODE: '1' }, root, out: (s) => (out += s + '\n'), prompt: fake(), version: '1.1.0', templatesDir, distDir: join(pkgDir, 'dist') });
  expect(code).toBe(0);
  expect(new Set(settingsBlocks(root))).toEqual(new Set(fresh));
  expect(settingsBlocks(root).filter((b) => beta.includes(b) && JSON.parse(b).event)).toEqual([]);
  expect(out).not.toContain('Removed');
  expect(out.trim().split('\n').pop()).toBe('Run /harness:update again to get recommendations for this repo.');
});

test('up to date inside Claude Code on the plain path still points to /harness:update, but not on a dry run', async () => {
  const root = await installed();
  const run = (args: string[]) => { let out = ''; return update(args, { env: { CLAUDECODE: '1' }, root, out: (s) => (out += s + '\n'), prompt: fake(), version: '1.0.0', templatesDir, distDir: join(pkgDir, 'dist') }).then(() => out); };
  const again = 'Run /harness:update again to get recommendations for this repo.';
  expect(await run(['--yes'])).toContain(again);
  expect(await run(['--dry-run'])).not.toContain(again);
});

// Ask once, then exempt: items the person already approved count on both sides, so they never ask again.
test('update with AI flags: an approved plugin does not ask, a newly added one does', async () => {
  const root = aiInstalled(REPO, [...OWN_IDS, 'impeccable']);
  const d = mkdtempSync(join(tmpdir(), 'harness-upd-ai-'));
  const flags = (ids: string[]) => {
    const w = (n: string, t: string) => (writeFileSync(join(d, n), t), join(d, n));
    const sec = ['Purpose', 'Users', 'Core features', 'Constraints', 'Non-goals', 'Sources'].map((s) => `## ${s}\nx\n`).join('\n');
    return [
      '--answers', w('a.json', JSON.stringify({ scope: { paths: ['src'] }, project: { type: 'library', domain: 'tools', compliance: [], data_handling: '', team_size: 1, open_source: false, codeowners: [], deploy_target: '', run_budget_usd: 0, named_items: [] }, apps: [], unattended: { multi_file_gate: 'block', require_reason: false }, tdd: { paths: ['src/**'], diff_coverage: 80 } })),
      '--product', w('p.md', sec),
      '--picks', w('k.json', JSON.stringify({ catalog_version: 1, findings: [], items: ids.map((id) => ({ id, include: 'recommended', reason: 'r', addresses: [] })) })),
      '--report', w('r.md', '## Findings\n\n## Roadmap\n30 days, 60 days, 90 days.\n\n## Deliberate exclusions\nnone\n\n## Limits\nx\n'),
      '--choose', ids.join(','),
    ];
  };
  const run = async (ids: string[], extra: string[] = [], over: object = {}) => {
    let out = '';
    const code = await update([...flags(ids), '--yes', ...extra], { ...over, env: { CLAUDECODE: '1', HARNESS_PLAIN_INIT: '1' }, root, out: (s) => (out += s + '\n'), prompt: fake(), version: '1.1.0', templatesDir, distDir: join(pkgDir, 'dist'), claudeVersion: () => null });
    return { code, out };
  };
  const added = await run([...OWN_IDS, 'impeccable', 'mobile-mcp']);
  expect(added.code).toBe(2);
  expect(added.out).toContain('Not measured before install: mobile-mcp');
  expect(added.out).toMatch(/Approved earlier: .*impeccable/);
  expect(added.out).toContain('Run again with --over-budget');
  const same = await run([...OWN_IDS, 'impeccable']);
  expect(same.code).toBe(0);
  expect(same.out).not.toContain('Over budget');
});

test('update --install-plugins after a committed hand edit does not record it, and the key survives uninstall; a clean one is recorded', async () => {
  const ids = [...OWN_IDS, 'impeccable'];
  const d = mkdtempSync(join(tmpdir(), 'harness-upd-ai-'));
  const w = (n: string, t: string) => (writeFileSync(join(d, n), t), join(d, n));
  const flags = [
    '--answers', w('a.json', JSON.stringify({ scope: { paths: ['src'] }, project: { type: 'library', domain: 'tools', compliance: [], data_handling: '', team_size: 1, open_source: false, codeowners: [], deploy_target: '', run_budget_usd: 0, named_items: [] }, apps: [], unattended: { multi_file_gate: 'block', require_reason: false }, tdd: { paths: ['src/**'], diff_coverage: 80 } })),
    '--product', w('p.md', ['Purpose', 'Users', 'Core features', 'Constraints', 'Non-goals', 'Sources'].map((s) => `## ${s}\nx\n`).join('\n')),
    '--picks', w('k.json', JSON.stringify({ catalog_version: 1, findings: [], items: ids.map((id) => ({ id, include: 'recommended', reason: 'r', addresses: [] })) })),
    '--report', w('r.md', '## Findings\n\n## Roadmap\n30 days, 60 days, 90 days.\n\n## Deliberate exclusions\nnone\n\n## Limits\nx\n'),
    '--choose', ids.join(','), '--yes', '--install-plugins',
  ];
  const go = async (root: string, hand: boolean) => {
    const p = join(root, '.claude/settings.json');
    if (hand) { writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, 'utf8')), mine: { keep: true } }, null, 2) + '\n'); commitAll(root); }
    const exec = (_c: string, a: string[]) => {
      if (!a.includes('install')) return { status: 0, stdout: '[]' };
      const j = JSON.parse(readFileSync(p, 'utf8'));
      j.enabledPlugins[Object.keys(j.enabledPlugins).find((k) => k.startsWith('impeccable@harness-pins-'))!] = false; // claude's own write
      writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
      return { status: 0, stdout: '{"command":"install","outcome":"ok","message":""}' };
    };
    let out = '';
    const code = await update(flags, { env: { CLAUDECODE: '1', HARNESS_PLAIN_INIT: '1' }, root, out: (s) => (out += s + '\n'), prompt: fake(), version: '1.1.0', templatesDir, distDir: join(pkgDir, 'dist'), claudeVersion: () => null, exec });
    return { code, out, p };
  };
  const dirty = aiInstalled(REPO, ids);
  const r = await go(dirty, true);
  expect(r.code, r.out).toBe(0);
  expect(r.out).toContain('settings.json has other edits; not recorded. Run /harness:update to review them.');
  expect(await uninstall(['--yes'], { env: {}, root: dirty, out: () => {}, prompt: fake() })).toBe(0);
  expect(JSON.parse(readFileSync(r.p, 'utf8')).mine).toEqual({ keep: true });
  const clean = aiInstalled(REPO, ids);
  const c = await go(clean, false);
  expect(c.code, c.out).toBe(0);
  expect(c.out).not.toContain('not recorded');
  expect(await uninstall(['--yes'], { env: {}, root: clean, out: () => {}, prompt: fake() })).toBe(0);
  const first = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: clean, encoding: 'utf8' }).trim();
  expect(execFileSync('git', ['diff', first], { cwd: clean, encoding: 'utf8' })).toBe('');
});

test('update: plugin flags without AI flags are a usage error; an EPERM write prints the ! line and rolls back', async () => {
  const root = aiInstalled(REPO, [...OWN_IDS, 'impeccable']);
  expect((await up(root, ['--yes', '--install-plugins'])).code).toBe(2);
  const before = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  const fs = { ...realFs, renameSync: (a: string, b: string) => { if (b.endsWith('dispatch.mjs')) throw Object.assign(new Error('EPERM: nope'), { code: 'EPERM', path: a, dest: b }); return realFs.renameSync(a, b); } } as unknown as FsLike;
  const r = await up(root, ['--yes'], { fs, distDir: newDist() });
  expect(r.code).toBe(1);
  expect(r.out).toContain("Run this yourself with Claude Code's `!` prefix");
  expect(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })).toBe(before); // no lock either: nothing was written
});

test('update on an unchanged selection asks before installing plugins unless --yes', async () => {
  const root = aiInstalled(REPO, [...OWN_IDS, 'impeccable']);
  const d = mkdtempSync(join(tmpdir(), 'harness-upd-ai-'));
  const w = (n: string, t: string) => (writeFileSync(join(d, n), t), join(d, n));
  const ids = [...OWN_IDS, 'impeccable'];
  const flags = [
    '--answers', w('a.json', JSON.stringify({ scope: { paths: ['src'] }, project: { type: 'library', domain: 'tools', compliance: [], data_handling: '', team_size: 1, open_source: false, codeowners: [], deploy_target: '', run_budget_usd: 0, named_items: [] }, apps: [], unattended: { multi_file_gate: 'block', require_reason: false }, tdd: { paths: ['src/**'], diff_coverage: 80 } })),
    '--product', w('p.md', ['Purpose', 'Users', 'Core features', 'Constraints', 'Non-goals', 'Sources'].map((s) => `## ${s}\nx\n`).join('\n')),
    '--picks', w('k.json', JSON.stringify({ catalog_version: 1, findings: [], items: ids.map((id) => ({ id, include: 'recommended', reason: 'r', addresses: [] })) })),
    '--report', w('r.md', '## Findings\n\n## Roadmap\n30 days, 60 days, 90 days.\n\n## Deliberate exclusions\nnone\n\n## Limits\nx\n'),
    '--choose', ids.join(','),
  ];
  const run = async (extra: string[], answers: boolean[]) => {
    const calls: string[][] = [];
    let out = '';
    const code = await update([...flags, ...extra], { env: { CLAUDECODE: '1', HARNESS_PLAIN_INIT: '1' }, root, out: (s) => (out += s + '\n'), prompt: fake(answers), version: '1.1.0', templatesDir, distDir: join(pkgDir, 'dist'), claudeVersion: () => null, exec: (_c, a) => (calls.push(a), { status: 1, stdout: '{"command":"install","outcome":"failed","message":"nope"}' }) });
    return { code, out, calls };
  };
  expect((await run(['--yes'], [])).code).toBe(0);
  commitAll(root);
  const no = await run(['--install-plugins'], [false]);
  expect(no.calls).toHaveLength(0);
  expect(no.out).toContain('No plugins were installed');
  const yes = await run(['--install-plugins'], [true]);
  expect(yes.calls).toHaveLength(1);
  expect(yes.code).toBe(1);
  expect(yes.out).toContain('1 plugin(s) not installed.');
  expect(yes.out).not.toContain('Files applied');
  expect((await run(['--install-plugins', '--yes'], [])).calls).toHaveLength(1);
});

// Task 21: update re-recommends when the catalog or the facts change.
const reFlags = (ids: string[]) => {
  const d = mkdtempSync(join(tmpdir(), 'harness-upd-re-'));
  const w = (n: string, t: string) => (writeFileSync(join(d, n), t), join(d, n));
  return [
    '--answers', w('a.json', JSON.stringify({ scope: { paths: ['src'] }, project: { type: 'library', domain: 'tools', compliance: [], data_handling: '', team_size: 1, open_source: false, codeowners: [], deploy_target: '', run_budget_usd: 0, named_items: [] }, apps: [], unattended: { multi_file_gate: 'block', require_reason: false }, tdd: { paths: ['src/**'], diff_coverage: 80 } })),
    '--product', w('p.md', ['Purpose', 'Users', 'Core features', 'Constraints', 'Non-goals', 'Sources'].map((s) => `## ${s}\nx\n`).join('\n')),
    '--picks', w('k.json', JSON.stringify({ catalog_version: 1, findings: [], items: ids.map((id) => ({ id, include: 'recommended', reason: 'r', addresses: [] })) })),
    '--report', w('r.md', '## Findings\n\n## Roadmap\n30 days, 60 days, 90 days.\n\n## Deliberate exclusions\nnone\n\n## Limits\nx\n'),
    '--choose', ids.join(','),
  ];
};

const upAi = async (root: string, args: string[]) => {
  let out = '';
  const code = await update(args, { env: { CLAUDECODE: '1', HARNESS_PLAIN_INIT: '1' }, root, out: (s) => (out += s + '\n'), prompt: fake(), version: '1.1.0', templatesDir, distDir: join(pkgDir, 'dist'), claudeVersion: () => null });
  return { code, out };
};

/** Every file under root (ignored ones too, .git aside): path, size and content hash. */
const tree = (root: string): string[] =>
  (readdirSync(root, { recursive: true, withFileTypes: true }) as import('node:fs').Dirent[])
    .filter((e) => e.isFile() && !(e.parentPath ?? (e as any).path).includes(`${root}/.git`))
    .map((e) => { const f = join(e.parentPath ?? (e as any).path, e.name); const b = readFileSync(f); return `${f} ${b.length} ${createHash('sha256').update(b).digest('hex')}`; })
    .sort();

const planOf = async (root: string) => {
  const r = await upAi(root, ['--plan']);
  return { code: r.code, ...JSON.parse(r.out) };
};

test('update --plan writes nothing and says to recommend when the catalog version differs', async () => {
  const root = aiInstalled(REPO, OWN_IDS);
  const before = tree(root);
  const p = await planOf(root);
  expect(p).toMatchObject({ code: 0, recommend: true, reask: [], delta: { changed: [], retired: [], conflicting: [] } });
  expect(tree(root)).toEqual(before);
});

test('update --plan: no change means no re-recommend', async () => {
  const root = aiInstalled(REPO, OWN_IDS);
  expect((await upAi(root, [...reFlags(OWN_IDS), '--yes'])).code).toBe(0);
  commitAll(root);
  expect(await planOf(root)).toMatchObject({ recommend: false, reask: [] });
});

test('update --plan: missing facts.json means recommend and nothing re-asked', async () => {
  const root = aiInstalled(REPO, OWN_IDS);
  expect((await upAi(root, [...reFlags(OWN_IDS), '--yes'])).code).toBe(0);
  rmSync(join(root, '.harness/facts.json'));
  expect(await planOf(root)).toMatchObject({ recommend: true, reask: [] });
});

test('update --plan: only contradicted keys are re-asked', async () => {
  const root = aiInstalled(REPO, OWN_IDS);
  expect((await upAi(root, [...reFlags(OWN_IDS), '--yes'])).code).toBe(0);
  const f = join(root, '.harness/facts.json');
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), deploy: ['vercel'] }, null, 2) + '\n');
  expect(await planOf(root)).toMatchObject({ recommend: true, reask: ['project.deploy_target'] });
});

test('update: retired items are removed with a line saying why; new picks are listed', async () => {
  const root = aiInstalled(REPO, [...OWN_IDS, 'impeccable']);
  const c = join(root, '.harness/config.yaml');
  writeFileSync(c, readFileSync(c, 'utf8').replace('id: impeccable', 'id: gone-item'));
  commitAll(root);
  const r = await upAi(root, [...reFlags([...OWN_IDS, 'mobile-mcp']), '--dry-run']);
  expect(r.out).toContain('gone-item: no longer in the catalog; its files are kept.');
  expect(r.out).toContain('New: mobile-mcp');
  const plain = await upAi(root, ['--dry-run']);
  expect(plain.out).toContain('gone-item: no longer in the catalog; its files are kept.');
});

test('update --plan: a facts.json of the wrong shape counts as missing', async () => {
  const root = aiInstalled(REPO, OWN_IDS);
  expect((await upAi(root, [...reFlags(OWN_IDS), '--yes'])).code).toBe(0);
  writeFileSync(join(root, '.harness/facts.json'), '{}\n');
  expect(await planOf(root)).toMatchObject({ code: 0, recommend: true, reask: [] });
});

test('partial answers change only the given keys, and config.yaml comments survive', async () => {
  const root = aiInstalled(REPO, OWN_IDS);
  const c = join(root, '.harness/config.yaml');
  writeFileSync(c, '# my note\n' + readFileSync(c, 'utf8'));
  commitAll(root);
  const before = parseYaml(readFileSync(c, 'utf8')) as any;
  const part = join(mkdtempSync(join(tmpdir(), 'harness-upd-part-')), 'a.json');
  writeFileSync(part, JSON.stringify({ project: { deploy_target: 'vercel' } }));
  const flags = reFlags(OWN_IDS).slice(2);
  const r = await upAi(root, ['--answers', part, ...flags, '--yes']);
  expect(r.code).toBe(0);
  const text = readFileSync(c, 'utf8');
  const after = parseYaml(text) as any;
  expect(after.project.deploy_target).toBe('vercel');
  expect(after.project).toEqual({ ...before.project, deploy_target: 'vercel' });
  expect(after.apps).toEqual(before.apps);
  expect(after.unattended).toEqual(before.unattended);
  expect(after.tdd).toEqual(before.tdd);
  expect(text).toContain('# my note');
});

// An older config has no checks.decisions and no decisions section.
const olderConfig = (text: string) => '# my note\n' + text.replace(/^  decisions: true\n/m, '').replace(/# Team decisions[^\n]*\ndecisions:\n(  .*\n)+\n?/, '');

test('update on the AI path adds checks.decisions and the decisions section additively, keeping comments', async () => {
  const root = aiInstalled(REPO, OWN_IDS);
  const c = join(root, '.harness/config.yaml');
  writeFileSync(c, olderConfig(readFileSync(c, 'utf8')));
  commitAll(root);
  const old = readFileSync(c, 'utf8');
  expect(old).not.toContain('decisions');
  const r = await upAi(root, [...reFlags(OWN_IDS), '--yes']);
  expect(r.code).toBe(0);
  const after = readFileSync(c, 'utf8');
  expect(after).toContain('# my note');
  const y = parseYaml(after) as any;
  expect(y.checks.decisions).toBe(true);
  expect(y.decisions).toEqual({ max_lines: 20, expiry_days: 90, nudge: true });
  const { decisions: _c, ...checks } = y.checks;
  const o = parseYaml(old) as any; // the re-recommend flags set project answers, so only the sections this change owns are compared
  expect(checks).toEqual(o.checks);
  for (const k of ['sandbox', 'tdd', 'pr_size', 'stop', 'unattended', 'context', 'multi_file_gate']) expect(y[k]).toEqual(o[k]);
});

test('update on the plain path leaves an older config byte-identical', async () => {
  const root = await installed();
  const c = join(root, '.harness/config.yaml');
  writeFileSync(c, olderConfig(readFileSync(c, 'utf8')));
  const before = readFileSync(c, 'utf8');
  expect((await up(root, ['--yes'], { distDir: newDist() })).code).toBe(0);
  expect(readFileSync(c, 'utf8')).toBe(before);
});

test('update gives the same budget verdict as add and sync for a hand-selected, never-installed item', async () => {
  const root = aiInstalled(REPO, OWN_IDS);
  const c = join(root, '.harness/config.yaml');
  const doc = parseDocument(readFileSync(c, 'utf8'));
  doc.addIn(['items'], { id: 'mobile-mcp', include: 'optional', selected: true, reason: 'by hand', addresses: [], pin: '' });
  writeFileSync(c, doc.toString());
  commitAll(root);
  const r = await upAi(root, [...reFlags([...OWN_IDS, 'mobile-mcp']), '--yes']);
  expect(r.code).toBe(2);
  expect(r.out).toContain('Not measured before install: mobile-mcp');
});

test('Review focus 1: update keeps a synced decision rule, its entry and its file', async () => {
  const root = await installed();
  writeDecision(root, decision('2026-11-03-use-zod'));
  syncNow(root);
  commitAll(root);
  const rel = '.claude/rules/harness-decision-2026-11-03-use-zod.md';
  const text = readFileSync(join(root, rel), 'utf8');
  const entry = readManifest(root)!.files.find((f) => f.rel === rel);
  expect((await up(root, ['--yes'], { distDir: newDist() })).code).toBe(0);
  expect(readManifest(root)!.files.find((f) => f.rel === rel)).toEqual(entry);
  expect(readFileSync(join(root, rel), 'utf8')).toBe(text);
});

test('Important 2: a sync after update neither rewrites nor reorders the manifest', async () => {
  const root = await installed();
  writeDecision(root, decision('2026-11-03-use-zod'));
  syncNow(root);
  commitAll(root);
  expect((await up(root, ['--yes'], { distDir: newDist() })).code).toBe(0);
  const manifest = readFileSync(join(root, '.harness/manifest.json'), 'utf8');
  syncNow(root);
  expect(readFileSync(join(root, '.harness/manifest.json'), 'utf8')).toBe(manifest);
  const order = readManifest(root)!.files.map((f) => f.rel);
  writeDecision(root, decision('2026-11-04-no-default-exports'));
  syncNow(root);
  const rule = '.claude/rules/harness-decision-2026-11-04-no-default-exports.md';
  const at = order.indexOf('.claude/rules/harness-decision-2026-11-03-use-zod.md') + 1;
  expect(readManifest(root)!.files.map((f) => f.rel)).toEqual([...order.slice(0, at), rule, ...order.slice(at)]);
});
