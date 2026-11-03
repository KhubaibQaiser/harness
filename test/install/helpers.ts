import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll } from 'vitest';

const made: string[] = [];
afterAll(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });

/** Writes `files` into a fresh temp dir; with git (default) inits and makes one commit. `remoteHead` fakes origin/HEAD -> origin/<name>. */
export function makeRepo(files: Record<string, string>, opts: { git?: boolean; remoteHead?: string; branch?: string; prefix?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), opts.prefix ?? 'harness-repo-'));
  made.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  if (opts.git === false) return root;
  git(root, 'init', '-q', '-b', opts.branch ?? 'main');
  git(root, 'config', 'user.name', 'test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '--allow-empty', '-m', 'init');
  if (opts.remoteHead) {
    git(root, 'update-ref', `refs/remotes/origin/${opts.remoteHead}`, 'HEAD');
    git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${opts.remoteHead}`);
  }
  return root;
}

/** The beta release's settings fragment: shell-form hooks, five events, eight deny rules. */
const betaHook = (timeout: number) => ({ type: 'command', command: 'node "${CLAUDE_PROJECT_DIR}/.harness/hooks/dispatch.mjs"', timeout });
export const BETA_GROUPS: Record<string, object> = {
  PreToolUse: { matcher: 'Bash|Read|Grep|Edit|Write|MultiEdit|NotebookEdit', hooks: [betaHook(10)] },
  PostToolUse: { matcher: 'Bash|Edit|Write|MultiEdit|NotebookEdit', hooks: [betaHook(10)] },
  UserPromptSubmit: { hooks: [betaHook(10)] },
  Stop: { hooks: [betaHook(600)] },
  SessionEnd: { hooks: [betaHook(10)] },
};
export const BETA_DENY = ['Read(./.env)', 'Read(./.env.*)', 'Read(./**/.env)', 'Read(./**/.env.*)', 'Edit(./.harness/hooks/**)', 'Edit(./.harness/state/**)', 'Edit(./.harness/logs/**)', 'Edit(./.claude/settings.json)'];
/** `pre` merged with the beta fragment as the beta release did it, and the blocks it recorded. */
export function betaSettings(pre: any): { s: any; blocks: string[] } {
  const s = structuredClone(pre);
  const blocks: string[] = [];
  s.hooks ??= {};
  for (const [event, group] of Object.entries(BETA_GROUPS)) {
    (s.hooks[event] ??= []).push(group);
    blocks.push(JSON.stringify({ event, group }));
  }
  s.permissions ??= {};
  s.permissions.deny ??= [];
  for (const d of BETA_DENY) if (!s.permissions.deny.includes(d)) s.permissions.deny.push(d), blocks.push(JSON.stringify({ deny: d }));
  return { s, blocks };
}

// A stand-in for the repo's Prettier: splits lines over 80 columns at ", ", and fails on FAIL_FORMAT.
const FAKE = `let s = '';
process.stdin.on('data', (d) => (s += d)).on('end', () => {
  if (s.includes('FAIL_FORMAT')) { process.stderr.write('boom\\n'); process.exit(2); }
  process.stdout.write(s.split('\\n').map((l) => (l.length > 80 ? l.replace(/, /g, ',\\n    ') : l)).join('\\n'));
});
`;
export const withPrettier = { 'node_modules/prettier/package.json': JSON.stringify({ name: 'prettier', bin: { prettier: 'bin/prettier.cjs' } }), 'node_modules/prettier/bin/prettier.cjs': FAKE };
