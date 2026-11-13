// Round 2: gh, hub and git write local files too. Downloads and clones that land in .harness or .claude are denied by
// protect; elsewhere they stay allowed.
import { expect, test } from 'vitest';
import { protect } from '../../src/checks/protect.js';
import { loadConfig } from '../../src/core/config.js';
import type { Ctx } from '../../src/hooks/dispatch.js';

const config = loadConfig('/nonexistent-harness-root').config;
const prot = (command: string) =>
  (protect.run({ input: { hook_event_name: 'PreToolUse', session_id: 's', cwd: '/p', tool_name: 'Bash', tool_input: { command } }, root: '/p', config, env: {}, unattended: false } as unknown as Ctx) as { kind: string }).kind;
const all = (cs: string[], want: string) => { for (const c of cs) expect(prot(c), c).toBe(want); };
const H = '.harness/hooks';

test('gh release/run download into a protected folder or file is denied', () => {
  all([`gh release download v1 -D ${H}`, `gh release download v1 --dir ${H} -p dispatch.mjs`, 'gh release download v1 -O .harness/config.yaml', 'gh release download v1 --output=.harness/config.yaml',
    `gh run download 1 -D ${H}`, 'gh run download 1 --dir=.harness', `env gh release download v1 -D ${H}`, `/usr/bin/gh run download 1 -D ${H}`], 'deny');
  all(['gh release download v1 -D dist', 'gh release download v1', 'gh run download 1 -D artifacts', 'gh release download v1 -O -'], 'allow');
});

test('gh repo/gist clone, hub clone and git clone into a protected folder are denied', () => {
  all([`gh repo clone o/r ${H}`, 'gh repo clone o/r .claude', `gh gist clone abc ${H}`, `hub clone o/r ${H}`, `git clone https://x/r ${H}`, 'git clone https://x/r .claude',
    `git clone --depth 1 https://x/r ${H}`, `git clone -b main https://x/r ${H}`, 'git clone https://x/.harness.git', `git -C . clone https://x/r ${H}`], 'deny');
  all(['gh repo clone o/r', 'gh repo clone o/r vendor/r', 'git clone https://x/r', 'git clone https://x/r.git lib/r', 'hub clone o/r'], 'allow');
});
